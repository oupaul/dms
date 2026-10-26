'use strict';
// 在暫存目錄建立「刻意混入各種壞資料」的資料庫，供 data-audit 測試使用。
// 用法：node build-audit-fixture.js <資料庫目錄>   （需在能 require('sqlite3') 的環境執行）
const path = require('path');
const sqlite3 = require('sqlite3');
const { initializeTables } = require('../../services/schema');

const dir = process.argv[2];

const open = (name) => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(path.join(dir, name), (err) => (err ? reject(err) : resolve(db)));
});
const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
const init = (db) => new Promise((resolve, reject) => initializeTables(db, (err) => (err ? reject(err) : resolve())));
const close = (db) => new Promise((resolve) => db.close(resolve));
// initializeTables 的欄位補丁（ALTER TABLE）是在回呼之後非同步完成的，先等欄位出現再寫入資料
const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))));
async function waitForColumn(db, table, column) {
  for (let i = 0; i < 100; i++) {
    if ((await all(db, `PRAGMA table_info(${table})`)).some(c => c.name === column)) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`等不到 ${table}.${column}`);
}

(async () => {
  // ---- system.db：帳號與資料庫登記
  const sys = await open('system.db');
  await init(sys);
  await waitForColumn(sys, 'accounts', 'role_level');
  await run(sys, `CREATE TABLE IF NOT EXISTS databases (name TEXT PRIMARY KEY, display_name TEXT, created_by TEXT, created_at DATETIME, description TEXT)`);
  const acc = (u, status, userDb, allowed) => run(sys,
    `INSERT INTO accounts (username, password_hash, status, user_database, allowed_databases) VALUES (?, 'x', ?, ?, ?)`, [u, status, userDb, allowed]);
  await acc('alice', 'active', 'clean.db', null);
  await acc('alice_x', 'active', 'user_alice_x.db', null);          // 與 alice 互為底線前綴；預設資料庫檔案不存在
  await acc('bob', 'active', 'clean.db', '["clean.db","gone.db"]');  // 可存取清單含不存在的資料庫
  await acc('carol', 'active', 'clean.db', '{not json');              // 不是合法 JSON
  await acc('dave', 'pending', 'clean.db', null);                     // 舊式申請帳號
  await acc('eve', 'active', 'clean.db', '["*"]');                      // 工程師「全部資料庫」標記：不是資料庫名稱，健檢與清理都必須放過
  await run(sys, `INSERT INTO databases (name, created_by) VALUES ('clean.db', 'alice'), ('ghost.db', 'alice')`); // ghost.db 沒有檔案；bad.db 沒登記
  await close(sys);

  // ---- clean.db：乾淨的資料
  const clean = await open('clean.db');
  await init(clean);
  await run(clean, `INSERT INTO folders (id, name, parent_id, path) VALUES (1, 'Share', NULL, '/Share'), (2, 'HR', 1, '/Share/HR')`);
  await run(clean, `INSERT INTO users (id, name, email) VALUES (1, 'Ann', 'ann@example.com')`);
  await run(clean, `INSERT INTO groups (id, name) VALUES (1, 'HR_RW')`);
  await run(clean, `INSERT INTO group_users (group_id, user_id) VALUES (1, 1)`);
  await run(clean, `INSERT INTO permissions (folder_id, user_id, group_id, permission_type) VALUES (2, NULL, 1, 'write')`);
  await run(clean, 'CREATE INDEX idx_permissions_folder ON permissions(folder_id)');  // 驗證「已有索引的欄位」不會被誤報
  await close(clean);

  // ---- bad.db：各種壞資料
  const bad = await open('bad.db');
  await init(bad);
  await waitForColumn(bad, 'users', 'account_key');
  await run(bad, `INSERT INTO folders (id, name, parent_id, path) VALUES
    (1, 'Root', NULL, '/Root'),
    (2, 'Child', 1, '/Root/Child'),
    (3, 'Child', 1, '/Root/Child'),
    (4, 'Orphan', 99, '/Orphan'),
    (5, 'A', 6, '/x'),
    (6, 'B', 5, '/y'),
    (7, 'bad:name', NULL, '/bad:name'),
    (8, 'X', 1, '/wrong')`);
  await run(bad, `INSERT INTO users (id, name, email, account_key) VALUES
    (1, 'U1', 'u1@example.com', 'u1'), (2, 'U2', 'U2@example.com', 'U2'), (3, 'U3', 'u2@example.com', 'u2')`);
  await run(bad, `INSERT INTO groups (id, name) VALUES (1, 'G'), (2, 'g'), (3, 'Empty')`);
  await run(bad, `INSERT INTO group_users (group_id, user_id) VALUES (1, 1), (99, 1), (1, 98)`);
  await run(bad, `INSERT INTO permissions (id, folder_id, user_id, group_id, permission_type) VALUES
    (1, 1, 1, NULL, 'read'),
    (2, 1, 1, NULL, 'read'),
    (3, 2, 2, NULL, 'banana'),
    (4, 2, 1, 1, 'write'),
    (5, 2, NULL, NULL, 'read'),
    (6, 77, 1, NULL, 'read'),
    (7, 2, 55, NULL, 'read'),
    (8, 2, NULL, 66, 'read'),
    (9, 3, 1, NULL, 'read'),
    (10, 3, NULL, 1, 'write')`);   // 人員 1 在資料夾 3：個人 read、所屬群組 1 write → 直接 vs 群組不一致
  await run(bad, `INSERT INTO permission_requests (folder_id, target_type, target_user_id, requested_permission_type, reason, status, requested_by_account_id, requested_by_username, requested_at, applied_permission_id) VALUES
    (555, 'user', 1, 'write', 'orphan folder', 'pending', 1, 'c', '2026-10-01T00:00:00+08:00', NULL),
    (1,   'user', 1, 'write', 'stale',         'pending', 1, 'c', '2020-01-01T00:00:00+08:00', NULL),
    (1,   'user', 1, 'write', 'weird',         'weird',   1, 'c', '2026-10-01T00:00:00+08:00', NULL),
    (1,   'user', 1, 'write', 'applied gone',  'approved',1, 'c', '2026-10-01T00:00:00+08:00', 4242)`);
  await close(bad);

  // ---- dirty.db：給「資料清理」測試用的情境（每一種可自動處理的項目與需人工處理的項目）
  const dirty = await open('dirty.db');
  await init(dirty);
  await waitForColumn(dirty, 'users', 'account_key');
  await run(dirty, `INSERT INTO folders (id, name, parent_id, path) VALUES
    (1, 'Root', NULL, '/Root'), (7, 'Sub', 1, '/WRONG'),
    (9, 'Lonely', NULL, '/Lonely'), (10, 'Lonely', NULL, '/Lonely'),
    (11, 'Both', NULL, '/Both'), (12, 'Both', NULL, '/Both')`);
  await run(dirty, `INSERT INTO users (id, name, email) VALUES (1, 'U1', 'u1@example.com'), (2, 'U2', 'u2@example.com')`);
  await run(dirty, `INSERT INTO groups (id, name) VALUES
    (1, 'G_RO'), (2, 'G_RW'), (3, 'Holder'),
    (4, 'Mix_RW'), (5, 'Mix_RO'), (6, 'Mix_Plain'),
    (7, 'Dup'), (8, 'dup'),
    (9, 'DupUsed'), (10, 'dupused')`);
  await run(dirty, `INSERT INTO group_users (group_id, user_id) VALUES (9, 1), (10, 2), (99, 1), (1, 98)`);  // 後兩筆是孤兒
  await run(dirty, `INSERT INTO permissions (id, folder_id, user_id, group_id, permission_type) VALUES
    (1, 1, NULL, 4, 'write'), (2, 1, NULL, 4, 'read'),
    (3, 1, NULL, 5, 'read'),  (4, 1, NULL, 5, 'write'),
    (5, 1, NULL, 6, 'read'),  (6, 1, NULL, 6, 'write'),
    (7, 7, NULL, 1, 'RO'),    (8, 7, NULL, 2, 'rw'),
    (9, 1, 1, NULL, 'read'),  (10, 1, 1, NULL, 'read'),
    (11, 11, NULL, 3, 'read'), (12, 12, NULL, 3, 'read'),
    (13, 77, 1, NULL, 'read')`);                                       // 13：指向不存在的資料夾
  await close(dirty);
})().catch((e) => { console.error(e); process.exit(1); });
