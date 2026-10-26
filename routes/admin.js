/**
 * 管理員 API：帳號、郵件／SSO 設定、邀請、稽核、備份、系統狀態。
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const argon2 = require('argon2');
const { execFile } = require('child_process');
const crypto = require('crypto');
const security = require('../lib/security');
const { DB_DIR } = require('../lib/config');
const { internalError } = require('../lib/http');
const { nowISO, toLocalISO } = require('../lib/time');
const { requireAdmin, requireAuth, requireCanInvite } = require('../middleware/auth');
const { sessionStore } = require('../middleware/session');
const { usernameCollisionOf } = require('../services/accounts');
const { logAudit } = require('../services/audit');
const { ALL_DATABASES_TOKEN, accountAllowsAllDatabases, connectDatabase, getSystemDb, hasAllDatabasesToken, listEngineerAccessibleDatabases, parseAllowedDatabases, sanitizeAllowedDatabases } = require('../services/database');
const { EMAIL_CONFIG_PATH, buildEmailHtml, cancelBatchTimer, flushBatch, getEmailConfig, getEmailTransporter, getPendingChangeCount, hasBatchTimer, loadEmailConfig, sendChangeNotification } = require('../services/email');
const { MSAL_CONFIG_PATH, getMsalClient, getMsalConfig, loadMsalConfig } = require('../services/sso');
const { dbGet, dbRun, dbRunExpectChange } = require('../lib/db');
const ROOT_DIR = path.join(__dirname, '..');

const router = express.Router();

// 計算會話時間（登入到登出或最後活動時間）
function calculateSessionTime(loginTime, logoutTime) {
  if (!loginTime) return 0;
  const logout = logoutTime ? new Date(logoutTime) : new Date();
  const login = new Date(loginTime);
  return Math.max(0, Math.floor((logout - login) / 1000)); // 返回秒數
}

// ==================== 管理員 API ====================

// 取得所有待審核的帳號（管理員專用）
// 舊待審核清單（已停用，改為邀請制，永遠回傳空陣列）
router.get('/api/admin/pending-accounts', requireAdmin, (req, res) => {
  res.json([]);
});

// 取得所有帳號（管理員專用）
router.get('/api/admin/accounts', requireAdmin, (req, res) => {
  getSystemDb().all(
    'SELECT id, username, full_name, role, role_level, can_invite, status, user_database, created_at, permission_level, allowed_databases, ms_email FROM accounts ORDER BY created_at DESC',
    [],
    (err, rows) => {
      if (err) {
        return internalError(res, err);
      }
      const mapped = (rows || []).map(row => ({
        ...row,
        permission_level: row.permission_level || 'editor',
        allowed_databases: parseAllowedDatabases(row.allowed_databases),
        allow_all_databases: accountAllowsAllDatabases(row),   // 工程師「全部資料庫」
        role_level: row.role === 'admin' ? 'admin' : (row.role_level || 'user'),
        can_invite: !!(row.can_invite || row.role === 'admin')
      }));
      res.json(mapped);
    }
  );
});

// 舊審核帳號（已停用）
router.post('/api/admin/review-account', requireAdmin, (req, res) => {
  res.status(410).json({ error: '審核流程已停用，改為邀請制。' });
});

// 更新帳號權限（管理員專用）
router.post('/api/admin/accounts/update-permission', requireAdmin, async (req, res) => {
  const { accountId, permissionLevel, allowedDatabases, roleLevel, canInvite, defaultDatabase, allowAllDatabases } = req.body;
  if (!accountId) {
    return res.status(400).json({ error: '缺少必要參數' });
  }

  try {
    const account = await dbGet(getSystemDb(), 'SELECT id, username, role, role_level, allowed_databases FROM accounts WHERE id = ?', [accountId]);

    if (!account) {
      return res.status(404).json({ error: '帳號不存在' });
    }

    if (account.role === 'admin') {
      return res.status(400).json({ error: '無法修改管理員帳號的權限' });
    }

    let finalPermissionLevel = permissionLevel === 'viewer' ? 'viewer' : 'editor';

    // role_level：只允許設定為 'db_admin'、'client_user'、'engineer' 或 'user'（admin 不可透過此 API 降級）
    const validRoleLevels = ['db_admin', 'client_user', 'engineer', 'user'];
    const finalRoleLevel = validRoleLevels.includes(roleLevel) ? roleLevel : null;
    const isClientRole = finalRoleLevel === 'db_admin' || finalRoleLevel === 'client_user';
    const isEngineer = finalRoleLevel === 'engineer';

    // db_admin 預設 can_invite=1；client_user 強制 0；engineer 依傳入值；user 依傳入值
    const finalCanInvite = finalRoleLevel === 'db_admin' ? 1 : (finalRoleLevel === 'client_user' ? 0 : (canInvite ? 1 : 0));

    // 「全部資料庫（含未來新增）」只有工程師角色可以設定，而且只有管理員能設（此 API 本身就是管理員專用）
    const wantsAll = allowAllDatabases === true;
    if (wantsAll && !isEngineer) {
      return res.status(400).json({ error: '只有「工程師」角色可以設定為可存取全部資料庫' });
    }

    let sanitized = [];
    let serialized = null;
    if (wantsAll) {
      sanitized = listEngineerAccessibleDatabases();   // 只用來決定預設資料庫；實際存取每次即時計算
      if (sanitized.length === 0) {
        return res.status(400).json({ error: '目前沒有可存取的資料庫' });
      }
      serialized = JSON.stringify([ALL_DATABASES_TOKEN]);
    } else if (finalPermissionLevel === 'viewer' || isClientRole || isEngineer) {
      sanitized = sanitizeAllowedDatabases(Array.isArray(allowedDatabases) ? allowedDatabases : []);
      if (sanitized.length === 0) {
        return res.status(400).json({ error: '請至少選擇一個可存取的資料庫' });
      }
      serialized = JSON.stringify(sanitized);
    }

    const updates = ['permission_level = ?', 'allowed_databases = ?'];
    const params = [finalPermissionLevel, serialized];
    // 所有有 allowed_databases 的帳號（viewer / client / engineer）都更新 user_database
    // 優先使用傳入的 defaultDatabase（需在 sanitized 清單內），否則退回第一個
    if (sanitized.length > 0) {
      updates.push('user_database = ?');
      const validDefault = (defaultDatabase && sanitized.includes(defaultDatabase))
        ? defaultDatabase
        : sanitized[0];
      params.push(validDefault);
    }
    if (finalRoleLevel !== null) {
      updates.push('role_level = ?');
      params.push(finalRoleLevel);
    }
    updates.push('can_invite = ?');
    params.push(finalCanInvite);
    params.push(accountId);

    await dbRunExpectChange(getSystemDb(), `UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`, params, '更新失敗');

    // 稽核：誰把誰的權限改成什麼（尤其是「全部資料庫」）
    logAudit(req, 'update', 'account_permission', account.id, account.username,
      { roleLevel: account.role_level || 'user', allDatabases: hasAllDatabasesToken(account.allowed_databases), databases: parseAllowedDatabases(account.allowed_databases).length },
      { roleLevel: finalRoleLevel, permissionLevel: finalPermissionLevel, allDatabases: wantsAll, databases: wantsAll ? null : sanitized.length });

    // 角色／權限／可存取資料庫都快取在 session 內，變更後讓該帳號的既有登入失效，強制以新權限重新登入
    sessionStore.destroyByUserId(account.id, req.sessionID);
    res.json({ success: true, message: '帳號權限已更新', permissionLevel: finalPermissionLevel, allowedDatabases: wantsAll ? [] : sanitized, allowAllDatabases: wantsAll, roleLevel: finalRoleLevel, canInvite: !!finalCanInvite });
  } catch (error) {
    console.error('更新帳號權限失敗:', error);
    internalError(res, error);
  }
});

// 升降管理員身份（管理員專用）
router.post('/api/admin/accounts/set-admin-role', requireAdmin, async (req, res) => {
  const { accountId, makeAdmin } = req.body;
  if (!accountId || makeAdmin === undefined) {
    return res.status(400).json({ error: '缺少必要參數' });
  }
  if (accountId === req.session.userId) {
    return res.status(400).json({ error: '不能變更自己的管理員身份' });
  }

  try {
    const account = await dbGet(getSystemDb(), 'SELECT id, username, role FROM accounts WHERE id = ?', [accountId]);
    if (!account) return res.status(404).json({ error: '帳號不存在' });

    // 降級時，確保還有其他管理員
    if (!makeAdmin) {
      const adminCount = (await dbGet(getSystemDb(), "SELECT COUNT(*) as cnt FROM accounts WHERE role = 'admin'", [])).cnt;
      if (adminCount <= 1) {
        return res.status(400).json({ error: '系統中至少需要保留一位管理員，無法降級最後一位管理員' });
      }
    }

    const newRole = makeAdmin ? 'admin' : 'user';
    await dbRunExpectChange(getSystemDb(), 'UPDATE accounts SET role = ? WHERE id = ?', [newRole, accountId], '更新失敗');

    console.log(`✓ ${makeAdmin ? '升級' : '降級'} 管理員: ${account.username}`);
    sessionStore.destroyByUserId(account.id, req.sessionID);
    res.json({ success: true, message: `${account.username} 已${makeAdmin ? '升為系統管理員' : '取消管理員身份'}` });
  } catch (err) {
    console.error('set-admin-role 失敗:', err);
    internalError(res, err);
  }
});

// ==================== 郵件設定 API ====================

// 取得郵件設定（遮蔽密碼）
router.get('/api/admin/email-config', requireAdmin, (req, res) => {
  const cfg = { ...getEmailConfig() };
  if (cfg.smtp && cfg.smtp.auth) {
    cfg.smtp = { ...cfg.smtp, auth: { ...cfg.smtp.auth, pass: cfg.smtp.auth.pass ? SECRET_MASK : '' } };
  }
  res.json(cfg);
});

// 只接受已知欄位並檢查型別，避免把任意 request body 寫進設定檔
const SECRET_MASK = '••••••••';

function sanitizeEmailConfig(body, current) {
  const out = { ...current };
  const str = (v, max = 255) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  if (typeof body.enabled === 'boolean') out.enabled = body.enabled;
  if (body.from !== undefined) out.from = str(body.from);
  if (body.subjectPrefix !== undefined) out.subjectPrefix = str(body.subjectPrefix, 100);
  if (body.batchMinutes !== undefined) {
    const n = parseInt(body.batchMinutes, 10);
    if (Number.isFinite(n)) out.batchMinutes = Math.min(Math.max(n, 1), 1440);
  }
  if (body.to !== undefined) {
    const list = Array.isArray(body.to) ? body.to : String(body.to).split(/[,;\s]+/);
    out.to = list.map(v => str(v)).filter(Boolean).slice(0, 50);
  }
  if (body.notifyEvents && typeof body.notifyEvents === 'object') {
    out.notifyEvents = { ...(current.notifyEvents || {}) };
    for (const [k, v] of Object.entries(body.notifyEvents)) {
      if (typeof v === 'boolean' && /^[a-z_]{1,40}$/.test(k)) out.notifyEvents[k] = v;
    }
  }
  if (body.smtp && typeof body.smtp === 'object') {
    const cur = current.smtp || {};
    const smtp = { ...cur };
    if (body.smtp.host !== undefined) smtp.host = str(body.smtp.host);
    if (body.smtp.port !== undefined) {
      const port = parseInt(body.smtp.port, 10);
      if (Number.isInteger(port) && port > 0 && port < 65536) smtp.port = port;
    }
    if (typeof body.smtp.secure === 'boolean') smtp.secure = body.smtp.secure;
    if (typeof body.smtp.ignoreTLS === 'boolean') smtp.ignoreTLS = body.smtp.ignoreTLS;
    if (['tls', 'starttls', 'none'].includes(body.smtp.encryption)) smtp.encryption = body.smtp.encryption;
    if (body.smtp.auth && typeof body.smtp.auth === 'object') {
      const curAuth = cur.auth || {};
      const auth = { ...curAuth };
      if (body.smtp.auth.user !== undefined) auth.user = str(body.smtp.auth.user);
      const newPass = body.smtp.auth.pass;
      if (typeof newPass === 'string' && newPass !== '' && newPass !== SECRET_MASK) auth.pass = newPass.slice(0, 512);
      smtp.auth = auth;
    }
    out.smtp = smtp;
  }
  return out;
}

function writeSecretConfig(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (e) { /* 非 POSIX 檔案系統 */ }
}

