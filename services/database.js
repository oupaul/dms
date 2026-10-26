/**
 * 資料庫連線、系統資料庫啟動、資料庫登記表與使用者資料庫連線快取。
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const argon2 = require('argon2');
const security = require('../lib/security');
const { DB_DIR, SYSTEM_DB_NAMES } = require('../lib/config');
const { nowISO, toLocalISO } = require('../lib/time');
const { initializeTables } = require('./schema');
const { dbRun } = require('../lib/db');
const { ConnectionCache } = require('../lib/connection-cache');
const ROOT_DIR = path.join(__dirname, '..');

function listAllDatabaseNames() {
  const files = fs.readdirSync(DB_DIR);
  return files.filter(f => f.endsWith('.db'));
}

function parseAllowedDatabases(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(name => typeof name === 'string' && name.trim().endsWith('.db'));
    }
  } catch (err) {
    console.warn('Failed to parse allowed_databases:', err);
  }
  return [];
}

function sanitizeAllowedDatabases(list) {
  if (!Array.isArray(list)) return [];
  const existing = new Set(listAllDatabaseNames());
  const unique = new Set();
  const sanitized = [];
  list.forEach((name) => {
    if (typeof name !== 'string') return;
    const trimmed = name.trim();
    if (!trimmed.endsWith('.db')) return;
    if (SYSTEM_DB_NAMES.has(trimmed)) return;   // 系統資料庫（system.db 掌管所有帳號與密碼雜湊）任何角色都不可被授權
    if (!existing.has(trimmed)) return;
    if (unique.has(trimmed)) return;
    unique.add(trimmed);
    sanitized.push(trimmed);
  });
  return sanitized;
}

// ==================== 工程師「全部資料庫」 ====================
//
// 工程師帳號可以不存名單，改存一個「全部」標記（allowed_databases = ["*"]）。存取時才即時判斷：
// 資料庫目錄裡所有資料庫，扣掉系統資料庫（system.db 掌管所有帳號，admin.db 為管理員用）與已刪除標記的檔案。
// 這樣新增、複製、改名、還原出來的資料庫立刻生效，不必逐一授權，也不必重新登入，刪除的資料庫也不會留下殘留名稱。
//
// 安全邊界：
//   - 標記只對「非管理員的工程師（role_level = engineer）」生效；同樣的標記出現在其他角色的帳號上一律忽略
//     （parseAllowedDatabases 本來就不會把它當成資料庫名稱）
//   - 只有管理員能透過帳號權限 API 設定；其他寫入 allowed_databases 的路徑都會過濾掉它
//   - 系統資料庫永遠不在範圍內
const ALL_DATABASES_TOKEN = '*';
const DB_NAME_PATTERN = /^[a-zA-Z0-9_\-\u4e00-\u9fa5]+\.db$/;

/** 帳號的 allowed_databases 是否帶有「全部」標記 */
function hasAllDatabasesToken(raw) {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.includes(ALL_DATABASES_TOKEN);
  } catch (err) {
    return false;
  }
}

/** 這個帳號（accounts 資料列）是否為「可存取全部資料庫」的工程師 */
function accountAllowsAllDatabases(account) {
  return !!account && account.role !== 'admin' && account.role_level === 'engineer' && hasAllDatabasesToken(account.allowed_databases);
}

/** 工程師「全部」涵蓋的資料庫（即時從資料庫目錄計算） */
function listEngineerAccessibleDatabases() {
  return listAllDatabaseNames()
    .filter(f => DB_NAME_PATTERN.test(f) && !SYSTEM_DB_NAMES.has(f) && !f.startsWith('deleted_'))
    .sort();
}

/** 此 session 是否為「全部資料庫」的工程師（登入時決定；仍再確認角色，避免標記被誤用到其他角色） */
function sessionAllowsAllDatabases(session) {
  return !!(session && session.allowAllDatabases && session.role !== 'admin' && session.roleLevel === 'engineer');
}

/** 此 session 目前可存取的資料庫清單（受限角色用；管理員與一般帳號不走這裡） */
function sessionAccessibleDatabases(session) {
  return sessionAllowsAllDatabases(session) ? listEngineerAccessibleDatabases() : ((session && session.allowedDatabases) || []);
}

