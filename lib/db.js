/**
 * sqlite3 回呼式 API 的 Promise 包裝。
 * 第一個參數是 sqlite3.Database 連線（系統資料庫或 req.userDb）。
 */

// 取單筆；找不到時 resolve undefined
function dbGet(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

// 取多筆；resolve 陣列
function dbAll(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// 執行 INSERT／UPDATE／DELETE／DDL；resolve { lastID, changes }
function dbRun(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// 同 dbRun，但沒有任何列被異動時以 Error(message) reject（用於「更新失敗」這類檢查）
async function dbRunExpectChange(database, sql, params, message) {
  const result = await dbRun(database, sql, params);
  if (result.changes === 0) throw new Error(message);
  return result;
}

// 執行不含參數的多段 SQL
function dbExec(database, sql) {
  return new Promise((resolve, reject) => {
    database.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = { dbGet, dbAll, dbRun, dbRunExpectChange, dbExec };