// 更新郵件設定
router.post('/api/admin/email-config', requireAdmin, async (req, res) => {
  try {
    const newConfig = sanitizeEmailConfig(req.body || {}, getEmailConfig());
    writeSecretConfig(EMAIL_CONFIG_PATH, newConfig);
    loadEmailConfig();
    logAudit(req, 'update', 'config', null, 'email_config', null, { enabled: !!newConfig.enabled });
    res.json({ success: true, message: '郵件設定已儲存並重新載入' });
  } catch (err) {
    console.error('儲存郵件設定失敗:', err);
    res.status(500).json({ error: '儲存郵件設定失敗' });
  }
});

// 取得待發彙整數量，並可立即觸發發送
router.get('/api/admin/email-pending', requireAdmin, (req, res) => {
  res.json({ pending: getPendingChangeCount(), timerActive: hasBatchTimer(), batchMinutes: getEmailConfig().batchMinutes || 15 });
});

router.post('/api/admin/email-flush', requireAdmin, async (req, res) => {
  cancelBatchTimer();
  const count = getPendingChangeCount();
  if (count === 0) return res.json({ success: true, message: '目前沒有待發的通知' });
  try {
    const result = await flushBatch();
    res.json({ success: true, message: `已發送 ${result.count} 筆通知`, to: result.to, subject: result.subject, messageId: result.messageId, smtpResponse: result.response });
  } catch (err) {
    console.error('email-flush 失敗:', err.message);
    res.status(500).json({ error: `發送失敗：${err.message}` });
  }
});

