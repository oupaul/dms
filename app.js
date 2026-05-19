const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const multer = require('multer');
const csv = require('csv-parser');
const { createObjectCsvWriter } = require('csv-writer');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const argon2 = require('argon2');
const session = require('express-session');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // 信任 nginx 的 X-Forwarded-Proto，讓 req.protocol 正確回傳 https
const PORT = process.env.PORT || 5000;
const UPLOAD_DIR = 'uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Session 中介軟體
app.use(session({
  secret: 'your-secret-key-change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // 如果使用 HTTPS 設為 true
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 小時
    sameSite: 'lax' // 允許跨頁面導航時保持 session
  }
}));

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
    if (!existing.has(trimmed)) return;
    if (unique.has(trimmed)) return;
    unique.add(trimmed);
    sanitized.push(trimmed);
  });
  return sanitized;
}

function getDatabaseOwner(dbName) {
  if (!dbName || !dbName.startsWith('user_')) return null;
  const withoutPrefix = dbName.slice(5).replace(/\.db$/i, '');
  const segments = withoutPrefix.split('_');
  return segments[0] || null;
}

function isDatabaseOwnedBy(dbName, username) {
  const owner = getDatabaseOwner(dbName);
  if (!owner || !username) return false;
  return owner === username;
}

function isViewer(req) {
  return req.session && req.session.permissionLevel === 'viewer';
}

const VIEWER_WRITE_WHITELIST = [
  '/api/auth/logout',
  '/api/databases/switch'
];

function ensureEditorAccess(req, res, next) {
  if (isViewer(req)) {
    const message = '此帳號為唯讀，無法使用此功能。';
    const acceptHeader = (req.headers && req.headers.accept) ? req.headers.accept : '';
    const prefersHtml = acceptHeader.includes('text/html') && !acceptHeader.includes('application/json');

    if (prefersHtml) {
      return res
        .status(403)
        .send(`<!DOCTYPE html>
<html lang="zh-TW">
<head><meta charset="UTF-8"><title>403 Forbidden</title></head>
<body style="font-family: Arial, sans-serif; background:#f8f9fa; color:#333; text-align:center; padding:40px;">
  <h1>403 - 僅限可編輯帳號</h1>
  <p>${message}</p>
  <p><a href="/index.html">返回主系統</a></p>
</body>
</html>`);
    }

    return res.status(403).json({ error: 'viewer_feature_forbidden', message });
  }
  next();
}

app.use((req, res, next) => {
  if (isViewer(req)) {
    const method = req.method.toUpperCase();
    if (method !== 'GET') {
      const allowed = VIEWER_WRITE_WHITELIST.some(path => req.path.startsWith(path));
      if (!allowed) {
        return res.status(403).json({ error: '此帳號僅能瀏覽指定資料庫', code: 'viewer_read_only' });
      }
    }
  }
  next();
});

const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

app.use((req, res, next) => {
  if (req.session && req.session.userId) {
    const now = Date.now();
    const lastActivity = req.session.lastActivity || now;
    if (now - lastActivity > IDLE_TIMEOUT_MS) {
      const username = req.session.username;
      console.log(`Session timeout for user: ${username}`);
      return req.session.destroy((err) => {
        if (err) {
          console.error('Session destroy error:', err);
        }
        res.status(440).json({ error: 'SESSION_TIMEOUT', message: '因長時間未操作，已自動登出。' });
      });
    }
    req.session.lastActivity = now;
  }
  next();
});

// 多資料庫管理
let db = null; // 當前使用的資料庫連線
let currentDbName = 'permissions.db'; // 當前資料庫名稱
const DB_DIR = 'databases'; // 資料庫存放目錄

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

// 執行權限檢查
ensureDatabaseDirectory();

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
}

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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    database.all("PRAGMA table_info(accounts)", [], (err, columns) => {
      if (err) return;
      const columnNames = columns.map(col => col.name);
      if (!columnNames.includes('permission_level')) {
        database.run("ALTER TABLE accounts ADD COLUMN permission_level TEXT DEFAULT 'editor'");
      }
      if (!columnNames.includes('allowed_databases')) {
        database.run("ALTER TABLE accounts ADD COLUMN allowed_databases TEXT");
      }
      if (!columnNames.includes('role_level')) {
        database.run("ALTER TABLE accounts ADD COLUMN role_level TEXT DEFAULT 'user'");
      }
      if (!columnNames.includes('can_invite')) {
        database.run("ALTER TABLE accounts ADD COLUMN can_invite INTEGER DEFAULT 0");
      }
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
        database.run('ALTER TABLE users ADD COLUMN department TEXT');
      }
      if (!columnNames.includes('company')) {
        database.run('ALTER TABLE users ADD COLUMN company TEXT');
      }
      if (!columnNames.includes('title')) {
        database.run('ALTER TABLE users ADD COLUMN title TEXT');
      }
      if (!columnNames.includes('phone')) {
        database.run('ALTER TABLE users ADD COLUMN phone TEXT');
      }
      if (!columnNames.includes('description')) {
        database.run('ALTER TABLE users ADD COLUMN description TEXT');
      }
    });
    
    // 群組表
    database.run(`CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    )`);
    
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

// 建立預設管理員帳號和資料庫
async function createDefaultAdmin() {
  const adminUsername = 'admin';
  const adminPassword = 'admin123'; // 預設密碼
  const adminDbName = 'admin.db';
  
  return new Promise(async (resolve, reject) => {
    // 檢查管理員帳號是否已存在
    db.get('SELECT id FROM accounts WHERE username = ?', [adminUsername], async (err, row) => {
      if (err) return reject(err);
      
      if (row) {
        console.log('✓ Admin account already exists');
        return resolve();
      }
      
      try {
        // 建立管理員帳號
        const passwordHash = await argon2.hash(adminPassword);
        
        await new Promise((res, rej) => {
          db.run(
            'INSERT INTO accounts (username, password_hash, full_name, role, status, user_database, permission_level, allowed_databases) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [adminUsername, passwordHash, '系統管理員', 'admin', 'active', adminDbName, 'editor', null],
            function(err) {
              if (err) return rej(err);
              console.log(`✓ Created default admin account: ${adminUsername} / ${adminPassword}`);
              res(this.lastID);
            }
          );
        });
        
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

// 啟動時載入預設資料庫
loadDefaultDatabase().then(() => {
  console.log('Database initialized!');
  
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
});

// ==================== 認證中介軟體 ====================

// 檢查是否已登入
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    next();
  } else {
    res.status(401).json({ error: 'unauthorized', message: '請先登入' });
  }
}

// 檢查是否為管理員
function requireAdmin(req, res, next) {
  if (req.session && req.session.userId && req.session.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'forbidden', message: '需要管理員權限' });
  }
}

// 檢查是否有邀請發送權限（admin 或 can_invite=1）
function requireCanInvite(req, res, next) {
  if (req.session && req.session.userId && (req.session.role === 'admin' || req.session.canInvite)) {
    next();
  } else {
    res.status(403).json({ error: 'forbidden', message: '您沒有發送邀請連結的權限' });
  }
}

// ==================== 審計日誌和使用時間統計 ====================

// 記錄審計日誌
function logAudit(req, actionType, resourceType, resourceId, resourceName, oldValue, newValue) {
  if (!req.session || !req.session.userId) return;
  
  const ipAddress = req.ip || req.connection.remoteAddress;
  const userAgent = req.get('User-Agent') || 'Unknown';
  
  db.run(
    `INSERT INTO audit_log (account_id, username, full_name, action_type, resource_type, resource_id, resource_name, old_value, new_value, user_database, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      userAgent
    ],
    (err) => {
      if (err) {
        console.error('Failed to log audit:', err);
      }
    }
  );
}

// 更新使用時間統計
function updateUsageStatistics(accountId, username, fullName, isLogin = false) {
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();
  
  if (isLogin) {
    // 登入時更新
    db.run(
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
    db.run(
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
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();
  
  db.run(
    `UPDATE usage_statistics 
     SET last_logout = ?, updated_at = ?
     WHERE account_id = ? AND date = ?`,
    [now, now, accountId, today],
    (err) => {
      if (err) console.error('Failed to log logout:', err);
    }
  );
}

// 計算會話時間（登入到登出或最後活動時間）
function calculateSessionTime(loginTime, logoutTime) {
  if (!loginTime) return 0;
  const logout = logoutTime ? new Date(logoutTime) : new Date();
  const login = new Date(loginTime);
  return Math.max(0, Math.floor((logout - login) / 1000)); // 返回秒數
}

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
    
    // 更新系統資料庫中的活動時間（僅在有 activeSessionId 時）
    if (req.session.activeSessionId) {
      db.run(
        'UPDATE active_sessions SET last_active = CURRENT_TIMESTAMP WHERE id = ?',
        [req.session.activeSessionId],
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

// ==================== 帳號管理 API ====================

// 舊自助申請已停用，改為邀請制
app.post('/api/auth/register', (req, res) => {
  res.status(410).json({ error: '自助申請帳號功能已停用，請向管理員索取邀請連結。' });
});

// 使用者資料庫連線管理（每個使用者一個連線）
const userDatabases = new Map();

// 取得使用者的資料庫連線
async function getUserDatabase(userId, userDbName) {
  // Key 包含 userId 和資料庫名稱，確保切換資料庫時不會使用錯誤的緩存
  const key = `user_${userId}_${userDbName}`;
  
  if (userDatabases.has(key)) {
    console.log(`Using cached database connection: ${key}`);
    return userDatabases.get(key);
  }
  
  console.log(`Creating new database connection: ${key}`);
  const userDb = await connectDatabase(userDbName);
  userDatabases.set(key, userDb);
  return userDb;
}

// 登入
app.post('/api/auth/login', async (req, res) => {
  console.log('Hit POST /api/auth/login', { username: req.body.username });
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: '請提供使用者名稱和密碼' });
  }
  
  try {
    // 查找使用者（從系統資料庫）
    const systemDb = db; // 保存系統資料庫連線
    const user = await new Promise((resolve, reject) => {
      systemDb.get('SELECT * FROM accounts WHERE username = ?', [username], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (!user) {
      return res.status(401).json({ error: '使用者名稱或密碼錯誤' });
    }
    
    // 檢查帳號狀態
    if (user.status === 'pending') {
      return res.status(403).json({ 
        error: '帳號尚未通過審核',
        message: '您的帳號正在等待管理員審核，請稍後再試。'
      });
    }
    
    if (user.status === 'rejected') {
      return res.status(403).json({ 
        error: '帳號已被拒絕',
        message: '您的帳號申請已被拒絕，請聯繫管理員。'
      });
    }
    
    if (user.status !== 'active') {
      return res.status(403).json({ error: '帳號狀態異常，請聯繫管理員' });
    }
    
    // 驗證密碼
    const isPasswordValid = await argon2.verify(user.password_hash, password);
    
    if (!isPasswordValid) {
      return res.status(401).json({ error: '使用者名稱或密碼錯誤' });
    }
    
    const permissionLevel = user.permission_level || 'editor';
    let allowedDatabases = parseAllowedDatabases(user.allowed_databases);
    if (permissionLevel === 'viewer') {
      allowedDatabases = sanitizeAllowedDatabases(allowedDatabases);
      if (allowedDatabases.length === 0) {
        return res.status(403).json({ 
          error: '尚未指派可讀取的資料庫',
          message: '請聯繫管理員設定可讀取的資料庫後再登入。'
        });
      }
    }
    
    let targetDatabase = user.user_database;
    if (permissionLevel === 'viewer') {
      targetDatabase = allowedDatabases[0];
    }
    
    if (!targetDatabase) {
      return res.status(500).json({ error: '帳號未設定資料庫，請聯繫管理員' });
    }
    
    // 切換到使用者的專屬資料庫
    try {
      const userDb = await getUserDatabase(user.id, targetDatabase);
      
      // 設定 session（包含使用者資料庫資訊）
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.fullName = user.full_name;
      req.session.role = user.role;
      req.session.roleLevel = user.role === 'admin' ? 'admin' : (user.role_level || 'user');
      req.session.canInvite = !!(user.can_invite || user.role === 'admin');
      req.session.permissionLevel = permissionLevel;
      req.session.allowedDatabases = permissionLevel === 'viewer' ? allowedDatabases : [];
      req.session.userDatabase = targetDatabase;
      
      // 記錄活動會話到系統資料庫（在線用戶追蹤）
      const ipAddress = req.ip || req.connection.remoteAddress;
      const userAgent = req.get('User-Agent') || 'Unknown';
      
      db.run(`INSERT INTO active_sessions (account_id, username, full_name, user_database, ip_address, user_agent)
                  VALUES (?, ?, ?, ?, ?, ?)`,
        [user.id, user.username, user.full_name, user.user_database, ipAddress, userAgent],
        (err) => {
          if (err) console.error('記錄活動會話錯誤:', err);
          else {
            // 保存會話ID到 session，方便後續更新和刪除
            db.get('SELECT last_insert_rowid() as id', (err, row) => {
              if (!err && row) {
                req.session.activeSessionId = row.id;
              }
            });
          }
        }
      );
      
      // 記錄使用時間統計（登入）
      updateUsageStatistics(user.id, user.username, user.full_name, true);
      
      // 記錄審計日誌（登入）
      logAudit(req, 'login', 'account', user.id, username, null, { database: targetDatabase, permissionLevel });
      
      console.log(`✓ 登入成功: ${username}, 資料庫: ${targetDatabase}, 權限: ${permissionLevel}`);
      res.json({
        success: true,
        message: '登入成功',
        user: {
          id: user.id,
          username: user.username,
          fullName: user.full_name,
          role: user.role,
          roleLevel: user.role === 'admin' ? 'admin' : (user.role_level || 'user'),
          canInvite: !!(user.can_invite || user.role === 'admin'),
          database: targetDatabase,
          permissionLevel,
          allowedDatabases: permissionLevel === 'viewer' ? allowedDatabases : []
        }
      });
    } catch (dbError) {
      console.error('資料庫切換失敗:', dbError);
      return res.status(500).json({ error: '無法連接到您的資料庫，請聯繫管理員' });
    }
    
  } catch (error) {
    console.error('登入錯誤:', error);
    res.status(500).json({ error: error.message });
  }
});

// 登出
app.post('/api/auth/logout', (req, res) => {
  console.log('Hit POST /api/auth/logout');
  
  // 記錄登出時間
  if (req.session && req.session.userId) {
    logLogout(req.session.userId, req.session.username);
    
    // 記錄審計日誌（登出）
    logAudit(req, 'logout', 'account', req.session.userId, req.session.username, null, null);
  }
  
  // 從系統資料庫刪除活動會話記錄
  if (req.session.activeSessionId) {
    db.run('DELETE FROM active_sessions WHERE id = ?', 
      [req.session.activeSessionId],
      (err) => {
        if (err) console.error('刪除活動會話錯誤:', err);
      }
    );
  }
  
  req.session.destroy((err) => {
    if (err) {
      console.error('登出錯誤:', err);
      return res.status(500).json({ error: '登出失敗' });
    }
    res.json({ success: true, message: '登出成功' });
  });
});

// 修改密碼
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.session.userId;
  
  try {
    // 驗證輸入
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: '請提供當前密碼和新密碼' });
    }
    
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '新密碼長度至少需要 6 個字元' });
    }
    
    // 使用系統資料庫（帳號資料庫）
    const systemDb = db;
    
    // 查詢當前使用者
    const user = await new Promise((resolve, reject) => {
      systemDb.get('SELECT * FROM accounts WHERE id = ?', [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (!user) {
      return res.status(404).json({ error: '使用者不存在' });
    }
    
    // 驗證當前密碼
    const isValidPassword = await argon2.verify(user.password_hash, currentPassword);
    if (!isValidPassword) {
      return res.status(401).json({ error: '當前密碼錯誤' });
    }
    
    // 檢查新密碼是否與舊密碼相同
    const isSamePassword = await argon2.verify(user.password_hash, newPassword);
    if (isSamePassword) {
      return res.status(400).json({ error: '新密碼不能與當前密碼相同' });
    }
    
    // 加密新密碼
    const newPasswordHash = await argon2.hash(newPassword);
    
    // 更新密碼
    await new Promise((resolve, reject) => {
      systemDb.run(
        'UPDATE accounts SET password_hash = ? WHERE id = ?',
        [newPasswordHash, userId],
        function(err) {
          if (err) reject(err);
          else resolve(this);
        }
      );
    });
    
    console.log(`✓ 使用者 ${user.username} 已成功修改密碼`);
    
    res.json({
      success: true,
      message: '密碼修改成功'
    });
    
  } catch (error) {
    console.error('修改密碼錯誤:', error);
    res.status(500).json({ error: '修改密碼失敗，請稍後再試' });
  }
});

// 檢查登入狀態
app.get('/api/auth/status', (req, res) => {
  if (req.session && req.session.userId) {
    res.json({
      loggedIn: true,
      user: {
        id: req.session.userId,
        username: req.session.username,
        fullName: req.session.fullName,
        role: req.session.role,
        roleLevel: req.session.role === 'admin' ? 'admin' : (req.session.roleLevel || 'user'),
        canInvite: !!(req.session.canInvite || req.session.role === 'admin'),
        permissionLevel: req.session.permissionLevel || 'editor',
        allowedDatabases: req.session.allowedDatabases || [],
        database: req.session.userDatabase
      }
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// 檢查是否有任何帳號
app.get('/api/auth/has-accounts', (req, res) => {
  db.get('SELECT COUNT(*) as count FROM accounts', [], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ hasAccounts: row.count > 0 });
  });
});

// ==================== 管理員 API ====================

// 取得所有待審核的帳號（管理員專用）
// 舊待審核清單（已停用，改為邀請制，永遠回傳空陣列）
app.get('/api/admin/pending-accounts', requireAdmin, (req, res) => {
  res.json([]);
});

// 取得所有帳號（管理員專用）
app.get('/api/admin/accounts', requireAdmin, (req, res) => {
  db.all(
    'SELECT id, username, full_name, role, role_level, can_invite, status, user_database, created_at, permission_level, allowed_databases FROM accounts ORDER BY created_at DESC',
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      const mapped = (rows || []).map(row => ({
        ...row,
        permission_level: row.permission_level || 'editor',
        allowed_databases: parseAllowedDatabases(row.allowed_databases),
        role_level: row.role === 'admin' ? 'admin' : (row.role_level || 'user'),
        can_invite: !!(row.can_invite || row.role === 'admin')
      }));
      res.json(mapped);
    }
  );
});

// 舊審核帳號（已停用）
app.post('/api/admin/review-account', requireAdmin, (req, res) => {
  res.status(410).json({ error: '審核流程已停用，改為邀請制。' });
});

// 更新帳號權限（管理員專用）
app.post('/api/admin/accounts/update-permission', requireAdmin, async (req, res) => {
  const { accountId, permissionLevel, allowedDatabases, roleLevel, canInvite } = req.body;
  if (!accountId) {
    return res.status(400).json({ error: '缺少必要參數' });
  }

  try {
    const account = await new Promise((resolve, reject) => {
      db.get('SELECT id, role FROM accounts WHERE id = ?', [accountId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!account) {
      return res.status(404).json({ error: '帳號不存在' });
    }

    if (account.role === 'admin') {
      return res.status(400).json({ error: '無法修改管理員帳號的權限' });
    }

    let finalPermissionLevel = permissionLevel === 'viewer' ? 'viewer' : 'editor';
    let sanitized = [];
    let serialized = null;
    if (finalPermissionLevel === 'viewer') {
      sanitized = sanitizeAllowedDatabases(Array.isArray(allowedDatabases) ? allowedDatabases : []);
      if (sanitized.length === 0) {
        return res.status(400).json({ error: '請至少選擇一個可讀取的資料庫' });
      }
      serialized = JSON.stringify(sanitized);
    }

    // role_level：只允許設定為 'db_admin' 或 'user'（admin 不可透過此 API 降級）
    const validRoleLevels = ['db_admin', 'user'];
    const finalRoleLevel = validRoleLevels.includes(roleLevel) ? roleLevel : null;
    // db_admin 預設 can_invite=1；user 依傳入值設定
    const finalCanInvite = finalRoleLevel === 'db_admin' ? 1 : (canInvite ? 1 : 0);

    const updates = ['permission_level = ?', 'allowed_databases = ?'];
    const params = [finalPermissionLevel, serialized];
    if (finalRoleLevel !== null) {
      updates.push('role_level = ?');
      params.push(finalRoleLevel);
    }
    updates.push('can_invite = ?');
    params.push(finalCanInvite);
    params.push(accountId);

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`,
        params,
        function(err) {
          if (err) reject(err);
          else if (this.changes === 0) reject(new Error('更新失敗'));
          else resolve();
        }
      );
    });

    res.json({ success: true, message: '帳號權限已更新', permissionLevel: finalPermissionLevel, allowedDatabases: sanitized, roleLevel: finalRoleLevel, canInvite: !!finalCanInvite });
  } catch (error) {
    console.error('更新帳號權限失敗:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== 邀請連結 API ====================

// 建立邀請連結
app.post('/api/admin/invitations', requireCanInvite, async (req, res) => {
  const { roleLevel, permissionLevel, allowedDatabases, note, expiryDays } = req.body;
  const isAdmin = req.session.role === 'admin';
  const senderAllowed = req.session.allowedDatabases || [];
  const senderRoleLevel = req.session.roleLevel || 'user';

  // 允許的 role_level：
  //   db_admin → 只能邀請 client_user（自己客戶公司的使用者）
  //   admin 或 can_invite 工程師 → 可邀請 db_admin、user、client_user
  const isDbAdmin = senderRoleLevel === 'db_admin';
  const validRoleLevels = isDbAdmin ? ['client_user'] : ['db_admin', 'user', 'client_user'];
  const finalRoleLevel = validRoleLevels.includes(roleLevel) ? roleLevel : validRoleLevels[0];
  const finalPermLevel = permissionLevel === 'viewer' ? 'viewer' : 'editor';

  // 資料庫範圍：
  //   admin 或 can_invite 工程師 → 可邀請至任何資料庫
  //   db_admin → 只能邀請至自身有存取權的資料庫
  let finalDbs = Array.isArray(allowedDatabases) ? allowedDatabases : [];
  if (isDbAdmin) {
    const ownDbs = senderAllowed.length > 0 ? senderAllowed : (req.session.userDatabase ? [req.session.userDatabase] : []);
    finalDbs = finalDbs.filter(d => ownDbs.includes(d));
  }
  if (finalDbs.length === 0) {
    return res.status(400).json({ error: '請選擇至少一個資料庫' });
  }

  const days = parseInt(expiryDays) || 7;
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  const token = crypto.randomUUID();

  try {
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO invitations (token, created_by, expires_at, role_level, permission_level, allowed_databases, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [token, req.session.username, expiresAt, finalRoleLevel, finalPermLevel, JSON.stringify(finalDbs), note || null],
        function(err) { if (err) reject(err); else resolve(this.lastID); }
      );
    });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, token, link: `${baseUrl}/login.html?token=${token}`, expiresAt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 取得邀請清單
app.get('/api/admin/invitations', requireCanInvite, (req, res) => {
  const isAdmin = req.session.role === 'admin';
  const query = isAdmin
    ? 'SELECT * FROM invitations ORDER BY created_at DESC'
    : 'SELECT * FROM invitations WHERE created_by = ? ORDER BY created_at DESC';
  const params = isAdmin ? [] : [req.session.username];
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json((rows || []).map(r => ({
      ...r,
      allowed_databases: (() => { try { return JSON.parse(r.allowed_databases || '[]'); } catch { return []; } })(),
      status: r.used_at ? 'used' : (new Date(r.expires_at) < new Date() ? 'expired' : 'active')
    })));
  });
});

// 撤銷邀請
app.delete('/api/admin/invitations/:id', requireCanInvite, async (req, res) => {
  const isAdmin = req.session.role === 'admin';
  const id = parseInt(req.params.id);
  try {
    const inv = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM invitations WHERE id = ?', [id], (err, row) => { if (err) reject(err); else resolve(row); });
    });
    if (!inv) return res.status(404).json({ error: '邀請不存在' });
    if (!isAdmin && inv.created_by !== req.session.username) return res.status(403).json({ error: '只能撤銷自己建立的邀請' });
    if (inv.used_at) return res.status(400).json({ error: '此邀請已被使用，無法撤銷' });
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM invitations WHERE id = ?', [id], err => { if (err) reject(err); else resolve(); });
    });
    res.json({ success: true, message: '邀請已撤銷' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 驗證邀請 token（公開，不需登入）
app.get('/api/invite/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const inv = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM invitations WHERE token = ?', [token], (err, row) => { if (err) reject(err); else resolve(row); });
    });
    if (!inv) return res.status(404).json({ error: '邀請連結無效' });
    if (inv.used_at) return res.status(410).json({ error: '此邀請連結已被使用' });
    if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: '此邀請連結已過期' });
    res.json({
      valid: true,
      note: inv.note,
      role_level: inv.role_level,
      permission_level: inv.permission_level,
      allowed_databases: (() => { try { return JSON.parse(inv.allowed_databases || '[]'); } catch { return []; } })(),
      expires_at: inv.expires_at
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 透過邀請連結建立帳號（公開）
app.post('/api/invite/:token/register', async (req, res) => {
  const { token } = req.params;
  const { username, password, full_name } = req.body;

  if (!username || !password) return res.status(400).json({ error: '請提供使用者名稱和密碼' });
  if (password.length < 6) return res.status(400).json({ error: '密碼長度至少需要 6 個字元' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: '使用者名稱只能包含英數字和底線' });

  try {
    const inv = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM invitations WHERE token = ?', [token], (err, row) => { if (err) reject(err); else resolve(row); });
    });
    if (!inv) return res.status(404).json({ error: '邀請連結無效' });
    if (inv.used_at) return res.status(410).json({ error: '此邀請連結已被使用' });
    if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: '此邀請連結已過期' });

    const existing = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM accounts WHERE username = ?', [username], (err, row) => { if (err) reject(err); else resolve(row); });
    });
    if (existing) return res.status(400).json({ error: '使用者名稱已存在' });

    const passwordHash = await argon2.hash(password);
    const userDbName = `user_${username}.db`;
    const isDbAdmin = inv.role_level === 'db_admin';
    const allowedDbs = (() => { try { return JSON.parse(inv.allowed_databases || '[]'); } catch { return []; } })();
    // editor 使用 user_database；viewer 使用 allowed_databases
    const finalPermLevel = inv.permission_level || 'editor';
    const finalAllowed = finalPermLevel === 'viewer' ? JSON.stringify(allowedDbs) : null;
    const finalUserDb = finalPermLevel === 'viewer' ? (allowedDbs[0] || userDbName) : userDbName;

    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO accounts (username, password_hash, full_name, role, role_level, can_invite, status, user_database, permission_level, allowed_databases) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [username, passwordHash, full_name || null, 'user', inv.role_level || 'user', isDbAdmin ? 1 : 0, 'active', finalUserDb, finalPermLevel, finalAllowed],
        function(err) { if (err) reject(err); else resolve(this.lastID); }
      );
    });

    // 建立專屬 DB（editor / db_admin 才需要）
    if (finalPermLevel !== 'viewer') {
      const newDb = await connectDatabase(userDbName);
      newDb.close();
    }

    // 標記邀請已使用
    db.run('UPDATE invitations SET used_at = CURRENT_TIMESTAMP, used_by = ? WHERE token = ?', [username, token]);

    console.log(`✓ 透過邀請建立帳號: ${username} (${inv.role_level})`);
    res.json({ success: true, message: '帳號建立成功，請使用您的帳號登入。' });
  } catch (error) {
    console.error('邀請註冊錯誤:', error);
    res.status(500).json({ error: error.message });
  }
});

