/**
 * 登入／登出／SSO／改密碼／邀請註冊。
 */

const express = require('express');
const argon2 = require('argon2');
const crypto = require('crypto');
const security = require('../lib/security');
const { internalError } = require('../lib/http');
const { nowISO } = require('../lib/time');
const { requireAuth } = require('../middleware/auth');
const { sessionStore } = require('../middleware/session');
const { usernameCollisionOf } = require('../services/accounts');
const { logAudit, logLogout, updateUsageStatistics } = require('../services/audit');
const { connectDatabase, getSystemDb, getUserDatabase, parseAllowedDatabases, sanitizeAllowedDatabases } = require('../services/database');
const { getMsalClient, getMsalConfig } = require('../services/sso');
const { dbGet, dbRun } = require('../lib/db');

const router = express.Router();

// ==================== 帳號管理 API ====================

// 舊自助申請已停用，改為邀請制
router.post('/api/auth/register', (req, res) => {
  res.status(410).json({ error: '自助申請帳號功能已停用，請向管理員索取邀請連結。' });
});

// 公開的邀請端點（查詢 token / 以 token 註冊）限速，防止猜測 token 與灌帳號
const inviteLimiter = security.createRequestLimiter({ windowMs: 15 * 60 * 1000, max: 60, message: '請求過於頻繁，請稍後再試' });

// 登入限速：同一 IP+帳號 5 次、同一 IP 30 次、同一帳號 30 次失敗後鎖定 15 分鐘（成功登入會清除 IP+帳號 的計數）
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const loginLimiterPair = security.createFailureLimiter({ windowMs: LOGIN_WINDOW_MS, max: 5 });

const loginLimiterIp = security.createFailureLimiter({ windowMs: LOGIN_WINDOW_MS, max: 30 });

const loginLimiterUser = security.createFailureLimiter({ windowMs: LOGIN_WINDOW_MS, max: 30 });

// 帳號不存在時也做一次等價的雜湊驗證，避免用回應時間探測帳號是否存在
let dummyPasswordHashPromise = null;