// SMTP 連線診斷
router.get('/api/admin/email-diagnose', requireAdmin, async (req, res) => {
  const enc = getEmailConfig().smtp?.encryption || 'starttls';
  const diag = {
    configLoaded: !!getEmailConfig(),
    enabled: !!getEmailConfig().enabled,
    transporterCreated: !!getEmailTransporter(),
    smtpHost: getEmailConfig().smtp?.host || null,
    smtpPort: getEmailConfig().smtp?.port || null,
    encryption: enc,
    hasAuth: enc === 'none' ? null : !!(getEmailConfig().smtp?.auth?.user && getEmailConfig().smtp?.auth?.pass),
    to: getEmailConfig().to || null,
    verifyResult: null,
    verifyError: null
  };

  if (!getEmailTransporter()) {
    diag.verifyError = '尚未建立 transporter（請確認 enabled:true 且設定正確）';
    return res.json(diag);
  }

  try {
    await getEmailTransporter().verify();
    diag.verifyResult = 'OK — SMTP 連線成功';
  } catch (err) {
    diag.verifyError = err.message;
  }

  res.json(diag);
});

// 發送測試郵件（直接丟出錯誤，不吞例外）
router.post('/api/admin/email-test', requireAdmin, async (req, res) => {
  if (!getEmailConfig().enabled || !getEmailTransporter()) {
    return res.status(400).json({ error: '郵件通知未啟用或設定不完整，請先確認設定並儲存' });
  }

  // 先驗證 SMTP 連線
  try {
    await getEmailTransporter().verify();
  } catch (err) {
    return res.status(502).json({ error: `SMTP 連線失敗：${err.message}` });
  }

  // 發送測試信（即時，不走彙整計時器）
  try {
    const prefix = getEmailConfig().subjectPrefix || '[DMS]';
    const toList = Array.isArray(getEmailConfig().to) ? getEmailConfig().to.join(', ') : (getEmailConfig().to || '');
    const batchMinutes = getEmailConfig().batchMinutes || 15;
    const html = buildEmailHtml({
      actionType: 'create',
      resourceType: 'folder',
      resourceName: '測試資料夾（Test）',
      dbName: req.session.userDatabase || 'system.db',
      username: req.session.username,
      fullName: req.session.fullName || null,
      oldValue: null,
      newValue: { name: '測試資料夾（Test）', path: '/測試資料夾' },
      extra: { '彙整時間窗口': `${batchMinutes} 分鐘` }
    });
    await getEmailTransporter().sendMail({
      from: getEmailConfig().from,
      to: toList,
      subject: `${prefix} 系統測試信件`,
      html
    });
    res.json({ success: true, message: `測試信件已成功發送至 ${toList}` });
  } catch (err) {
    res.status(500).json({ error: `寄信失敗：${err.message}` });
  }
});

// ==================== 邀請連結 API ====================