// 取得同資料庫範圍的帳號（db_admin 用）
app.get('/api/my-team-accounts', requireAuth, (req, res) => {
  const myDb = req.session.userDatabase;
  const myAllowed = req.session.allowedDatabases || [];
  const scope = myAllowed.length > 0 ? myAllowed : (myDb ? [myDb] : []);
  if (scope.length === 0) return res.json([]);

  db.all(
    'SELECT id, username, full_name, role_level, permission_level, allowed_databases, user_database, status, created_at FROM accounts WHERE status = ? AND role != ?',
    ['active', 'admin'],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const result = (rows || []).filter(r => {
        const dbs = (() => {
          try { return JSON.parse(r.allowed_databases || '[]'); } catch { return []; }
        })();
        const rDbs = dbs.length > 0 ? dbs : (r.user_database ? [r.user_database] : []);
        return scope.some(d => rDbs.includes(d)) || scope.includes(r.user_database);
      }).map(r => ({
        id: r.id,
        username: r.username,
        full_name: r.full_name,
        role_level: r.role_level || 'user',
        permission_level: r.permission_level || 'editor',
        status: r.status,
        created_at: r.created_at
      }));
      res.json(result);
    }
  );
});

// ==================== 帳號密碼管理 ====================

// 重設使用者密碼（管理員專用）
app.post('/api/admin/accounts/reset-password', requireAdmin, async (req, res) => {
  const { accountId, newPassword } = req.body;
  
  if (!accountId || !newPassword) {
    return res.status(400).json({ error: '缺少必要參數' });
  }
  
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ error: '新密碼長度需至少 6 個字元' });
  }
  
  try {
    const account = await new Promise((resolve, reject) => {
      db.get('SELECT id, username, role FROM accounts WHERE id = ?', [accountId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (!account) {
      return res.status(404).json({ error: '帳號不存在' });
    }
    
    if (account.role === 'admin') {
      return res.status(400).json({ error: '無法透過此功能修改管理員帳號密碼' });
    }
    
    const passwordHash = await argon2.hash(newPassword);
    
    await new Promise((resolve, reject) => {
      db.run('UPDATE accounts SET password_hash = ? WHERE id = ?', [passwordHash, accountId], function(err) {
        if (err) reject(err);
        else if (this.changes === 0) reject(new Error('更新失敗'));
        else resolve();
      });
    });
    
    res.json({ success: true, message: `已更新 ${account.username} 的密碼` });
  } catch (error) {
    console.error('重設密碼失敗:', error);
    res.status(500).json({ error: error.message });
  }
});

// 管理員廣播訊息
app.post('/api/admin/broadcast', requireAdmin, (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: '請提供訊息內容' });
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return res.status(400).json({ error: '訊息內容不得為空' });
  }

  if (trimmed.length > 500) {
    return res.status(400).json({ error: '訊息長度不得超過 500 字元' });
  }

  const createdAt = new Date().toISOString();
  const createdBy = req.session.userId;
  const createdByName = req.session.fullName || req.session.username || '系統';

  db.run(
    'INSERT INTO broadcast_messages (message, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?)',
    [trimmed, createdBy, createdByName, createdAt],
    function(err) {
      if (err) {
        console.error('Failed to insert broadcast message:', err);
        return res.status(500).json({ error: '無法送出訊息' });
      }

      console.log(`✓ Broadcast message sent by ${createdByName}`);
      res.json({
        success: true,
        broadcast: {
          id: this.lastID,
          message: trimmed,
          createdAt,
          createdByName
        }
      });
    }
  );
});

// 取得審計日誌（管理員專用）
app.get('/api/admin/audit-log', requireAdmin, (req, res) => {
  const { username, actionType, resourceType, startDate, endDate, limit = 100, offset = 0 } = req.query;
  
  let sql = `
    SELECT 
      al.id,
      al.account_id,
      al.username,
      al.full_name,
      al.action_type,
      al.resource_type,
      al.resource_id,
      al.resource_name,
      al.old_value,
      al.new_value,
      al.user_database,
      al.ip_address,
      al.user_agent,
      al.created_at
    FROM audit_log al
    WHERE 1=1
  `;
  const params = [];
  
  if (username) {
    sql += ' AND al.username LIKE ?';
    params.push(`%${username}%`);
  }
  
  if (actionType) {
    sql += ' AND al.action_type = ?';
    params.push(actionType);
  }
  
  if (resourceType) {
    sql += ' AND al.resource_type = ?';
    params.push(resourceType);
  }
  
  if (startDate) {
    sql += ' AND DATE(al.created_at) >= ?';
    params.push(startDate);
  }
  
  if (endDate) {
    sql += ' AND DATE(al.created_at) <= ?';
    params.push(endDate);
  }
  
  sql += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Failed to fetch audit log:', err);
      return res.status(500).json({ error: '無法取得審計日誌' });
    }
    
    // 取得總數
    let countSql = 'SELECT COUNT(*) as total FROM audit_log WHERE 1=1';
    const countParams = [];
    
    if (username) {
      countSql += ' AND username LIKE ?';
      countParams.push(`%${username}%`);
    }
    if (actionType) {
      countSql += ' AND action_type = ?';
      countParams.push(actionType);
    }
    if (resourceType) {
      countSql += ' AND resource_type = ?';
      countParams.push(resourceType);
    }
    if (startDate) {
      countSql += ' AND DATE(created_at) >= ?';
      countParams.push(startDate);
    }
    if (endDate) {
      countSql += ' AND DATE(created_at) <= ?';
      countParams.push(endDate);
    }
    
    db.get(countSql, countParams, (err2, countRow) => {
      if (err2) {
        console.error('Failed to count audit log:', err2);
        return res.status(500).json({ error: '無法取得總數' });
      }
      
      res.json({
        logs: rows || [],
        total: countRow?.total || 0,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    });
  });
});

// 取得使用時間統計（管理員專用）
app.get('/api/admin/usage-statistics', requireAdmin, (req, res) => {
  const { username, startDate, endDate, limit = 100, offset = 0 } = req.query;
  
  let sql = `
    SELECT 
      us.id,
      us.account_id,
      us.username,
      us.full_name,
      us.date,
      us.login_count,
      us.total_session_time,
      us.last_login,
      us.last_logout,
      us.created_at,
      us.updated_at
    FROM usage_statistics us
    WHERE 1=1
  `;
  const params = [];
  
  if (username) {
    sql += ' AND us.username LIKE ?';
    params.push(`%${username}%`);
  }
  
  if (startDate) {
    sql += ' AND us.date >= ?';
    params.push(startDate);
  }
  
  if (endDate) {
    sql += ' AND us.date <= ?';
    params.push(endDate);
  }
  
  sql += ' ORDER BY us.date DESC, us.username ASC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Failed to fetch usage statistics:', err);
      return res.status(500).json({ error: '無法取得使用時間統計' });
    }
    
    // 計算會話時間（如果沒有記錄，從 active_sessions 計算）
    const enrichedRows = (rows || []).map(row => {
      let sessionTime = row.total_session_time || 0;
      
      // 如果有登入和登出時間，計算會話時間
      if (row.last_login && row.last_logout) {
        sessionTime = calculateSessionTime(row.last_login, row.last_logout);
      } else if (row.last_login) {
        // 如果只有登入時間，計算到現在的時間
        sessionTime = calculateSessionTime(row.last_login, null);
      }
      
      return {
        ...row,
        total_session_time: sessionTime,
        formatted_session_time: formatTime(sessionTime)
      };
    });
    
    // 取得總數
    let countSql = 'SELECT COUNT(*) as total FROM usage_statistics WHERE 1=1';
    const countParams = [];
    
    if (username) {
      countSql += ' AND username LIKE ?';
      countParams.push(`%${username}%`);
    }
    if (startDate) {
      countSql += ' AND date >= ?';
      countParams.push(startDate);
    }
    if (endDate) {
      countSql += ' AND date <= ?';
      countParams.push(endDate);
    }
    
    db.get(countSql, countParams, (err2, countRow) => {
      if (err2) {
        console.error('Failed to count usage statistics:', err2);
        return res.status(500).json({ error: '無法取得總數' });
      }
      
      res.json({
        statistics: enrichedRows,
        total: countRow?.total || 0,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    });
  });
});