function getDummyPasswordHash() {
  if (!dummyPasswordHashPromise) dummyPasswordHashPromise = argon2.hash(crypto.randomBytes(16).toString('hex'));
  return dummyPasswordHashPromise;
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

// 登入
router.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: '請提供使用者名稱和密碼' });
  }

  const ip = req.ip || 'unknown';
  const userKey = username.toLowerCase();
  const pairKey = `${ip}|${userKey}`;
  for (const [limiter, key] of [[loginLimiterPair, pairKey], [loginLimiterIp, ip], [loginLimiterUser, userKey]]) {
    const state = limiter.check(key);
    if (state.blocked) {
      res.set('Retry-After', String(state.retryAfterSec));
      return res.status(429).json({
        error: '登入失敗次數過多，請稍後再試',
        message: `請於 ${Math.ceil(state.retryAfterSec / 60)} 分鐘後再試。`
      });
    }
  }
  const recordLoginFailure = () => {
    loginLimiterPair.fail(pairKey);
    loginLimiterIp.fail(ip);
    loginLimiterUser.fail(userKey);
  };
  
  try {
    // 查找使用者（從系統資料庫）
    const systemDb = getSystemDb(); // 保存系統資料庫連線
    const user = await dbGet(systemDb, 'SELECT * FROM accounts WHERE username = ?', [username]);
    
    // 先驗證密碼（帳號不存在時用假雜湊，耗時相同），再揭露帳號狀態，避免未認證者探測帳號
    const hashToCheck = user ? user.password_hash : await getDummyPasswordHash();
    let isPasswordValid = false;
    try {
      isPasswordValid = await argon2.verify(hashToCheck, password);
    } catch (verifyErr) {
      isPasswordValid = false;
    }
    if (!user || !isPasswordValid) {
      recordLoginFailure();
      return res.status(401).json({ error: '使用者名稱或密碼錯誤' });
    }
    
    // 檢查帳號狀態（已通過密碼驗證，才告知狀態）
    if (user.status === 'pending') {
      return res.status(403).json({ 
        error: '帳號尚未通過審核',
        message: '您的帳號正在等待管理員審核，請稍後再試。'
      });
    }
    
    if (user.status === 'rejected') {
      return res.status(403).json({ 
        error: '帳號已被拒絕',
        message: '您的帳號申請已被拒絕，請聯繫管理員。'
      });
    }
    
    if (user.status !== 'active') {
      return res.status(403).json({ error: '帳號狀態異常，請聯繫管理員' });
    }
    
    loginLimiterPair.reset(pairKey);
    
    const permissionLevel = user.permission_level || 'editor';
    const userRoleLevel = user.role === 'admin' ? 'admin' : (user.role_level || 'user');
    const isClientRole = userRoleLevel === 'db_admin' || userRoleLevel === 'client_user';
    const isEngineer = userRoleLevel === 'engineer';
    let allowedDatabases = parseAllowedDatabases(user.allowed_databases);
    if (permissionLevel === 'viewer' || isClientRole || isEngineer) {
      allowedDatabases = sanitizeAllowedDatabases(allowedDatabases);
      if (allowedDatabases.length === 0) {
        return res.status(403).json({
          error: '尚未指派可存取的資料庫',
          message: '請聯繫管理員設定可存取的資料庫後再登入。'
        });
      }
    }

    let targetDatabase = user.user_database;
    if (permissionLevel === 'viewer' || isClientRole || isEngineer) {
      // 優先使用帳號記錄的 user_database（即管理員指定的預設資料庫）
      // 若不在允許清單內（例如帳號剛被調整），退回清單第一個
      targetDatabase = allowedDatabases.includes(user.user_database)
        ? user.user_database
        : allowedDatabases[0];
    }

    if (!targetDatabase) {
      return res.status(500).json({ error: '帳號未設定資料庫，請聯繫管理員' });
    }

    // 切換到使用者的專屬資料庫
    try {
      const userDb = await getUserDatabase(user.id, targetDatabase);
      
      // 登入成功後換發新的 session ID，防止 session fixation
      await regenerateSession(req);
      
      // 設定 session（包含使用者資料庫資訊）
      req.session.mustChangePassword = !!user.must_change_password;
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.fullName = user.full_name;
      req.session.role = user.role;
      req.session.roleLevel = user.role === 'admin' ? 'admin' : (user.role_level || 'user');
      req.session.canInvite = !!(user.can_invite || user.role === 'admin');
      req.session.permissionLevel = permissionLevel;
      req.session.allowedDatabases = (permissionLevel === 'viewer' || isClientRole || isEngineer) ? allowedDatabases : [];
      req.session.userDatabase = targetDatabase;
      
      // 記錄活動會話到系統資料庫（在線用戶追蹤）
      const ipAddress = req.ip || req.connection.remoteAddress;
      const userAgent = req.get('User-Agent') || 'Unknown';
      
      getSystemDb().run(`INSERT INTO active_sessions (account_id, username, full_name, user_database, ip_address, user_agent, login_time, last_active)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [user.id, user.username, user.full_name, user.user_database, ipAddress, userAgent, nowISO(), nowISO()],
        (err) => {
          if (err) console.error('記錄活動會話錯誤:', err);
          else {
            // 保存會話ID到 session，方便後續更新和刪除
            getSystemDb().get('SELECT last_insert_rowid() as id', (err, row) => {
              if (!err && row) {
                req.session.activeSessionId = row.id;
              }
            });
          }
        }
      );
      
      // 記錄使用時間統計（登入）
      updateUsageStatistics(user.id, user.username, user.full_name, true);
      
      // 記錄審計日誌（登入）
      logAudit(req, 'login', 'account', user.id, username, null, { database: targetDatabase, permissionLevel });
      
      console.log(`✓ 登入成功: ${username}, 資料庫: ${targetDatabase}, 權限: ${permissionLevel}`);
      res.json({
        success: true,
        message: '登入成功',
        mustChangePassword: !!user.must_change_password,
        user: {
          id: user.id,
          username: user.username,
          fullName: user.full_name,
          role: user.role,
          roleLevel: user.role === 'admin' ? 'admin' : (user.role_level || 'user'),
          canInvite: !!(user.can_invite || user.role === 'admin'),
          database: targetDatabase,
          permissionLevel,
          allowedDatabases: (permissionLevel === 'viewer' || isClientRole || isEngineer) ? allowedDatabases : []
        }
      });
    } catch (dbError) {
      console.error('資料庫切換失敗:', dbError);
      return res.status(500).json({ error: '無法連接到您的資料庫，請聯繫管理員' });
    }
    
  } catch (error) {
    console.error('登入錯誤:', error);
    internalError(res, error);
  }
});

// 登出
router.post('/api/auth/logout', (req, res) => {
  console.log('Hit POST /api/auth/logout');
  
  // 記錄登出時間
  if (req.session && req.session.userId) {
    logLogout(req.session.userId, req.session.username);
    
    // 記錄審計日誌（登出）
    logAudit(req, 'logout', 'account', req.session.userId, req.session.username, null, null);
  }
  
  // 從系統資料庫刪除活動會話記錄
  if (req.session.activeSessionId) {
    getSystemDb().run('DELETE FROM active_sessions WHERE id = ?', 
      [req.session.activeSessionId],
      (err) => {
        if (err) console.error('刪除活動會話錯誤:', err);
      }
    );
  }
  
  req.session.destroy((err) => {
    if (err) {
      console.error('登出錯誤:', err);
      return res.status(500).json({ error: '登出失敗' });
    }
    res.clearCookie('connect.sid', { httpOnly: true, secure: true, sameSite: 'lax' });
    res.json({ success: true, message: '登出成功' });
  });
});

// M365 SSO 狀態（公開，不需登入）
router.get('/api/auth/sso-status', (req, res) => {
  res.json({ enabled: !!(getMsalConfig().enabled && getMsalClient()) });
});

// M365 SSO 登入入口
router.get('/auth/microsoft', async (req, res) => {
  if (!getMsalClient() || !getMsalConfig().enabled) {
    return res.redirect('/login.html?error=sso_disabled');
  }
  try {
    const ssoState = crypto.randomBytes(24).toString('hex'); // 隨機 state 綁定本次 session，防止 login CSRF
    const authCodeUrl = await getMsalClient().getAuthCodeUrl({
      scopes: ['openid', 'profile', 'email'],
      redirectUri: getMsalConfig().redirectUri,
      state: ssoState,
    });
    // 強制儲存 session 後再跳轉，確保 cookie 已寫入
    req.session.msalPending = true;
    req.session.msalState = ssoState;
    req.session.save((err) => {
      if (err) console.error('Session save error before SSO redirect:', err);
      res.redirect(authCodeUrl);
    });
  } catch (err) {
    console.error('SSO redirect error:', err);
    res.redirect('/login.html?error=sso_error');
  }
});

// M365 SSO Callback
router.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('Microsoft auth error:', error, req.query.error_description);
    return res.redirect('/login.html?error=ms_auth_cancelled');
  }
  // 只接受單一字串的授權碼（?code=a&code=b 會變成陣列）。MSAL 對 acquireTokenByCode 的建議也是只傳入純授權碼
  if (!code || typeof code !== 'string') return res.redirect('/login.html?error=ms_auth_failed');

  // state 驗證：必須與發起登入時存在 session 的隨機值一致（一次性）
  const expectedState = req.session && req.session.msalState;
  if (req.session) delete req.session.msalState;
  if (!state || !expectedState || typeof state !== 'string' ||
      state.length !== expectedState.length ||
      !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) {
    console.error('SSO state mismatch');
    return res.redirect('/login.html?error=ms_auth_failed');
  }

  try {
    const tokenResponse = await getMsalClient().acquireTokenByCode({
      code,
      scopes: ['openid', 'profile', 'email'],
      redirectUri: getMsalConfig().redirectUri,
    });

    const msEmail = tokenResponse.account?.username
      || tokenResponse.idTokenClaims?.email
      || tokenResponse.idTokenClaims?.preferred_username;

    if (!msEmail) return res.redirect('/login.html?error=ms_no_email');

    const user = await dbGet(getSystemDb(), "SELECT * FROM accounts WHERE LOWER(ms_email) = LOWER(?) AND status = 'active'", [msEmail]);

    if (!user) {
      console.log(`M365 SSO: 找不到綁定帳號 for ${msEmail}`);
      return res.redirect('/login.html?error=ms_no_linked_account');
    }

    const permissionLevel = user.permission_level || 'editor';
    const userRoleLevel = user.role === 'admin' ? 'admin' : (user.role_level || 'user');
    const isClientRole = userRoleLevel === 'db_admin' || userRoleLevel === 'client_user';
    const isEngineer = userRoleLevel === 'engineer';
    let allowedDatabases = parseAllowedDatabases(user.allowed_databases);

    if (permissionLevel === 'viewer' || isClientRole || isEngineer) {
      allowedDatabases = sanitizeAllowedDatabases(allowedDatabases);
      if (allowedDatabases.length === 0) {
        return res.redirect('/login.html?error=ms_no_database');
      }
    }

    let targetDatabase = user.user_database;
    if (permissionLevel === 'viewer' || isClientRole || isEngineer) {
      targetDatabase = allowedDatabases.includes(user.user_database)
        ? user.user_database
        : allowedDatabases[0];
    }
    if (!targetDatabase) return res.redirect('/login.html?error=ms_no_database');

    await getUserDatabase(user.id, targetDatabase);

    // 登入成功後換發新的 session ID，防止 session fixation
    await regenerateSession(req);

    req.session.mustChangePassword = false;
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.fullName = user.full_name;
    req.session.role = user.role;
    req.session.roleLevel = user.role === 'admin' ? 'admin' : (user.role_level || 'user');
    req.session.canInvite = !!(user.can_invite || user.role === 'admin');
    req.session.permissionLevel = permissionLevel;
    req.session.allowedDatabases = (permissionLevel === 'viewer' || isClientRole || isEngineer) ? allowedDatabases : [];
    req.session.userDatabase = targetDatabase;
    req.session.loginMethod = 'sso';

    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent') || 'Unknown';

    // 必須在 redirect 前取得 activeSessionId，否則 session 會在非同步回呼完成前就被儲存
    const activeSessionId = await new Promise((resolve) => {
      getSystemDb().run(
        'INSERT INTO active_sessions (account_id, username, full_name, user_database, ip_address, user_agent, login_time, last_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [user.id, user.username, user.full_name || '', targetDatabase, ipAddress, userAgent, nowISO(), nowISO()],
        function(err) {
          if (err) { console.error('active_sessions insert error (SSO):', err); resolve(null); }
          else resolve(this.lastID);
        }
      );
    });
    if (activeSessionId) req.session.activeSessionId = activeSessionId;

    updateUsageStatistics(user.id, user.username, user.full_name, true);
    logAudit(req, 'login', 'account', user.id, user.username, null, { database: targetDatabase, method: 'M365 SSO' });

    console.log(`✓ M365 SSO 登入成功: ${user.username} (${msEmail})`);

    // 明確儲存 session（含 activeSessionId）後再 redirect，確保後續操作記錄正常
    req.session.save((saveErr) => {
      if (saveErr) console.error('Session save error in SSO callback:', saveErr);
      res.redirect('/index.html');
    });
  } catch (err) {
    console.error('SSO callback error:', err);
    res.redirect('/login.html?error=ms_auth_failed');
  }
});

const changePasswordLimiter = security.createFailureLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

// 修改密碼
router.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.session.userId;
  
  try {
    // 驗證輸入
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: '請提供當前密碼和新密碼' });
    }
    
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: '欄位格式不正確' });
    }

    const cpState = changePasswordLimiter.check(String(userId));
    if (cpState.blocked) {
      res.set('Retry-After', String(cpState.retryAfterSec));
      return res.status(429).json({ error: '嘗試次數過多，請稍後再試' });
    }
    
    // 使用系統資料庫（帳號資料庫）
    const systemDb = getSystemDb();
    
    // 查詢當前使用者
    const user = await dbGet(systemDb, 'SELECT * FROM accounts WHERE id = ?', [userId]);
    
    if (!user) {
      return res.status(404).json({ error: '使用者不存在' });
    }
    
    // 驗證當前密碼
    const isValidPassword = await argon2.verify(user.password_hash, currentPassword);
    if (!isValidPassword) {
      changePasswordLimiter.fail(String(userId));
      return res.status(401).json({ error: '當前密碼錯誤' });
    }
    changePasswordLimiter.reset(String(userId));

    const newPwError = security.validatePassword(newPassword, user.username);
    if (newPwError) {
      return res.status(400).json({ error: newPwError });
    }
    
    // 檢查新密碼是否與舊密碼相同
    const isSamePassword = await argon2.verify(user.password_hash, newPassword);
    if (isSamePassword) {
      return res.status(400).json({ error: '新密碼不能與當前密碼相同' });
    }
    
    // 加密新密碼
    const newPasswordHash = await argon2.hash(newPassword);
    
    // 更新密碼
    await new Promise((resolve, reject) => {
      systemDb.run(
        'UPDATE accounts SET password_hash = ?, must_change_password = 0 WHERE id = ?',
        [newPasswordHash, userId],
        function(err) {
          if (err) reject(err);
          else resolve(this);
        }
      );
    });
    req.session.mustChangePassword = false;
    // 改密碼後，該帳號在其他裝置上的登入全部失效
    sessionStore.destroyByUserId(userId, req.sessionID);
    logAudit(req, 'update', 'account', userId, user.username, null, { event: 'change_password' });
    
    console.log(`✓ 使用者 ${user.username} 已成功修改密碼`);
    
    res.json({
      success: true,
      message: '密碼修改成功'
    });
    
  } catch (error) {
    console.error('修改密碼錯誤:', error);
    res.status(500).json({ error: '修改密碼失敗，請稍後再試' });
  }
});

// 檢查登入狀態
router.get('/api/auth/status', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({
      loggedIn: true,
      user: {
        id: req.session.userId,
        username: req.session.username,
        fullName: req.session.fullName,
        role: req.session.role,
        roleLevel: req.session.role === 'admin' ? 'admin' : (req.session.roleLevel || 'user'),
        canInvite: !!(req.session.canInvite || req.session.role === 'admin'),
        permissionLevel: req.session.permissionLevel || 'editor',
        allowedDatabases: req.session.allowedDatabases || [],
        database: req.session.userDatabase,
        mustChangePassword: !!req.session.mustChangePassword
      }
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// 檢查是否有任何帳號
router.get('/api/auth/has-accounts', (req, res) => {
  getSystemDb().get('SELECT COUNT(*) as count FROM accounts', [], (err, row) => {
    if (err) {
      return internalError(res, err);
    }
    res.json({ hasAccounts: row.count > 0 });
  });
});

// 驗證邀請 token（公開，不需登入）
router.get('/api/invite/:token', inviteLimiter, async (req, res) => {
  const { token } = req.params;
  try {
    const inv = await dbGet(getSystemDb(), 'SELECT * FROM invitations WHERE token = ?', [token]);
    if (!inv) return res.status(404).json({ error: '邀請連結無效' });
    if (inv.used_at) return res.status(410).json({ error: '此邀請連結已被使用' });
    if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: '此邀請連結已過期' });
    res.json({
      valid: true,
      note: inv.note,
      role_level: inv.role_level,
      permission_level: inv.permission_level,
      allowed_databases: (() => { try { return JSON.parse(inv.allowed_databases || '[]'); } catch { return []; } })(),
      expires_at: inv.expires_at
    });
  } catch (error) {
    internalError(res, error);
  }
});

// 透過邀請連結建立帳號（公開）
router.post('/api/invite/:token/register', inviteLimiter, async (req, res) => {
  const { token } = req.params;
  const { username, password, full_name } = req.body;

  if (!username || !password) return res.status(400).json({ error: '請提供使用者名稱和密碼' });
  if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: '欄位格式不正確' });
  if (!/^[a-zA-Z0-9_]+$/.test(username) || username.length > 64) return res.status(400).json({ error: '使用者名稱只能包含英數字和底線' });
  const invitePwError = security.validatePassword(password, username);
  if (invitePwError) return res.status(400).json({ error: invitePwError });

  try {
    const inv = await dbGet(getSystemDb(), 'SELECT * FROM invitations WHERE token = ?', [token]);
    if (!inv) return res.status(404).json({ error: '邀請連結無效' });
    if (inv.used_at) return res.status(410).json({ error: '此邀請連結已被使用' });
    if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: '此邀請連結已過期' });

    const existing = await dbGet(getSystemDb(), 'SELECT id FROM accounts WHERE username = ?', [username]);
    if (existing) return res.status(400).json({ error: '使用者名稱已存在' });

    const inviteCollision = await usernameCollisionOf(username);
    if (inviteCollision) {
      return res.status(400).json({ error: `使用者名稱與既有帳號「${inviteCollision}」衝突，請改用其他名稱` });
    }

    const passwordHash = await argon2.hash(password);
    const userDbName = `user_${username}.db`;
    const isClient = inv.role_level === 'db_admin' || inv.role_level === 'client_user';
    const isDbAdmin = inv.role_level === 'db_admin';
    const allowedDbs = (() => { try { return JSON.parse(inv.allowed_databases || '[]'); } catch { return []; } })();
    const finalPermLevel = inv.permission_level || 'editor';

    let finalUserDb, finalAllowed;
    if (isClient) {
      // 客戶帳號：使用邀請指定的資料庫，不建立個人資料庫
      if (allowedDbs.length === 0) {
        return res.status(400).json({ error: '邀請未指定可存取的資料庫，請聯繫管理員重新發送邀請' });
      }
      finalUserDb = allowedDbs[0];
      finalAllowed = JSON.stringify(allowedDbs);
    } else {
      // 工程師帳號：viewer 使用 allowed_databases，editor 使用個人資料庫
      finalUserDb = finalPermLevel === 'viewer' ? (allowedDbs[0] || userDbName) : userDbName;
      finalAllowed = finalPermLevel === 'viewer' ? JSON.stringify(allowedDbs) : null;
    }

    await dbRun(getSystemDb(), 'INSERT INTO accounts (username, password_hash, full_name, role, role_level, can_invite, status, user_database, permission_level, allowed_databases, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [username, passwordHash, full_name || null, 'user', inv.role_level || 'user', isDbAdmin ? 1 : 0, 'active', finalUserDb, finalPermLevel, finalAllowed, nowISO()]);

    // 只有工程師 editor 帳號才建立個人資料庫
    if (!isClient && finalPermLevel !== 'viewer') {
      const newDb = await connectDatabase(userDbName);
      newDb.close();
    }

    // 標記邀請已使用
    getSystemDb().run('UPDATE invitations SET used_at = ?, used_by = ? WHERE token = ?', [nowISO(), username, token]);

    console.log(`✓ 透過邀請建立帳號: ${username} (${inv.role_level})`);
    res.json({ success: true, message: '帳號建立成功，請使用您的帳號登入。' });
  } catch (error) {
    console.error('邀請註冊錯誤:', error);
    internalError(res, error);
  }
});

module.exports = router;
