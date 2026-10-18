/**
 * 資料庫管理 API 與清空資料。
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { DB_DIR, SYSTEM_DB_NAMES } = require('../lib/config');
const { internalError } = require('../lib/http');
const { isClientRoleSession, requireAdmin, requireAuth, requireStaffRole } = require('../middleware/auth');
const { withUserDatabase } = require('../middleware/user-database');
const { logAudit } = require('../services/audit');
const { backupBeforeClear } = require('../services/backup');
const { closeUserDatabase, connectDatabase, getCurrentDbName, getDatabaseOwner, getSystemDb, getUserDatabase, isDatabaseOwnedBy, parseAllowedDatabases } = require('../services/database');
const { dbGet, dbRun } = require('../lib/db');

const router = express.Router();

// 清空資料庫：僅限內部帳號（管理員／工程師／一般內部帳號），客戶帳號與唯讀帳號不可使用
router.post('/api/clear_all', requireStaffRole, withUserDatabase, async (req, res) => {
  console.log('Hit /api/clear_all - Clearing all data');
  const { confirm } = req.body;
  
  // 安全確認
  if (confirm !== 'CLEAR_ALL_DATA') {
    return res.status(400).json({ error: 'Confirmation code incorrect' });
  }
  
  try {
    const backupFile = await backupBeforeClear(req.userDb, req.session.userDatabase);
    logAudit(req, 'delete', 'database_data', null, req.session.userDatabase, null, { event: 'clear_all', backup: path.basename(backupFile) });

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
    res.json({ success: true, message: 'All data cleared', backup: path.basename(backupFile) });
  } catch (error) {
    console.error('Clear all error:', error);
    res.status(500).json({ error: 'Failed to clear data' });
  }
});

// ==================== 資料庫管理 API ====================

// 取得所有資料庫列表
router.get('/api/databases', requireAuth, (req, res) => {
  const userDatabase = req.session.userDatabase;
  const username = req.session.username;
  const isAdmin = req.session.role === 'admin';
  const permissionLevel = req.session.permissionLevel || 'editor';
  const allowedForViewer = req.session.allowedDatabases || [];
  const isViewer = permissionLevel === 'viewer' && !isAdmin;
  const sessionRoleLevelDb = req.session.roleLevel || 'user';
  const isEngineerDb = sessionRoleLevelDb === 'engineer' && !isAdmin;
  const isClientDb = isClientRoleSession(req) && !isAdmin;

  // 從 databases registry 取得 metadata
  getSystemDb().all('SELECT name, display_name, created_by, description FROM databases', [], (regErr, regRows) => {
    const regMap = {};
    if (!regErr && regRows) regRows.forEach(r => { regMap[r.name] = r; });

    try {
      const files = fs.readdirSync(DB_DIR);
      let databases = files
        .filter(f => f.endsWith('.db') && !f.startsWith('deleted_') && (isAdmin || !SYSTEM_DB_NAMES.has(f)))
        .map(f => {
          const dbPath = path.join(DB_DIR, f);
          const stats = fs.statSync(dbPath);
          const reg = regMap[f] || {};
          return {
            name: f,
            display_name: reg.display_name || null,
            created_by: reg.created_by || getDatabaseOwner(f),
            description: reg.description || null,
            size: stats.size,
            modified: stats.mtime,
            isCurrent: f === userDatabase
          };
        });

      if (isViewer || isEngineerDb || isClientDb) {
        databases = databases.filter(d => allowedForViewer.includes(d.name));
      }

      const enriched = databases.map(d => {
        const owner = d.created_by;
        const ownerLabel = owner || '系統';
        const isOwner = !!owner && owner === username;

        let canSwitch = isAdmin;
        let canRename = isAdmin;
        let canDelete = isAdmin;
        let canCopy = true;

        if (!isAdmin) {
          if (isClientDb) {
            canSwitch = true;   // 客戶可切換到被授權的資料庫（已過濾），不可管理
            canRename = false;
            canDelete = false;
            canCopy = false;
          } else if (isViewer) {
            canSwitch = true;
            canRename = false;
            canDelete = false;
          } else if (isEngineerDb) {
            canSwitch = true;   // engineer 可切換到被授權的資料庫（已過濾）
            canRename = false;
            canDelete = false;
          } else {
            canSwitch = isOwner;
            canRename = isOwner;
            canDelete = isOwner;
          }
        }

        return { ...d, owner: ownerLabel, isOwner, canSwitch, canRename, canDelete, canCopy };
      });

      res.json({
        databases: enriched,
        current: userDatabase,
        isAdmin,
        username,
        permissionLevel,
        allowedDatabases: (isViewer || isEngineerDb || isClientDb) ? allowedForViewer : [],
        message: isClientDb
          ? '客戶帳號可切換至被授權的資料庫'
          : isViewer
          ? '此帳號為唯讀模式，僅能檢視被授權的資料庫'
          : (isEngineerDb ? '工程師帳號可存取被授權的資料庫，僅供編輯，無法管理資料庫'
          : (isAdmin ? '管理員可查看並管理所有資料庫' : '您可以查看所有資料庫；僅能管理自己的資料庫，其他人的資料庫可複製以便參考'))
      });
    } catch (err) {
      console.error('Failed to list databases:', err);
      internalError(res, err);
    }
  });
});

// 新增資料庫
router.post('/api/databases', requireAuth, async (req, res) => {
  try {
    if (isClientRoleSession(req)) {
      return res.status(403).json({ error: '客戶帳號無法管理資料庫' });
    }
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
      if (!name.startsWith(requiredPrefix) || !isDatabaseOwnedBy(name, username)) {
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
      if (err) console.error('Failed to close new database:', err);
    });

    // 登記到 databases registry
    const { display_name, description } = req.body;
    getSystemDb().run(
      'INSERT OR IGNORE INTO databases (name, display_name, created_by, description) VALUES (?, ?, ?, ?)',
      [name, display_name || null, username, description || null]
    );

    // 工程師自動取得新建資料庫的存取權
    const sessionRoleLevel = req.session.roleLevel || 'user';
    const isEngineerCreator = sessionRoleLevel === 'engineer' && !isAdmin;
    if (isEngineerCreator) {
      try {
        const account = await dbGet(getSystemDb(), 'SELECT id, allowed_databases FROM accounts WHERE username = ? AND status = ?', [username, 'active']);
        if (account) {
          const currentList = parseAllowedDatabases(account.allowed_databases);
          if (!currentList.includes(name)) {
            const newList = [...currentList, name];
            const serialized = JSON.stringify(newList);
            await dbRun(getSystemDb(), 'UPDATE accounts SET allowed_databases = ? WHERE id = ?', [serialized, account.id]);
            // 同步更新 session，讓新資料庫立即可存取
            req.session.allowedDatabases = newList;
            await new Promise((resolve) => {
              req.session.save((saveErr) => {
                if (saveErr) console.error('Session save error after engineer DB create:', saveErr);
                resolve();
              });
            });
            console.log(`✓ 工程師 ${username} 新建資料庫 ${name} 已自動加入可存取清單`);
          }
        }
      } catch (autoAddErr) {
        console.error('自動加入工程師 allowed_databases 失敗:', autoAddErr);
        // 不因此中斷，繼續回傳成功
      }
    }

    console.log(`✓ 使用者 ${username} 創建資料庫: ${name}`);
    res.json({ success: true, message: '資料庫建立成功', name, isAdmin });
  } catch (err) {
    console.error('Failed to create database:', err);
    internalError(res, err);
  }
});

// 切換資料庫（基於 session，使用者獨立）
router.post('/api/databases/switch', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: '資料庫名稱為必填' });
    }
    
    const username = req.session.username;
    const isAdmin = req.session.role === 'admin';
    const permissionLevel = req.session.permissionLevel || 'editor';
    const sessionRoleLevel = req.session.roleLevel || 'user';
    const isClientRole = sessionRoleLevel === 'db_admin' || sessionRoleLevel === 'client_user';
    const isEngineerSwitch = sessionRoleLevel === 'engineer';
    const allowedForRestricted = req.session.allowedDatabases || [];

    if (!isAdmin && (permissionLevel === 'viewer' || isClientRole || isEngineerSwitch)) {
      if (!allowedForRestricted.includes(name)) {
        return res.status(403).json({ error: '此帳號無法切換到該資料庫' });
      }
    } else if (!isAdmin) {
      const requiredPrefix = `user_${username}_`;
      // 或者是他們最初註冊時的資料庫 user_{username}.db
      const initialDb = `user_${username}.db`;

      if (!isDatabaseOwnedBy(name, username)) {
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
    
    await closeUserDatabase(userId, oldDatabase);
    
    // 預先建立新資料庫連線（完成 initializeTables 後才繼續），
    // 確保切換後第一個 /api/folders 等請求能直接使用已就緒的快取連線
    try {
      await getUserDatabase(userId, name);
      console.log(`✓ 已預先連接新資料庫: ${name}`);
    } catch (preErr) {
      console.error(`預先連接新資料庫失敗 (${name}):`, preErr);
      return res.status(500).json({ error: `無法開啟資料庫: ${preErr.message}` });
    }

    console.log(`✓ 使用者 ${username} 切換到資料庫: ${name}`);

    // 明確儲存 session，確保 userDatabase 更新在回應送出前寫入 store
    await new Promise((resolve) => {
      req.session.save((saveErr) => {
        if (saveErr) console.error('Session save error in switch:', saveErr);
        resolve();
      });
    });

    res.json({
      success: true,
      message: '已切換到資料庫',
      name: name,
      note: '此切換僅影響您的 session，不會影響其他使用者',
      isAdmin: isAdmin
    });
  } catch (err) {
    console.error('Failed to switch database:', err);
    internalError(res, err);
  }
});

// 刪除資料庫
router.delete('/api/databases', requireAuth, (req, res) => {
  try {
    if (isClientRoleSession(req)) {
      return res.status(403).json({ error: '客戶帳號無法管理資料庫' });
    }
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Database name is required' });
    }
    
    // 不能刪除當前使用中的資料庫
    if (name === getCurrentDbName()) {
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
    getSystemDb().run('DELETE FROM databases WHERE name = ?', [name]);

    res.json({ message: '資料庫已刪除', name });
  } catch (err) {
    console.error('Failed to delete database:', err);
    internalError(res, err);
  }
});

// 複製資料庫
router.post('/api/databases/copy', requireAuth, (req, res) => {
  try {
    if (isClientRoleSession(req)) {
      return res.status(403).json({ error: '客戶帳號無法管理資料庫' });
    }
    const { source, target } = req.body;
    if (!source || !target) {
      return res.status(400).json({ error: 'Source and target names are required' });
    }
    
    // 驗證檔名格式（來源也要驗證，避免 ../ 路徑跳脫）
    const dbNamePattern = /^[a-zA-Z0-9_\-\u4e00-\u9fa5]+\.db$/;
    if (!dbNamePattern.test(source) || !dbNamePattern.test(target)) {
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
      if (!isDatabaseOwnedBy(target, username)) {
        return res.status(403).json({ 
          error: '權限不足',
          message: `一般使用者複製時，目標資料庫名稱須以 "${requiredPrefix}" 開頭`
        });
      }
      // 系統資料庫（含全部帳號與密碼雜湊）絕不可被非管理員複製。
      // 複製他人的（非系統）資料庫供參考是既有設計，僅限內部帳號，客戶帳號已在上方被擋下。
      if (SYSTEM_DB_NAMES.has(source)) {
        return res.status(403).json({ error: '權限不足', message: '無法複製系統資料庫' });
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
    // registry：複製的 DB 由操作者擁有
    getSystemDb().run('INSERT OR IGNORE INTO databases (name, created_by) VALUES (?, ?)', [target, req.session.username]);

    res.json({ message: '資料庫已複製', source, target });
  } catch (err) {
    console.error('Failed to copy database:', err);
    internalError(res, err);
  }
});

// 重新命名資料庫
router.post('/api/databases/rename', requireAuth, (req, res) => {
  try {
    if (isClientRoleSession(req)) {
      return res.status(403).json({ error: '客戶帳號無法管理資料庫' });
    }
    const { oldName, newName } = req.body;
    if (!oldName || !newName) {
      return res.status(400).json({ error: 'Old and new names are required' });
    }
    
    // 不能重新命名當前使用中的資料庫
    if (oldName === getCurrentDbName()) {
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
      if (!isDatabaseOwnedBy(newName, username)) {
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

    // registry：更新名稱，選擇性更新擁有者
    const { newOwner } = req.body;
    const ownerUpdate = (newOwner && req.session.role === 'admin') ? newOwner : undefined;
    getSystemDb().run(
      ownerUpdate
        ? 'UPDATE databases SET name = ?, created_by = ? WHERE name = ?'
        : 'UPDATE databases SET name = ? WHERE name = ?',
      ownerUpdate ? [newName, ownerUpdate, oldName] : [newName, oldName],
      function() {
        if (this.changes === 0) {
          getSystemDb().run('INSERT OR IGNORE INTO databases (name, created_by) VALUES (?, ?)', [newName, ownerUpdate || req.session.username]);
        }
      }
    );

    res.json({ message: '資料庫已重新命名', oldName, newName });
  } catch (err) {
    console.error('Failed to rename database:', err);
    internalError(res, err);
  }
});

// 更新資料庫 metadata（display_name / created_by / description）
router.patch('/api/admin/databases/:name', requireAdmin, (req, res) => {
  const { name } = req.params;
  const { display_name, created_by, description } = req.body;
  getSystemDb().run(
    `INSERT INTO databases (name, created_by, display_name, description) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       display_name = CASE WHEN ? IS NOT NULL THEN ? ELSE display_name END,
       created_by   = CASE WHEN ? IS NOT NULL THEN ? ELSE created_by END,
       description  = CASE WHEN ? IS NOT NULL THEN ? ELSE description END`,
    [name, created_by ?? req.session.username, display_name ?? null, description ?? null,
     display_name ?? null, display_name ?? null,
     created_by ?? null, created_by ?? null,
     description ?? null, description ?? null],
    function(err) {
      if (err) return internalError(res, err);
      res.json({ success: true, name, display_name, created_by, description });
    }
  );
});

module.exports = router;