/** 此 session 是否可存取指定資料庫（受限角色用） */
function sessionCanAccessDatabase(session, name) {
  if (typeof name !== 'string' || !name) return false;
  if (sessionAllowsAllDatabases(session)) {
    return DB_NAME_PATTERN.test(name) && !SYSTEM_DB_NAMES.has(name) && !name.startsWith('deleted_')
      && fs.existsSync(path.join(DB_DIR, name));
  }
  return ((session && session.allowedDatabases) || []).includes(name);
}

// 僅用於顯示（資料庫登記表的 created_by 後備值）；授權判斷請一律用 isDatabaseOwnedBy
function getDatabaseOwner(dbName) {
  if (!dbName || !dbName.startsWith('user_')) return null;
  const withoutPrefix = dbName.slice(5).replace(/\.db$/i, '');
  const segments = withoutPrefix.split('_');
  return segments[0] || null;
}

// 資料庫歸屬判斷（授權用）。新帳號名稱不得與既有帳號互為 "_" 前綴（見 findUsernameCollision），
// 因此 user_<username>.db / user_<username>_*.db 的前綴比對不會有歧義。
const isDatabaseOwnedBy = security.isDatabaseOwnedBy;

// =============================================================================

// 多資料庫管理
let db = null; // 當前使用的資料庫連線

let currentDbName = 'permissions.db'; // 當前資料庫名稱

// 確保資料庫目錄存在且權限正確
function ensureDatabaseDirectory() {
  try {
    // 檢查目錄是否存在
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { mode: 0o775 });
      console.log('✅ Created databases directory with proper permissions (775)');
    }
    
    // 測試寫入權限
    const testFile = path.join(DB_DIR, '.write_test_' + Date.now());
    try {
      fs.writeFileSync(testFile, 'permission test');
      fs.unlinkSync(testFile);
      console.log('✅ Database directory has write permissions');
    } catch (writeError) {
      console.error('\n' + '='.repeat(70));
      console.error('❌ DATABASE PERMISSION ERROR - 資料庫權限錯誤');
      console.error('='.repeat(70));
      console.error('\n錯誤：資料庫目錄無法寫入！');
      console.error('\n可能原因：');
      console.error('  1. 目錄權限不足');
      console.error('  2. 檔案擁有者不正確');
      console.error('  3. 磁碟空間不足');
      console.error('\n修復方法（在伺服器上執行）：');
      console.error('  cd ' + process.cwd());
      console.error('  sudo chown -R $USER:$USER ' + DB_DIR + '/');
      console.error('  chmod 775 ' + DB_DIR + '/');
      console.error('  chmod 664 ' + DB_DIR + '/*.db');
      console.error('\n然後重啟應用：');
      console.error('  pm2 restart all');
      console.error('\n' + '='.repeat(70) + '\n');
      throw new Error('Database directory is not writable: ' + writeError.message);
    }
    
    // 檢查現有資料庫檔案權限
    const dbFiles = fs.readdirSync(DB_DIR).filter(f => f.endsWith('.db'));
    if (dbFiles.length > 0) {
      console.log(`📂 Found ${dbFiles.length} database file(s)`);
      
      // 嘗試檢查每個檔案的可寫性
      let hasPermissionIssue = false;
      dbFiles.forEach(dbFile => {
        const dbPath = path.join(DB_DIR, dbFile);
        try {
          fs.accessSync(dbPath, fs.constants.W_OK);
          console.log(`  ✅ ${dbFile} - writable`);
        } catch (err) {
          console.error(`  ❌ ${dbFile} - NOT writable!`);
          hasPermissionIssue = true;
        }
      });
      
      if (hasPermissionIssue) {
        console.error('\n⚠️  警告：某些資料庫檔案沒有寫入權限');
        console.error('   請執行：chmod 664 ' + DB_DIR + '/*.db\n');
      }
    }
  } catch (error) {
    if (error.message.includes('not writable')) {
      throw error; // 重新拋出我們自訂的錯誤
    }
    console.error('Database directory setup error:', error);
    throw error;
  }
}

