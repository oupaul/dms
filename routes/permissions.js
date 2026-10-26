/**
 * 權限 API。
 */

const express = require('express');
const { internalError } = require('../lib/http');
const { withUserDatabase } = require('../middleware/user-database');
const { logAudit } = require('../services/audit');
const { insertPermissionRecord } = require('../services/permissions');
const { validatePermissionInput } = require('../services/relations');

const router = express.Router();

// API: 權限 (修復：加 folder_id 驗證)
router.get('/api/permissions', withUserDatabase, (req, res) => {
  console.log('Hit /api/permissions');
  req.userDb.all(`SELECT p.*, f.path, u.name as user_name, g.name as group_name
          FROM permissions p
          LEFT JOIN folders f ON p.folder_id = f.id
          LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN groups g ON p.group_id = g.id`, (err, rows) => {
    if (err) return internalError(res, err);
    res.json(rows || []);
  });
});

console.log('Registered /api/permissions');

router.post('/api/permissions', withUserDatabase, async (req, res) => {
  console.log('Hit POST /api/permissions', req.body);
  const { folder_id, user_id, group_id, permission_type } = req.body;
  // 修復：驗證 folder_id 必須為有效數字
  if (!folder_id || isNaN(folder_id) || folder_id <= 0) {
    console.error('Invalid folder_id:', folder_id);
    return res.status(400).json({ error: 'folder_id must be a positive integer' });
  }

  // 類型只能是 read／write、對象二選一、資料夾與對象必須存在、同一對象在同一資料夾不能重複
  try {
    const problem = await validatePermissionInput(req.userDb, { folder_id, user_id, group_id, permission_type });
    if (problem) return res.status(problem.status).json({ error: problem.error, ...(problem.id ? { id: problem.id } : {}) });
  } catch (errValidate) {
    return internalError(res, errValidate);
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
      return internalError(res, err);
    }
    
    insertPermissionRecord(req.userDb, {
      folder_id: parseInt(folder_id),
      user_id: user_id ? parseInt(user_id) : null,
      group_id: group_id ? parseInt(group_id) : null,
      permission_type
    }).then((permissionId) => {
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
    }).catch((err2) => {
      console.error('Insert permission error:', err2.message);
      res.status(500).json({ error: err2.message });
    });
  });
});

router.delete('/api/permissions', withUserDatabase, (req, res) => {
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
    if (err) return internalError(res, err);
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
router.delete('/api/permissions/batch', withUserDatabase, (req, res) => {
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

module.exports = router;
