'use strict';
/**
 * 安全相關共用工具：登入限速、安全標頭、Origin 檢查（CSRF 防護）、
 * 反向代理來源白名單、密碼政策、使用者名稱衝突與資料庫歸屬判斷、session 密鑰載入。
 *
 * 刻意不依賴第三方套件（helmet / express-rate-limit），降低供應鏈風險。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ==================== 登入限速 ====================

/**
 * 以記憶體計數的失敗次數限速器（單一 Node 程序，足以應付本系統的 PM2 單實例部署）。
 * 只計「失敗」次數：check() 判斷是否被鎖定，fail() 記一次失敗，reset() 成功後清除。
 */
function createFailureLimiter({ windowMs, max }) {
  const buckets = new Map(); // key -> { count, resetAt }

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(key);
    }
  }, Math.min(windowMs, 60 * 1000));
  if (timer.unref) timer.unref();

  function get(key) {
    const b = buckets.get(key);
    if (!b) return null;
    if (b.resetAt <= Date.now()) {
      buckets.delete(key);
      return null;
    }
    return b;
  }

  return {
    /** 回傳 { blocked, retryAfterSec } */
    check(key) {
      const b = get(key);
      if (b && b.count >= max) {
        return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - Date.now()) / 1000)) };
      }
      return { blocked: false, retryAfterSec: 0 };
    },
    fail(key) {
      const b = get(key);
      if (b) b.count += 1;
      else buckets.set(key, { count: 1, resetAt: Date.now() + windowMs });
    },
    reset(key) {
      buckets.delete(key);
    },
    _size() {
      return buckets.size;
    }
  };
}

/**
 * 一般請求頻率限制（不分成功失敗），用於公開端點如邀請 token 查詢。
 */
function createRequestLimiter({ windowMs, max, message }) {
  const limiter = createFailureLimiter({ windowMs, max });
  return function requestLimiter(req, res, next) {
    const key = req.ip || 'unknown';
    const state = limiter.check(key);
    if (state.blocked) {
      res.set('Retry-After', String(state.retryAfterSec));
      return res.status(429).json({ error: message || '請求過於頻繁，請稍後再試' });
    }
    limiter.fail(key); // 每次請求都記一次
    next();
  };
}

// ==================== 安全標頭 ====================

function buildCsp() {
  // 前端大量使用 inline script / inline handler，必須保留 'unsafe-inline'；
  // 其餘來源收斂為自身 + 公司設計系統網域（megapower.asia）。
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://www.megapower.asia",
    "img-src 'self' data: blob: https://www.megapower.asia",
    "font-src 'self' data: https://www.megapower.asia",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
}

function securityHeaders() {
  const csp = buildCsp();
  return function securityHeadersMiddleware(req, res, next) {
    res.removeHeader('X-Powered-By');
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin'
    });
    // 經由 HTTPS 反向代理進來時才送 HSTS（req.protocol 受 trust proxy 影響）
    if (req.protocol === 'https') {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    // API 回應與已登入頁面不應被快取
    if (req.path.startsWith('/api/') || req.path === '/' || req.path === '/index.html') {
      res.set('Cache-Control', 'no-store');
    }
    next();
  };
}

// ==================== CSRF：Origin / Sec-Fetch-Site 檢查 ====================

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hostOf(urlLike) {
  try {
    return new URL(urlLike).host.toLowerCase();
  } catch (e) {
    return null;
  }
}

/**
 * 對非安全方法（POST/PUT/DELETE/PATCH）驗證請求來源：
 *  1. Sec-Fetch-Site 為 cross-site / same-site 一律拒絕
 *  2. 有 Origin（或 Referer）時，其 host 必須等於 Host / X-Forwarded-Host，或在白名單內
 * 無 Origin 也無 Referer 的請求（如 curl、後端腳本）不受影響：它們沒有瀏覽器自動帶入的 cookie 風險。
 * 反向代理必須保留原始 Host（proxy_set_header Host $host;）。
 */
function originCheck({ allowedOrigins = [], logger = console } = {}) {
  const allowHosts = new Set(allowedOrigins.map(o => hostOf(o) || o.toLowerCase()));

  return function originCheckMiddleware(req, res, next) {
    if (SAFE_METHODS.has(req.method.toUpperCase())) return next();

    const fetchSite = (req.get('sec-fetch-site') || '').toLowerCase();
    const origin = req.get('origin');
    const source = origin || req.get('referer');

    let sourceHost = null;
    if (source && source !== 'null') sourceHost = hostOf(source);

    const ownHosts = new Set();
    const host = req.get('host');
    const fwdHost = req.get('x-forwarded-host');
    if (host) ownHosts.add(host.toLowerCase());
    if (fwdHost) fwdHost.split(',').forEach(h => ownHosts.add(h.trim().toLowerCase()));

    if (sourceHost) {
      if (ownHosts.has(sourceHost) || allowHosts.has(sourceHost)) return next();
      logger.warn(`[CSRF] 拒絕來源 ${sourceHost}（Host=${host}, X-Forwarded-Host=${fwdHost || '-'}）。` +
        '若為合法來源，請確認 nginx 有 proxy_set_header Host $host，或設定 ALLOWED_ORIGINS。');
      return res.status(403).json({ error: 'forbidden', message: '來源不被允許' });
    }

    if (source === 'null' || fetchSite === 'cross-site') {
      return res.status(403).json({ error: 'forbidden', message: '來源不被允許' });
    }
    if (fetchSite === 'same-site') {
      return res.status(403).json({ error: 'forbidden', message: '來源不被允許' });
    }
    next();
  };
}