// 初始化資料庫連線
function connectDatabase(dbName) {
  const dbPath = path.join(DB_DIR, dbName);

  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('DB Connection Error:', err);
        reject(err);
        return;
      }
      console.log(`Connected to database: ${dbName}`);

      // 設定 busy_timeout，避免多連線時 SQLITE_BUSY 錯誤造成操作中斷
      database.run('PRAGMA busy_timeout = 5000', () => {
        // 啟用 WAL 模式，提升並發讀寫效能
        database.run('PRAGMA journal_mode = WAL', (walErr) => {
          if (walErr) console.warn(`WAL mode warning for ${dbName}:`, walErr.message);

          // 初始化資料表結構
          initializeTables(database, (initErr) => {
            if (initErr) {
              console.error('Table initialization error:', initErr);
              reject(initErr);
              return;
            }
            resolve(database);
          });
        });
      });
    });
  });
}

// 首次安裝用的管理員密碼：
//  1. deploy.sh 會產生亂數密碼、顯示在部署終端機，並寫入 .initial_admin_password（權限 600）；
//  2. 若沒有該檔案（例如手動啟動），則由程式產生亂數密碼並只印出一次。
// 帳號建立後該檔案立即刪除，且帳號被標記為「首次登入必須改密碼」。
const INITIAL_ADMIN_PASSWORD_FILE = path.join(ROOT_DIR, '.initial_admin_password');

function consumeInitialAdminPassword() {
  let fromFile = null;
  try {
    fromFile = fs.readFileSync(INITIAL_ADMIN_PASSWORD_FILE, 'utf8').trim();
  } catch (e) {
    // 沒有檔案，往下自行產生
  }
  if (fromFile && !security.validatePassword(fromFile, 'admin')) {
    return { password: fromFile, source: 'file' };
  }
  return { password: security.generatePassword(20), source: 'generated' };
}

function removeInitialAdminPasswordFile() {
  try { fs.unlinkSync(INITIAL_ADMIN_PASSWORD_FILE); } catch (e) { /* 不存在即可 */ }
}

