/**
 * 資料夾 API。
 */

const express = require('express');
const { internalError } = require('../lib/http');
const { withUserDatabase } = require('../middleware/user-database');
const { logAudit } = require('../services/audit');
const { buildPathWithDb } = require('../services/folders');

const router = express.Router();

// API: 資料夾
router.get('/api/folders', withUserDatabase, (req, res) => {
  console.log('Hit /api/folders');
  req.userDb.all('SELECT * FROM folders', (err, rows) => {
    if (err) return internalError(res, err);
    res.json(rows || []);
  });
});

console.log('Registered /api/folders');

router.get('/api/folders/:id', withUserDatabase, (req, res) => {
  const { id } = req.params;
  console.log(`Hit GET /api/folders/${id}`);
  req.userDb.get('SELECT * FROM folders WHERE id = ?', [id], (err, row) => {
    if (err) return internalError(res, err);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });
});

router.post('/api/folders', withUserDatabase, (req, res) => {
  console.log('Hit POST /api/folders', req.body);
  const { name, parent_id } = req.body;
  req.userDb.run('INSERT INTO folders (name, parent_id) VALUES (?, ?)', [name, parent_id || null], function(err) {
    if (err) return internalError(res, err);
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

router.put('/api/folders/:id', withUserDatabase, (req, res) => {
  const { id } = req.params;
  const { name, parent_id } = req.body;
  console.log('Hit PUT /api/folders/' + id, { name, parent_id });
  
  const userDb = req.userDb;
  
  // 先獲取舊值
  userDb.get('SELECT name, parent_id, path FROM folders WHERE id = ?', [id], (err, oldFolder) => {
    if (err) return internalError(res, err);
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

router.delete('/api/folders', withUserDatabase, (req, res) => {
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
        if (err) return internalError(res, err);
        
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
        if (err) return internalError(res, err);
        // 記錄審計日誌
        logAudit(req, 'delete', 'folder', parseInt(id), folder.name, { ...folder, force: true }, null);
        console.log(`✓ Force deleted folder: ${id}`);
        res.json({ success: true, force: true });
      });
    }
  });
});

module.exports = router;