// ==================== 反向代理來源白名單 ====================

function normalizeIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * 只接受來自指定反向代理主機（nginx）的連線，直連應用埠一律拒絕。
 * 白名單為空時不啟用（維持舊行為），但啟動時會警告。
 */
function proxyAllowlist(ips) {
  const allow = new Set(ips.map(normalizeIp));
  return function proxyAllowlistMiddleware(req, res, next) {
    const remote = normalizeIp(req.socket && req.socket.remoteAddress);
    if (allow.has(remote)) return next();
    res.status(403).type('text/plain').send('Forbidden');
  };
}

function parseCsvEnv(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ==================== 密碼政策 ====================

const MIN_PASSWORD_LENGTH = 10;
const WEAK_PASSWORDS = new Set([
  'admin123', 'admin1234', 'password', 'password1', 'password123', '12345678', '123456789',
  '1234567890', 'qwerty123', 'qwertyuiop', 'abc123456', 'iloveyou', 'welcome1', 'letmein123',
  'p@ssw0rd', 'p@ssword', 'changeme', 'changeme123'
]);

/** 回傳 null 代表通過，否則回傳錯誤訊息 */
function validatePassword(password, username) {
  if (typeof password !== 'string') return '密碼格式不正確';
  if (password.length < MIN_PASSWORD_LENGTH) return `密碼長度至少需要 ${MIN_PASSWORD_LENGTH} 個字元`;
  if (password.length > 128) return '密碼長度不可超過 128 個字元';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(password)).length;
  if (classes < 3) return '密碼需包含大寫、小寫、數字、符號中至少三類';
  const lower = password.toLowerCase();
  if (WEAK_PASSWORDS.has(lower)) return '密碼過於常見，請改用其他密碼';
  if (username && lower.includes(String(username).toLowerCase()) && String(username).length >= 3) {
    return '密碼不可包含使用者名稱';
  }
  return null;
}

/** 產生符合密碼政策、無易混淆字元的隨機密碼（預設 20 字元） */
function generatePassword(length = 20) {
  const sets = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnopqrstuvwxyz',
    '23456789',
    '!@#$%^&*-_=+'
  ];
  const all = sets.join('');
  const pick = (chars) => chars[crypto.randomInt(chars.length)];
  const out = sets.map(pick);
  while (out.length < length) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

// ==================== 使用者名稱 / 資料庫歸屬 ====================

/**
 * 個人資料庫以檔名前綴 user_<username>_ 或 user_<username>.db 歸屬。
 * 若允許 a 與 a_b 並存，user_a_b.db 同時符合兩者的前綴，造成跨帳號存取。
 * 因此新帳號名稱不可以是既有帳號名稱加 "_" 的延伸，也不可是既有帳號名稱的 "_" 前綴。
 * 回傳衝突的既有帳號名稱，沒有衝突回傳 null。
 */
function findUsernameCollision(candidate, existingUsernames) {
  const c = String(candidate).toLowerCase();
  for (const name of existingUsernames) {
    const e = String(name).toLowerCase();
    if (e === c) continue; // 完全相同由唯一性檢查處理
    if (c.startsWith(e + '_') || e.startsWith(c + '_')) return name;
  }
  return null;
}

function isDatabaseOwnedBy(dbName, username) {
  if (!dbName || !username || typeof dbName !== 'string') return false;
  if (!dbName.endsWith('.db')) return false;
  return dbName === `user_${username}.db` || dbName.startsWith(`user_${username}_`);
}

// ==================== Session 密鑰 ====================

/**
 * 優先使用環境變數 SESSION_SECRET；其次讀取主機專屬的 .session_secret；
 * 兩者皆無時產生隨機密鑰並寫入 .session_secret（權限 600）。
 * 不再使用任何寫死在原始碼中的後備值。
 */
function loadSessionSecret(baseDir, logger = console) {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) {
    return process.env.SESSION_SECRET;
  }
  if (process.env.SESSION_SECRET) {
    logger.warn('⚠️  SESSION_SECRET 長度不足 32 字元，改用 .session_secret。');
  }
  const file = path.join(baseDir, '.session_secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (e) {
    // 檔案不存在，往下產生
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  logger.warn(`⚠️  未設定 SESSION_SECRET，已產生主機專屬密鑰並寫入 ${file}（權限 600，已列入 .gitignore）。`);
  return secret;
}

module.exports = {
  createFailureLimiter,
  createRequestLimiter,
  securityHeaders,
  originCheck,
  proxyAllowlist,
  parseCsvEnv,
  validatePassword,
  generatePassword,
  findUsernameCollision,
  isDatabaseOwnedBy,
  loadSessionSecret,
  MIN_PASSWORD_LENGTH
};
