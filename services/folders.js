/**
 * 資料夾路徑組合與重複檢查。
 */
const { dbGet } = require('../lib/db');

// 同一個父層底下不允許兩個同名資料夾（路徑必須唯一，權限才能正確對應）。
// parentId 為 null/undefined 代表根層；excludeId 用於「改名／搬移」時排除自己。
function findFolderByNameAndParent(database, name, parentId, excludeId = null) {
  const parent = parentId === undefined || parentId === '' ? null : parentId;
  return dbGet(
    database,
    'SELECT id, name, parent_id, path FROM folders WHERE name = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL)) AND (? IS NULL OR id != ?) LIMIT 1',
    [name, parent, parent, excludeId, excludeId]
  );
}

const DUPLICATE_FOLDER_ERROR = '同一層已有名稱相同的資料夾';

// 輔助：建構路徑（支援指定資料庫）
function buildPathWithDb(database, id, callback, visited = new Set()) {
  // 檢測循環引用
  if (visited.has(id)) {
    console.error(`Circular reference detected for folder ID ${id}`);
    return callback('Circular reference detected');
  }
  
  visited.add(id);
  
  database.get('SELECT * FROM folders WHERE id = ?', [id], (err, folder) => {
    if (err) {
      console.error(`Error fetching folder ${id}:`, err);
      return callback(err);
    }
    if (!folder) {
      console.error(`Folder ${id} not found`);
      return callback('Folder not found');
    }
    
    // 根資料夾
    if (!folder.parent_id || folder.parent_id === null || folder.parent_id === '') {
      return callback(null, '/' + folder.name);
    }
    
    // 遞迴建構父路徑
    buildPathWithDb(database, folder.parent_id, (err, parentPath) => {
      if (err) {
        console.error(`Error building parent path for folder ${id}:`, err);
        // 如果父資料夾有問題，將此資料夾視為根資料夾
        return callback(null, '/' + folder.name);
      }
      callback(null, parentPath + '/' + folder.name);
    }, visited);
  });
}

module.exports = {
  buildPathWithDb, findFolderByNameAndParent, DUPLICATE_FOLDER_ERROR };
