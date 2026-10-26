/**
 * 群組 API。
 */

const express = require('express');
const { internalError } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { withUserDatabase } = require('../middleware/user-database');
const { logAudit } = require('../services/audit');
const { dbAll, dbRun } = require('../lib/db');
const { DUPLICATE_GROUP_ERROR, findGroupByName, deleteGroupCascade } = require('../services/relations');

const router = express.Router();

// API: 群組
router.get('/api/groups', withUserDatabase, (req, res) => {
  console.log('Hit /api/groups');
  // member_count：資料夾權限卡片顯示人數用（只計人員仍存在的成員）；新增欄位，不影響既有使用者
  req.userDb.all(`SELECT g.*, (SELECT COUNT(*) FROM group_users gu JOIN users u ON u.id = gu.user_id WHERE gu.group_id = g.id) AS member_count FROM groups g`, (err, rows) => {
    if (err) return internalError(res, err);
    res.json(rows || []);
  });
});

console.log('Registered /api/groups');

router.get('/api/groups/:id', withUserDatabase, (req, res) => {
  const { id } = req.params;
  console.log(`Hit GET /api/groups/${id}`);
  req.userDb.get('SELECT * FROM groups WHERE id = ?', [id], (err, row) => {
    if (err) return internalError(res, err);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });
});

router.post('/api/groups', withUserDatabase, async (req, res) => {
  console.log('Hit POST /api/groups', req.body);
  const { name, description } = req.body;
  if (typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: '群組名稱不可為空' });
  }
  try {
    const existing = await findGroupByName(req.userDb, name);
    if (existing) return res.status(409).json({ error: DUPLICATE_GROUP_ERROR, id: existing.id });
  } catch (errCheck) {
    return internalError(res, errCheck);
  }
  req.userDb.run('INSERT INTO groups (name, description) VALUES (?, ?)', [name.trim(), description || ''], function(err) {
    if (err) return internalError(res, err);
    const groupId = this.lastID;
    // 記錄審計日誌
    logAudit(req, 'create', 'group', groupId, name, null, { name, description });
    res.json({ id: groupId });
  });
});

router.put('/api/groups/:id', withUserDatabase, async (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body;
  console.log('Hit PUT /api/groups/' + id, { name, description });
  if (typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: '群組名稱不可為空' });
  }
  try {
    const clash = await findGroupByName(req.userDb, name, parseInt(id, 10));
    if (clash) return res.status(409).json({ error: DUPLICATE_GROUP_ERROR, id: clash.id });
  } catch (errCheck) {
    return internalError(res, errCheck);
  }

  // 先獲取舊值
  req.userDb.get('SELECT name, description FROM groups WHERE id = ?', [id], (err, oldGroup) => {
    if (err) return internalError(res, err);
    if (!oldGroup) return res.status(404).json({ error: 'Not found' });

    req.userDb.run('UPDATE groups SET name = ?, description = ? WHERE id = ?', [name, description !== undefined ? description : (oldGroup.description || ''), id], (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      // 記錄審計日誌
      logAudit(req, 'update', 'group', parseInt(id), name, oldGroup, { name, description });
      res.json({ success: true });
    });
  });
});

router.delete('/api/groups', withUserDatabase, (req, res) => {
  const { id } = req.body;
  console.log('Hit DELETE /api/groups', { id });
  
  // 先檢查是否有關聯的權限
  req.userDb.all(`
    SELECT p.id, p.permission_type, f.name as folder_name, f.path as folder_path
    FROM permissions p
    LEFT JOIN folders f ON p.folder_id = f.id
    WHERE p.group_id = ?
  `, [id], (err, permissions) => {
    if (err) return internalError(res, err);
    
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
      deleteGroupCascade(req.userDb, id, (err3) => {
        if (err3) return res.status(500).json({ error: err3.message });
        // 記錄審計日誌
        logAudit(req, 'delete', 'group', parseInt(id), group.name, group, null);
        res.json({ success: true });
      });
    });
  });
});

