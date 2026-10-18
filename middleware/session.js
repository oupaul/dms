/**
 * Session 儲存、閒置逾時與強制改密碼中介軟體。
 */

const path = require('path');
const session = require('express-session');
const security = require('../lib/security');
const { SqliteSessionStore } = require('../lib/session-store');
const ROOT_DIR = path.join(__dirname, '..');

// Session 中介軟體（持久化於 sessions/sessions.sqlite；密鑰來自環境變數或主機專屬 .session_secret）
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const sessionStore = new SqliteSessionStore({
  dir: path.join(ROOT_DIR, 'sessions'),
  ttlMs: SESSION_MAX_AGE_MS
});

const sessionMiddleware = session({
  store: sessionStore,
  secret: security.loadSessionSecret(ROOT_DIR),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,      // 站台為 HTTPS，必須設 true（trust proxy: 1 已設定）
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_MS,
    sameSite: 'lax'   // 允許 OAuth redirect 後帶回 cookie
  }
});

const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

const idleTimeout = (req, res, next) => {
  if (req.session && req.session.userId) {
    const now = Date.now();
    const lastActivity = req.session.lastActivity || now;
    if (now - lastActivity > IDLE_TIMEOUT_MS) {
      const username = req.session.username;
      console.log(`Session timeout for user: ${username}`);
      return req.session.destroy((err) => {
        if (err) {
          console.error('Session destroy error:', err);
        }
        res.status(440).json({ error: 'SESSION_TIMEOUT', message: '因長時間未操作，已自動登出。' });
      });
    }
    req.session.lastActivity = now;
  }
  next();
};

// 首次登入／管理員重設密碼後，必須先修改密碼才能使用其他功能
const MUST_CHANGE_ALLOWED_PATHS = new Set(['/api/auth/change-password', '/api/auth/logout', '/api/auth/status']);

const forcePasswordChange = (req, res, next) => {
  if (req.session && req.session.userId && req.session.mustChangePassword) {
    if (MUST_CHANGE_ALLOWED_PATHS.has(req.path)) return next();
    const isPlainPage = req.method === 'GET' && !req.path.startsWith('/api/') && !/^\/(export|download|import)/.test(req.path);
    if (isPlainPage) return next();
    return res.status(403).json({
      error: 'must_change_password',
      code: 'MUST_CHANGE_PASSWORD',
      message: '請先修改密碼後再繼續使用系統'
    });
  }
  next();
};

module.exports = {
  forcePasswordChange,
  idleTimeout,
  sessionMiddleware,
  sessionStore,
};
