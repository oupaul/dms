/**
 * 依登入者切換並掛上其資料庫連線（req.userDb）。
 */

const { nowISO } = require('../lib/time');
const { isViewer } = require('./viewer');
const { updateUsageStatistics } = require('../services/audit');
const { getSystemDb, getUserDatabase, retainUserDatabase } = require('../services/database');

// 取得使用者資料庫的中介軟體
async function withUserDatabase(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'unauthorized', message: '請先登入' });
  }
  
  try {
    const targetDatabase = req.session.userDatabase;
    if (!targetDatabase) {
      return res.status(400).json({ error: '未設定資料庫', message: '請先選擇可用的資料庫' });
    }
    
    if (isViewer(req)) {
      const allowed = (req.session.allowedDatabases || []).includes(targetDatabase);
      if (!allowed) {
        return res.status(403).json({ error: '無法存取此資料庫', code: 'viewer_database_forbidden' });
      }
    }
    
    const userDb = await getUserDatabase(req.session.userId, targetDatabase);
    req.userDb = userDb; // 將使用者資料庫附加到請求物件
    retainUserDatabase(userDb, res); // 回應結束前不讓快取回收這條連線
    
    // 更新系統資料庫中的活動時間（僅在有 activeSessionId 時）
    if (req.session.activeSessionId) {
      getSystemDb().run(
        'UPDATE active_sessions SET last_active = ? WHERE id = ?',
        [nowISO(), req.session.activeSessionId],
        (err) => {
          if (err) console.error('更新活動時間錯誤:', err);
        }
      );
    }
    
    // 更新使用時間統計（節流：每分鐘最多更新一次）
    const lastUpdate = req.session.lastUsageUpdate || 0;
    const now = Date.now();
    if (now - lastUpdate > 60000) { // 60秒
      updateUsageStatistics(req.session.userId, req.session.username, req.session.fullName, false);
      req.session.lastUsageUpdate = now;
    }
    
    next();
  } catch (error) {
    console.error('無法取得使用者資料庫:', error);
    res.status(500).json({ error: '無法連接到資料庫' });
  }
}

module.exports = {
  withUserDatabase,
};