// 格式化時間（秒數轉為可讀格式）
function formatTime(seconds) {
  if (!seconds || seconds < 0) return '0 秒';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  const parts = [];
  if (hours > 0) parts.push(`${hours} 小時`);
  if (minutes > 0) parts.push(`${minutes} 分鐘`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs} 秒`);
  
  return parts.join(' ');
}

// 取得最新廣播訊息
app.get('/api/notifications', requireAuth, (req, res) => {
  const sinceParam = req.query.since ? parseInt(req.query.since, 10) : null;
  const hasSince = Number.isFinite(sinceParam) && sinceParam > 0;
  const sinceIso = hasSince ? new Date(sinceParam).toISOString() : null;

  let sql = 'SELECT id, message, created_by_name, created_at FROM broadcast_messages';
  const params = [];

  if (sinceIso) {
    sql += ' WHERE created_at > ?';
    params.push(sinceIso);
  }

  sql += ' ORDER BY created_at ASC LIMIT 50';

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('Failed to fetch notifications:', err);
      return res.status(500).json({ error: '無法取得訊息' });
    }

    let lastTimestamp = hasSince ? sinceParam : 0;
    const messages = (rows || []).map(row => {
      let ts = Date.parse(row.created_at);
      if (!Number.isFinite(ts)) {
        ts = Date.parse(`${row.created_at}Z`);
      }
      if (!Number.isFinite(ts)) {
        ts = Date.now();
      }
      if (ts > lastTimestamp) lastTimestamp = ts;
      return {
        id: row.id,
        message: row.message,
        createdByName: row.created_by_name || '系統',
        createdAt: row.created_at,
        timestamp: ts
      };
    });

    res.json({
      messages,
      lastTimestamp,
      serverTime: Date.now()
    });
  });
});

// 刪除帳號（管理員專用）
app.delete('/api/admin/accounts/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  
  try {
    // 不能刪除自己的帳號
    if (parseInt(id) === req.session.userId) {
      return res.status(400).json({ error: '不能刪除自己的帳號' });
    }
    
    // 取得帳號資訊
    const account = await new Promise((resolve, reject) => {
      db.get('SELECT user_database FROM accounts WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (!account) {
      return res.status(404).json({ error: '帳號不存在' });
    }
    
    // 刪除帳號
    await new Promise((resolve, reject) => {
      db.run('DELETE FROM accounts WHERE id = ?', [id], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
    
    // 刪除使用者資料庫檔案（選用，可能保留作為備份）
    const dbPath = path.join(DB_DIR, account.user_database);
    if (fs.existsSync(dbPath)) {
      // 備份後刪除
      const backupPath = path.join(DB_DIR, `deleted_${Date.now()}_${account.user_database}`);
      fs.renameSync(dbPath, backupPath);
      console.log(`✓ 資料庫已備份: ${backupPath}`);
    }
    
    console.log(`✓ 帳號已刪除: ID ${id}`);
    res.json({ success: true, message: '帳號已刪除' });
  } catch (error) {
    console.error('刪除帳號失敗:', error);
    res.status(500).json({ error: error.message });
  }
});

// 輔助：建構路徑（加入循環檢測）- 使用全域 db（向後兼容）
function buildPath(id, callback, visited = new Set()) {
  buildPathWithDb(db, id, callback, visited);
}

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

// API: 資料夾
app.get('/api/folders', withUserDatabase, (req, res) => {
  console.log('Hit /api/folders');
  req.userDb.all('SELECT * FROM folders', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});
console.log('Registered /api/folders');

app.get('/api/folders/:id', withUserDatabase, (req, res) => {
  const { id } = req.params;
  console.log(`Hit GET /api/folders/${id}`);
  req.userDb.get('SELECT * FROM folders WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });
});

app.post('/api/folders', withUserDatabase, (req, res) => {
  console.log('Hit POST /api/folders', req.body);
  const { name, parent_id } = req.body;
  req.userDb.run('INSERT INTO folders (name, parent_id) VALUES (?, ?)', [name, parent_id || null], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    const folderId = this.lastID;
    buildPathWithDb(req.userDb, folderId, (err, path) => {
      if (err) return res.status(500).json({ error: err });
      req.userDb.run('UPDATE folders SET path = ? WHERE id = ?', [path, folderId]);
      // 記錄審計日誌
      logAudit(req, 'create', 'folder', folderId, name, null, { name, parent_id, path });
      res.json({ id: folderId, path });
    });
  });
});

app.put('/api/folders/:id', withUserDatabase, (req, res) => {
  const { id } = req.params;
  const { name, parent_id } = req.body;
  console.log('Hit PUT /api/folders/' + id, { name, parent_id });
  
  const userDb = req.userDb;
  
  // 先獲取舊值
  userDb.get('SELECT name, parent_id, path FROM folders WHERE id = ?', [id], (err, oldFolder) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!oldFolder) return res.status(404).json({ error: 'Not found' });
    
    // 更新名稱和父資料夾
    userDb.run('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?', [name, parent_id, id], function(err) {
      if (err || this.changes === 0) return res.status(500).json({ error: err ? err.message : 'Not found' });
      
      // 重新計算此資料夾的路徑
      buildPathWithDb(userDb, id, (err, path) => {
        if (err) return res.status(500).json({ error: err });
        userDb.run('UPDATE folders SET path = ? WHERE id = ?', [path, id], (err2) => {
          if (err2) return res.status(500).json({ error: err2.message });
          
          // 記錄審計日誌
          logAudit(req, 'update', 'folder', parseInt(id), name, oldFolder, { name, parent_id, path });
          
          // 重新計算所有子資料夾的路徑（因為父資料夾可能改變了）
          userDb.all('SELECT id FROM folders WHERE parent_id = ?', [id], (err3, children) => {
            if (err3) return res.status(500).json({ error: err3.message });
            
            // 遞迴更新所有子資料夾的路徑
            const updateChildPaths = (childIds, callback) => {
              if (childIds.length === 0) return callback();
              
              const childId = childIds[0];
              buildPathWithDb(userDb, childId, (err, childPath) => {
                if (err) return callback(err);
                userDb.run('UPDATE folders SET path = ? WHERE id = ?', [childPath, childId], (err2) => {
                  if (err2) return callback(err2);
                  
                  // 查找此子資料夾的子資料夾
                  userDb.all('SELECT id FROM folders WHERE parent_id = ?', [childId], (err3, grandchildren) => {
                    if (err3) return callback(err3);
                    
                    // 遞迴處理
                    updateChildPaths(grandchildren.map(g => g.id), (err4) => {
                      if (err4) return callback(err4);
                      // 繼續處理同層的其他子資料夾
                      updateChildPaths(childIds.slice(1), callback);
                    });
                  });
                });
              });
            };
            
            updateChildPaths(children.map(c => c.id), (err4) => {
              if (err4) return res.status(500).json({ error: err4.message });
              console.log(`✓ Updated folder ${id} and all its descendants`);
              res.json({ success: true });
            });
          });
        });
      });
    });
  });
});

app.delete('/api/folders', withUserDatabase, (req, res) => {
  const { id, force } = req.body;
  console.log('Hit DELETE /api/folders', { id, force });
  
  // 先獲取要刪除的資料夾資訊
  req.userDb.get('SELECT name, parent_id, path FROM folders WHERE id = ?', [id], (err3, folder) => {
    if (err3) return res.status(500).json({ error: err3.message });
    if (!folder) return res.status(404).json({ error: 'Not found' });
    
    // 如果不是強制刪除，檢查是否有子資料夾或權限
    if (!force) {
      // 檢查是否有子資料夾
      req.userDb.get('SELECT COUNT(*) as count FROM folders WHERE parent_id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        
        if (row.count > 0) {
          return res.status(400).json({ 
            error: 'cannot_delete_folder_with_children',
            message: '此資料夾有子資料夾，無法刪除'
          });
        }
        
        // 檢查是否有權限指派
        req.userDb.get('SELECT COUNT(*) as count FROM permissions WHERE folder_id = ?', [id], (err2, row2) => {
          if (err2) return res.status(500).json({ error: err2.message });
          
          if (row2.count > 0) {
            return res.status(400).json({ 
              error: 'cannot_delete_folder_with_permissions',
              message: '此資料夾已被指派權限，無法刪除'
            });
          }
          
          // 可以安全刪除
          req.userDb.run('DELETE FROM folders WHERE id = ?', [id], (err4) => {
            if (err4) return res.status(500).json({ error: err4.message });
            // 記錄審計日誌
            logAudit(req, 'delete', 'folder', parseInt(id), folder.name, folder, null);
            console.log(`✓ Deleted folder: ${id}`);
            res.json({ success: true });
          });
        });
      });
    } else {
      // 強制刪除：先刪除所有子資料夾和相關權限
      // 遞迴刪除所有子資料夾
      function deleteFolderRecursive(folderId, callback) {
        // 先刪除該資料夾的所有權限
        req.userDb.run('DELETE FROM permissions WHERE folder_id = ?', [folderId], (err) => {
          if (err) return callback(err);
          
          // 獲取所有子資料夾
          req.userDb.all('SELECT id FROM folders WHERE parent_id = ?', [folderId], (err2, children) => {
            if (err2) return callback(err2);
            
            // 遞迴刪除每個子資料夾
            if (children && children.length > 0) {
              let completed = 0;
              let hasError = null;
              
              children.forEach(child => {
                deleteFolderRecursive(child.id, (err3) => {
                  if (err3 && !hasError) hasError = err3;
                  completed++;
                  if (completed === children.length) {
                    if (hasError) return callback(hasError);
                    // 刪除子資料夾記錄
                    req.userDb.run('DELETE FROM folders WHERE id = ?', [folderId], callback);
                  }
                });
              });
            } else {
              // 沒有子資料夾，直接刪除
              req.userDb.run('DELETE FROM folders WHERE id = ?', [folderId], callback);
            }
          });
        });
      }
      
      // 開始遞迴刪除
      deleteFolderRecursive(parseInt(id), (err) => {
        if (err) return res.status(500).json({ error: err.message });
        // 記錄審計日誌
        logAudit(req, 'delete', 'folder', parseInt(id), folder.name, { ...folder, force: true }, null);
        console.log(`✓ Force deleted folder: ${id}`);
        res.json({ success: true, force: true });
      });
    }
  });
});

// API: 人員
app.get('/api/users', withUserDatabase, (req, res) => {
  console.log('Hit /api/users');
  req.userDb.all('SELECT * FROM users', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});
console.log('Registered /api/users');

// 獲取在線用戶列表（僅管理員）
app.get('/api/online-users', requireAdmin, (req, res) => {
  console.log('Hit GET /api/online-users');
  
  // 清理超過 30 分鐘沒有活動的會話（從系統資料庫）
  db.run(`DELETE FROM active_sessions 
          WHERE datetime(last_active) < datetime('now', '-30 minutes')`,
    (err) => {
      if (err) console.error('清理過期會話錯誤:', err);
    }
  );
  
  // 從系統資料庫獲取所有用戶的活動會話（15 分鐘內有活動視為在線）
  db.all(
    `SELECT 
      id,
      account_id,
      username,
      full_name,
      user_database,
      login_time,
      last_active,
      ip_address,
      user_agent,
      CAST((julianday('now') - julianday(last_active)) * 24 * 60 AS INTEGER) as idle_minutes
    FROM active_sessions 
    WHERE datetime(last_active) > datetime('now', '-15 minutes')
    ORDER BY last_active DESC`,
    (err, rows) => {
      if (err) {
        console.error('獲取在線用戶錯誤:', err);
        return res.status(500).json({ error: err.message });
      }
      
      res.json({
        online_count: rows ? rows.length : 0,
        users: rows || []
      });
    }
  );
});
console.log('Registered /api/online-users');

// 獲取系統健康狀態（僅管理員）
app.get('/api/system/health', requireAdmin, (req, res) => {
  console.log('Hit GET /api/system/health');
  
  try {
    const health = {
      timestamp: new Date().toISOString(),
      services: {},
      databases: {},
      backups: {},
      system: {}
    };
    
    // 1. 檢查資料庫服務狀態
    try {
      db.get('SELECT COUNT(*) as count FROM accounts', [], (err, row) => {
        if (err) throw err;
        health.services.database = {
          status: 'healthy',
          accounts: row.count
        };
        
        // 2. 檢查資料庫目錄
        const dbFiles = fs.readdirSync(DB_DIR).filter(f => f.endsWith('.db'));
        let totalSize = 0;
        dbFiles.forEach(file => {
          const filePath = path.join(DB_DIR, file);
          const stats = fs.statSync(filePath);
          totalSize += stats.size;
        });
        
        health.databases = {
          count: dbFiles.length,
          totalSize: totalSize,
          totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
          directory: DB_DIR,
          status: 'healthy'
        };
        
        // 3. 檢查備份資訊
        const BACKUP_ROOT = '/opt/backups';
        const backupInfo = {
          directory: BACKUP_ROOT,
          exists: fs.existsSync(BACKUP_ROOT),
          backups: [],
          totalSize: 0,
          status: 'unknown'
        };
        
        if (backupInfo.exists) {
          try {
            const backupFiles = fs.readdirSync(BACKUP_ROOT)
              .filter(f => f.endsWith('.tar.gz') && f.startsWith('auto_'))
              .map(f => {
                const filePath = path.join(BACKUP_ROOT, f);
                const stats = fs.statSync(filePath);
                return {
                  name: f,
                  size: stats.size,
                  sizeMB: (stats.size / 1024 / 1024).toFixed(2),
                  created: stats.birthtime,
                  modified: stats.mtime
                };
              })
              .sort((a, b) => b.modified - a.modified);
            
            backupInfo.backups = backupFiles;
            backupInfo.totalSize = backupFiles.reduce((sum, f) => sum + f.size, 0);
            backupInfo.totalSizeMB = (backupInfo.totalSize / 1024 / 1024).toFixed(2);
            backupInfo.status = backupFiles.length > 0 ? 'healthy' : 'no_backups';
            backupInfo.latestBackup = backupFiles[0] || null;
          } catch (err) {
            backupInfo.status = 'error';
            backupInfo.error = err.message;
          }
        } else {
          backupInfo.status = 'not_configured';
        }
        
        health.backups = backupInfo;
        
        // 4. 檢查在線用戶數
        db.get('SELECT COUNT(*) as count FROM active_sessions WHERE datetime(last_active) > datetime("now", "-15 minutes")', [], (err, row) => {
          if (err) {
            health.services.onlineUsers = { status: 'error', error: err.message };
          } else {
            health.services.onlineUsers = {
              status: 'healthy',
              count: row.count
            };
          }
          
          // 5. 檢查系統資源（磁碟空間）
          try {
            const os = require('os');
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;
            
            health.system = {
              platform: os.platform(),
              arch: os.arch(),
              nodeVersion: process.version,
              uptime: process.uptime(),
              uptimeHours: (process.uptime() / 3600).toFixed(2),
              memory: {
                total: totalMem,
                totalMB: (totalMem / 1024 / 1024).toFixed(2),
                free: freeMem,
                freeMB: (freeMem / 1024 / 1024).toFixed(2),
                used: usedMem,
                usedMB: (usedMem / 1024 / 1024).toFixed(2),
                usagePercent: ((usedMem / totalMem) * 100).toFixed(2)
              }
            };
            
            // 檢查資料庫目錄的磁碟空間
            try {
              const { execSync } = require('child_process');
              const dfOutput = execSync(`df -h "${DB_DIR}"`, { encoding: 'utf8' });
              const lines = dfOutput.trim().split('\n');
              if (lines.length > 1) {
                const parts = lines[1].split(/\s+/);
                health.system.disk = {
                  filesystem: parts[0],
                  size: parts[1],
                  used: parts[2],
                  available: parts[3],
                  usePercent: parts[4],
                  mounted: parts[5]
                };
              }
            } catch (err) {
              health.system.disk = { error: '無法取得磁碟資訊' };
            }
          } catch (err) {
            health.system = { error: err.message };
          }
          
          // 6. 檢查應用程式狀態
          health.services.application = {
            status: 'running',
            port: PORT,
            uptime: process.uptime(),
            uptimeHours: (process.uptime() / 3600).toFixed(2)
          };
          
          res.json(health);
        });
      });
    } catch (err) {
      console.error('Health check error:', err);
      res.status(500).json({ error: err.message });
    }
  } catch (err) {
    console.error('Health check error:', err);
    res.status(500).json({ error: err.message });
  }
});
console.log('Registered /api/system/health');

// 手動執行備份（管理員專用）
app.post('/api/admin/backup/run', requireAdmin, async (req, res) => {
  console.log('Hit POST /api/admin/backup/run');
  
  // 動態偵測備份腳本位置
  const possiblePaths = [
    path.join(__dirname, 'backup_databases.sh'),  // 應用程式目錄
    '/opt/folder-permission-system/backup_databases.sh',  // 預設路徑
    '/root/folder-dev-ins/backup_databases.sh',  // 可能的開發路徑
    path.join(__dirname, '..', 'backup_databases.sh')  // 父目錄
  ];
  
  let BACKUP_SCRIPT = null;
  for (const scriptPath of possiblePaths) {
    if (fs.existsSync(scriptPath)) {
      BACKUP_SCRIPT = scriptPath;
      console.log(`✓ 找到備份腳本：${BACKUP_SCRIPT}`);
      break;
    }
  }
  
  // 檢查備份腳本是否存在
  if (!BACKUP_SCRIPT) {
    console.error('備份腳本搜尋失敗，已嘗試的路徑：', possiblePaths);
    return res.status(404).json({ 
      error: '備份腳本不存在',
      message: '找不到備份腳本，請確認 backup_databases.sh 是否存在',
      searchedPaths: possiblePaths
    });
  }
  
  const BACKUP_ROOT = '/opt/backups';
  const SCRIPT_DIR = path.dirname(BACKUP_SCRIPT);
  
  try {
    // 執行備份腳本（非同步執行，不等待完成）
    exec(`bash "${BACKUP_SCRIPT}"`, { 
      cwd: SCRIPT_DIR,  // 在腳本所在目錄執行
      timeout: 300000 // 5 分鐘超時
    }, (error, stdout, stderr) => {
      if (error) {
        console.error('備份執行錯誤:', error);
        // 即使有錯誤，也可能已經創建了備份，所以繼續檢查
      }
      
      // 記錄審計日誌
      logAudit(req, 'create', 'backup', null, '手動備份', null, {
        script: BACKUP_SCRIPT,
        stdout: stdout?.substring(0, 500), // 只記錄前 500 字元
        error: error ? error.message : null
      });
    });
    
    // 立即返回，不等待備份完成
    res.json({ 
      success: true, 
      message: '備份任務已啟動，正在背景執行中...',
      note: '備份完成後，請重新整理頁面查看最新備份檔案',
      scriptPath: BACKUP_SCRIPT
    });
  } catch (err) {
    console.error('啟動備份失敗:', err);
    res.status(500).json({ 
      error: '啟動備份失敗',
      message: err.message 
    });
  }
});

// 下載備份檔案（管理員專用）
app.get('/api/admin/backup/download/:filename', requireAdmin, (req, res) => {
  const { filename } = req.params;
  const BACKUP_ROOT = '/opt/backups';
  const filePath = path.join(BACKUP_ROOT, filename);
  
  // 安全檢查：確保檔案在備份目錄內
  const resolvedPath = path.resolve(filePath);
  const resolvedBackupRoot = path.resolve(BACKUP_ROOT);
  
  if (!resolvedPath.startsWith(resolvedBackupRoot)) {
    return res.status(403).json({ error: '無權限存取此檔案' });
  }
  
  // 檢查檔案是否存在
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '備份檔案不存在' });
  }
  
  // 檢查是否為備份檔案（只允許下載 .tar.gz 檔案）
  if (!filename.endsWith('.tar.gz') || !filename.startsWith('auto_')) {
    return res.status(403).json({ error: '只能下載自動備份檔案' });
  }
  
  // 記錄審計日誌
  logAudit(req, 'download', 'backup', null, filename, null, {
    filePath: filePath,
    fileSize: fs.statSync(filePath).size
  });
  
  // 下載檔案
  res.download(filePath, filename, (err) => {
    if (err) {
      console.error('下載備份檔案失敗:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: '下載失敗' });
      }
    }
  });
});

// 取得備份檔案列表（管理員專用）
app.get('/api/admin/backup/list', requireAdmin, (req, res) => {
  const BACKUP_ROOT = '/opt/backups';
  
  if (!fs.existsSync(BACKUP_ROOT)) {
    return res.json({ 
      backups: [],
      total: 0,
      message: '備份目錄不存在'
    });
  }
  
  try {
    const backupFiles = fs.readdirSync(BACKUP_ROOT)
      .filter(f => f.endsWith('.tar.gz') && f.startsWith('auto_'))
      .map(f => {
        const filePath = path.join(BACKUP_ROOT, f);
        const stats = fs.statSync(filePath);
        return {
          filename: f,
          size: stats.size,
          sizeMB: (stats.size / 1024 / 1024).toFixed(2),
          created: stats.birthtime,
          modified: stats.mtime,
          downloadUrl: `/api/admin/backup/download/${f}`
        };
      })
      .sort((a, b) => b.modified - a.modified);
    
    res.json({
      backups: backupFiles,
      total: backupFiles.length,
      totalSize: backupFiles.reduce((sum, f) => sum + f.size, 0),
      totalSizeMB: (backupFiles.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024).toFixed(2)
    });
  } catch (err) {
    console.error('取得備份列表失敗:', err);
    res.status(500).json({ 
      error: '取得備份列表失敗',
      message: err.message 
    });
  }
});

// 管理員直接新增使用者（無需審核）
app.post('/api/admin/accounts/create', requireAdmin, async (req, res) => {
  console.log('Hit POST /api/admin/accounts/create');
  const { username, password, full_name, permissionLevel, allowedDatabases } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: '請提供使用者名稱和密碼' });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ error: '密碼長度至少需要 6 個字元' });
  }
  
  // 驗證使用者名稱格式（只允許英數字和底線）
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: '使用者名稱只能包含英數字和底線' });
  }
  
  try {
    // 檢查使用者是否已存在
    const existingUser = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM accounts WHERE username = ?', [username], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (existingUser) {
      return res.status(400).json({ error: '使用者名稱已存在' });
    }
    
    // 雜湊密碼
    const passwordHash = await argon2.hash(password);
    
    // 建立使用者專屬資料庫名稱
    const userDbName = `user_${username}.db`;
    
    // 處理權限設定
    let finalPermissionLevel = permissionLevel === 'viewer' ? 'viewer' : 'editor';
    let serializedAllowed = null;
    
    if (finalPermissionLevel === 'viewer') {
      const sanitized = sanitizeAllowedDatabases(Array.isArray(allowedDatabases) ? allowedDatabases : []);
      if (sanitized.length === 0) {
        return res.status(400).json({ error: '唯讀帳號請至少選擇一個可讀取的資料庫' });
      }
      serializedAllowed = JSON.stringify(sanitized);
    }
    
    // 建立帳號（直接啟用，無需審核）
    const accountId = await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO accounts (username, password_hash, full_name, role, status, user_database, permission_level, allowed_databases) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [username, passwordHash, full_name || null, 'user', 'active', userDbName, finalPermissionLevel, serializedAllowed],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
    
    // 建立使用者專屬資料庫
    const userDb = await connectDatabase(userDbName);
    userDb.close();
    
    console.log(`✓ 管理員建立帳號成功: ${username}, 資料庫: ${userDbName}, 權限: ${finalPermissionLevel}`);
    res.json({ 
      success: true, 
      message: '帳號建立成功',
      accountId: accountId,
      username: username,
      userDatabase: userDbName,
      permissionLevel: finalPermissionLevel,
      status: 'active'
    });
    
  } catch (error) {
    console.error('建立帳號錯誤:', error);
    res.status(500).json({ error: error.message });
  }
});
console.log('Registered /api/admin/accounts/create');

app.get('/api/users/:id', withUserDatabase, (req, res) => {
  const { id } = req.params;
  console.log(`Hit GET /api/users/${id}`);
  req.userDb.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });
});

app.post('/api/users', withUserDatabase, (req, res) => {
  console.log('Hit POST /api/users', req.body);
  const { name, email, department, company, title, phone, description } = req.body;
  req.userDb.run(
    'INSERT INTO users (name, email, department, company, title, phone, description) VALUES (?, ?, ?, ?, ?, ?, ?)', 
    [name, email, department || null, company || null, title || null, phone || null, description || null], 
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      const userId = this.lastID;
      // 記錄審計日誌
      logAudit(req, 'create', 'user', userId, name, null, { name, email, department, company, title, phone, description });
      res.json({ id: userId });
    }
  );
});

app.put('/api/users/:id', withUserDatabase, (req, res) => {
  const { id } = req.params;
  const { name, email, department, company, title, phone, description } = req.body;
  console.log('Hit PUT /api/users/' + id, req.body);
  
  // 先獲取舊值
  req.userDb.get('SELECT name, email, department, company, title, phone, description FROM users WHERE id = ?', [id], (err, oldUser) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!oldUser) return res.status(404).json({ error: 'Not found' });
    
    req.userDb.run(
      'UPDATE users SET name = ?, email = ?, department = ?, company = ?, title = ?, phone = ?, description = ? WHERE id = ?', 
      [name, email, department || null, company || null, title || null, phone || null, description || null, id], 
      (err2) => {
        if (err2 || this.changes === 0) return res.status(500).json({ error: err2 ? err2.message : 'Not found' });
        // 記錄審計日誌
        logAudit(req, 'update', 'user', parseInt(id), name, oldUser, { name, email, department, company, title, phone, description });
        res.json({ success: true });
      }
    );
  });
});

app.delete('/api/users', withUserDatabase, (req, res) => {
  const { id } = req.body;
  console.log('Hit DELETE /api/users', { id });
  
  // 先檢查是否有關聯的權限
  req.userDb.all(`
    SELECT p.id, p.permission_type, f.name as folder_name, f.path as folder_path
    FROM permissions p
    LEFT JOIN folders f ON p.folder_id = f.id
    WHERE p.user_id = ?
  `, [id], (err, permissions) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (permissions && permissions.length > 0) {
      // 有關聯的權限，禁止刪除
      return res.status(400).json({ 
        error: 'cannot_delete_user_with_permissions',
        message: '此人員已被指派權限，無法刪除',
        permissions: permissions.map(p => ({
          id: p.id,
          folder: p.folder_path || p.folder_name || '未知資料夾',
          permission_type: p.permission_type
        }))
      });
    }
    
    // 先獲取要刪除的人員資訊
    req.userDb.get('SELECT name, email, department, company, title, phone, description FROM users WHERE id = ?', [id], (err2, user) => {
      if (err2) return res.status(500).json({ error: err2.message });
      if (!user) return res.status(404).json({ error: 'Not found' });
      
      // 沒有關聯的權限，可以刪除
      req.userDb.run('DELETE FROM users WHERE id = ?', [id], (err3) => {
        if (err3) return res.status(500).json({ error: err3.message });
        // 記錄審計日誌
        logAudit(req, 'delete', 'user', parseInt(id), user.name, user, null);
        res.json({ success: true });
      });
    });
  });
});

// 批次刪除人員
app.delete('/api/users/batch', withUserDatabase, (req, res) => {
  const { ids } = req.body;
  console.log('Hit DELETE /api/users/batch', { ids });
  
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  
  const deleted = [];
  const failed = [];
  let processed = 0;
  const total = ids.length;
  
  if (total === 0) {
    return res.json({ success: true, deleted: 0, failed: 0, deleted_ids: [], failed_ids: [] });
  }
  
  ids.forEach((id) => {
    // 檢查是否有關聯的權限
    req.userDb.all(`
      SELECT p.id, p.permission_type, f.name as folder_name, f.path as folder_path
      FROM permissions p
      LEFT JOIN folders f ON p.folder_id = f.id
      WHERE p.user_id = ?
    `, [id], (err, permissions) => {
      if (err) {
        failed.push({ id, error: err.message });
        processed++;
        if (processed === total) {
          res.json({ success: true, deleted: deleted.length, failed: failed.length, deleted_ids: deleted, failed_ids: failed });
        }
        return;
      }
      
      if (permissions && permissions.length > 0) {
        failed.push({ id, error: '已被指派權限，無法刪除' });
        processed++;
        if (processed === total) {
          res.json({ success: true, deleted: deleted.length, failed: failed.length, deleted_ids: deleted, failed_ids: failed });
        }
        return;
      }
      
      // 獲取要刪除的人員資訊
      req.userDb.get('SELECT name, email, department, company, title, phone, description FROM users WHERE id = ?', [id], (err2, user) => {
        if (err2) {
          failed.push({ id, error: err2.message });
          processed++;
          if (processed === total) {
            res.json({ success: true, deleted: deleted.length, failed: failed.length, deleted_ids: deleted, failed_ids: failed });
          }
          return;
        }
        
        if (!user) {
          failed.push({ id, error: 'Not found' });
          processed++;
          if (processed === total) {
            res.json({ success: true, deleted: deleted.length, failed: failed.length, deleted_ids: deleted, failed_ids: failed });
          }
          return;
        }
        
        // 刪除人員
        req.userDb.run('DELETE FROM users WHERE id = ?', [id], (err3) => {
          if (err3) {
            failed.push({ id, error: err3.message });
          } else {
            deleted.push(id);
            logAudit(req, 'delete', 'user', parseInt(id), user.name, user, null);
          }
          
          processed++;
          if (processed === total) {
            res.json({ success: true, deleted: deleted.length, failed: failed.length, deleted_ids: deleted, failed_ids: failed });
          }
        });
      });
    });
  });
});

// API: 群組
app.get('/api/groups', withUserDatabase, (req, res) => {
  console.log('Hit /api/groups');
  req.userDb.all('SELECT * FROM groups', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});
console.log('Registered /api/groups');

app.get('/api/groups/:id', withUserDatabase, (req, res) => {
  const { id } = req.params;
  console.log(`Hit GET /api/groups/${id}`);
  req.userDb.get('SELECT * FROM groups WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });
});

app.post('/api/groups', withUserDatabase, (req, res) => {
  console.log('Hit POST /api/groups', req.body);
  const { name } = req.body;
  req.userDb.run('INSERT INTO groups (name) VALUES (?)', [name], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    const groupId = this.lastID;
    // 記錄審計日誌
    logAudit(req, 'create', 'group', groupId, name, null, { name });
    res.json({ id: groupId });
  });
});

app.put('/api/groups/:id', withUserDatabase, (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  console.log('Hit PUT /api/groups/' + id, { name });
  
  // 先獲取舊值
  req.userDb.get('SELECT name FROM groups WHERE id = ?', [id], (err, oldGroup) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!oldGroup) return res.status(404).json({ error: 'Not found' });
    
    req.userDb.run('UPDATE groups SET name = ? WHERE id = ?', [name, id], (err2) => {
      if (err2 || this.changes === 0) return res.status(500).json({ error: err2 ? err2.message : 'Not found' });
      // 記錄審計日誌
      logAudit(req, 'update', 'group', parseInt(id), name, oldGroup, { name });
      res.json({ success: true });
    });
  });
});

app.delete('/api/groups', withUserDatabase, (req, res) => {
  const { id } = req.body;
  console.log('Hit DELETE /api/groups', { id });
  
  // 先檢查是否有關聯的權限
  req.userDb.all(`
    SELECT p.id, p.permission_type, f.name as folder_name, f.path as folder_path
    FROM permissions p
    LEFT JOIN folders f ON p.folder_id = f.id
    WHERE p.group_id = ?
  `, [id], (err, permissions) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (permissions && permissions.length > 0) {
      // 有關聯的權限，禁止刪除
      return res.status(400).json({ 
        error: 'cannot_delete_group_with_permissions',
        message: '此群組已被指派權限，無法刪除',
        permissions: permissions.map(p => ({
          id: p.id,
          folder: p.folder_path || p.folder_name || '未知資料夾',
          permission_type: p.permission_type
        }))
      });
    }
    
    // 先獲取要刪除的群組資訊
    req.userDb.get('SELECT name FROM groups WHERE id = ?', [id], (err2, group) => {
      if (err2) return res.status(500).json({ error: err2.message });
      if (!group) return res.status(404).json({ error: 'Not found' });
      
      // 沒有關聯的權限，可以刪除
      req.userDb.run('DELETE FROM groups WHERE id = ?', [id], (err3) => {
        if (err3) return res.status(500).json({ error: err3.message });
        // 記錄審計日誌
        logAudit(req, 'delete', 'group', parseInt(id), group.name, group, null);
        res.json({ success: true });
      });
    });
  });
});

// 批次刪除群組
app.delete('/api/groups/batch', withUserDatabase, (req, res) => {
  const { ids } = req.body;
  console.log('Hit DELETE /api/groups/batch', { ids });
  
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  
  const deleted = [];
  const failed = [];
  let processed = 0;
  const total = ids.length;
  
  if (total === 0) {
    return res.json({ success: true, deleted: 0, failed: 0, deleted_ids: [], failed_ids: [] });
  }
  
  ids.forEach((id) => {
    // 檢查是否有關聯的權限
    req.userDb.all(`
      SELECT p.id, p.permission_type, f.name as folder_name, f.path as folder_path
      FROM permissions p
      LEFT JOIN folders f ON p.folder_id = f.id
      WHERE p.group_id = ?
    `, [id], (err, permissions) => {
      if (err) {
        failed.push({ id, error: err.message });
        processed++;
        if (processed === total) {
          res.json({ success: true, deleted: deleted.length, failed: failed.length, deleted_ids: deleted, failed_ids: failed });
        }
        return;
      }
      
      if (permissions && permissions.length > 0) {
        failed.push({ id, error: '已被指派權限，無法刪除' });
        processed++;
        if (processed === total) {
          res.json({ success: true, deleted: deleted.length, failed: failed.length, deleted_ids: deleted, failed_ids: failed });
        }
        return;
      }
      
      // 獲取要刪除的群組資訊
      req.userDb.get('SELECT name FROM groups WHERE id = ?', [id], (err2, group) => {
        if (err2) {
          failed.push({ id, error: err2.message });
          processed++;
          if (processed === total) {
            res.json({ success: true, deleted: deleted.length, failed: failed.length, deleted_ids: deleted, failed_ids: failed });
          }
          return;
        }
        
        if (!group) {
          failed.push({ id, error: 'Not found' });
          processed++;
          if (processed === total) {
            res.json({ success: true, deleted: deleted.length, failed: failed.length, deleted_ids: deleted, failed_ids: failed });
          }
          return;
        }
        
        // 刪除群組
        req.userDb.run('DELETE FROM groups WHERE id = ?', [id], (err3) => {
          if (err3) {
            failed.push({ id, error: err3.message });
          } else {
            deleted.push(id);
            logAudit(req, 'delete', 'group', parseInt(id), group.name, group, null);
          }
          
          processed++;
          if (processed === total) {
            res.json({ success: true, deleted: deleted.length, failed: failed.length, deleted_ids: deleted, failed_ids: failed });
          }
        });
      });
    });
  });
});

// 群組-人員
app.get('/api/groups/:id/users', withUserDatabase, (req, res) => {
  const { id } = req.params;
  console.log('Hit /api/groups/' + id + '/users');
  req.userDb.all('SELECT u.* FROM users u JOIN group_users gu ON u.id = gu.user_id WHERE gu.group_id = ?', [id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// 獲取人員所屬的群組
app.get('/api/users/:id/groups', withUserDatabase, (req, res) => {
  const { id } = req.params;
  console.log('Hit /api/users/' + id + '/groups');
  req.userDb.all('SELECT g.* FROM groups g JOIN group_users gu ON g.id = gu.group_id WHERE gu.user_id = ?', [id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/groups/:id/users', withUserDatabase, (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;
  console.log('Hit POST /api/groups/' + id + '/users', { user_id });
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  
  // 先獲取群組和人員資訊以便記錄
  req.userDb.get(`
    SELECT g.name as group_name, u.name as user_name
    FROM groups g, users u
    WHERE g.id = ? AND u.id = ?
  `, [parseInt(id), parseInt(user_id)], (err, info) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!info) return res.status(404).json({ error: 'Group or user not found' });
    
    req.userDb.run('INSERT INTO group_users (group_id, user_id) VALUES (?, ?)', [parseInt(id), parseInt(user_id)], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      
      // 記錄審計日誌
      const resourceName = `${info.group_name} ← ${info.user_name}`;
      logAudit(req, 'update', 'group', parseInt(id), resourceName, null, {
        action: 'add_user_to_group',
        group_id: parseInt(id),
        group_name: info.group_name,
        user_id: parseInt(user_id),
        user_name: info.user_name
      });
      
      res.json({ success: true });
    });
  });
});

app.delete('/api/groups/:id/users', withUserDatabase, (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;
  console.log('Hit DELETE /api/groups/' + id + '/users', { user_id });
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  
  // 先獲取群組和人員資訊以便記錄
  req.userDb.get(`
    SELECT g.name as group_name, u.name as user_name
    FROM groups g, users u
    WHERE g.id = ? AND u.id = ?
  `, [parseInt(id), parseInt(user_id)], (err, info) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!info) return res.status(404).json({ error: 'Group or user not found' });
    
    req.userDb.run('DELETE FROM group_users WHERE group_id = ? AND user_id = ?', [parseInt(id), parseInt(user_id)], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      
      // 記錄審計日誌
      const resourceName = `${info.group_name} ← ${info.user_name}`;
      logAudit(req, 'update', 'group', parseInt(id), resourceName, {
        action: 'remove_user_from_group',
        group_id: parseInt(id),
        group_name: info.group_name,
        user_id: parseInt(user_id),
        user_name: info.user_name
      }, null);
      
      res.json({ success: true });
    });
  });
});

// API: 權限 (修復：加 folder_id 驗證)
app.get('/api/permissions', withUserDatabase, (req, res) => {
  console.log('Hit /api/permissions');
  req.userDb.all(`SELECT p.*, f.path, u.name as user_name, g.name as group_name
          FROM permissions p
          LEFT JOIN folders f ON p.folder_id = f.id
          LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN groups g ON p.group_id = g.id`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});
console.log('Registered /api/permissions');

app.post('/api/permissions', withUserDatabase, (req, res) => {
  console.log('Hit POST /api/permissions', req.body);
  const { folder_id, user_id, group_id, permission_type } = req.body;
  // 修復：驗證 folder_id 必須為有效數字
  if (!folder_id || isNaN(folder_id) || folder_id <= 0) {
    console.error('Invalid folder_id:', folder_id);
    return res.status(400).json({ error: 'folder_id must be a positive integer' });
  }
  
  // 先獲取相關資訊以便記錄
  req.userDb.get(`
    SELECT f.path as folder_path, f.name as folder_name,
           u.name as user_name, g.name as group_name
    FROM folders f
    LEFT JOIN users u ON u.id = ?
    LEFT JOIN groups g ON g.id = ?
    WHERE f.id = ?
  `, [user_id || null, group_id || null, folder_id], (err, info) => {
    if (err) {
      console.error('Get permission info error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    
    req.userDb.run('INSERT INTO permissions (folder_id, user_id, group_id, permission_type) VALUES (?, ?, ?, ?)',
      [parseInt(folder_id), user_id ? parseInt(user_id) : null, group_id ? parseInt(group_id) : null, permission_type], function(err2) {
      if (err2) {
        console.error('Insert permission error:', err2.message);
        return res.status(500).json({ error: err2.message });
      }
      const permissionId = this.lastID;
      
      // 構建資源名稱
      const resourceName = info ? 
        `${info.folder_path || info.folder_name || '資料夾'}: ${info.user_name || info.group_name || '未知'}` : 
        `資料夾 ${folder_id}`;
      
      // 記錄審計日誌
      logAudit(req, 'create', 'permission', permissionId, resourceName, null, {
        folder_id,
        user_id,
        group_id,
        permission_type,
        folder_path: info?.folder_path,
        user_name: info?.user_name,
        group_name: info?.group_name
      });
      
      res.json({ id: permissionId });
    });
  });
});

app.delete('/api/permissions', withUserDatabase, (req, res) => {
  const { id } = req.body;
  console.log('Hit DELETE /api/permissions', { id });
  
  // 先獲取要刪除的權限資訊
  req.userDb.get(`
    SELECT p.*, f.path as folder_path, f.name as folder_name,
           u.name as user_name, g.name as group_name
    FROM permissions p
    LEFT JOIN folders f ON p.folder_id = f.id
    LEFT JOIN users u ON p.user_id = u.id
    LEFT JOIN groups g ON p.group_id = g.id
    WHERE p.id = ?
  `, [id], (err, permission) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!permission) return res.status(404).json({ error: 'Not found' });
    
    // 構建資源名稱
    const resourceName = `${permission.folder_path || permission.folder_name || '資料夾'}: ${permission.user_name || permission.group_name || '未知'}`;
    
    req.userDb.run('DELETE FROM permissions WHERE id = ?', [id], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      
      // 記錄審計日誌
      logAudit(req, 'delete', 'permission', parseInt(id), resourceName, {
        folder_id: permission.folder_id,
        user_id: permission.user_id,
        group_id: permission.group_id,
        permission_type: permission.permission_type,
        folder_path: permission.folder_path,
        user_name: permission.user_name,
        group_name: permission.group_name
      }, null);
      
      res.json({ success: true });
    });
  });
});

// 批次刪除權限
app.delete('/api/permissions/batch', withUserDatabase, (req, res) => {
  const { ids } = req.body;
  console.log('Hit DELETE /api/permissions/batch', { ids });
  
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  
  const deleted = [];
  const failed = [];
  let processed = 0;
  const total = ids.length;
  
  if (total === 0) {
    return res.json({ success: true, deleted: 0, failed: 0, deleted_ids: [], failed_ids: [] });
  }
  
  ids.forEach((id) => {
    // 獲取要刪除的權限資訊
    req.userDb.get(`
      SELECT p.*, f.path as folder_path, f.name as folder_name,
             u.name as user_name, g.name as group_name
      FROM permissions p
      LEFT JOIN folders f ON p.folder_id = f.id
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN groups g ON p.group_id = g.id
      WHERE p.id = ?
    `, [id], (err, permission) => {
      if (err) {
        failed.push({ id, error: err.message });
        processed++;
        if (processed === total) {
          res.json({ success: true, deleted: deleted.length, failed: failed.length, deleted_ids: deleted, failed_ids: failed });
        }
        return;
      }
      
      if (!permission) {
        failed.push({ id, error: 'Not found' });
        processed++;
        if (processed === total) {
          res.json({ success: true, deleted: deleted.length, failed: failed.length, deleted_ids: deleted, failed_ids: failed });
        }
        return;
      }
      
      // 構建資源名稱
      const resourceName = `${permission.folder_path || permission.folder_name || '資料夾'}: ${permission.user_name || permission.group_name || '未知'}`;
      
      // 刪除權限
      req.userDb.run('DELETE FROM permissions WHERE id = ?', [id], (err2) => {
        if (err2) {
          failed.push({ id, error: err2.message });
        } else {
          deleted.push(id);
          logAudit(req, 'delete', 'permission', parseInt(id), resourceName, {
            folder_id: permission.folder_id,
            user_id: permission.user_id,
            group_id: permission.group_id,
            permission_type: permission.permission_type,
            folder_path: permission.folder_path,
            user_name: permission.user_name,
            group_name: permission.group_name
          }, null);
        }
        
        processed++;
        if (processed === total) {
          res.json({ success: true, deleted: deleted.length, failed: failed.length, deleted_ids: deleted, failed_ids: failed });
        }
      });
    });
  });
});

// 清空所有資料（使用 Promise 確保操作完成）
app.post('/api/clear_all', withUserDatabase, async (req, res) => {
  console.log('Hit /api/clear_all - Clearing all data');
  const { confirm } = req.body;
  
  // 安全確認
  if (confirm !== 'CLEAR_ALL_DATA') {
    return res.status(400).json({ error: 'Confirmation code incorrect' });
  }
  
  try {
    // 依序刪除所有資料（注意外鍵關係）
    const tables = ['permissions', 'group_users', 'groups', 'users', 'folders'];
    
    for (const table of tables) {
      await new Promise((resolve, reject) => {
        req.userDb.run(`DELETE FROM ${table}`, (err) => {
          if (err) {
            console.error(`Error clearing ${table}:`, err);
            reject(err);
          } else {
            console.log(`✓ Cleared ${table} (user: ${req.session.username})`);
            resolve();
          }
        });
      });
    }
    
    // 重置自動遞增 ID
    await new Promise((resolve, reject) => {
      req.userDb.run('DELETE FROM sqlite_sequence', (err) => {
        if (err) {
          console.error('Error resetting sequences:', err);
          reject(err);
        } else {
          console.log('✓ Reset sequences');
          resolve();
        }
      });
    });
    
    console.log(`All data cleared successfully for user: ${req.session.username}`);
    res.json({ success: true, message: 'All data cleared' });
  } catch (error) {
    console.error('Clear all error:', error);
    res.status(500).json({ error: 'Failed to clear data: ' + error.message });
  }
});

// 匯出權限 CSV (UTF-8 with BOM)
app.get('/export_csv', ensureEditorAccess, withUserDatabase, (req, res) => {
  console.log('Hit /export_csv');
  req.userDb.all(`SELECT p.*, f.path, f.name as folder_name, u.name as user_name, g.name as group_name
          FROM permissions p
          LEFT JOIN folders f ON p.folder_id = f.id
          LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN groups g ON p.group_id = g.id
          ORDER BY p.id`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // 手動建立 CSV 內容，並加入 UTF-8 BOM
    // 使用標準格式，可直接匯入
    const BOM = '\uFEFF';
    const headers = ['type', 'folder_id', 'user_id', 'group_id', 'permission_type', 'folder_path', 'user_name', 'group_name'];
    let csvContent = BOM + headers.join(',') + '\n';
    
    (rows || []).forEach(row => {
      const values = [
        'permission',
        row.folder_id || '',
        row.user_id || '',
        row.group_id || '',
        row.permission_type || '',
        row.path || row.folder_name || '',
        row.user_name || '',
        row.group_name || ''
      ].map(val => {
        // 如果欄位包含逗號、引號或換行符號，需要用引號包起來
        const strVal = String(val);
        if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
          return `"${strVal.replace(/"/g, '""')}"`;
        }
        return strVal;
      });
      csvContent += values.join(',') + '\n';
    });
    
    console.log(`Exported ${rows.length} permissions`);
    
    // 寫入檔案
    const tempFile = 'temp_permissions.csv';
    fs.writeFileSync(tempFile, csvContent, 'utf8');
    
    // 設置正確的 Content-Type 並下載
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.download(tempFile, 'permissions.csv', (err) => {
      if (err) console.error('Download error:', err);
      // 下載完成後刪除暫存檔
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });
  });
});

