/**
 * 審計日誌與使用時間統計。
 */

const { nowISO, todayString } = require('../lib/time');
const { getSystemDb } = require('./database');
const { NOTIFY_ACTION_TYPES, NOTIFY_RESOURCE_TYPES, sendChangeNotification } = require('./email');

// ==================== 審計日誌 ====================

function logAudit(req, actionType, resourceType, resourceId, resourceName, oldValue, newValue) {
  if (!req.session || !req.session.userId) return;
  
  const ipAddress = req.ip || req.connection.remoteAddress;
  const userAgent = req.get('User-Agent') || 'Unknown';
  
  getSystemDb().run(
    `INSERT INTO audit_log (account_id, username, full_name, action_type, resource_type, resource_id, resource_name, old_value, new_value, user_database, ip_address, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.session.userId,
      req.session.username,
      req.session.fullName || null,
      actionType,
      resourceType,
      resourceId || null,
      resourceName || null,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      req.session.userDatabase || null,
      ipAddress,
      userAgent,
      nowISO()
    ],
    (err) => {
      if (err) {
        console.error('Failed to log audit:', err);
      }
    }
  );

  // 發送異動通知信
  if (NOTIFY_RESOURCE_TYPES.includes(resourceType) && NOTIFY_ACTION_TYPES.includes(actionType)) {
    sendChangeNotification({
      actionType,
      resourceType,
      resourceName,
      dbName: req.session.userDatabase || null,
      username: req.session.username,
      fullName: req.session.fullName || null,
      oldValue,
      newValue
    });
  }
}

// 更新使用時間統計
function updateUsageStatistics(accountId, username, fullName, isLogin = false) {
  const today = todayString();
  const now = nowISO();
  
  if (isLogin) {
    // 登入時更新
    getSystemDb().run(
      `INSERT INTO usage_statistics (account_id, username, full_name, date, login_count, last_login, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(account_id, date) DO UPDATE SET
         login_count = login_count + 1,
         last_login = ?,
         updated_at = ?`,
      [accountId, username, fullName || null, today, now, now, now, now],
      (err) => {
        if (err) console.error('Failed to update usage statistics (login):', err);
      }
    );
  } else {
    // 活動時更新（每分鐘最多更新一次）
    getSystemDb().run(
      `INSERT INTO usage_statistics (account_id, username, full_name, date, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, date) DO UPDATE SET
         updated_at = ?`,
      [accountId, username, fullName || null, today, now, now],
      (err) => {
        if (err) console.error('Failed to update usage statistics:', err);
      }
    );
  }
}

// 記錄登出時間
function logLogout(accountId, username) {
  const today = todayString();
  const now = nowISO();
  
  getSystemDb().run(
    `UPDATE usage_statistics 
     SET last_logout = ?, updated_at = ?
     WHERE account_id = ? AND date = ?`,
    [now, now, accountId, today],
    (err) => {
      if (err) console.error('Failed to log logout:', err);
    }
  );
}

module.exports = {
  logAudit,
  logLogout,
  updateUsageStatistics,
};