// 建立預設管理員帳號和資料庫
async function createDefaultAdmin() {
  const adminUsername = 'admin';
  const adminDbName = 'admin.db';
  
  return new Promise(async (resolve, reject) => {
    // 檢查管理員帳號是否已存在
    db.get('SELECT id FROM accounts WHERE username = ?', [adminUsername], async (err, row) => {
      if (err) return reject(err);
      
      if (row) {
        console.log('✓ Admin account already exists');
        removeInitialAdminPasswordFile(); // 帳號已存在，殘留的初始密碼檔不應保留
        return resolve();
      }
      
      try {
        const { password: adminPassword, source } = consumeInitialAdminPassword();
        // 建立管理員帳號
        const passwordHash = await argon2.hash(adminPassword);
        
        await dbRun(db, 'INSERT INTO accounts (username, password_hash, full_name, role, status, user_database, permission_level, allowed_databases, created_at, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)', [adminUsername, passwordHash, '系統管理員', 'admin', 'active', adminDbName, 'editor', null, nowISO()]);
        removeInitialAdminPasswordFile();

        if (source === 'generated') {
          // 只在首次建立時印出一次；請立即登入並修改（登入後系統會強制改密碼）
          console.log('\n' + '='.repeat(64));
          console.log('  已建立預設管理員帳號（僅顯示這一次，請立即記下）');
          console.log(`  帳號：${adminUsername}`);
          console.log(`  密碼：${adminPassword}`);
          console.log('  首次登入後會被要求立即修改密碼。');
          console.log('='.repeat(64) + '\n');
        } else {
          console.log(`✓ Created default admin account: ${adminUsername}（密碼來自部署流程，已於部署終端機顯示）`);
        }
        
        // 建立管理員專屬資料庫
        const adminDb = await connectDatabase(adminDbName);
        adminDb.close();
        console.log(`✓ Created admin database: ${adminDbName}`);
        
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

// 載入預設資料庫或最後使用的資料庫
async function loadDefaultDatabase() {
  const configFile = path.join(DB_DIR, 'config.json');
  let dbToLoad = 'system.db'; // 系統資料庫，用於帳號管理
  
  // 讀取上次使用的資料庫
  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.lastDatabase) {
        dbToLoad = config.lastDatabase;
      }
    } catch (err) {
      console.error('Failed to read config:', err);
    }
  }
  
  try {
    db = await connectDatabase(dbToLoad);
    currentDbName = dbToLoad;
    console.log(`System database loaded: ${dbToLoad}`);
    
    // 建立預設管理員帳號
    await createDefaultAdmin();
  } catch (err) {
    console.error('Failed to load default database:', err);
    process.exit(1);
  }
}

// 自動掃描 databases/ 目錄，將尚未登記的 .db 檔案加入 databases 表
function syncDatabaseRegistry() {
  let files;
  try {
    files = fs.readdirSync(DB_DIR).filter(f => f.endsWith('.db') && !SYSTEM_DB_NAMES.has(f) && !f.startsWith('deleted_'));
  } catch (e) {
    console.error('syncDatabaseRegistry 掃描失敗:', e.message);
    return;
  }
  if (files.length === 0) return;

  const stmt = db.prepare(`INSERT OR IGNORE INTO databases (name, display_name, created_by, created_at) VALUES (?, ?, ?, ?)`);
  files.forEach(name => {
    // 從 user_<name>.db 推算 created_by
    const createdBy = name.startsWith('user_') ? name.slice(5).replace(/\.db$/i, '') : null;
    const displayName = createdBy ? null : name.replace(/\.db$/i, '');
    const stat = (() => { try { return fs.statSync(path.join(DB_DIR, name)); } catch { return null; } })();
    const createdAt = stat ? toLocalISO(stat.birthtime) : nowISO();
    stmt.run(name, displayName, createdBy, createdAt);
  });
  stmt.finalize(() => console.log(`✓ 資料庫登記同步完成（共 ${files.length} 個）`));
}

// 啟動時載入預設資料庫
function startDatabase() {
  userDbCache.startSweeper();
  loadDefaultDatabase().then(() => {
    console.log('Database initialized!');

    // 稽核：既有帳號名稱若互為 "_" 前綴（如 a 與 a_b），個人資料庫歸屬會有歧義，啟動時警告管理員處理
    db.all('SELECT username FROM accounts', [], (accErr, accRows) => {
      if (accErr || !accRows) return;
      const names = accRows.map(r => r.username);
      const reported = new Set();
      names.forEach(n => {
        const other = security.findUsernameCollision(n, names.filter(x => x !== n));
        const key = [n, other].sort().join('|');
        if (other && !reported.has(key)) {
          reported.add(key);
          console.warn(`⚠️  帳號名稱衝突：「${n}」與「${other}」互為底線前綴，個人資料庫（user_${n}_*.db）可能被對方存取，請將其中一個帳號改名。`);
        }
      });
    });
    
    // 在系統資料庫中創建活動會話表（用於追蹤所有用戶的在線狀態）
    db.run(`CREATE TABLE IF NOT EXISTS active_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      full_name TEXT NOT NULL,
      user_database TEXT NOT NULL,
      login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT,
      user_agent TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    )`, (err) => {
      if (err) {
        console.error('Failed to create active_sessions table:', err);
      } else {
        console.log('✓ Active sessions table initialized in system database');
      }
    });

    // 建立審計日誌表（記錄使用者操作）
    db.run(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      full_name TEXT,
      action_type TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id INTEGER,
      resource_name TEXT,
      old_value TEXT,
      new_value TEXT,
      user_database TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    )`, (err) => {
      if (err) {
        console.error('Failed to create audit_log table:', err);
      } else {
        console.log('✓ Audit log table initialized in system database');
      }
    });

    // 建立使用時間統計表（記錄使用者每日活動時間）
    db.run(`CREATE TABLE IF NOT EXISTS usage_statistics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      full_name TEXT,
      date DATE NOT NULL,
      login_count INTEGER DEFAULT 0,
      total_session_time INTEGER DEFAULT 0,
      last_login DATETIME,
      last_logout DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      UNIQUE(account_id, date)
    )`, (err) => {
      if (err) {
        console.error('Failed to create usage_statistics table:', err);
      } else {
        console.log('✓ Usage statistics table initialized in system database');
      }
      // 補丁：為舊版 system.db 補齊可能缺少的欄位
      db.all('PRAGMA table_info(usage_statistics)', [], (perr, columns) => {
        if (perr || !columns) return;
        const cols = columns.map(c => c.name);
        const needed = ['login_count', 'total_session_time', 'last_login', 'last_logout', 'created_at', 'updated_at'];
        const missing = needed.filter(c => !cols.includes(c));
        const defs = {
          login_count: 'INTEGER DEFAULT 0',
          total_session_time: 'INTEGER DEFAULT 0',
          last_login: 'DATETIME',
          last_logout: 'DATETIME',
          created_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
          updated_at: 'DATETIME DEFAULT CURRENT_TIMESTAMP',
        };
        missing.forEach(col => {
          db.run(`ALTER TABLE usage_statistics ADD COLUMN ${col} ${defs[col]}`);
          console.log(`✓ usage_statistics 補丁：新增欄位 ${col}`);
        });
      });
    });

    db.run(`CREATE TABLE IF NOT EXISTS broadcast_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      created_by INTEGER,
      created_by_name TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES accounts(id)
    )`, (err) => {
      if (err) {
        console.error('Failed to create broadcast_messages table:', err);
      } else {
        console.log('✓ Broadcast messages table initialized in system database');
      }
    });

    // 邀請連結表
    db.run(`CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      created_by TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      used_by TEXT,
      role_level TEXT NOT NULL DEFAULT 'user',
      permission_level TEXT DEFAULT 'editor',
      allowed_databases TEXT DEFAULT '[]',
      note TEXT
    )`, (err) => {
      if (err) {
        console.error('Failed to create invitations table:', err);
      } else {
        console.log('✓ Invitations table initialized in system database');
      }
    });

    // 資料庫登記表
    db.run(`CREATE TABLE IF NOT EXISTS databases (
      name TEXT PRIMARY KEY,
      display_name TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      description TEXT
    )`, (err) => {
      if (err) {
        console.error('Failed to create databases table:', err);
        return;
      }
      console.log('✓ Databases registry table initialized');
      // 自動掃描現有 .db 檔案並登記（跳過系統保留檔）
      syncDatabaseRegistry();
    });
  });
}

// 使用者資料庫連線管理（每個使用者一個連線；有數量上限，閒置過久自動關閉）
const USER_DB_CACHE_MAX = Number(process.env.USER_DB_CACHE_MAX) || 20;
const USER_DB_IDLE_MINUTES = Number(process.env.USER_DB_IDLE_MINUTES) || 30;
const userDbCache = new ConnectionCache({
  max: USER_DB_CACHE_MAX,
  idleMs: USER_DB_IDLE_MINUTES * 60 * 1000,
  close: (conn) => new Promise((resolve) => {
    conn.close((err) => {
      if (err) console.error('Error closing database:', err);
      resolve();
    });
  })
});

const userDatabaseKey = (userId, userDbName) => `user_${userId}_${userDbName}`;

// 取得使用者的資料庫連線
async function getUserDatabase(userId, userDbName) {
  // Key 包含 userId 和資料庫名稱，確保切換資料庫時不會使用錯誤的緩存
  const key = userDatabaseKey(userId, userDbName);

  if (userDbCache.has(key)) {
    console.log(`Using cached database connection: ${key}`);
  } else {
    console.log(`Creating new database connection: ${key}`);
  }
  return userDbCache.get(key, () => connectDatabase(userDbName));
}

// 標記請求正在使用某條使用者資料庫連線（回應結束前不會被回收）
function retainUserDatabase(userDb, res) {
  const release = userDbCache.retain(userDb);
  res.once('close', release);
}

// 關閉並移除某位使用者對某資料庫的快取連線
async function closeUserDatabase(userId, userDbName) {
  const key = userDatabaseKey(userId, userDbName);
  if (!userDbCache.has(key)) return;
  console.log(`Closing old database connection: ${key}`);
  await userDbCache.evict(key);
  console.log(`Deleted old database connection from cache: ${key}`);
}

const getSystemDb = () => db;
const getCurrentDbName = () => currentDbName;

module.exports = {
  connectDatabase,
  ensureDatabaseDirectory,
  getCurrentDbName,
  getDatabaseOwner,
  getSystemDb,
  getUserDatabase,
  isDatabaseOwnedBy,
  listAllDatabaseNames,
  parseAllowedDatabases,
  sanitizeAllowedDatabases,
  ALL_DATABASES_TOKEN,
  DB_NAME_PATTERN,
  hasAllDatabasesToken,
  accountAllowsAllDatabases,
  listEngineerAccessibleDatabases,
  sessionAllowsAllDatabases,
  sessionAccessibleDatabases,
  sessionCanAccessDatabase,
  closeUserDatabase,
  retainUserDatabase,
  startDatabase,
};