// 匯出資料夾 CSV (UTF-8 with BOM)
app.get('/export_folders_csv', withUserDatabase, (req, res) => {
  console.log('Hit /export_folders_csv');
  req.userDb.all('SELECT * FROM folders ORDER BY id', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // 手動建立 CSV 內容，並加入 UTF-8 BOM
    const BOM = '\uFEFF';
    const headers = ['type', 'name', 'parent_id'];
    let csvContent = BOM + headers.join(',') + '\n';
    
    (rows || []).forEach(row => {
      const values = [
        'folder',
        row.name || '',
        row.parent_id || ''
      ].map(val => {
        const strVal = String(val);
        if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
          return `"${strVal.replace(/"/g, '""')}"`;
        }
        return strVal;
      });
      csvContent += values.join(',') + '\n';
    });
    
    // 寫入檔案
    const tempFile = 'temp_folders.csv';
    fs.writeFileSync(tempFile, csvContent, 'utf8');
    
    // 設置正確的 Content-Type 並下載
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.download(tempFile, 'folders.csv', (err) => {
      if (err) console.error('Download error:', err);
      // 下載完成後刪除暫存檔
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });
  });
});

// 匯出人員 CSV (UTF-8 with BOM)
app.get('/export_users_csv', withUserDatabase, (req, res) => {
  console.log('Hit /export_users_csv');
  req.userDb.all('SELECT * FROM users ORDER BY id', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // 手動建立 CSV 內容，並加入 UTF-8 BOM
    const BOM = '\uFEFF';
    const headers = ['type', 'name', 'email', 'department', 'company', 'title', 'phone', 'description'];
    let csvContent = BOM + headers.join(',') + '\n';
    
    (rows || []).forEach(row => {
      const values = [
        'user',
        row.name || '',
        row.email || '',
        row.department || '',
        row.company || '',
        row.title || '',
        row.phone || '',
        row.description || ''
      ].map(val => {
        const strVal = String(val);
        if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
          return `"${strVal.replace(/"/g, '""')}"`;
        }
        return strVal;
      });
      csvContent += values.join(',') + '\n';
    });
    
    // 寫入檔案
    const tempFile = 'temp_users.csv';
    fs.writeFileSync(tempFile, csvContent, 'utf8');
    
    // 設置正確的 Content-Type 並下載
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.download(tempFile, 'users.csv', (err) => {
      if (err) console.error('Download error:', err);
      // 下載完成後刪除暫存檔
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });
  });
});

