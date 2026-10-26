/**
 * 帳號相關輔助函式。
 */

const security = require('../lib/security');
const { getSystemDb } = require('./database');

// 檢查候選使用者名稱是否與既有帳號衝突；回傳衝突的既有帳號名稱，沒有則回傳 null
function usernameCollisionOf(candidate) {
  return new Promise((resolve, reject) => {
    getSystemDb().all('SELECT username FROM accounts', [], (err, rows) => {
      if (err) return reject(err);
      resolve(security.findUsernameCollision(candidate, rows.map(r => r.username)));
    });
  });
}

module.exports = {
  usernameCollisionOf,
};