// 建立邀請連結
router.post('/api/admin/invitations', requireCanInvite, async (req, res) => {
  const { roleLevel, permissionLevel, allowedDatabases, note, expiryDays } = req.body;
  const isAdmin = req.session.role === 'admin';
  const senderAllowed = req.session.allowedDatabases || [];
  const senderRoleLevel = req.session.roleLevel || 'user';

  // 允許的 role_level：
  //   db_admin → 只能邀請 client_user（自己客戶公司的使用者）
  //   admin 或 can_invite 工程師 → 可邀請 db_admin、user、client_user
  const isDbAdmin = senderRoleLevel === 'db_admin';
  const validRoleLevels = isDbAdmin ? ['client_user'] : ['db_admin', 'user', 'client_user'];
  const finalRoleLevel = validRoleLevels.includes(roleLevel) ? roleLevel : validRoleLevels[0];
  const finalPermLevel = permissionLevel === 'viewer' ? 'viewer' : 'editor';

  // 資料庫範圍：
  //   admin 或 can_invite 工程師 → 可邀請至任何資料庫
  //   db_admin → 只能邀請至自身有存取權的資料庫
  // 邀請只能指定具體的資料庫名稱；「全部」標記不接受（只有管理員能在帳號權限設定）
  let finalDbs = (Array.isArray(allowedDatabases) ? allowedDatabases : []).filter(d => typeof d === 'string' && d !== ALL_DATABASES_TOKEN && d.endsWith('.db'));
  if (isDbAdmin) {
    const ownDbs = senderAllowed.length > 0 ? senderAllowed : (req.session.userDatabase ? [req.session.userDatabase] : []);
    finalDbs = finalDbs.filter(d => ownDbs.includes(d));
  }
  if (finalDbs.length === 0) {
    return res.status(400).json({ error: '請選擇至少一個資料庫' });
  }

  const days = parseInt(expiryDays) || 7;
  const expiresAt = toLocalISO(new Date(Date.now() + days * 86400000));
  const token = crypto.randomUUID();

  try {
    await dbRun(getSystemDb(), 'INSERT INTO invitations (token, created_by, expires_at, role_level, permission_level, allowed_databases, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [token, req.session.username, expiresAt, finalRoleLevel, finalPermLevel, JSON.stringify(finalDbs), note || null, nowISO()]);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const inviteLink = `${baseUrl}/login.html?token=${token}`;

    const roleLabelMap = { admin: '最高管理者', db_admin: '客戶負責人', client_user: '客戶使用者', user: '工程師帳號' };
    sendChangeNotification({
      actionType: 'invite',
      resourceType: 'invite',
      resourceName: note || `邀請至 ${finalDbs.join('、')}`,
      dbName: null,
      username: req.session.username,
      fullName: req.session.fullName || null,
      oldValue: null,
      newValue: null,
      extra: {
        '邀請角色': roleLabelMap[finalRoleLevel] || finalRoleLevel,
        '存取資料庫': finalDbs.join('、'),
        '到期時間': new Date(expiresAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
        '備注': note || '—',
        '邀請連結': inviteLink
      }
    });

    res.json({ success: true, token, link: inviteLink, expiresAt });
  } catch (error) {
    internalError(res, error);
  }
});

// 取得邀請清單
router.get('/api/admin/invitations', requireCanInvite, (req, res) => {
  const isAdmin = req.session.role === 'admin';
  const query = isAdmin
    ? 'SELECT * FROM invitations ORDER BY created_at DESC'
    : 'SELECT * FROM invitations WHERE created_by = ? ORDER BY created_at DESC';
  const params = isAdmin ? [] : [req.session.username];
  getSystemDb().all(query, params, (err, rows) => {
    if (err) return internalError(res, err);
    res.json((rows || []).map(r => ({
      ...r,
      allowed_databases: (() => { try { return JSON.parse(r.allowed_databases || '[]'); } catch { return []; } })(),
      status: r.used_at ? 'used' : (new Date(r.expires_at) < new Date() ? 'expired' : 'active')
    })));
  });
});

// 撤銷邀請
router.delete('/api/admin/invitations/:id', requireCanInvite, async (req, res) => {
  const isAdmin = req.session.role === 'admin';
  const id = parseInt(req.params.id);
  try {
    const inv = await dbGet(getSystemDb(), 'SELECT * FROM invitations WHERE id = ?', [id]);
    if (!inv) return res.status(404).json({ error: '邀請不存在' });
    if (!isAdmin && inv.created_by !== req.session.username) return res.status(403).json({ error: '只能撤銷自己建立的邀請' });
    if (inv.used_at) return res.status(400).json({ error: '此邀請已被使用，無法撤銷' });
    await dbRun(getSystemDb(), 'DELETE FROM invitations WHERE id = ?', [id]);
    res.json({ success: true, message: '邀請已撤銷' });
  } catch (error) {
    internalError(res, error);
  }
});

// 取得同資料庫範圍的帳號（db_admin 用）
router.get('/api/my-team-accounts', requireAuth, (req, res) => {
  const myDb = req.session.userDatabase;
  const myAllowed = req.session.allowedDatabases || [];
  const scope = myAllowed.length > 0 ? myAllowed : (myDb ? [myDb] : []);
  if (scope.length === 0) return res.json([]);

  getSystemDb().all(
    'SELECT id, username, full_name, role_level, permission_level, allowed_databases, user_database, status, created_at FROM accounts WHERE status = ? AND role != ?',
    ['active', 'admin'],
    (err, rows) => {
      if (err) return internalError(res, err);
      const result = (rows || []).filter(r => {
        const dbs = (() => {
          try { return JSON.parse(r.allowed_databases || '[]'); } catch { return []; }
        })();
        const rDbs = dbs.length > 0 ? dbs : (r.user_database ? [r.user_database] : []);
        // 「全部資料庫」的工程師對每個資料庫都有存取權（標記只對工程師角色有效）
        if (r.role_level === 'engineer' && rDbs.includes(ALL_DATABASES_TOKEN)) return true;
        return scope.some(d => rDbs.includes(d)) || scope.includes(r.user_database);
      }).map(r => ({
        id: r.id,
        username: r.username,
        full_name: r.full_name,
        role_level: r.role_level || 'user',
        permission_level: r.permission_level || 'editor',
        status: r.status,
        created_at: r.created_at
      }));
      res.json(result);
    }
  );
});

// ==================== 帳號密碼管理 ====================

// 重設使用者密碼（管理員專用）
router.post('/api/admin/accounts/reset-password', requireAdmin, async (req, res) => {
  const { accountId, newPassword } = req.body;
  
  if (!accountId || !newPassword) {
    return res.status(400).json({ error: '缺少必要參數' });
  }
  
  if (typeof newPassword !== 'string') {
    return res.status(400).json({ error: '新密碼格式不正確' });
  }
  
  try {
    const account = await dbGet(getSystemDb(), 'SELECT id, username, role FROM accounts WHERE id = ?', [accountId]);
    
    if (!account) {
      return res.status(404).json({ error: '帳號不存在' });
    }
    
    if (account.role === 'admin') {
      return res.status(400).json({ error: '無法透過此功能修改管理員帳號密碼' });
    }

    const resetPwError = security.validatePassword(newPassword, account.username);
    if (resetPwError) {
      return res.status(400).json({ error: resetPwError });
    }
    
    const passwordHash = await argon2.hash(newPassword);
    
    // 重設後的密碼視為臨時密碼：使用者下次登入必須自行修改，且既有登入全部失效
    await dbRunExpectChange(getSystemDb(), 'UPDATE accounts SET password_hash = ?, must_change_password = 1 WHERE id = ?', [passwordHash, accountId], '更新失敗');
    sessionStore.destroyByUserId(account.id, null);
    logAudit(req, 'update', 'account', account.id, account.username, null, { event: 'admin_reset_password' });
    
    res.json({ success: true, message: `已更新 ${account.username} 的密碼` });
  } catch (error) {
    console.error('重設密碼失敗:', error);
    internalError(res, error);
  }
});

// ==================== M365 SSO 管理 API ====================

// 取得 SSO 設定（遮蔽 clientSecret）
router.get('/api/admin/sso-config', requireAdmin, (req, res) => {
  const cfg = { ...getMsalConfig() };
  if (cfg.clientSecret) cfg.clientSecret = SECRET_MASK;
  res.json(cfg);
});

// 儲存 SSO 設定（僅接受已知欄位）
router.post('/api/admin/sso-config', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const newConfig = { ...getMsalConfig() };
    const str = (v, max = 512) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    if (typeof body.enabled === 'boolean') newConfig.enabled = body.enabled;
    if (body.clientId !== undefined) newConfig.clientId = str(body.clientId);
    if (body.tenantId !== undefined) newConfig.tenantId = str(body.tenantId);
    if (body.redirectUri !== undefined) {
      const uri = str(body.redirectUri);
      let ok = false;
      try {
        const u = new URL(uri);
        ok = u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
      } catch (e) { ok = false; }
      if (uri && !ok) return res.status(400).json({ error: 'redirectUri 必須是 https 網址' });
      newConfig.redirectUri = uri;
    }
    if (typeof body.clientSecret === 'string' && body.clientSecret !== '' && body.clientSecret !== SECRET_MASK) {
      newConfig.clientSecret = body.clientSecret.slice(0, 512);
    } else {
      newConfig.clientSecret = getMsalConfig().clientSecret || '';
    }
    writeSecretConfig(MSAL_CONFIG_PATH, newConfig);
    loadMsalConfig();
    logAudit(req, 'update', 'config', null, 'msal_config', null, { enabled: !!newConfig.enabled });
    res.json({ success: true, message: 'SSO 設定已儲存並重新載入', enabled: !!(getMsalConfig().enabled && getMsalClient()) });
  } catch (err) {
    console.error('儲存 SSO 設定失敗:', err);
    res.status(500).json({ error: '儲存 SSO 設定失敗' });
  }
});

