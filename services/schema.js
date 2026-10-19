/**
 * 資料表結構初始化。
 */

// 初始化資料表
function initializeTables(database, callback) {
  database.serialize(() => {
    // 帳號表（全域，用於登入認證）
    database.run(`CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'pending',
      user_database TEXT,
      permission_level TEXT DEFAULT 'editor',
      allowed_databases TEXT,
      ms_email TEXT,
      must_change_password INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    database.all("PRAGMA table_info(accounts)", [], (err, columns) => {
      if (err) return;
      const columnNames = columns.map(col => col.name);
      if (!columnNames.includes('must_change_password')) {
        database.run("ALTER TABLE accounts ADD COLUMN must_change_password INTEGER DEFAULT 0", (e) => { if (e) console.warn('migrate accounts.must_change_password:', e.message); });
      }
      if (!columnNames.includes('permission_level')) {
        database.run("ALTER TABLE accounts ADD COLUMN permission_level TEXT DEFAULT 'editor'", (e) => { if (e) console.warn('migrate accounts.permission_level:', e.message); });
      }
      if (!columnNames.includes('allowed_databases')) {
        database.run("ALTER TABLE accounts ADD COLUMN allowed_databases TEXT", (e) => { if (e) console.warn('migrate accounts.allowed_databases:', e.message); });
      }
      if (!columnNames.includes('role_level')) {
        database.run("ALTER TABLE accounts ADD COLUMN role_level TEXT DEFAULT 'user'", (e) => { if (e) console.warn('migrate accounts.role_level:', e.message); });
      }
      if (!columnNames.includes('can_invite')) {
        database.run("ALTER TABLE accounts ADD COLUMN can_invite INTEGER DEFAULT 0", (e) => { if (e) console.warn('migrate accounts.can_invite:', e.message); });
      }
      if (!columnNames.includes('ms_email')) {
        // 用 serialize 確保 ALTER TABLE 一定在 CREATE INDEX 之前完成，
        // 避免 parallel 模式下兩條語句競爭造成 "no such column: ms_email" uncaughtException
        database.serialize(() => {
          database.run("ALTER TABLE accounts ADD COLUMN ms_email TEXT", (e) => { if (e) console.warn('migrate accounts.ms_email:', e.message); });
          database.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_ms_email ON accounts(ms_email) WHERE ms_email IS NOT NULL", (e) => { if (e) console.warn('migrate idx_accounts_ms_email:', e.message); });
        });
      }

      // 修補：多資料庫機制上線前建立的帳號可能沒有 user_database，
      // 登入時會因為找不到對應資料庫而失敗。自動補上安全預設值，
      // 管理員之後可在後台「帳號管理」調整成正確的資料庫。
      database.all("SELECT id, role FROM accounts WHERE user_database IS NULL OR user_database = ''", [], (backfillErr, rows) => {
        if (backfillErr || !rows || rows.length === 0) return;
        rows.forEach(row => {
          const fallbackDb = row.role === 'admin' ? 'admin.db' : 'system.db';
          database.run("UPDATE accounts SET user_database = ? WHERE id = ?", [fallbackDb, row.id], (e) => {
            if (e) console.warn(`migrate accounts.user_database (id=${row.id}):`, e.message);
            else console.log(`✓ 自動補齊帳號 id=${row.id}（role=${row.role}）的 user_database = ${fallbackDb}`);
          });
        });
      });
    });
    
    // 資料夾表
    database.run(`CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER,
      path TEXT
    )`);
    
    // 人員表（擴充欄位以對應AD格式）
    database.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      department TEXT,
      company TEXT,
      title TEXT,
      phone TEXT,
      description TEXT
    )`);
    
    // 為現有資料庫添加新欄位（如果欄位不存在）
    database.all("PRAGMA table_info(users)", [], (err, columns) => {
      if (err) return;
      const columnNames = columns.map(col => col.name);

      if (!columnNames.includes('department')) {
        database.run('ALTER TABLE users ADD COLUMN department TEXT', (e) => { if (e) console.warn('migrate users.department:', e.message); });
      }
      if (!columnNames.includes('company')) {
        database.run('ALTER TABLE users ADD COLUMN company TEXT', (e) => { if (e) console.warn('migrate users.company:', e.message); });
      }
      if (!columnNames.includes('title')) {
        database.run('ALTER TABLE users ADD COLUMN title TEXT', (e) => { if (e) console.warn('migrate users.title:', e.message); });
      }
      if (!columnNames.includes('phone')) {
        database.run('ALTER TABLE users ADD COLUMN phone TEXT', (e) => { if (e) console.warn('migrate users.phone:', e.message); });
      }
      if (!columnNames.includes('description')) {
        database.run('ALTER TABLE users ADD COLUMN description TEXT', (e) => { if (e) console.warn('migrate users.description:', e.message); });
      }
      if (!columnNames.includes('account_key')) {
        // 同 ms_email：用 serialize 確保 ALTER TABLE 先完成再建 INDEX
        database.serialize(() => {
          database.run('ALTER TABLE users ADD COLUMN account_key TEXT', (e) => { if (e) console.warn('migrate users.account_key:', e.message); });
          database.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_account_key ON users(account_key) WHERE account_key IS NOT NULL', (e) => { if (e) console.warn('migrate idx_users_account_key:', e.message); });
        });
      }
    });
    
    // 群組表
    database.run(`CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    )`);

    // 新增 description 欄位（若不存在）
    database.all("PRAGMA table_info(groups)", [], (err, columns) => {
      if (err) return;
      const columnNames = columns.map(col => col.name);
      if (!columnNames.includes('description')) {
        database.run("ALTER TABLE groups ADD COLUMN description TEXT DEFAULT ''", (e) => { if (e) console.warn('migrate groups.description:', e.message); });
      }
    });

    // 群組成員關聯表
    database.run(`CREATE TABLE IF NOT EXISTS group_users (
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (group_id, user_id),
      FOREIGN KEY (group_id) REFERENCES groups(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
    
    // 權限表
    database.run(`CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL,
      user_id INTEGER,
      group_id INTEGER,
      permission_type TEXT NOT NULL,
      FOREIGN KEY (folder_id) REFERENCES folders(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (group_id) REFERENCES groups(id)
    )`);

    // 權限異動申請單（客戶端唯讀帳號提出，工程師審核後才實際寫入 permissions 表）
    database.run(`CREATE TABLE IF NOT EXISTS permission_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_user_id INTEGER,
      target_group_id INTEGER,
      requested_permission_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by_account_id INTEGER NOT NULL,
      requested_by_username TEXT NOT NULL,
      requested_at DATETIME NOT NULL,
      reviewed_by_username TEXT,
      reviewed_at DATETIME,
      review_note TEXT,
      applied_permission_id INTEGER,
      FOREIGN KEY (folder_id) REFERENCES folders(id),
      FOREIGN KEY (target_user_id) REFERENCES users(id),
      FOREIGN KEY (target_group_id) REFERENCES groups(id)
    )`);

    // 為既有 permission_requests 表補上多筆送出／前後比對用的欄位（若不存在）
    database.all("PRAGMA table_info(permission_requests)", [], (err, columns) => {
      if (err) return;
      const columnNames = columns.map(col => col.name);
      if (!columnNames.includes('batch_id')) {
        database.run('ALTER TABLE permission_requests ADD COLUMN batch_id TEXT', (e) => { if (e) console.warn('migrate permission_requests.batch_id:', e.message); });
      }
      if (!columnNames.includes('previous_permission_type')) {
        database.run('ALTER TABLE permission_requests ADD COLUMN previous_permission_type TEXT', (e) => { if (e) console.warn('migrate permission_requests.previous_permission_type:', e.message); });
      }
      if (!columnNames.includes('previous_permission_source')) {
        database.run('ALTER TABLE permission_requests ADD COLUMN previous_permission_source TEXT', (e) => { if (e) console.warn('migrate permission_requests.previous_permission_source:', e.message); });
      }
      if (!columnNames.includes('previous_via_group_id')) {
        database.run('ALTER TABLE permission_requests ADD COLUMN previous_via_group_id INTEGER', (e) => { if (e) console.warn('migrate permission_requests.previous_via_group_id:', e.message); });
      }
      if (!columnNames.includes('previous_via_group_name')) {
        database.run('ALTER TABLE permission_requests ADD COLUMN previous_via_group_name TEXT', (e) => { if (e) console.warn('migrate permission_requests.previous_via_group_name:', e.message); });
      }
      if (!columnNames.includes('applied_via_group_id')) {
        database.run('ALTER TABLE permission_requests ADD COLUMN applied_via_group_id INTEGER', (e) => { if (e) console.warn('migrate permission_requests.applied_via_group_id:', e.message); });
      }
      if (!columnNames.includes('applied_via_group_name')) {
        database.run('ALTER TABLE permission_requests ADD COLUMN applied_via_group_name TEXT', (e) => { if (e) console.warn('migrate permission_requests.applied_via_group_name:', e.message); });
      }
    });

    // 匯入歷史主表
    database.run(`CREATE TABLE IF NOT EXISTS import_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      imported_by TEXT NOT NULL,
      file_name TEXT,
      mode TEXT NOT NULL DEFAULT 'diff_only',
      added INTEGER DEFAULT 0,
      updated INTEGER DEFAULT 0,
      deleted INTEGER DEFAULT 0,
      skipped INTEGER DEFAULT 0
    )`);

    // 匯入歷史明細表
    database.run(`CREATE TABLE IF NOT EXISTS import_history_detail (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      history_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      folder_path TEXT,
      target_type TEXT,
      target_name TEXT,
      old_permission TEXT,
      new_permission TEXT,
      FOREIGN KEY (history_id) REFERENCES import_history(id)
    )`, callback);
  });
}

module.exports = {
  initializeTables,
};