// 批次刪除群組
router.delete('/api/groups/batch', withUserDatabase, (req, res) => {
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
        deleteGroupCascade(req.userDb, id, (err3) => {
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
router.get('/api/groups/:id/users', withUserDatabase, (req, res) => {
  const { id } = req.params;
  console.log('Hit /api/groups/' + id + '/users');
  req.userDb.all('SELECT u.* FROM users u JOIN group_users gu ON u.id = gu.user_id WHERE gu.group_id = ?', [id], (err, rows) => {
    if (err) return internalError(res, err);
    res.json(rows || []);
  });
});

// 獲取人員所屬的群組
router.get('/api/users/:id/groups', withUserDatabase, (req, res) => {
  const { id } = req.params;
  console.log('Hit /api/users/' + id + '/groups');
  req.userDb.all('SELECT g.* FROM groups g JOIN group_users gu ON g.id = gu.group_id WHERE gu.user_id = ?', [id], (err, rows) => {
    if (err) return internalError(res, err);
    res.json(rows || []);
  });
});

router.post('/api/groups/:id/users', withUserDatabase, (req, res) => {
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
    if (err) return internalError(res, err);
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

router.delete('/api/groups/:id/users', withUserDatabase, (req, res) => {
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
    if (err) return internalError(res, err);
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

// API: 取得群組的資料夾權限清單
router.get('/api/groups/:id/permissions', withUserDatabase, (req, res) => {
  const { id } = req.params;
  req.userDb.all(`
    SELECT p.id, p.permission_type, p.folder_id,
           f.name as folder_name, f.path as folder_path
    FROM permissions p
    LEFT JOIN folders f ON p.folder_id = f.id
    WHERE p.group_id = ?
    ORDER BY f.path
  `, [id], (err, rows) => {
    if (err) return internalError(res, err);
    res.json(rows || []);
  });
});

// API: 將群組資料夾權限套用到全體成員
router.post('/api/groups/:id/apply-permissions', withUserDatabase, requireAuth, (req, res) => {
  const groupId = parseInt(req.params.id);
  const db = req.userDb;

  // 取得群組成員
  db.all('SELECT user_id FROM group_users WHERE group_id = ?', [groupId], (err, members) => {
    if (err) return internalError(res, err);
    if (members.length === 0) return res.json({ applied: 0, skipped: 0, message: '群組無成員' });

    // 取得群組的資料夾權限
    db.all('SELECT folder_id, permission_type FROM permissions WHERE group_id = ?', [groupId], (err2, groupPerms) => {
      if (err2) return res.status(500).json({ error: err2.message });
      if (groupPerms.length === 0) return res.json({ applied: 0, skipped: 0, message: '群組無資料夾權限' });

      let applied = 0, skipped = 0, errors = 0;
      const total = members.length * groupPerms.length;
      let done = 0;

      if (total === 0) return res.json({ applied: 0, skipped: 0 });

      members.forEach(({ user_id }) => {
        groupPerms.forEach(({ folder_id, permission_type }) => {
          // 檢查使用者是否已有該資料夾的個人權限
          db.get('SELECT id FROM permissions WHERE user_id = ? AND folder_id = ? AND group_id IS NULL', [user_id, folder_id], (err3, existing) => {
            done++;
            if (err3) { errors++; }
            else if (existing) { skipped++; }
            else {
              db.run('INSERT INTO permissions (folder_id, user_id, group_id, permission_type) VALUES (?, ?, NULL, ?)',
                [folder_id, user_id, permission_type], (err4) => {
                  if (err4) errors++;
                  else applied++;
                });
            }
            if (done === total) {
              // 等待插入完成
              setTimeout(() => {
                res.json({ applied, skipped, errors, message: `已套用 ${applied} 筆，略過 ${skipped} 筆（已存在）` });
              }, 100);
            }
          });
        });
      });
    });
  });
});

// 自動生成群組並指派權限（優化版本 - 批次處理）
router.post('/api/auto-generate-groups', withUserDatabase, async (req, res) => {
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
    const existingGroups = (await dbAll(req.userDb, 'SELECT id, name FROM groups', [])) || [];
    
    const groupMap = {};
    existingGroups.forEach(g => {
      groupMap[g.name] = g.id;
    });
    
    console.log(`現有群組數量: ${existingGroups.length}`);
    
    // 先一次性獲取所有現有權限（減少查詢次數）
    const existingPermissions = (await dbAll(req.userDb, 'SELECT folder_id, group_id, permission_type FROM permissions WHERE group_id IS NOT NULL', [])) || [];
    
    // 以 (資料夾, 群組) 為鍵，不分類型：同一群組在同一資料夾已有權限（即使類型和預期相反）就不再新增，
    // 否則會變成同一群組同時有 read 與 write 兩筆。類型相反的只計數回報，不自動改。
    const permissionSet = new Map();
    existingPermissions.forEach(p => {
      permissionSet.set(`${p.folder_id}-${p.group_id}`, p.permission_type);
    });
    let permissionsConflicting = 0;
    
    console.log(`現有權限數量: ${existingPermissions.length}`);
    
    // 準備批次插入的資料
    const groupsToInsert = new Set();   // 以 Set 去重：資料夾重名（舊資料）會產生相同的群組名稱
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
          groupsToInsert.add(groupName);
        }
      }
      
      foldersProcessed++;
    }
    
    // 批次插入群組
    if (groupsToInsert.size > 0) {
      console.log(`批次建立 ${groupsToInsert.size} 個群組...`);
      
      for (const groupName of groupsToInsert) {
        const existing = await findGroupByName(req.userDb, groupName);
        if (existing) {            // 不分大小寫已存在：重用，不重複建立
          groupMap[groupName] = existing.id;
          continue;
        }
        const groupId = (await dbRun(req.userDb, 'INSERT INTO groups (name) VALUES (?)', [groupName])).lastID;
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
          const permKey = `${folderId}-${groupId}`;

          if (permissionSet.has(permKey)) {
            permissionsExisted++;
            if (permissionSet.get(permKey) !== permType) permissionsConflicting++;
          } else {
            permissionSet.set(permKey, permType);   // 同一次執行內也不重複排入
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
            'INSERT INTO permissions (folder_id, user_id, group_id, permission_type) VALUES (?, NULL, ?, ?)',
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
      permissionsConflicting,
      foldersProcessed
    };
    
    console.log('自動生成完成:', result);
    
    res.json(result);
    
  } catch (error) {
    console.error('自動生成群組時發生錯誤:', error);
    internalError(res, error);
  }
});

module.exports = router;
