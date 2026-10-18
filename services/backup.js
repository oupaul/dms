/**
 * 清空資料前的備份。
 */

const path = require('path');
const fs = require('fs');
const { nowFileStamp } = require('../lib/time');
const ROOT_DIR = path.join(__dirname, '..');

// 清空所有資料（使用 Promise 確保操作完成）
// 清空前先把整個資料庫以 VACUUM INTO 備份到 backups/pre-clear/（權限 700），只保留最近 20 份
const PRE_CLEAR_BACKUP_DIR = path.join(ROOT_DIR, 'backups', 'pre-clear');

async function backupBeforeClear(userDb, dbName) {
  fs.mkdirSync(PRE_CLEAR_BACKUP_DIR, { recursive: true, mode: 0o700 });
  const safeName = String(dbName).replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5.]/g, '_');
  const target = path.join(PRE_CLEAR_BACKUP_DIR, `${safeName}.${nowFileStamp()}.bak`);
  await new Promise((resolve, reject) => {
    userDb.run(`VACUUM INTO '${target.replace(/'/g, "''")}'`, (err) => (err ? reject(err) : resolve()));
  });
  try { fs.chmodSync(target, 0o600); } catch (e) { /* ignore */ }
  const files = fs.readdirSync(PRE_CLEAR_BACKUP_DIR).filter(f => f.endsWith('.bak')).sort();
  files.slice(0, Math.max(0, files.length - 20)).forEach(f => {
    try { fs.unlinkSync(path.join(PRE_CLEAR_BACKUP_DIR, f)); } catch (e) { /* ignore */ }
  });
  return target;
}

module.exports = {
  backupBeforeClear,
};
