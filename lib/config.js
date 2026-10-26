/**
 * 共用常數：連接埠、目錄與系統資料庫名稱。
 */

const UPLOAD_DIR = 'uploads';

const DB_DIR = 'databases'; // 資料庫存放目錄

// 系統保留的資料庫名稱，不列入一般資料庫管理
const SYSTEM_DB_NAMES = new Set(['system.db', 'admin.db']);

module.exports = {
  DB_DIR,
  SYSTEM_DB_NAMES,
  UPLOAD_DIR,
};
