/**
 * 人員 API。
 */

const express = require('express');
const { internalError } = require('../lib/http');
const { withUserDatabase } = require('../middleware/user-database');
const { logAudit } = require('../services/audit');

const router = express.Router();

// API: 人員
router.get('/api/users', withUserDatabase, (req, res) => {
  console.log('Hit /api/users');
  req.userDb.all('SELECT * FROM users', (err, rows) => {
    if (err) return internalError(res, err);
    res.json(rows || []);
  });
});

console.log('Registered /api/users');

router.get('/api/users/:id', withUserDatabase, (req, res) => {
  const { id } = req.params;
  console.log(`Hit GET /api/users/${id}`);
  req.userDb.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
    if (err) return internalError(res, err);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });
});

router.post('/api/users', withUserDatabase, (req, res) => {
  console.log('Hit POST /api/users', req.body);
  const { name, email, department, company, title, phone, description, account_key } = req.body;
  req.userDb.run(
    'INSERT INTO users (name, email, department, company, title, phone, description, account_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [name, email, department || null, company || null, title || null, phone || null, description || null, account_key || null],
    function(err) {
      if (err) return internalError(res, err);
      const userId = this.lastID;
      logAudit(req, 'create', 'user', userId, name, null, { name, email, department, company, title, phone, description, account_key });
      res.json({ id: userId });
    }
  );
});

router.put('/api/users/:id', withUserDatabase, (req, res) => {
  const { id } = req.params;
  const { name, email, department, company, title, phone, description, account_key } = req.body;
  console.log('Hit PUT /api/users/' + id, req.body);

  req.userDb.get('SELECT name, email, department, company, title, phone, description, account_key FROM users WHERE id = ?', [id], (err, oldUser) => {
    if (err) return internalError(res, err);
    if (!oldUser) return res.status(404).json({ error: 'Not found' });

    req.userDb.run(
      'UPDATE users SET name = ?, email = ?, department = ?, company = ?, title = ?, phone = ?, description = ?, account_key = ? WHERE id = ?',
      [name, email, department || null, company || null, title || null, phone || null, description || null, account_key || null, id],
      function(err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        logAudit(req, 'update', 'user', parseInt(id), name, oldUser, { name, email, department, company, title, phone, description, account_key });
        res.json({ success: true });
      }
    );
  });
});

router.delete('/api/users', withUserDatabase, (req, res) => {
  const { id } = req.body;
  console.log('Hit DELETE /api/users', { id });
  
  // 先檢查是否有關聯的權限
  req.userDb.all(`
    SELECT p.id, p.permission_type, f.name as folder_name, f.path as folder_path
    FROM permissions p
    LEFT JOIN folders f ON p.folder_id = f.id
    WHERE p.user_id = ?
  `, [id], (err, permissions) => {
    if (err) return internalError(res, err);
    
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

// 複製人員（AD-like Copy User）
router.post('/api/users/:id/copy', withUserDatabase, (req, res) => {
  const sourceId = parseInt(req.params.id);
  const { name, account_key, email, description } = req.body;
  console.log('Hit POST /api/users/' + sourceId + '/copy', req.body);

  if (!name || !account_key || !email) {
    return res.status(400).json({ error: '姓名、帳號、Email 為必填欄位' });
  }

  const db = req.userDb;

  // 1. 取得來源人員資料
  db.get('SELECT * FROM users WHERE id = ?', [sourceId], (err, source) => {
    if (err) return internalError(res, err);
    if (!source) return res.status(404).json({ error: '來源人員不存在' });

    // 2. 建立新人員（name / account_key / description 用新值，其餘照抄）
    db.run(
      'INSERT INTO users (name, email, department, company, title, phone, description, account_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, email, source.department || null, source.company || null, source.title || null, source.phone || null, description || null, account_key],
      function(err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        const newUserId = this.lastID;

        // 3. 複製群組關聯
        db.all('SELECT group_id FROM group_users WHERE user_id = ?', [sourceId], (err3, groups) => {
          if (err3) return res.status(500).json({ error: err3.message });

          const groupInserts = (groups || []).map(g => new Promise((resolve, reject) => {
            db.run('INSERT OR IGNORE INTO group_users (group_id, user_id) VALUES (?, ?)', [g.group_id, newUserId], err4 => {
              if (err4) reject(err4); else resolve();
            });
          }));

          // 4. 複製個人直接權限（user_id 直接指定，非透過 group_id）
          db.all('SELECT folder_id, permission_type FROM permissions WHERE user_id = ? AND group_id IS NULL', [sourceId], (err5, perms) => {
            if (err5) return res.status(500).json({ error: err5.message });

            const permInserts = (perms || []).map(p => new Promise((resolve, reject) => {
              db.run('INSERT OR IGNORE INTO permissions (folder_id, user_id, group_id, permission_type) VALUES (?, ?, NULL, ?)',
                [p.folder_id, newUserId, p.permission_type], err6 => {
                  if (err6) reject(err6); else resolve();
                });
            }));

            Promise.all([...groupInserts, ...permInserts])
              .then(() => {
                logAudit(req, 'create', 'user', newUserId, name, null, {
                  name, account_key, description,
                  copied_from_id: sourceId,
                  copied_from_name: source.name,
                  groups_copied: (groups || []).length,
                  permissions_copied: (perms || []).length
                });
                res.json({
                  id: newUserId,
                  groups_copied: (groups || []).length,
                  permissions_copied: (perms || []).length
                });
              })
              .catch(err7 => res.status(500).json({ error: err7.message }));
          });
        });
      }
    );
  });
});

// 批次刪除人員
router.delete('/api/users/batch', withUserDatabase, (req, res) => {
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

module.exports = router;