// 設定帳號的 M365 Email（用於 SSO 綁定）
router.post('/api/admin/accounts/set-ms-email', requireAdmin, async (req, res) => {
  const { accountId, ms_email } = req.body;
  if (!accountId) return res.status(400).json({ error: '缺少 accountId' });

  const emailVal = (ms_email || '').trim().toLowerCase() || null;

  try {
    if (emailVal) {
      const conflict = await dbGet(getSystemDb(), 'SELECT id, username FROM accounts WHERE LOWER(ms_email) = ? AND id != ?', [emailVal, accountId]);
      if (conflict) {
        return res.status(400).json({ error: `此 M365 Email 已綁定至帳號 ${conflict.username}` });
      }
    }

    await dbRunExpectChange(getSystemDb(), 'UPDATE accounts SET ms_email = ? WHERE id = ?', [emailVal, accountId], '帳號不存在');

    res.json({ success: true, message: emailVal ? `已綁定 M365 Email: ${emailVal}` : '已清除 M365 Email 綁定' });
  } catch (err) {
    console.error('set-ms-email 失敗:', err);
    internalError(res, err);
  }
});

// 管理員廣播訊息
router.post('/api/admin/broadcast', requireAdmin, (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: '請提供訊息內容' });
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return res.status(400).json({ error: '訊息內容不得為空' });
  }

  if (trimmed.length > 500) {
    return res.status(400).json({ error: '訊息長度不得超過 500 字元' });
  }

  const createdAt = nowISO();
  const createdBy = req.session.userId;
  const createdByName = req.session.fullName || req.session.username || '系統';

  getSystemDb().run(
    'INSERT INTO broadcast_messages (message, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?)',
    [trimmed, createdBy, createdByName, createdAt],
    function(err) {
      if (err) {
        console.error('Failed to insert broadcast message:', err);
        return res.status(500).json({ error: '無法送出訊息' });
      }

      console.log(`✓ Broadcast message sent by ${createdByName}`);
      res.json({
        success: true,
        broadcast: {
          id: this.lastID,
          message: trimmed,
          createdAt,
          createdByName
        }
      });
    }
  );
});