// 匯出群組 CSV (UTF-8 with BOM)
app.get('/export_groups_csv', withUserDatabase, async (req, res) => {
  console.log('Hit /export_groups_csv');
  
  try {
    // 1. 先取得所有群組
    const groups = await new Promise((resolve, reject) => {
      req.userDb.all('SELECT * FROM groups ORDER BY id', (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    // 2. 取得所有群組成員關係
    const groupMembers = await new Promise((resolve, reject) => {
      req.userDb.all(`
        SELECT gu.group_id, gu.user_id, u.name as user_name, u.email
        FROM group_users gu
        LEFT JOIN users u ON gu.user_id = u.id
        ORDER BY gu.group_id, gu.user_id
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    // 3. 手動建立 CSV 內容，並加入 UTF-8 BOM
    const BOM = '\uFEFF';
    const headers = ['type', 'name', 'group_id', 'user_id'];
    let csvContent = BOM + headers.join(',') + '\n';
    
    // 4. 先輸出所有群組
    groups.forEach(group => {
      const values = [
        'group',
        group.name || '',
        '',
        ''
      ].map(val => {
        const strVal = String(val);
        if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
          return `"${strVal.replace(/"/g, '""')}"`;
        }
        return strVal;
      });
      csvContent += values.join(',') + '\n';
    });
    
    // 5. 再輸出所有群組成員關係
    groupMembers.forEach(member => {
      const values = [
        'group_member',
        '', // name 欄位留空
        member.group_id || '',
        member.user_id || ''
      ].map(val => {
        const strVal = String(val);
        if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
          return `"${strVal.replace(/"/g, '""')}"`;
        }
        return strVal;
      });
      csvContent += values.join(',') + '\n';
    });
    
    // 6. 寫入檔案
    const tempFile = 'temp_groups.csv';
    fs.writeFileSync(tempFile, csvContent, 'utf8');
    
    console.log(`Exported ${groups.length} groups and ${groupMembers.length} group members`);
    
    // 7. 設置正確的 Content-Type 並下載
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.download(tempFile, 'groups.csv', (err) => {
      if (err) console.error('Download error:', err);
      // 下載完成後刪除暫存檔
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });
  } catch (error) {
    console.error('Export groups error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 匯出完整資料 CSV（一次性匯出所有資料：資料夾、人員、群組、群組成員、權限）
app.get('/export_full_csv', ensureEditorAccess, withUserDatabase, async (req, res) => {
  console.log('Hit /export_full_csv - Exporting all data');
  
  try {
    // 1. 查詢所有資料夾
    const allFolders = await new Promise((resolve, reject) => {
      req.userDb.all(`SELECT id, name, parent_id FROM folders ORDER BY id`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    // 依賴排序：確保父資料夾在子資料夾之前
    const folders = [];
    const processed = new Set();
    const folderMap = {};
    
    allFolders.forEach(f => {
      folderMap[f.id] = f;
    });
    
    function processFolder(folder) {
      if (processed.has(folder.id)) return;
      
      // 如果有父資料夾，先處理父資料夾
      if (folder.parent_id) {
        const parent = folderMap[folder.parent_id];
        if (parent && !processed.has(parent.id)) {
          processFolder(parent);
        }
      }
      
      folders.push(folder);
      processed.add(folder.id);
    }
    
    allFolders.forEach(folder => {
      processFolder(folder);
    });
    
    // 建立資料夾 ID 到名稱的映射
    const folderIdToName = {};
    folders.forEach(f => {
      folderIdToName[f.id] = f.name;
    });
    
    // 2. 查詢所有人員
    const users = await new Promise((resolve, reject) => {
      req.userDb.all(`SELECT id, name, email, department, company, title, phone, description FROM users ORDER BY id`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    // 建立人員 ID 到名稱的映射
    const userIdToName = {};
    users.forEach(u => {
      userIdToName[u.id] = u.name;
    });
    
    // 3. 查詢所有群組
    const groups = await new Promise((resolve, reject) => {
      req.userDb.all(`SELECT id, name FROM groups ORDER BY id`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    // 建立群組 ID 到名稱的映射
    const groupIdToName = {};
    groups.forEach(g => {
      groupIdToName[g.id] = g.name;
    });
    
    // 4. 查詢所有群組成員關係（只包含有效關係）
    const groupMembers = await new Promise((resolve, reject) => {
      req.userDb.all(`
        SELECT gu.group_id, gu.user_id, g.name as group_name, u.name as user_name
        FROM group_users gu
        INNER JOIN groups g ON gu.group_id = g.id
        INNER JOIN users u ON gu.user_id = u.id
        ORDER BY gu.group_id, gu.user_id
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    // 5. 查詢所有權限
    const permissions = await new Promise((resolve, reject) => {
      req.userDb.all(`
        SELECT p.folder_id, p.user_id, p.group_id, p.permission_type,
               f.name as folder_name, u.name as user_name, g.name as group_name
        FROM permissions p
        LEFT JOIN folders f ON p.folder_id = f.id
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN groups g ON p.group_id = g.id
        ORDER BY p.id
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    // 6. 建立 CSV 內容（使用 UTF-8 BOM）
    const BOM = '\uFEFF';
    let csvContent = BOM;
    
    // 輔助函數：轉義 CSV 值
    const escapeCSV = (val) => {
      const strVal = String(val || '');
      if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
        return `"${strVal.replace(/"/g, '""')}"`;
      }
      return strVal;
    };
    
    // 使用統一的標題行（包含所有可能的欄位）
    // type,name,parent_name,email,department,company,title,phone,description,group_name,user_name,folder_name,permission_type
    csvContent += 'type,name,parent_name,email,department,company,title,phone,description,group_name,user_name,folder_name,permission_type\n';
    
    // 6.1 匯出資料夾（使用名稱和父資料夾名稱，已按依賴順序排序）
    folders.forEach(folder => {
      if (!folder.parent_id) {
        // 根資料夾
        csvContent += `folder,${escapeCSV(folder.name)},,,,,,,,,,,\n`;
      } else {
        // 子資料夾
        const parentName = folderIdToName[folder.parent_id] || '';
        csvContent += `folder,${escapeCSV(folder.name)},${escapeCSV(parentName)},,,,,,,,,,,\n`;
      }
    });

    // 6.2 匯出人員
    users.forEach(user => {
      csvContent += `user,${escapeCSV(user.name)},,${escapeCSV(user.email)},${escapeCSV(user.department || '')},${escapeCSV(user.company || '')},${escapeCSV(user.title || '')},${escapeCSV(user.phone || '')},${escapeCSV(user.description || '')},,,,\n`;
    });

    // 6.3 匯出群組
    groups.forEach(group => {
      csvContent += `group,${escapeCSV(group.name)},,,,,,,,,,,\n`;
    });

    // 6.4 匯出群組成員（使用群組名稱和人員名稱）
    // 使用 INNER JOIN 確保只匯出有效關係
    groupMembers.forEach(member => {
      csvContent += `group_member,,,,,,,,,${escapeCSV(member.group_name)},${escapeCSV(member.user_name)},,\n`;
    });

    // 6.5 匯出權限（使用資料夾名稱、群組名稱/人員名稱）
    permissions.forEach(perm => {
      csvContent += `permission,,,,,,,,,${escapeCSV(perm.group_name)},${escapeCSV(perm.user_name)},${escapeCSV(perm.folder_name)},${escapeCSV(perm.permission_type)}\n`;
    });
    
    console.log(`Exported full data: ${folders.length} folders, ${users.length} users, ${groups.length} groups, ${groupMembers.length} group members, ${permissions.length} permissions`);
    
    // 7. 寫入檔案
    const tempFile = 'temp_full_data.csv';
    fs.writeFileSync(tempFile, csvContent, 'utf8');
    
    // 8. 設置正確的 Content-Type 並下載
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.download(tempFile, `full_data_${new Date().toISOString().slice(0, 10)}.csv`, (err) => {
      if (err) console.error('Download error:', err);
      // 下載完成後刪除暫存檔
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });
  } catch (error) {
    console.error('Export full data error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 匯入 CSV (改用 Promise 確保操作完成)
const upload = multer({ dest: UPLOAD_DIR });
app.post('/import_csv', withUserDatabase, upload.single('file'), (req, res) => {
  console.log('Hit /import_csv');
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const results = [];
  
  fs.createReadStream(req.file.path)
    .pipe(csv({
      mapHeaders: ({ header }) => {
        // 清理欄位名稱：移除引號、空格、BOM
        return header.replace(/^['"\uFEFF\s]+|['"\s]+$/g, '').trim();
      }
    }))
    .on('data', (row) => {
      console.log('CSV row read:', row);
      results.push(row);
    })
    .on('end', async () => {
      try {
        console.log(`CSV parsing completed. Total rows: ${results.length}`);
        if (results.length > 0) {
          console.log('First row keys:', Object.keys(results[0]));
          console.log('First row values:', results[0]);
        }
        
        let importCount = 0;
        const stats = {
          folders: 0,
          users: 0,
          groups: 0,
          group_members: 0,
          permissions: 0
        };

        const importMode = req.body.mode === 'full_replace' ? 'full_replace' : 'diff_only';
        const historyDetails = [];
        const permStats = { added: 0, updated: 0, deleted: 0, skipped: 0 };
        const seenPermKeys = new Set();       // 追蹤本次匯入的直接權限 key
        const seenGroupMemberKeys = new Set(); // 追蹤本次匯入的群組成員 key (group_id|user_id)
        const affectedGroupIds = new Set();    // 本次有出現的群組，full_replace 時用來清除舊成員

        // 定義處理順序（確保依賴關係正確）
        // 順序：folder → user → group → group_member → permission
        const typeOrder = {
          'folder': 1,
          'user': 2,
          'group': 3,
          'group_member': 4,
          'permission': 5
        };
        
        // 按照類型排序，確保處理順序正確
        results.sort((a, b) => {
          const typeA = (a.type || a.Type || a.TYPE || '').toLowerCase();
          const typeB = (b.type || b.Type || b.TYPE || '').toLowerCase();
          const orderA = typeOrder[typeA] || 999;
          const orderB = typeOrder[typeB] || 999;
          
          // 如果類型相同，保持原始順序（對於資料夾的依賴排序很重要）
          if (orderA === orderB && typeA === 'folder') {
            // 資料夾需要保持原始順序（父資料夾在前）
            return 0;
          }
          
          return orderA - orderB;
        });
        
        console.log(`Sorted ${results.length} rows by type order: folder -> user -> group -> group_member -> permission`);
        
        // 循序處理每一行（已按正確順序排序）
        for (const row of results) {
          const type = row.type || row.Type || row.TYPE;
          console.log(`Processing row - type: ${type}, name: ${row.name}`);
          
          if (!type) {
            console.log('Skipping row with no type:', row);
            continue;
          }
          
          if (type === 'user') {
            const name = row.name || row.Name;
            const email = row.email || row.Email;
            const department = row.department || row.Department || null;
            const company = row.company || row.Company || null;
            const title = row.title || row.Title || null;
            const phone = row.phone || row.Phone || null;
            const description = row.description || row.Description || null;
            
            await new Promise((resolve, reject) => {
              req.userDb.run(
                'INSERT OR IGNORE INTO users (name, email, department, company, title, phone, description) VALUES (?, ?, ?, ?, ?, ?, ?)', 
                [name, email, department, company, title, phone, description], 
                (err) => {
                  if (err) reject(err);
                  else {
                    importCount++;
                    stats.users++;
                    resolve();
                  }
                }
              );
            });
          } else if (type === 'group') {
            const name = row.name || row.Name;
            
            // 插入群組
            const groupId = await new Promise((resolve, reject) => {
              req.userDb.run('INSERT OR IGNORE INTO groups (name) VALUES (?)', 
                [name], 
                function(err) {
                  if (err) {
                    reject(err);
                  } else {
                    console.log(`✓ Inserted group: ${name}, ID: ${this.lastID}`);
                    importCount++;
                    stats.groups++;
                    resolve(this.lastID);
                  }
                }
              );
            });
            
            // 自動指派權限：根據群組名稱自動對應資料夾
            // 格式：完整路徑_RO 或 完整路徑_RW（例如：RD_Test_Lab_RO）
            if (name.endsWith('_RO') || name.endsWith('_RW')) {
              const folderPath = name.endsWith('_RO') 
                ? name.substring(0, name.length - 3) 
                : name.substring(0, name.length - 3);
              
              const permissionType = name.endsWith('_RO') ? 'read' : 'write';
              
              // 獲取所有資料夾，建立完整路徑映射
              const allFolders = await new Promise((resolve, reject) => {
                req.userDb.all('SELECT id, name, parent_id FROM folders', [], (err, rows) => {
                  if (err) reject(err);
                  else resolve(rows || []);
                });
              });
              
              // 建立資料夾映射
              const folderMap = {};
              allFolders.forEach(f => {
                folderMap[f.id] = f;
              });
              
              // 函數：獲取資料夾的完整路徑
              const getFolderPath = (folder) => {
                const path = [];
                let current = folder;
                
                while (current) {
                  path.unshift(current.name);
                  if (current.parent_id && folderMap[current.parent_id]) {
                    current = folderMap[current.parent_id];
                  } else {
                    break;
                  }
                }
                
                return path.join('_');
              };
              
              // 查找完整路徑匹配的資料夾
              let targetFolder = null;
              for (const folder of allFolders) {
                const fullPath = getFolderPath(folder);
                if (fullPath === folderPath) {
                  targetFolder = folder;
                  break;
                }
              }
              
              if (targetFolder) {
                // 指派權限
                await new Promise((resolve, reject) => {
                  req.userDb.run(
                    'INSERT OR IGNORE INTO permissions (folder_id, user_id, group_id, permission_type) VALUES (?, NULL, ?, ?)',
                    [targetFolder.id, groupId, permissionType],
                    (err) => {
                      if (err) {
                        console.error(`❌ Error assigning permission for group ${name}:`, err);
                        reject(err);
                      } else {
                        console.log(`✓ Auto-assigned ${permissionType} permission: group "${name}" (${groupId}) → folder "${folderPath}" (${targetFolder.id})`);
                        resolve();
                      }
                    }
                  );
                });
              } else {
                console.warn(`⚠ Folder with path "${folderPath}" not found for group "${name}", skipping auto-permission`);
              }
            }
          } else if (type === 'folder') {
            const name = row.name || row.Name;
            const parent_id_raw = row.parent_id || row.Parent_id || row.parent_Id || row.Parent_Id;
            const parent_name_raw = row.parent_name || row.Parent_name || row.parent_Name || row.Parent_Name;
            let parent_id = parent_id_raw ? parseInt(parent_id_raw) : null;
            
            // 如果沒有 parent_id 但有 parent_name，根據名稱查找
            if (!parent_id && parent_name_raw) {
              console.log(`Looking up parent folder ID for name: "${parent_name_raw}"`);
              const parentFolder = await new Promise((res) => {
                req.userDb.get('SELECT id FROM folders WHERE name = ?', [parent_name_raw], (err, row) => {
                  if (err) {
                    console.error('Error looking up parent folder:', err);
                    res(null);
                  } else {
                    res(row);
                  }
                });
              });
              
              if (parentFolder) {
                parent_id = parentFolder.id;
                console.log(`✓ Found parent folder ID ${parent_id} for name "${parent_name_raw}"`);
              } else {
                console.warn(`⚠ Parent folder "${parent_name_raw}" not found for "${name}", creating as root folder`);
                parent_id = null;
              }
            }
            
            console.log(`Inserting folder: name="${name}", parent_id=${parent_id}`);
            
            // 驗證 parent_id 是否有效（如果有提供的話）
            if (parent_id) {
              const parentExists = await new Promise((res) => {
                req.userDb.get('SELECT id FROM folders WHERE id = ?', [parent_id], (err, row) => {
                  res(!err && row);
                });
              });
              
              if (!parentExists) {
                console.warn(`⚠ Parent folder ${parent_id} not found for "${name}", creating as root folder`);
                // 將 parent_id 設為 null，作為根資料夾
                parent_id = null;
              }
            }
            
            // 插入資料夾（循序執行，確保順序）
            await new Promise((resolve, reject) => {
              req.userDb.run('INSERT INTO folders (name, parent_id) VALUES (?, ?)', 
                [name, parent_id], 
                function(err) {
                  if (err) {
                    console.error('Error inserting folder:', err);
                    return reject(err);
                  }
                  const folderId = this.lastID;
                  console.log(`✓ Inserted folder: ${name}, ID: ${folderId}, parent_id: ${parent_id || 'null'}`);
                  importCount++;
                  stats.folders++;
                  
                  // 建構路徑
                  buildPathWithDb(req.userDb, folderId, (err, pth) => {
                    if (err) {
                      console.error('Error building path:', err);
                      // 路徑建構失敗，使用簡單路徑
                      const simplePath = '/' + name;
                      req.userDb.run('UPDATE folders SET path = ? WHERE id = ?', [simplePath, folderId], () => {
                        console.log(`✓ Used simple path for folder ${folderId}: ${simplePath}`);
                        resolve();
                      });
                      return;
                    }
                    req.userDb.run('UPDATE folders SET path = ? WHERE id = ?', 
                      [pth, folderId], 
                      (err) => {
                        if (err) console.error('Error updating path:', err);
                        else console.log(`✓ Updated path for folder ${folderId}: ${pth}`);
                        resolve();
                      }
                    );
                  });
                }
              );
            });
          } else if (type === 'group_member') {
            // 支援群組成員匯入（支援 ID 或名稱）
            // 嘗試多種可能的欄位名稱格式
            const group_id_raw = row.group_id || row.Group_id || row.GROUP_ID || row['group_id'] || row['Group_id'];
            const user_id_raw = row.user_id || row.User_id || row.USER_ID || row['user_id'] || row['User_id'];
            const group_name_raw = row.group_name || row.Group_name || row.group_Name || row.Group_Name || 
                                   row['group_name'] || row['Group_name'] || row['group_Name'] || row['Group_Name'] || '';
            const user_name_raw = row.user_name || row.User_name || row.user_Name || row.User_Name || 
                                 row['user_name'] || row['User_name'] || row['user_Name'] || row['User_name'] || '';
            
            console.log(`Processing group_member row:`, {
              group_id: group_id_raw,
              user_id: user_id_raw,
              group_name: group_name_raw,
              user_name: user_name_raw,
              row_keys: Object.keys(row),
              row_values: Object.values(row),
              raw_row: row
            });
            
            let group_id = group_id_raw ? parseInt(group_id_raw) : null;
            let user_id = user_id_raw ? parseInt(user_id_raw) : null;
            
            // 如果沒有 group_id 但有 group_name，根據名稱查找
            if (!group_id && group_name_raw && typeof group_name_raw === 'string' && group_name_raw.trim() !== '') {
              const groupNameClean = group_name_raw.trim();
              console.log(`Looking up group ID for name: "${groupNameClean}"`);
              const groupRow = await new Promise((res) => {
                req.userDb.get('SELECT id FROM groups WHERE name = ?', [groupNameClean], (err, row) => {
                  if (err) {
                    console.error('Error looking up group:', err);
                    res(null);
                  } else {
                    res(row);
                  }
                });
              });
              
              if (groupRow) {
                group_id = groupRow.id;
                console.log(`✓ Found group ID ${group_id} for name "${groupNameClean}"`);
              } else {
                console.warn(`⚠ Group "${groupNameClean}" not found, skipping group member`);
              }
            }
            
            // 如果沒有 user_id 但有 user_name，根據名稱查找
            if (!user_id && user_name_raw && typeof user_name_raw === 'string' && user_name_raw.trim() !== '') {
              const userNameClean = user_name_raw.trim();
              console.log(`Looking up user ID for name: "${userNameClean}"`);
              const userRow = await new Promise((res) => {
                req.userDb.get('SELECT id FROM users WHERE name = ?', [userNameClean], (err, row) => {
                  if (err) {
                    console.error('Error looking up user:', err);
                    res(null);
                  } else {
                    res(row);
                  }
                });
              });
              
              if (userRow) {
                user_id = userRow.id;
                console.log(`✓ Found user ID ${user_id} for name "${userNameClean}"`);
              } else {
                console.warn(`⚠ User "${userNameClean}" not found, skipping group member`);
              }
            }
            
            if (group_id && !isNaN(group_id) && user_id && !isNaN(user_id)) {
              seenGroupMemberKeys.add(`${group_id}|${user_id}`);
              affectedGroupIds.add(group_id);
              console.log(`Adding user ${user_id} to group ${group_id}`);
              await new Promise((resolve, reject) => {
                req.userDb.run('INSERT OR IGNORE INTO group_users (group_id, user_id) VALUES (?, ?)',
                  [group_id, user_id],
                  function(err) {
                    if (err) {
                      console.error('Error adding group member:', err);
                      reject(err);
                    } else {
                      if (this.changes > 0) {
                        console.log(`✓ Added user ${user_id} to group ${group_id}`);
                        importCount++;
                        stats.group_members++;
                      } else {
                        console.log(`ℹ User ${user_id} already in group ${group_id} (skipped)`);
                      }
                      resolve();
                    }
                  }
                );
              });
            } else {
              console.warn(`⚠ Skipping group_member: group_id=${group_id}, user_id=${user_id}, group_name="${group_name_raw}", user_name="${user_name_raw}"`);
              console.warn(`   Full row data:`, JSON.stringify(row, null, 2));
            }
          } else if (type === 'permission') {
            // 改進：支援多種欄位名稱格式（支援 ID 或名稱）
            let folder_id_raw = row.folder_id || row.Folder_id || row.FOLDER_ID;
            const folder_name_raw = row.folder_name || row.Folder_name || row.FOLDER_NAME;
            let user_id_raw = row.user_id || row.User_id || row.USER_ID;
            const user_name_raw = row.user_name || row.User_name || row.user_Name || row.User_Name;
            let group_id_raw = row.group_id || row.Group_id || row.GROUP_ID;
            const group_name_raw = row.group_name || row.Group_name || row.group_Name || row.Group_Name;
            const permission_type_raw = row.permission_type || row.Permission_type || row.PERMISSION_TYPE;
            
            // 如果沒有 folder_id 但有 folder_name，嘗試從資料夾名稱查找 ID
            if (!folder_id_raw && folder_name_raw) {
              console.log(`Looking up folder ID for name: "${folder_name_raw}"`);
              const folderRow = await new Promise((res) => {
                req.userDb.get('SELECT id FROM folders WHERE name = ?', [folder_name_raw], (err, row) => {
                  if (err) {
                    console.error('Error looking up folder:', err);
                    res(null);
                  } else {
                    res(row);
                  }
                });
              });
              if (folderRow) {
                folder_id_raw = folderRow.id;
                console.log(`✓ Found folder ID ${folder_id_raw} for name "${folder_name_raw}"`);
              } else {
                console.warn(`⚠ Folder not found for name: "${folder_name_raw}"`);
              }
            }
            
            // 如果沒有 user_id 但有 user_name，嘗試從人員名稱查找 ID
            if (!user_id_raw && user_name_raw) {
              console.log(`Looking up user ID for name: "${user_name_raw}"`);
              const userRow = await new Promise((res) => {
                req.userDb.get('SELECT id FROM users WHERE name = ?', [user_name_raw], (err, row) => {
                  if (err) {
                    console.error('Error looking up user:', err);
                    res(null);
                  } else {
                    res(row);
                  }
                });
              });
              if (userRow) {
                user_id_raw = userRow.id;
                console.log(`✓ Found user ID ${user_id_raw} for name "${user_name_raw}"`);
              } else {
                console.warn(`⚠ User not found for name: "${user_name_raw}"`);
              }
            }
            
            // 如果沒有 group_id 但有 group_name，嘗試從群組名稱查找 ID
            if (!group_id_raw && group_name_raw) {
              console.log(`Looking up group ID for name: "${group_name_raw}"`);
              const groupRow = await new Promise((res) => {
                req.userDb.get('SELECT id FROM groups WHERE name = ?', [group_name_raw], (err, row) => {
                  if (err) {
                    console.error('Error looking up group:', err);
                    res(null);
                  } else {
                    res(row);
                  }
                });
              });
              if (groupRow) {
                group_id_raw = groupRow.id;
                console.log(`✓ Found group ID ${group_id_raw} for name "${group_name_raw}"`);
              } else {
                console.warn(`⚠ Group not found for name: "${group_name_raw}"`);
              }
            }
            
            const folder_id = folder_id_raw ? parseInt(folder_id_raw) : null;
            const user_id = user_id_raw ? parseInt(user_id_raw) : null;
            const group_id = group_id_raw ? parseInt(group_id_raw) : null;
            const permission_type = permission_type_raw;
            
            console.log(`Processing permission: folder_id=${folder_id}, user_id=${user_id}, group_id=${group_id}, type=${permission_type}`);
            
            // 權限 CSV 匯入：處理不同來源的權限記錄
            // 1. 如果同時有 user_id 和 group_id，表示要將人員加入群組（來自權限CSV生成器）
            // 2. 如果有 folder_id，表示要設定資料夾權限（來自完整資料匯出）
            if (user_id && !isNaN(user_id) && group_id && !isNaN(group_id) && !folder_id) {
              // 來自權限CSV生成器：將人員加入群組
              seenGroupMemberKeys.add(`${group_id}|${user_id}`);
              affectedGroupIds.add(group_id);
              console.log(`Adding user ${user_id} to group ${group_id} (from permission CSV generator)`);

              await new Promise((resolve, reject) => {
                req.userDb.run('INSERT OR IGNORE INTO group_users (group_id, user_id) VALUES (?, ?)',
                  [group_id, user_id],
                  (err) => {
                    if (err) {
                      console.error('Error adding user to group:', err);
                      reject(err);
                    } else {
                      console.log(`✓ Added user ${user_id} to group ${group_id}`);
                      importCount++;
                      stats.group_members++;
                      resolve();
                    }
                  }
                );
              });
            } else if (folder_id && !isNaN(folder_id) && permission_type) {
              // 取得資料夾路徑，供記錄用
              const folderPathRow = await new Promise(res => {
                req.userDb.get('SELECT path, name FROM folders WHERE id = ?', [folder_id], (err, r) => res(r || null));
              });
              const folderLabel = folderPathRow ? (folderPathRow.path || folderPathRow.name) : String(folder_id);

              const applyDiffPermission = async (fid, uid, gid, ptype, targetType, targetName) => {
                const permKey = `${fid}|${uid ?? ''}|${gid ?? ''}`;
                seenPermKeys.add(permKey);

                // 查詢是否已存在
                const existing = await new Promise(res => {
                  req.userDb.get(
                    'SELECT id, permission_type FROM permissions WHERE folder_id=? AND (user_id IS ?) AND (group_id IS ?)',
                    [fid, uid ?? null, gid ?? null],
                    (err, r) => res(r || null)
                  );
                });

                if (!existing) {
                  // 新增
                  await new Promise((resolve, reject) => {
                    req.userDb.run(
                      'INSERT INTO permissions (folder_id, user_id, group_id, permission_type) VALUES (?, ?, ?, ?)',
                      [fid, uid ?? null, gid ?? null, ptype],
                      err => { if (err) reject(err); else resolve(); }
                    );
                  });
                  permStats.added++;
                  importCount++;
                  stats.permissions++;
                  historyDetails.push({ action: 'added', folder_path: folderLabel, target_type: targetType, target_name: targetName, old_permission: null, new_permission: ptype });
                  console.log(`✓ [added] permission: folder ${fid}, ${targetType} ${targetName}, ${ptype}`);
                } else if (existing.permission_type !== ptype) {
                  // 更新
                  await new Promise((resolve, reject) => {
                    req.userDb.run(
                      'UPDATE permissions SET permission_type=? WHERE id=?',
                      [ptype, existing.id],
                      err => { if (err) reject(err); else resolve(); }
                    );
                  });
                  permStats.updated++;
                  importCount++;
                  stats.permissions++;
                  historyDetails.push({ action: 'updated', folder_path: folderLabel, target_type: targetType, target_name: targetName, old_permission: existing.permission_type, new_permission: ptype });
                  console.log(`✓ [updated] permission: folder ${fid}, ${targetType} ${targetName}, ${existing.permission_type} → ${ptype}`);
                } else {
                  // 相同，略過
                  permStats.skipped++;
                  historyDetails.push({ action: 'skipped', folder_path: folderLabel, target_type: targetType, target_name: targetName, old_permission: existing.permission_type, new_permission: ptype });
                  console.log(`ℹ [skipped] permission already exists: folder ${fid}, ${targetType} ${targetName}, ${ptype}`);
                }
              };

              if (group_id && !isNaN(group_id)) {
                const grpName = group_name_raw || String(group_id);
                await applyDiffPermission(folder_id, null, group_id, permission_type, 'group', grpName);
              } else if (user_id && !isNaN(user_id)) {
                const usrName = user_name_raw || String(user_id);
                await applyDiffPermission(folder_id, user_id, null, permission_type, 'user', usrName);
              } else {
                console.log('Skipping permission: no valid user_id or group_id specified');
              }
            } else {
              console.log('Skipping permission with invalid data:', { folder_id, permission_type, row });
            }
          } else {
            console.log('Unknown type:', type);
          }
        }
        
        // full_replace：清除本次有出現的群組中，CSV 裡沒有的舊成員（處理 RO→RW 移動）
        if (importMode === 'full_replace' && affectedGroupIds.size > 0) {
          for (const gid of affectedGroupIds) {
            const existingMembers = await new Promise((res, rej) => {
              req.userDb.all(
                `SELECT gu.user_id, u.name AS user_name, g.name AS group_name
                 FROM group_users gu
                 LEFT JOIN users u ON u.id = gu.user_id
                 LEFT JOIN groups g ON g.id = gu.group_id
                 WHERE gu.group_id = ?`,
                [gid],
                (err, rows) => { if (err) rej(err); else res(rows); }
              );
            });
            for (const m of existingMembers) {
              const key = `${gid}|${m.user_id}`;
              if (!seenGroupMemberKeys.has(key)) {
                await new Promise((resolve, reject) => {
                  req.userDb.run('DELETE FROM group_users WHERE group_id = ? AND user_id = ?',
                    [gid, m.user_id], err => { if (err) reject(err); else resolve(); });
                });
                permStats.deleted++;
                historyDetails.push({ action: 'deleted', folder_path: `group:${m.group_name || gid}`, target_type: 'user', target_name: m.user_name || String(m.user_id), old_permission: 'member', new_permission: null });
                console.log(`✓ [deleted] group member: group ${gid}, user ${m.user_id} (${m.user_name})`);
              }
            }
          }
        }

        // full_replace：刪除本次未出現在匯入檔案中的舊直接權限
        if (importMode === 'full_replace') {
          const allPerms = await new Promise((res, rej) => {
            req.userDb.all(
              `SELECT p.id, p.folder_id, p.user_id, p.group_id, p.permission_type,
                      f.path AS folder_path, f.name AS folder_name,
                      u.name AS user_name, g.name AS group_name
               FROM permissions p
               LEFT JOIN folders f ON f.id = p.folder_id
               LEFT JOIN users u ON u.id = p.user_id
               LEFT JOIN groups g ON g.id = p.group_id`,
              [],
              (err, rows) => { if (err) rej(err); else res(rows); }
            );
          });

          for (const perm of allPerms) {
            const permKey = `${perm.folder_id}|${perm.user_id ?? ''}|${perm.group_id ?? ''}`;
            if (!seenPermKeys.has(permKey)) {
              await new Promise((resolve, reject) => {
                req.userDb.run('DELETE FROM permissions WHERE id=?', [perm.id], err => { if (err) reject(err); else resolve(); });
              });
              const folderLabel = perm.folder_path || perm.folder_name || String(perm.folder_id);
              const targetType = perm.user_id ? 'user' : 'group';
              const targetName = perm.user_name || perm.group_name || '';
              permStats.deleted++;
              historyDetails.push({ action: 'deleted', folder_path: folderLabel, target_type: targetType, target_name: targetName, old_permission: perm.permission_type, new_permission: null });
              console.log(`✓ [deleted] permission: folder ${perm.folder_id}, ${targetType} ${targetName}`);
            }
          }
        }

        // 儲存匯入歷史
        const historyId = await new Promise((resolve, reject) => {
          req.userDb.run(
            'INSERT INTO import_history (imported_by, file_name, mode, added, updated, deleted, skipped) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [req.session.username || 'unknown', req.file.originalname || req.file.filename, importMode, permStats.added, permStats.updated, permStats.deleted, permStats.skipped],
            function(err) { if (err) reject(err); else resolve(this.lastID); }
          );
        });

        for (const d of historyDetails) {
          await new Promise((resolve, reject) => {
            req.userDb.run(
              'INSERT INTO import_history_detail (history_id, action, folder_path, target_type, target_name, old_permission, new_permission) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [historyId, d.action, d.folder_path, d.target_type, d.target_name, d.old_permission, d.new_permission],
              err => { if (err) reject(err); else resolve(); }
            );
          });
        }

        // 所有操作已循序完成
        console.log(`Import completed: ${importCount} operations`);
        console.log('Import statistics:', stats);
        console.log('Permission diff stats:', permStats);

        // 刪除上傳的檔案
        fs.unlinkSync(req.file.path);

        res.json({
          success: true,
          imported: importCount,
          count: importCount,
          stats: stats,
          permStats: permStats,
          historyId: historyId,
          mode: importMode
        });
      } catch (error) {
        console.error('Import error:', error);
        // 確保刪除上傳的檔案
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: error.message });
      }
    })
    .on('error', (error) => {
      console.error('CSV parse error:', error);
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      res.status(500).json({ error: 'CSV parse error: ' + error.message });
    });
});

// 匯入權限矩陣 xlsx（從匯出的權限清單 xlsx 回匯，操作群組成員）
app.post('/import_permission_matrix_xlsx', withUserDatabase, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  // 修正 multer latin1 編碼問題，還原中文檔名
  const fileName = Buffer.from(req.file.originalname || '', 'latin1').toString('utf8');

  try {
    const importMode = req.body.mode === 'full_replace' ? 'full_replace' : 'diff_only';
    const historyDetails = [];
    const permStats = { added: 0, updated: 0, deleted: 0, skipped: 0 };
    // seenGroupMemberKeys: Set<"groupId|userId"> 本次 xlsx 應在的群組成員
    const seenGroupMemberKeys = new Set();
    // affectedGroupIds: Set<groupId> 本次 xlsx 涵蓋的 RO/RW 群組（full_replace 時清除多餘成員）
    const affectedGroupIds = new Set();

    // 1. 讀取 xlsx
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const ws = workbook.worksheets[0];
    if (!ws) throw new Error('找不到工作表');

    // 2. 偵測是否含描述欄（B1 = '描述'）
    const b1 = ws.getRow(1).getCell(2).value;
    const hasDesc = (b1 && b1.toString().trim() === '描述');
    const dataStartCol = hasDesc ? 3 : 2;

    // 3. 讀取 4 列標頭，建立欄→資料夾 path 映射（路徑以 "/" 連接，群組用 "_"）
    const colFolderPath = {};   // col → "A/B/C" 格式
    const colGroupPath = {};    // col → "A_B_C" 格式（用於對應群組名）
    const lastCol = ws.columnCount || 300;
    for (let col = dataStartCol; col <= lastCol; col++) {
      const parts = [1, 2, 3, 4].map(r => {
        const v = ws.getRow(r).getCell(col).value;
        return v ? v.toString().trim() : '';
      }).filter(v => v !== '');
      if (parts.length > 0) {
        colFolderPath[col] = parts.join('/');
        colGroupPath[col] = parts.join('_');
      }
    }
    if (Object.keys(colFolderPath).length === 0) {
      throw new Error('無法從 xlsx 標頭解析出資料夾欄位，請確認檔案格式正確');
    }

    // 4. 載入所有群組，建立 name→group 映射
    const allGroups = await new Promise((res, rej) => {
      req.userDb.all('SELECT id, name FROM groups', [], (err, rows) => { if (err) rej(err); else res(rows); });
    });
    const groupByName = {};
    allGroups.forEach(g => { groupByName[g.name] = g; });

    // 5. 為每個資料夾欄建立 RO/RW 群組映射，並登記 affectedGroupIds
    const colGroups = {}; // col → { roId, rwId, folderPath, groupPath }
    for (const [col, gpath] of Object.entries(colGroupPath)) {
      const roGroup = groupByName[`${gpath}_RO`];
      const rwGroup = groupByName[`${gpath}_RW`];
      colGroups[col] = {
        roId: roGroup ? roGroup.id : null,
        rwId: rwGroup ? rwGroup.id : null,
        folderPath: colFolderPath[col],
        groupPath: gpath
      };
      if (roGroup) affectedGroupIds.add(roGroup.id);
      if (rwGroup) affectedGroupIds.add(rwGroup.id);
    }

    // 6. 載入所有人員，建立 name→id 映射
    const allUsers = await new Promise((res, rej) => {
      req.userDb.all('SELECT id, name FROM users', [], (err, rows) => { if (err) rej(err); else res(rows); });
    });
    const nameToUserId = {};
    allUsers.forEach(u => { nameToUserId[u.name.trim()] = u.id; });

    // 7. 處理人員列（第 5 列起）
    const totalRows = ws.rowCount || 0;
    for (let rowIdx = 5; rowIdx <= totalRows; rowIdx++) {
      const rowObj = ws.getRow(rowIdx);
      const nameCell = rowObj.getCell(1).value;
      if (!nameCell) continue;
      const userName = nameCell.toString().trim();
      if (!userName) continue;

      const userId = nameToUserId[userName];
      if (!userId) {
        console.warn(`[xlsx import] 找不到人員: "${userName}"`);
        continue;
      }

      for (const [col, grpInfo] of Object.entries(colGroups)) {
        const cellVal = rowObj.getCell(parseInt(col)).value;
        const raw = cellVal ? cellVal.toString().trim().toUpperCase() : '';
        const isRW = raw === 'RW';
        const isRO = raw === 'RO';

        const targetGroupId = isRW ? grpInfo.rwId : isRO ? grpInfo.roId : null;

        if (targetGroupId) {
          const key = `${targetGroupId}|${userId}`;
          seenGroupMemberKeys.add(key);

          // 檢查是否已是成員
          const existing = await new Promise(resolve => {
            req.userDb.get('SELECT 1 FROM group_users WHERE group_id=? AND user_id=?',
              [targetGroupId, userId], (err, row) => resolve(row || null));
          });

          if (!existing) {
            await new Promise((resolve, reject) => {
              req.userDb.run('INSERT OR IGNORE INTO group_users (group_id, user_id) VALUES (?, ?)',
                [targetGroupId, userId], err => { if (err) reject(err); else resolve(); });
            });
            permStats.added++;
            const permLabel = isRW ? 'RW' : 'RO';
            historyDetails.push({ action: 'added', folder_path: grpInfo.folderPath, target_type: 'user', target_name: userName, old_permission: null, new_permission: permLabel });
            console.log(`[xlsx import] added: ${userName} → ${grpInfo.groupPath}_${permLabel}`);
          } else {
            permStats.skipped++;
          }
        }
      }
    }

    // 8. full_replace：清除 affectedGroupIds 中，不在 seenGroupMemberKeys 的舊成員
    if (importMode === 'full_replace' && affectedGroupIds.size > 0) {
      for (const gid of affectedGroupIds) {
        const members = await new Promise((res, rej) => {
          req.userDb.all(
            `SELECT gu.user_id, u.name AS user_name, g.name AS group_name
             FROM group_users gu
             LEFT JOIN users u ON u.id = gu.user_id
             LEFT JOIN groups g ON g.id = gu.group_id
             WHERE gu.group_id = ?`,
            [gid], (err, rows) => { if (err) rej(err); else res(rows); }
          );
        });
        for (const m of members) {
          const key = `${gid}|${m.user_id}`;
          if (!seenGroupMemberKeys.has(key)) {
            await new Promise((resolve, reject) => {
              req.userDb.run('DELETE FROM group_users WHERE group_id=? AND user_id=?',
                [gid, m.user_id], err => { if (err) reject(err); else resolve(); });
            });
            permStats.deleted++;
            historyDetails.push({ action: 'deleted', folder_path: m.group_name || String(gid), target_type: 'user', target_name: m.user_name, old_permission: m.group_name, new_permission: null });
            console.log(`[xlsx import] deleted: ${m.user_name} from ${m.group_name}`);
          }
        }
      }
    }

    // 9. 儲存匯入歷史
    const historyId = await new Promise((resolve, reject) => {
      req.userDb.run(
        'INSERT INTO import_history (imported_by, file_name, mode, added, updated, deleted, skipped) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.session.username || 'unknown', fileName, importMode, permStats.added, permStats.updated, permStats.deleted, permStats.skipped],
        function(err) { if (err) reject(err); else resolve(this.lastID); }
      );
    });
    for (const d of historyDetails) {
      await new Promise((resolve, reject) => {
        req.userDb.run(
          'INSERT INTO import_history_detail (history_id, action, folder_path, target_type, target_name, old_permission, new_permission) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [historyId, d.action, d.folder_path, d.target_type, d.target_name, d.old_permission, d.new_permission],
          err => { if (err) reject(err); else resolve(); }
        );
      });
    }

    fs.unlinkSync(req.file.path);

    console.log(`[xlsx import] 完成: added=${permStats.added} skipped=${permStats.skipped} deleted=${permStats.deleted}`);
    res.json({ success: true, permStats, historyId, mode: importMode });

  } catch (error) {
    console.error('[xlsx import] error:', error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

// 查詢匯入歷史清單
app.get('/api/import-history', withUserDatabase, (req, res) => {
  req.userDb.all(
    'SELECT * FROM import_history ORDER BY imported_at DESC LIMIT 100',
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// 查詢單次匯入的明細
app.get('/api/import-history/:id/details', withUserDatabase, (req, res) => {
  const id = parseInt(req.params.id);
  req.userDb.all(
    'SELECT * FROM import_history_detail WHERE history_id = ? ORDER BY id ASC',
    [id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// login.html 為公開頁（不需登入），同時相容 public/ 和根目錄兩種部署位置
app.get('/login.html', (req, res) => {
  const inPublic = path.join(__dirname, 'public', 'login.html');
  const inRoot   = path.join(__dirname, 'login.html');
  const target   = fs.existsSync(inPublic) ? inPublic : inRoot;
  res.sendFile(target, (err) => {
    if (err) {
      console.error('SendFile login.html error:', err);
      res.status(404).send('login.html not found');
    }
  });
});

app.get('/csv_generator.html', ensureEditorAccess, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/csv_generator.html'), (err) => {
    if (err) {
      console.error('SendFile error:', err);
      res.status(404).json({ error: 'CSV Generator not found' });
    }
  });
});

app.get('/user_csv_generator.html', ensureEditorAccess, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/user_csv_generator.html'), (err) => {
    if (err) {
      console.error('SendFile error:', err);
      res.status(404).json({ error: 'User CSV Generator not found' });
    }
  });
});

app.get('/permission_generator.html', ensureEditorAccess, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/permission_generator.html'), (err) => {
    if (err) {
      console.error('SendFile error:', err);
      res.status(404).json({ error: 'Permission Generator not found' });
    }
  });
});

// 靜態檔案
app.use(express.static('public'));

// 首頁
app.get('/', (req, res) => {
  console.log('Hit / (root)');
  res.sendFile(path.join(__dirname, 'public/index.html'), (err) => {
    if (err) {
      console.error('SendFile error:', err);
      res.status(404).json({ error: 'Index not found' });
    }
  });
});

// 匯出完整 Excel 報表（中文欄位，多個 Sheet）
app.get('/export_excel', withUserDatabase, async (req, res) => {
  console.log('Hit /export_excel - Exporting all data to Excel');
  
  try {
    // 1. 查詢所有資料夾
    const folders = await new Promise((resolve, reject) => {
      req.userDb.all(`SELECT id, name, parent_id, path FROM folders ORDER BY id`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    // 2. 查詢所有人員
    const users = await new Promise((resolve, reject) => {
      req.userDb.all(`SELECT id, name, email, department, company, title, phone, description FROM users ORDER BY id`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    // 3. 查詢所有群組及成員
    const groups = await new Promise((resolve, reject) => {
      req.userDb.all(`SELECT id, name FROM groups ORDER BY id`, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    // 4. 查詢群組成員詳細資訊
    const groupMembers = await new Promise((resolve, reject) => {
      req.userDb.all(`
        SELECT g.id as group_id, g.name as group_name, 
               u.id as user_id, u.name as user_name, u.email,
               u.department, u.company, u.title, u.phone, u.description
        FROM groups g
        LEFT JOIN group_users gu ON g.id = gu.group_id
        LEFT JOIN users u ON gu.user_id = u.id
        ORDER BY g.id, u.id
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    // 5. 查詢所有權限
    const permissions = await new Promise((resolve, reject) => {
      req.userDb.all(`
        SELECT p.id, 
               f.name as folder_name, f.path as folder_path,
               u.name as user_name, u.email as user_email,
               g.name as group_name,
               p.permission_type
        FROM permissions p
        LEFT JOIN folders f ON p.folder_id = f.id
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN groups g ON p.group_id = g.id
        ORDER BY p.id
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    // 6. 建立 Excel 工作簿 (使用 ExcelJS)
    const workbook = new ExcelJS.Workbook();
    workbook.creator = '資料夾權限文管系統';
    workbook.created = new Date();
    workbook.modified = new Date();
    
    // 輔助函數：添加工作表並格式化
    const addWorksheet = (name, data) => {
      const worksheet = workbook.addWorksheet(name);
      
      if (data.length > 0) {
        // 獲取標題
        const headers = Object.keys(data[0]);
        
        // 添加標題行
        const headerRow = worksheet.addRow(headers);
        
        // 設定標題樣式
        headerRow.font = { bold: true, size: 11 };
        headerRow.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFD9D9D9' }
        };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
        headerRow.height = 20;
        
        // 添加資料行
        data.forEach(row => {
          const values = headers.map(header => row[header] || '');
          worksheet.addRow(values);
        });
        
        // 自動調整欄寬
        worksheet.columns.forEach((column, index) => {
          let maxLength = headers[index].length;
          column.eachCell({ includeEmpty: false }, cell => {
            const cellLength = cell.value ? cell.value.toString().length : 0;
            if (cellLength > maxLength) maxLength = cellLength;
          });
          column.width = Math.min(Math.max(maxLength + 2, 10), 50);
        });
        
        // 添加篩選
        if (data.length > 0) {
          worksheet.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: headers.length }
          };
        }
        
        // 凍結標題行
        worksheet.views = [
          { state: 'frozen', xSplit: 0, ySplit: 1 }
        ];
      }
      
      return worksheet;
    };
    
    // 7. 建立「資料夾」工作表
    const foldersData = folders.map(f => ({
      '編號': f.id,
      '資料夾名稱': f.name,
      '父資料夾編號': f.parent_id || '',
      '完整路徑': f.path || ''
    }));
    addWorksheet('資料夾', foldersData);
    
    // 8. 建立「人員」工作表
    const usersData = users.map(u => ({
      '編號': u.id,
      '姓名': u.name,
      'Email': u.email,
      '部門': u.department || '',
      '公司': u.company || '',
      '職稱': u.title || '',
      '電話': u.phone || '',
      '描述': u.description || ''
    }));
    addWorksheet('人員', usersData);
    
    // 9. 建立「群組」工作表
    const groupsData = groups.map(g => {
      const members = groupMembers
        .filter(m => m.group_id === g.id && m.user_id)
        .map(m => m.user_name)
        .join(', ');
      return {
        '編號': g.id,
        '群組名稱': g.name,
        '成員人數': groupMembers.filter(m => m.group_id === g.id && m.user_id).length,
        '成員清單': members || '無'
      };
    });
    addWorksheet('群組', groupsData);
    
    // 10. 建立「群組成員明細」工作表
    const groupMembersData = groupMembers
      .filter(m => m.user_id) // 只顯示有成員的記錄
      .map(m => ({
        '群組編號': m.group_id,
        '群組名稱': m.group_name,
        '人員編號': m.user_id,
        '人員姓名': m.user_name,
        '人員Email': m.email,
        '部門': m.department || '',
        '公司': m.company || '',
        '職稱': m.title || '',
        '電話': m.phone || '',
        '描述': m.description || ''
      }));
    addWorksheet('群組成員明細', groupMembersData);
    
    // 11. 建立「權限」工作表
    const permissionsData = permissions.map(p => {
      const permType = p.permission_type === 'read' ? '讀取' :
                       p.permission_type === 'write' ? '寫入' : p.permission_type;
      const target = p.user_name ? `人員: ${p.user_name}` : 
                     p.group_name ? `群組: ${p.group_name}` : '未知';
      return {
        '編號': p.id,
        '資料夾': p.folder_path || p.folder_name,
        '授權對象': target,
        '對象名稱': p.user_name || p.group_name || '',
        'Email/說明': p.user_email || '',
        '權限類型': permType
      };
    });
    addWorksheet('權限', permissionsData);
    
    // 12. 建立統計摘要工作表
    const summaryData = [
      { '項目': '資料夾總數', '數量': folders.length },
      { '項目': '人員總數', '數量': users.length },
      { '項目': '群組總數', '數量': groups.length },
      { '項目': '群組成員總數', '數量': groupMembers.filter(m => m.user_id).length },
      { '項目': '權限總數', '數量': permissions.length }
    ];
    addWorksheet('統計摘要', summaryData);
    
    // 13. 寫入檔案 (使用 ExcelJS)
    const tempFile = 'temp_export_' + Date.now() + '.xlsx';
    await workbook.xlsx.writeFile(tempFile);
    
    console.log(`Exported Excel: ${folders.length} folders, ${users.length} users, ${groups.length} groups, ${permissions.length} permissions`);
    
    // 14. 下載檔案
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `權限管理系統_完整報表_${timestamp}.xlsx`;
    
    res.download(tempFile, filename, (err) => {
      if (err) console.error('Download error:', err);
      // 刪除臨時檔案
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });
    
  } catch (error) {
    console.error('Export Excel error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 匯出權限清單（橫向格式，四層標題 + 人員權限）
// 查詢參數：include_description=1 時一併輸出人員描述欄位
app.get('/export_permission_matrix', withUserDatabase, async (req, res) => {
  const includeDescription = (req.query.include_description === '1' || req.query.include_description === 'true');
  console.log('Hit /export_permission_matrix - Exporting permission matrix, include_description:', includeDescription);
  
  try {
    // 1. 查詢所有資料夾
    const allFolders = await new Promise((resolve, reject) => {
      req.userDb.all(`SELECT id, name, parent_id, path FROM folders ORDER BY id`, (err, rows) => {
        if (err) {
          console.error('Error querying folders:', err);
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    });
    
    if (!allFolders || allFolders.length === 0) {
      return res.status(400).json({ error: '沒有資料夾資料，無法匯出權限清單' });
    }
    
    // 2. 查詢所有人員（需要描述時一併查詢 description；若 DB 無 description 欄位則自動改為不輸出描述）
    let actualIncludeDescription = includeDescription;
    let users;
    if (actualIncludeDescription) {
      try {
        users = await new Promise((resolve, reject) => {
          req.userDb.all(`SELECT id, name, description FROM users ORDER BY name`, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          });
        });
      } catch (userErr) {
        const msg = (userErr && userErr.message) ? String(userErr.message) : '';
        if (/no such column.*description/i.test(msg)) {
          actualIncludeDescription = false;
          users = await new Promise((resolve, reject) => {
            req.userDb.all(`SELECT id, name FROM users ORDER BY name`, (err, rows) => {
              if (err) reject(err);
              else resolve(rows || []);
            });
          });
        } else {
          throw userErr;
        }
      }
    } else {
      users = await new Promise((resolve, reject) => {
        req.userDb.all(`SELECT id, name FROM users ORDER BY name`, (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });
    }
    
    if (!users || users.length === 0) {
      return res.status(400).json({ error: '沒有人員資料，無法匯出權限清單' });
    }
    
    // 3. 查詢所有權限
    const permissions = await new Promise((resolve, reject) => {
      req.userDb.all(`
        SELECT p.folder_id, p.user_id, p.group_id, p.permission_type,
               f.path as folder_path, f.name as folder_name,
               u.name as user_name, g.name as group_name
        FROM permissions p
        LEFT JOIN folders f ON p.folder_id = f.id
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN groups g ON p.group_id = g.id
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    // 4. 建立資料夾階層結構（最多4層）
    const folderMap = {};
    allFolders.forEach(f => {
      folderMap[f.id] = f;
    });
    
    // 計算每個資料夾的層級
    function getFolderLevel(folderId, visited = new Set()) {
      if (visited.has(folderId)) return 0; // 防止循環
      visited.add(folderId);
      
      const folder = folderMap[folderId];
      if (!folder || !folder.parent_id) return 1;
      
      return 1 + getFolderLevel(folder.parent_id, visited);
    }
    
    // 建立資料夾列表，包含層級資訊
    const foldersWithLevel = allFolders.map(f => {
      const level = getFolderLevel(f.id);
      return {
        ...f,
        level: Math.min(level, 4) // 最多4層
      };
    });
    
    // 按層級和名稱排序
    foldersWithLevel.sort((a, b) => {
      if (a.level !== b.level) return a.level - b.level;
      return (a.path || a.name).localeCompare(b.path || b.name, 'zh-TW');
    });
    
    // 5. 建立權限映射（人員 -> 資料夾 -> 權限類型）
    const permissionMap = {};
    
    // 先處理人員權限
    permissions.forEach(p => {
      if (p.user_id && p.user_name) {
        if (!permissionMap[p.user_id]) {
          permissionMap[p.user_id] = {};
        }
        permissionMap[p.user_id][p.folder_id] = p.permission_type;
      }
    });
    
    // 處理群組權限（需要展開群組成員）
    const groupPermissions = permissions.filter(p => p.group_id);
    if (groupPermissions.length > 0) {
      const groupIds = [...new Set(groupPermissions.map(p => p.group_id))];
      
      // 查詢所有群組成員
      const allGroupMembers = await new Promise((resolve, reject) => {
        const placeholders = groupIds.map(() => '?').join(',');
        req.userDb.all(`
          SELECT group_id, user_id FROM group_users WHERE group_id IN (${placeholders})
        `, groupIds, (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });
      
      // 建立群組到成員的映射
      const groupToMembers = {};
      allGroupMembers.forEach(m => {
        if (!groupToMembers[m.group_id]) {
          groupToMembers[m.group_id] = [];
        }
        groupToMembers[m.group_id].push(m.user_id);
      });
      
      // 將群組權限展開到成員
      groupPermissions.forEach(p => {
        const members = groupToMembers[p.group_id] || [];
        members.forEach(userId => {
          if (!permissionMap[userId]) {
            permissionMap[userId] = {};
          }
          // 如果該人員已有權限，保留較高權限（write > read）
          if (!permissionMap[userId][p.folder_id] || 
              (permissionMap[userId][p.folder_id] === 'read' && p.permission_type === 'write')) {
            permissionMap[userId][p.folder_id] = p.permission_type;
          }
        });
      });
    }
    
    // 6. 建立 Excel 工作簿
    const workbook = new ExcelJS.Workbook();
    workbook.creator = '資料夾權限文管系統';
    workbook.created = new Date();
    workbook.modified = new Date();
    
    const worksheet = workbook.addWorksheet('權限清單');
    
    // 7. 建立標題行（4層）
    // 輔助函數：取得資料夾的根目錄（第一層資料夾）
    function getRootFolder(folderId) {
      let currentId = folderId;
      let rootFolder = folderMap[currentId];
      while (currentId && folderMap[currentId] && folderMap[currentId].parent_id) {
        currentId = folderMap[currentId].parent_id;
        rootFolder = folderMap[currentId];
      }
      return rootFolder;
    }
    
    // 輔助函數：取得資料夾的所有祖先（從根到父，不包括資料夾本身）
    function getFolderAncestors(folderId) {
      const ancestors = [];
      let currentId = folderId;
      while (currentId && folderMap[currentId] && folderMap[currentId].parent_id) {
        currentId = folderMap[currentId].parent_id;
        if (folderMap[currentId]) {
          ancestors.unshift(folderMap[currentId]);
        }
      }
      return ancestors;
    }
    
    // 建立標題行資料
    const row1 = []; // 第一層：根目錄資料夾名稱（需要合併相同根目錄）
    const row2 = []; // 第二層：依父資料夾 ID 顯示
    const row3 = []; // 第三層：依父資料夾 ID 顯示
    const row4 = []; // 第四層：依父資料夾 ID 顯示
    
    let currentCol = actualIncludeDescription ? 3 : 2; // 含描述時從第3欄開始（A=層級/人員名，B=描述），否則從第2欄
    
    // 記錄每個根目錄的起始和結束列，用於合併
    const rootFolderRanges = {};
    let lastRootFolderId = null;
    let rootStartCol = 2; // 從B欄開始（第2列）
    
    foldersWithLevel.forEach((folder, index) => {
      const rootFolder = getRootFolder(folder.id);
      const rootFolderId = rootFolder ? rootFolder.id : folder.id;
      const ancestors = getFolderAncestors(folder.id);
      
      // 如果是第一個資料夾，初始化根目錄範圍
      if (index === 0) {
        rootStartCol = currentCol;
        lastRootFolderId = rootFolderId;
      }
      // 如果根目錄改變，記錄上一個根目錄的範圍
      else if (lastRootFolderId !== null && lastRootFolderId !== rootFolderId) {
        // 記錄上一個根目錄的結束位置
        if (rootFolderRanges[lastRootFolderId]) {
          rootFolderRanges[lastRootFolderId].end = currentCol - 1;
        } else {
          rootFolderRanges[lastRootFolderId] = { start: rootStartCol, end: currentCol - 1 };
        }
        // 開始新的根目錄範圍
        rootStartCol = currentCol;
        lastRootFolderId = rootFolderId;
      }
      
      // 取得完整路徑鏈（根 → ... → 資料夾本身）
      const pathChain = [...ancestors.map(a => a.name), folder.name];
      const levelValues = [
        pathChain[0] || '', // 第一層：根目錄
        pathChain[1] || '', // 第二層
        pathChain[2] || '', // 第三層
        pathChain[3] || ''  // 第四層
      ];
      
      // 第一層：根目錄名稱（需要合併相同根目錄）
      const rootName = levelValues[0] || folder.name;
      row1.push(rootName);
      
      // 第二層、第三層、第四層：依據父資料夾階層顯示（不足的層級填空字串）
      row2.push(levelValues[1]);
      row3.push(levelValues[2]);
      row4.push(levelValues[3]);
      
      currentCol += 1;
    });
    
    // 記錄最後一個根目錄的範圍
    if (lastRootFolderId !== null) {
      if (rootFolderRanges[lastRootFolderId]) {
        // 如果已經有記錄，更新結束位置
        rootFolderRanges[lastRootFolderId].end = currentCol - 1;
      } else {
        // 如果沒有記錄，創建新記錄
        rootFolderRanges[lastRootFolderId] = { start: rootStartCol, end: currentCol - 1 };
      }
    }
    
    // 添加標題行（A欄顯示層級標籤，B欄為描述欄標題（可選），其後為資料夾標題）
    if (actualIncludeDescription) {
      worksheet.addRow(['第一層', '描述', ...row1]);
      worksheet.addRow(['第二層', '', ...row2]);
      worksheet.addRow(['第三層', '', ...row3]);
      worksheet.addRow(['第四層', '', ...row4]);
    } else {
      worksheet.addRow(['第一層', ...row1]);
      worksheet.addRow(['第二層', ...row2]);
      worksheet.addRow(['第三層', ...row3]);
      worksheet.addRow(['第四層', ...row4]);
    }
    
        // 8.（不進行欄位合併，確保每一層的文字都能對應至各自的欄位）
// 9. 設定標題樣式
    for (let row = 1; row <= 4; row++) {
      const rowObj = worksheet.getRow(row);
      rowObj.font = { bold: true, size: 11 };
      rowObj.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD9D9D9' }
      };
      rowObj.alignment = { vertical: 'middle', horizontal: 'center' };
      rowObj.height = 20;
    }
    
    // 10. 添加人員權限資料
    users.forEach(user => {
      const desc = actualIncludeDescription && user && 'description' in user
        ? String(user.description != null ? user.description : '').trim()
        : '';
      const row = actualIncludeDescription ? [user.name, desc] : [user.name];
      
      foldersWithLevel.forEach(folder => {
        const perm = permissionMap[user.id] && permissionMap[user.id][folder.id];
        if (perm === 'write') {
          row.push('RW');
        } else if (perm === 'read') {
          row.push('RO');
        } else {
          row.push('');
        }
      });
      
      worksheet.addRow(row);
    });
    
    // 11. 設定資料行樣式
    for (let row = 5; row <= 4 + users.length; row++) {
      const rowObj = worksheet.getRow(row);
      rowObj.alignment = { vertical: 'middle', horizontal: 'center' };
      rowObj.height = 18;
    }
    
    // 12. 設定欄寬
    worksheet.getColumn(1).width = 20; // A欄：人員名稱列和層級標籤
    if (actualIncludeDescription) {
      worksheet.getColumn(2).width = 25; // B欄：描述
      for (let col = 3; col <= currentCol - 1; col++) {
        worksheet.getColumn(col).width = 8;
      }
    } else {
      for (let col = 2; col <= currentCol - 1; col++) {
        worksheet.getColumn(col).width = 8;
      }
    }
    
    // 13. 凍結標題行和人員名稱列（含描述時凍結 A、B 欄，前4行）
    worksheet.views = [
      { state: 'frozen', xSplit: actualIncludeDescription ? 2 : 1, ySplit: 4 }
    ];
    
    // 14. 寫入檔案
    const tempFile = 'temp_permission_matrix_' + Date.now() + '.xlsx';
    await workbook.xlsx.writeFile(tempFile);
    
    console.log(`Exported permission matrix: ${foldersWithLevel.length} folders, ${users.length} users`);
    
    // 15. 下載檔案
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `權限清單_${timestamp}.xlsx`;
    
    res.download(tempFile, filename, (err) => {
      if (err) console.error('Download error:', err);
      // 刪除臨時檔案
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });
    
  } catch (error) {
    console.error('Export permission matrix error:', error);
    console.error('Error stack:', error.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: '匯出失敗：' + error.message });
    }
  }
});

// ==================== 資料庫管理 API ====================

// 取得所有資料庫列表
app.get('/api/databases', requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(DB_DIR);
    const userDatabase = req.session.userDatabase; // 當前使用者的資料庫
    const username = req.session.username;
    const isAdmin = req.session.role === 'admin';
    const permissionLevel = req.session.permissionLevel || 'editor';
    const allowedForViewer = req.session.allowedDatabases || [];
    const isViewer = permissionLevel === 'viewer' && !isAdmin;
    
    let databases = files
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const dbPath = path.join(DB_DIR, f);
        const stats = fs.statSync(dbPath);
        return {
          name: f,
          size: stats.size,
          modified: stats.mtime,
          isCurrent: f === userDatabase
        };
      });
    
    if (isViewer) {
      databases = databases.filter(db => allowedForViewer.includes(db.name));
    }
    
    const enriched = databases.map(db => {
      const owner = getDatabaseOwner(db.name);
      const ownerLabel = owner || '系統';
      const isOwner = !!owner && owner === username;
      
      let canSwitch = isAdmin;
      let canRename = isAdmin;
      let canDelete = isAdmin;
      
      if (!isAdmin) {
        if (isViewer) {
          canSwitch = true; // viewer 只能切換到被授權的資料庫
          canRename = false;
          canDelete = false;
        } else {
          canSwitch = isOwner;
          canRename = isOwner;
          canDelete = isOwner;
        }
      }
      
      return {
        ...db,
        owner: ownerLabel,
        isOwner,
        canSwitch,
        canRename,
        canDelete,
        canCopy: true
      };
    });
    
    res.json({ 
      databases: enriched, 
      current: userDatabase,
      isAdmin: isAdmin,
      username: username,
      permissionLevel,
      allowedDatabases: isViewer ? allowedForViewer : [],
      message: isViewer
        ? '此帳號為唯讀模式，僅能檢視被授權的資料庫'
        : (isAdmin 
            ? '管理員可查看並管理所有資料庫' 
            : '您可以查看所有資料庫；僅能管理自己的資料庫，其他人的資料庫可複製以便參考')
    });
  } catch (err) {
    console.error('Failed to list databases:', err);
    res.status(500).json({ error: err.message });
  }
});

// 新增資料庫
app.post('/api/databases', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: '資料庫名稱為必填' });
    }
    
    const username = req.session.username;
    const isAdmin = req.session.role === 'admin';
    
    // 驗證檔名格式
    if (!/^[a-zA-Z0-9_\-\u4e00-\u9fa5]+\.db$/.test(name)) {
      return res.status(400).json({ error: '資料庫名稱格式不正確，請使用英文、數字、底線或中文，並以 .db 結尾' });
    }
    
    // 一般使用者只能創建以 user_{username}_ 開頭的資料庫
    if (!isAdmin) {
      const requiredPrefix = `user_${username}_`;
      if (!name.startsWith(requiredPrefix)) {
        return res.status(403).json({ 
          error: '權限不足',
          message: `一般使用者只能創建以 "${requiredPrefix}" 開頭的資料庫\n例如：${requiredPrefix}project1.db`
        });
      }
    }
    
    const dbPath = path.join(DB_DIR, name);
    
    // 檢查是否已存在
    if (fs.existsSync(dbPath)) {
      return res.status(400).json({ error: '資料庫已存在' });
    }
    
    // 建立新資料庫
    const newDb = await connectDatabase(name);
    newDb.close((err) => {
      if (err) {
        console.error('Failed to close new database:', err);
      }
    });
    
    console.log(`✓ 使用者 ${username} 創建資料庫: ${name}`);
    res.json({ 
      success: true,
      message: '資料庫建立成功', 
      name: name,
      isAdmin: isAdmin
    });
  } catch (err) {
    console.error('Failed to create database:', err);
    res.status(500).json({ error: err.message });
  }
});

// 切換資料庫（基於 session，使用者獨立）
app.post('/api/databases/switch', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: '資料庫名稱為必填' });
    }
    
    const username = req.session.username;
    const isAdmin = req.session.role === 'admin';
    const permissionLevel = req.session.permissionLevel || 'editor';
    const allowedForViewer = req.session.allowedDatabases || [];
    
    if (permissionLevel === 'viewer' && !isAdmin) {
      if (!allowedForViewer.includes(name)) {
        return res.status(403).json({ error: '此帳號無法切換到該資料庫' });
      }
    } else if (!isAdmin) {
      const requiredPrefix = `user_${username}_`;
      // 或者是他們最初註冊時的資料庫 user_{username}.db
      const initialDb = `user_${username}.db`;
      
      if (!name.startsWith(requiredPrefix) && name !== initialDb) {
        return res.status(403).json({ 
          error: '權限不足',
          message: `您只能切換到自己的資料庫（以 "${requiredPrefix}" 開頭或 "${initialDb}"）`
        });
      }
    }
    
    const dbPath = path.join(DB_DIR, name);
    
    // 檢查資料庫是否存在
    if (!fs.existsSync(dbPath)) {
      return res.status(404).json({ error: '資料庫不存在' });
    }
    
    // 更新 session 中的資料庫名稱（不影響其他使用者）
    const oldDatabase = req.session.userDatabase;
    req.session.userDatabase = name;
    
    // 關閉當前使用者的舊資料庫連接（如果存在）
    const userId = req.session.userId;
    const oldKey = `user_${userId}_${oldDatabase}`;
    
    if (userDatabases.has(oldKey)) {
      console.log(`Closing old database connection: ${oldKey}`);
      const oldDb = userDatabases.get(oldKey);
      await new Promise((resolve) => {
        oldDb.close((err) => {
          if (err) console.error('Error closing old database:', err);
          resolve();
        });
      });
      userDatabases.delete(oldKey);
      console.log(`Deleted old database connection from cache: ${oldKey}`);
    }
    
    console.log(`✓ 使用者 ${username} 切換到資料庫: ${name}`);
    res.json({ 
      success: true,
      message: '已切換到資料庫',
      name: name,
      note: '此切換僅影響您的 session，不會影響其他使用者',
      isAdmin: isAdmin
    });
  } catch (err) {
    console.error('Failed to switch database:', err);
    res.status(500).json({ error: err.message });
  }
});

// 刪除資料庫
app.delete('/api/databases', requireAuth, (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Database name is required' });
    }
    
    // 不能刪除當前使用中的資料庫
    if (name === currentDbName) {
      return res.status(400).json({ error: '無法刪除目前使用中的資料庫，請先切換到其他資料庫' });
    }
    
     const username = req.session.username;
     const isAdmin = req.session.role === 'admin';
     const permissionLevel = req.session.permissionLevel || 'editor';
     
     if (!isAdmin) {
       if (permissionLevel === 'viewer') {
         return res.status(403).json({ error: '唯讀帳號無法刪除資料庫' });
       }
       if (!isDatabaseOwnedBy(name, username)) {
         return res.status(403).json({ error: '只能刪除自己的資料庫' });
       }
     }
    
    const dbPath = path.join(DB_DIR, name);
    
    // 檢查資料庫是否存在
    if (!fs.existsSync(dbPath)) {
      return res.status(404).json({ error: '資料庫不存在' });
    }
    
    // 刪除檔案
    fs.unlinkSync(dbPath);
    
    res.json({ message: '資料庫已刪除', name });
  } catch (err) {
    console.error('Failed to delete database:', err);
    res.status(500).json({ error: err.message });
  }
});

// 複製資料庫
app.post('/api/databases/copy', requireAuth, (req, res) => {
  try {
    const { source, target } = req.body;
    if (!source || !target) {
      return res.status(400).json({ error: 'Source and target names are required' });
    }
    
    // 驗證檔名格式
    if (!/^[a-zA-Z0-9_\-\u4e00-\u9fa5]+\.db$/.test(target)) {
      return res.status(400).json({ error: '資料庫名稱格式不正確' });
    }
    
    const sourcePath = path.join(DB_DIR, source);
    const targetPath = path.join(DB_DIR, target);
    const username = req.session.username;
    const isAdmin = req.session.role === 'admin';
    const permissionLevel = req.session.permissionLevel || 'editor';
    
    if (!isAdmin) {
      if (permissionLevel === 'viewer') {
        return res.status(403).json({ error: '唯讀帳號無法複製資料庫' });
      }
      const requiredPrefix = `user_${username}_`;
      const defaultName = `user_${username}.db`;
      if (!(target === defaultName || target.startsWith(requiredPrefix))) {
        return res.status(403).json({ 
          error: '權限不足',
          message: `一般使用者複製時，目標資料庫名稱須以 "${requiredPrefix}" 開頭`
        });
      }
    }
    
    // 檢查來源是否存在
    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: '來源資料庫不存在' });
    }
    
    // 檢查目標是否已存在
    if (fs.existsSync(targetPath)) {
      return res.status(400).json({ error: '目標資料庫已存在' });
    }
    
    // 複製檔案
    fs.copyFileSync(sourcePath, targetPath);
    
    res.json({ message: '資料庫已複製', source, target });
  } catch (err) {
    console.error('Failed to copy database:', err);
    res.status(500).json({ error: err.message });
  }
});

// 重新命名資料庫
app.post('/api/databases/rename', requireAuth, (req, res) => {
  try {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) {
      return res.status(400).json({ error: 'Old and new names are required' });
    }
    
    // 不能重新命名當前使用中的資料庫
    if (oldName === currentDbName) {
      return res.status(400).json({ error: '無法重新命名目前使用中的資料庫，請先切換到其他資料庫' });
    }
    
    // 驗證檔名格式
    if (!/^[a-zA-Z0-9_\-\u4e00-\u9fa5]+\.db$/.test(newName)) {
      return res.status(400).json({ error: '資料庫名稱格式不正確' });
    }
    
    const username = req.session.username;
    const isAdmin = req.session.role === 'admin';
    const permissionLevel = req.session.permissionLevel || 'editor';
    
    if (!isAdmin) {
      if (permissionLevel === 'viewer') {
        return res.status(403).json({ error: '唯讀帳號無法重新命名資料庫' });
      }
      if (!isDatabaseOwnedBy(oldName, username)) {
        return res.status(403).json({ error: '只能重新命名自己的資料庫' });
      }
      const requiredPrefix = `user_${username}_`;
      const defaultName = `user_${username}.db`;
      if (!(newName === defaultName || newName.startsWith(requiredPrefix))) {
        return res.status(403).json({ error: `新名稱必須以 ${requiredPrefix} 開頭` });
      }
    }
    
    const oldPath = path.join(DB_DIR, oldName);
    const newPath = path.join(DB_DIR, newName);
    
    // 檢查舊檔案是否存在
    if (!fs.existsSync(oldPath)) {
      return res.status(404).json({ error: '資料庫不存在' });
    }
    
    // 檢查新檔案是否已存在
    if (fs.existsSync(newPath)) {
      return res.status(400).json({ error: '目標名稱已存在' });
    }
    
    // 重新命名
    fs.renameSync(oldPath, newPath);
    
    res.json({ message: '資料庫已重新命名', oldName, newName });
  } catch (err) {
    console.error('Failed to rename database:', err);
    res.status(500).json({ error: err.message });
  }
});

// 自動生成群組並指派權限（優化版本 - 批次處理）
app.post('/api/auto-generate-groups', withUserDatabase, async (req, res) => {
  console.log('Hit POST /api/auto-generate-groups');
  
  try {
    const { folders } = req.body;
    
    if (!folders || folders.length === 0) {
      return res.status(400).json({ error: '沒有資料夾需要處理' });
    }
    
    console.log(`開始處理 ${folders.length} 個資料夾...`);
    
    let groupsCreated = 0;
    let groupsExisted = 0;
    let permissionsCreated = 0;
    let permissionsExisted = 0;
    let foldersProcessed = 0;
    
    // 建立資料夾 ID 映射表（用於追溯路徑）
    const folderMap = {};
    folders.forEach(f => {
      folderMap[f.id] = f;
    });
    
    // 函數：獲取資料夾的完整路徑（從根目錄到當前資料夾）
    const getFolderPath = (folder) => {
      const path = [];
      let current = folder;
      
      while (current) {
        path.unshift(current.name); // 加到陣列開頭
        
        // 如果有父資料夾，繼續追溯
        if (current.parent_id && folderMap[current.parent_id]) {
          current = folderMap[current.parent_id];
        } else {
          break;
        }
      }
      
      return path.join('_'); // 用底線連接路徑
    };
    
    // 先一次性獲取所有現有群組（減少查詢次數）
    const existingGroups = await new Promise((resolve, reject) => {
      req.userDb.all('SELECT id, name FROM groups', [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    const groupMap = {};
    existingGroups.forEach(g => {
      groupMap[g.name] = g.id;
    });
    
    console.log(`現有群組數量: ${existingGroups.length}`);
    
    // 先一次性獲取所有現有權限（減少查詢次數）
    const existingPermissions = await new Promise((resolve, reject) => {
      req.userDb.all('SELECT folder_id, group_id, permission_type FROM permissions WHERE group_id IS NOT NULL', [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    const permissionSet = new Set();
    existingPermissions.forEach(p => {
      permissionSet.add(`${p.folder_id}-${p.group_id}-${p.permission_type}`);
    });
    
    console.log(`現有權限數量: ${existingPermissions.length}`);
    
    // 準備批次插入的資料
    const groupsToInsert = [];
    const permissionsToInsert = [];
    
    for (const folder of folders) {
      const folderPath = getFolderPath(folder); // 使用完整路徑
      const folderId = folder.id;
      
      console.log(`資料夾 "${folder.name}" (ID: ${folderId}) 的完整路徑: ${folderPath}`);
      
      const groupsToCreate = [
        { name: `${folderPath}_RO`, permissionType: 'read' },
        { name: `${folderPath}_RW`, permissionType: 'write' }
      ];
      
      for (const groupInfo of groupsToCreate) {
        const groupName = groupInfo.name;
        const permType = groupInfo.permissionType;
        
        let groupId = groupMap[groupName];
        
        if (groupId) {
          groupsExisted++;
        } else {
          // 準備插入新群組
          groupsToInsert.push(groupName);
        }
      }
      
      foldersProcessed++;
    }
    
    // 批次插入群組
    if (groupsToInsert.length > 0) {
      console.log(`批次建立 ${groupsToInsert.length} 個群組...`);
      
      for (const groupName of groupsToInsert) {
        const groupId = await new Promise((resolve, reject) => {
          req.userDb.run('INSERT OR IGNORE INTO groups (name) VALUES (?)', [groupName], function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
          });
        });
        
        if (groupId > 0) {
          groupMap[groupName] = groupId;
          groupsCreated++;
        }
      }
      
      console.log(`✓ 成功建立 ${groupsCreated} 個群組`);
    }
    
    // 準備權限資料
    for (const folder of folders) {
      const folderPath = getFolderPath(folder); // 使用完整路徑
      const folderId = folder.id;
      
      const groupsToCheck = [
        { name: `${folderPath}_RO`, permissionType: 'read' },
        { name: `${folderPath}_RW`, permissionType: 'write' }
      ];
      
      for (const groupInfo of groupsToCheck) {
        const groupName = groupInfo.name;
        const permType = groupInfo.permissionType;
        const groupId = groupMap[groupName];
        
        if (groupId) {
          const permKey = `${folderId}-${groupId}-${permType}`;
          
          if (permissionSet.has(permKey)) {
            permissionsExisted++;
          } else {
            permissionsToInsert.push({
              folderId,
              groupId,
              permType
            });
          }
        }
      }
    }
    
    // 批次插入權限
    if (permissionsToInsert.length > 0) {
      console.log(`批次指派 ${permissionsToInsert.length} 個權限...`);
      
      for (const perm of permissionsToInsert) {
        await new Promise((resolve, reject) => {
          req.userDb.run(
            'INSERT OR IGNORE INTO permissions (folder_id, user_id, group_id, permission_type) VALUES (?, NULL, ?, ?)',
            [perm.folderId, perm.groupId, perm.permType],
            function(err) {
              if (err) reject(err);
              else {
                if (this.changes > 0) {
                  permissionsCreated++;
                }
                resolve();
              }
            }
          );
        });
      }
      
      console.log(`✓ 成功指派 ${permissionsCreated} 個權限`);
    }
    
    const result = {
      success: true,
      groupsCreated,
      groupsExisted,
      permissionsCreated,
      permissionsExisted,
      foldersProcessed
    };
    
    console.log('自動生成完成:', result);
    
    res.json(result);
    
  } catch (error) {
    console.error('自動生成群組時發生錯誤:', error);
    res.status(500).json({ error: error.message });
  }
});

// 自訂 404
app.use((req, res) => {
  console.log('404 for:', req.url);
  res.status(404).json({ error: 'Not Found: ' + req.url });
});

// 未捕獲錯誤寫入 stderr，方便 pm2 logs --err 看到
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('[unhandledRejection]', reason, p);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server on ${PORT}`);
});