// 取得審計日誌（管理員專用）
router.get('/api/admin/audit-log', requireAdmin, (req, res) => {
  const { username, actionType, resourceType, startDate, endDate, limit = 100, offset = 0 } = req.query;
  
  let sql = `
    SELECT 
      al.id,
      al.account_id,
      al.username,
      al.full_name,
      al.action_type,
      al.resource_type,
      al.resource_id,
      al.resource_name,
      al.old_value,
      al.new_value,
      al.user_database,
      al.ip_address,
      al.user_agent,
      al.created_at
    FROM audit_log al
    WHERE 1=1
  `;
  const params = [];
  
  if (username) {
    sql += ' AND al.username LIKE ?';
    params.push(`%${username}%`);
  }
  
  if (actionType) {
    sql += ' AND al.action_type = ?';
    params.push(actionType);
  }
  
  if (resourceType) {
    sql += ' AND al.resource_type = ?';
    params.push(resourceType);
  }
  
  if (startDate) {
    sql += ' AND DATE(al.created_at) >= ?';
    params.push(startDate);
  }
  
  if (endDate) {
    sql += ' AND DATE(al.created_at) <= ?';
    params.push(endDate);
  }
  
  sql += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  
  getSystemDb().all(sql, params, (err, rows) => {
    if (err) {
      console.error('Failed to fetch audit log:', err);
      return res.status(500).json({ error: '無法取得審計日誌' });
    }
    
    // 取得總數
    let countSql = 'SELECT COUNT(*) as total FROM audit_log WHERE 1=1';
    const countParams = [];
    
    if (username) {
      countSql += ' AND username LIKE ?';
      countParams.push(`%${username}%`);
    }
    if (actionType) {
      countSql += ' AND action_type = ?';
      countParams.push(actionType);
    }
    if (resourceType) {
      countSql += ' AND resource_type = ?';
      countParams.push(resourceType);
    }
    if (startDate) {
      countSql += ' AND DATE(created_at) >= ?';
      countParams.push(startDate);
    }
    if (endDate) {
      countSql += ' AND DATE(created_at) <= ?';
      countParams.push(endDate);
    }
    
    getSystemDb().get(countSql, countParams, (err2, countRow) => {
      if (err2) {
        console.error('Failed to count audit log:', err2);
        return res.status(500).json({ error: '無法取得總數' });
      }
      
      res.json({
        logs: rows || [],
        total: countRow?.total || 0,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    });
  });
});

// 取得使用時間統計（管理員專用）
router.get('/api/admin/usage-statistics', requireAdmin, (req, res) => {
  const { username, startDate, endDate, limit = 100, offset = 0 } = req.query;
  
  let sql = `
    SELECT 
      us.id,
      us.account_id,
      us.username,
      us.full_name,
      us.date,
      us.login_count,
      us.total_session_time,
      us.last_login,
      us.last_logout,
      us.created_at,
      us.updated_at
    FROM usage_statistics us
    WHERE 1=1
  `;
  const params = [];
  
  if (username) {
    sql += ' AND us.username LIKE ?';
    params.push(`%${username}%`);
  }
  
  if (startDate) {
    sql += ' AND us.date >= ?';
    params.push(startDate);
  }
  
  if (endDate) {
    sql += ' AND us.date <= ?';
    params.push(endDate);
  }
  
  sql += ' ORDER BY us.date DESC, us.username ASC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  
  getSystemDb().all(sql, params, (err, rows) => {
    if (err) {
      console.error('Failed to fetch usage statistics:', err);
      return res.status(500).json({ error: '無法取得使用時間統計' });
    }
    
    // 計算會話時間（如果沒有記錄，從 active_sessions 計算）
    const enrichedRows = (rows || []).map(row => {
      let sessionTime = row.total_session_time || 0;
      
      // 如果有登入和登出時間，計算會話時間
      if (row.last_login && row.last_logout) {
        sessionTime = calculateSessionTime(row.last_login, row.last_logout);
      } else if (row.last_login) {
        // 如果只有登入時間，計算到現在的時間
        sessionTime = calculateSessionTime(row.last_login, null);
      }
      
      return {
        ...row,
        total_session_time: sessionTime,
        formatted_session_time: formatTime(sessionTime)
      };
    });
    
    // 取得總數
    let countSql = 'SELECT COUNT(*) as total FROM usage_statistics WHERE 1=1';
    const countParams = [];
    
    if (username) {
      countSql += ' AND username LIKE ?';
      countParams.push(`%${username}%`);
    }
    if (startDate) {
      countSql += ' AND date >= ?';
      countParams.push(startDate);
    }
    if (endDate) {
      countSql += ' AND date <= ?';
      countParams.push(endDate);
    }
    
    getSystemDb().get(countSql, countParams, (err2, countRow) => {
      if (err2) {
        console.error('Failed to count usage statistics:', err2);
        return res.status(500).json({ error: '無法取得總數' });
      }
      
      res.json({
        statistics: enrichedRows,
        total: countRow?.total || 0,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    });
  });
});

// 格式化時間（秒數轉為可讀格式）
function formatTime(seconds) {
  if (!seconds || seconds < 0) return '0 秒';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  const parts = [];
  if (hours > 0) parts.push(`${hours} 小時`);
  if (minutes > 0) parts.push(`${minutes} 分鐘`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs} 秒`);
  
  return parts.join(' ');
}

// 取得最新廣播訊息
router.get('/api/notifications', requireAuth, (req, res) => {
  const sinceParam = req.query.since ? parseInt(req.query.since, 10) : null;
  const hasSince = Number.isFinite(sinceParam) && sinceParam > 0;
  const sinceIso = hasSince ? toLocalISO(new Date(sinceParam)) : null;

  let sql = 'SELECT id, message, created_by_name, created_at FROM broadcast_messages';
  const params = [];

  if (sinceIso) {
    sql += ' WHERE created_at > ?';
    params.push(sinceIso);
  }

  sql += ' ORDER BY created_at ASC LIMIT 50';

  getSystemDb().all(sql, params, (err, rows) => {
    if (err) {
      console.error('Failed to fetch notifications:', err);
      return res.status(500).json({ error: '無法取得訊息' });
    }

    let lastTimestamp = hasSince ? sinceParam : 0;
    const messages = (rows || []).map(row => {
      let ts = Date.parse(row.created_at);
      if (!Number.isFinite(ts)) {
        ts = Date.parse(`${row.created_at}Z`);
      }
      if (!Number.isFinite(ts)) {
        ts = Date.now();
      }
      if (ts > lastTimestamp) lastTimestamp = ts;
      return {
        id: row.id,
        message: row.message,
        createdByName: row.created_by_name || '系統',
        createdAt: row.created_at,
        timestamp: ts
      };
    });

    res.json({
      messages,
      lastTimestamp,
      serverTime: Date.now()
    });
  });
});

// 刪除帳號（管理員專用）
router.delete('/api/admin/accounts/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  
  try {
    // 不能刪除自己的帳號
    if (parseInt(id) === req.session.userId) {
      return res.status(400).json({ error: '不能刪除自己的帳號' });
    }
    
    // 取得帳號資訊
    const account = await dbGet(getSystemDb(), 'SELECT user_database FROM accounts WHERE id = ?', [id]);
    
    if (!account) {
      return res.status(404).json({ error: '帳號不存在' });
    }
    
    // 刪除帳號（資料庫檔案不動，由管理員在資料庫管理中獨立處理）
    await dbRun(getSystemDb(), 'DELETE FROM accounts WHERE id = ?', [id]);

    console.log(`✓ 帳號已刪除: ID ${id}（資料庫檔案保留）`);
    sessionStore.destroyByUserId(parseInt(id, 10), null);
    res.json({ success: true, message: '帳號已刪除' });
  } catch (error) {
    console.error('刪除帳號失敗:', error);
    internalError(res, error);
  }
});

// 獲取在線用戶列表（僅管理員）
router.get('/api/online-users', requireAdmin, (req, res) => {
  console.log('Hit GET /api/online-users');
  
  // 清理超過 30 分鐘沒有活動的會話（從系統資料庫）
  getSystemDb().run(`DELETE FROM active_sessions 
          WHERE datetime(last_active) < datetime('now', '-30 minutes')`,
    (err) => {
      if (err) console.error('清理過期會話錯誤:', err);
    }
  );
  
  // 從系統資料庫獲取所有用戶的活動會話（15 分鐘內有活動視為在線）
  getSystemDb().all(
    `SELECT 
      id,
      account_id,
      username,
      full_name,
      user_database,
      login_time,
      last_active,
      ip_address,
      user_agent,
      CAST((julianday('now') - julianday(last_active)) * 24 * 60 AS INTEGER) as idle_minutes
    FROM active_sessions 
    WHERE datetime(last_active) > datetime('now', '-15 minutes')
    ORDER BY last_active DESC`,
    (err, rows) => {
      if (err) {
        console.error('獲取在線用戶錯誤:', err);
        return internalError(res, err);
      }
      
      res.json({
        online_count: rows ? rows.length : 0,
        users: rows || []
      });
    }
  );
});

console.log('Registered /api/online-users');

// 獲取系統健康狀態（僅管理員）
router.get('/api/system/health', requireAdmin, (req, res) => {
  console.log('Hit GET /api/system/health');
  
  try {
    const health = {
      timestamp: nowISO(),
      services: {},
      databases: {},
      backups: {},
      system: {}
    };
    
    // 1. 檢查資料庫服務狀態
    try {
      getSystemDb().get('SELECT COUNT(*) as count FROM accounts', [], (err, row) => {
        if (err) throw err;
        health.services.database = {
          status: 'healthy',
          accounts: row.count
        };
        
        // 2. 檢查資料庫目錄
        const dbFiles = fs.readdirSync(DB_DIR).filter(f => f.endsWith('.db'));
        let totalSize = 0;
        dbFiles.forEach(file => {
          const filePath = path.join(DB_DIR, file);
          const stats = fs.statSync(filePath);
          totalSize += stats.size;
        });
        
        health.databases = {
          count: dbFiles.length,
          totalSize: totalSize,
          totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
          directory: DB_DIR,
          status: 'healthy'
        };
        
        // 3. 檢查備份資訊
        const BACKUP_ROOT = '/opt/backups';
        const backupInfo = {
          directory: BACKUP_ROOT,
          exists: fs.existsSync(BACKUP_ROOT),
          backups: [],
          totalSize: 0,
          status: 'unknown'
        };
        
        if (backupInfo.exists) {
          try {
            const backupFiles = fs.readdirSync(BACKUP_ROOT)
              .filter(f => f.endsWith('.tar.gz') && f.startsWith('auto_'))
              .map(f => {
                const filePath = path.join(BACKUP_ROOT, f);
                const stats = fs.statSync(filePath);
                return {
                  name: f,
                  size: stats.size,
                  sizeMB: (stats.size / 1024 / 1024).toFixed(2),
                  created: stats.birthtime,
                  modified: stats.mtime
                };
              })
              .sort((a, b) => b.modified - a.modified);
            
            backupInfo.backups = backupFiles;
            backupInfo.totalSize = backupFiles.reduce((sum, f) => sum + f.size, 0);
            backupInfo.totalSizeMB = (backupInfo.totalSize / 1024 / 1024).toFixed(2);
            backupInfo.status = backupFiles.length > 0 ? 'healthy' : 'no_backups';
            backupInfo.latestBackup = backupFiles[0] || null;
          } catch (err) {
            backupInfo.status = 'error';
            backupInfo.error = err.message;
          }
        } else {
          backupInfo.status = 'not_configured';
        }
        
        health.backups = backupInfo;
        
        // 4. 檢查在線用戶數
        getSystemDb().get('SELECT COUNT(*) as count FROM active_sessions WHERE datetime(last_active) > datetime("now", "-15 minutes")', [], (err, row) => {
          if (err) {
            health.services.onlineUsers = { status: 'error', error: err.message };
          } else {
            health.services.onlineUsers = {
              status: 'healthy',
              count: row.count
            };
          }
          
          // 5. 檢查系統資源（磁碟空間）
          try {
            const os = require('os');
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;
            
            health.system = {
              platform: os.platform(),
              arch: os.arch(),
              nodeVersion: process.version,
              uptime: process.uptime(),
              uptimeHours: (process.uptime() / 3600).toFixed(2),
              memory: {
                total: totalMem,
                totalMB: (totalMem / 1024 / 1024).toFixed(2),
                free: freeMem,
                freeMB: (freeMem / 1024 / 1024).toFixed(2),
                used: usedMem,
                usedMB: (usedMem / 1024 / 1024).toFixed(2),
                usagePercent: ((usedMem / totalMem) * 100).toFixed(2)
              }
            };
            
            // 檢查資料庫目錄的磁碟空間
            try {
              const { execFileSync } = require('child_process');
              const dfOutput = execFileSync('df', ['-h', DB_DIR], { encoding: 'utf8' });
              const lines = dfOutput.trim().split('\n');
              if (lines.length > 1) {
                const parts = lines[1].split(/\s+/);
                health.system.disk = {
                  filesystem: parts[0],
                  size: parts[1],
                  used: parts[2],
                  available: parts[3],
                  usePercent: parts[4],
                  mounted: parts[5]
                };
              }
            } catch (err) {
              health.system.disk = { error: '無法取得磁碟資訊' };
            }
          } catch (err) {
            health.system = { error: err.message };
          }
          
          // 6. 檢查應用程式狀態
          health.services.application = {
            status: 'running',
            port: req.app.get('port'),
            uptime: process.uptime(),
            uptimeHours: (process.uptime() / 3600).toFixed(2)
          };
          
          res.json(health);
        });
      });
    } catch (err) {
      console.error('Health check error:', err);
      internalError(res, err);
    }
  } catch (err) {
    console.error('Health check error:', err);
    internalError(res, err);
  }
});

console.log('Registered /api/system/health');

// 手動執行備份（管理員專用）
router.post('/api/admin/backup/run', requireAdmin, async (req, res) => {
  console.log('Hit POST /api/admin/backup/run');
  
  // 動態偵測備份腳本位置
  const possiblePaths = [
    path.join(ROOT_DIR, 'backup_databases.sh'),  // 應用程式目錄
    '/opt/folder-permission-system/backup_databases.sh',  // 預設路徑
    '/root/folder-dev-ins/backup_databases.sh',  // 可能的開發路徑
    path.join(ROOT_DIR, '..', 'backup_databases.sh')  // 父目錄
  ];
  
  let BACKUP_SCRIPT = null;
  for (const scriptPath of possiblePaths) {
    if (fs.existsSync(scriptPath)) {
      BACKUP_SCRIPT = scriptPath;
      console.log(`✓ 找到備份腳本：${BACKUP_SCRIPT}`);
      break;
    }
  }
  
  // 檢查備份腳本是否存在
  if (!BACKUP_SCRIPT) {
    console.error('備份腳本搜尋失敗，已嘗試的路徑：', possiblePaths);
    return res.status(404).json({ 
      error: '備份腳本不存在',
      message: '找不到備份腳本，請確認 backup_databases.sh 是否存在'
    });
  }
  
  const BACKUP_ROOT = '/opt/backups';
  const SCRIPT_DIR = path.dirname(BACKUP_SCRIPT);
  
  try {
    // 執行備份腳本（非同步執行，不等待完成）
    execFile('bash', [BACKUP_SCRIPT], { 
      cwd: SCRIPT_DIR,  // 在腳本所在目錄執行
      timeout: 300000 // 5 分鐘超時
    }, (error, stdout, stderr) => {
      if (error) {
        console.error('備份執行錯誤:', error);
        // 即使有錯誤，也可能已經創建了備份，所以繼續檢查
      }
      
      // 記錄審計日誌
      logAudit(req, 'create', 'backup', null, '手動備份', null, {
        script: path.basename(BACKUP_SCRIPT),
        stdout: stdout?.substring(0, 500), // 只記錄前 500 字元
        error: error ? error.message : null
      });
    });
    
    // 立即返回，不等待備份完成
    res.json({ 
      success: true, 
      message: '備份任務已啟動，正在背景執行中...',
      note: '備份完成後，請重新整理頁面查看最新備份檔案'
    });
  } catch (err) {
    console.error('啟動備份失敗:', err);
    res.status(500).json({ 
      error: '啟動備份失敗'
    });
  }
});

// 下載備份檔案（管理員專用）
router.get('/api/admin/backup/download/:filename', requireAdmin, (req, res) => {
  const { filename } = req.params;
  const BACKUP_ROOT = '/opt/backups';
  const filePath = path.join(BACKUP_ROOT, filename);
  
  // 安全檢查：確保檔案在備份目錄內
  const resolvedPath = path.resolve(filePath);
  const resolvedBackupRoot = path.resolve(BACKUP_ROOT);
  
  if (!resolvedPath.startsWith(resolvedBackupRoot + path.sep)) {
    return res.status(403).json({ error: '無權限存取此檔案' });
  }
  
  // 檢查檔案是否存在
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '備份檔案不存在' });
  }
  
  // 檢查是否為備份檔案（只允許下載 .tar.gz 檔案）
  if (!filename.endsWith('.tar.gz') || !filename.startsWith('auto_')) {
    return res.status(403).json({ error: '只能下載自動備份檔案' });
  }
  
  // 記錄審計日誌
  logAudit(req, 'download', 'backup', null, filename, null, {
    filePath: filePath,
    fileSize: fs.statSync(filePath).size
  });
  
  // 下載檔案
  res.download(filePath, filename, (err) => {
    if (err) {
      console.error('下載備份檔案失敗:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: '下載失敗' });
      }
    }
  });
});

// 取得備份檔案列表（管理員專用）
router.get('/api/admin/backup/list', requireAdmin, (req, res) => {
  const BACKUP_ROOT = '/opt/backups';
  
  if (!fs.existsSync(BACKUP_ROOT)) {
    return res.json({ 
      backups: [],
      total: 0,
      message: '備份目錄不存在'
    });
  }
  
  try {
    const backupFiles = fs.readdirSync(BACKUP_ROOT)
      .filter(f => f.endsWith('.tar.gz') && f.startsWith('auto_'))
      .map(f => {
        const filePath = path.join(BACKUP_ROOT, f);
        const stats = fs.statSync(filePath);
        return {
          filename: f,
          size: stats.size,
          sizeMB: (stats.size / 1024 / 1024).toFixed(2),
          created: stats.birthtime,
          modified: stats.mtime,
          downloadUrl: `/api/admin/backup/download/${f}`
        };
      })
      .sort((a, b) => b.modified - a.modified);
    
    res.json({
      backups: backupFiles,
      total: backupFiles.length,
      totalSize: backupFiles.reduce((sum, f) => sum + f.size, 0),
      totalSizeMB: (backupFiles.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024).toFixed(2)
    });
  } catch (err) {
    console.error('取得備份列表失敗:', err);
    res.status(500).json({ 
      error: '取得備份列表失敗',
      message: err.message 
    });
  }
});

// 管理員直接新增使用者（無需審核）
router.post('/api/admin/accounts/create', requireAdmin, async (req, res) => {
  console.log('Hit POST /api/admin/accounts/create');
  const { username, password, full_name, permissionLevel, allowedDatabases } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: '請提供使用者名稱和密碼' });
  }
  
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: '欄位格式不正確' });
  }

  // 驗證使用者名稱格式（只允許英數字和底線）
  if (!/^[a-zA-Z0-9_]+$/.test(username) || username.length > 64) {
    return res.status(400).json({ error: '使用者名稱只能包含英數字和底線' });
  }

  const pwError = security.validatePassword(password, username);
  if (pwError) {
    return res.status(400).json({ error: pwError });
  }
  
  try {
    const collision = await usernameCollisionOf(username);
    if (collision) {
      return res.status(400).json({ error: `使用者名稱與既有帳號「${collision}」衝突（兩者互為底線前綴，會造成個人資料庫歸屬混淆），請改用其他名稱` });
    }

    // 檢查使用者是否已存在
    const existingUser = await dbGet(getSystemDb(), 'SELECT id FROM accounts WHERE username = ?', [username]);
    
    if (existingUser) {
      return res.status(400).json({ error: '使用者名稱已存在' });
    }
    
    // 雜湊密碼
    const passwordHash = await argon2.hash(password);
    
    // 建立使用者專屬資料庫名稱
    const userDbName = `user_${username}.db`;
    
    // 處理權限設定
    let finalPermissionLevel = permissionLevel === 'viewer' ? 'viewer' : 'editor';
    let serializedAllowed = null;
    
    if (finalPermissionLevel === 'viewer') {
      const sanitized = sanitizeAllowedDatabases(Array.isArray(allowedDatabases) ? allowedDatabases : []);
      if (sanitized.length === 0) {
        return res.status(400).json({ error: '唯讀帳號請至少選擇一個可讀取的資料庫' });
      }
      serializedAllowed = JSON.stringify(sanitized);
    }
    
    // 建立帳號（直接啟用，無需審核）
    const accountId = (await dbRun(getSystemDb(), 'INSERT INTO accounts (username, password_hash, full_name, role, status, user_database, permission_level, allowed_databases, created_at, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)', [username, passwordHash, full_name || null, 'user', 'active', userDbName, finalPermissionLevel, serializedAllowed, nowISO()])).lastID;
    
    // 建立使用者專屬資料庫
    const userDb = await connectDatabase(userDbName);
    userDb.close();
    
    console.log(`✓ 管理員建立帳號成功: ${username}, 資料庫: ${userDbName}, 權限: ${finalPermissionLevel}`);
    res.json({ 
      success: true, 
      message: '帳號建立成功',
      accountId: accountId,
      username: username,
      userDatabase: userDbName,
      permissionLevel: finalPermissionLevel,
      status: 'active'
    });
    
  } catch (error) {
    console.error('建立帳號錯誤:', error);
    internalError(res, error);
  }
});

console.log('Registered /api/admin/accounts/create');

module.exports = router;
