/**
 * 權限異動申請單。
 */

const express = require('express');
const ExcelJS = require('exceljs');
const fs = require('fs');
const crypto = require('crypto');
const { DB_DIR, SYSTEM_DB_NAMES } = require('../lib/config');
const { internalError } = require('../lib/http');
const { nowFileStamp, nowISO } = require('../lib/time');
const { isClientRoleSession, requireStaffRole } = require('../middleware/auth');
const { withUserDatabase } = require('../middleware/user-database');
const { logAudit } = require('../services/audit');
const { connectDatabase, getSystemDb, isDatabaseOwnedBy, listAllDatabaseNames } = require('../services/database');
const { getEffectivePermissionInfo, insertPermissionRecord } = require('../services/permissions');
const { dbAll, dbGet, dbRun } = require('../lib/db');

const router = express.Router();

// ==================== 權限異動申請單 ====================

// 驗證單一申請項目，回傳整理後的欄位；有誤則回傳 { error }
function validatePermissionRequestItem(item) {
  const { folder_id, target_type, target_user_id, target_group_id, requested_permission_type, reason } = item || {};

  if (!folder_id || isNaN(folder_id) || folder_id <= 0) {
    return { error: 'folder_id must be a positive integer' };
  }
  if (target_type !== 'user' && target_type !== 'group') {
    return { error: 'target_type must be "user" or "group"' };
  }
  const targetUserId = target_type === 'user' ? parseInt(target_user_id) : null;
  const targetGroupId = target_type === 'group' ? parseInt(target_group_id) : null;
  if (target_type === 'user' && (!targetUserId || isNaN(targetUserId))) {
    return { error: 'target_user_id required when target_type is "user"' };
  }
  if (target_type === 'group' && (!targetGroupId || isNaN(targetGroupId))) {
    return { error: 'target_group_id required when target_type is "group"' };
  }
  if (requested_permission_type !== 'read' && requested_permission_type !== 'write') {
    return { error: 'requested_permission_type must be "read" or "write"' };
  }
  if (!reason || !String(reason).trim()) {
    return { error: 'reason is required' };
  }

  return {
    folder_id: parseInt(folder_id),
    target_type,
    target_user_id: targetUserId,
    target_group_id: targetGroupId,
    requested_permission_type,
    reason: String(reason).trim()
  };
}

// 客戶端帳號一次送出多筆申請（唯讀帳號也可呼叫，見 VIEWER_WRITE_WHITELIST）
router.post('/api/permission-requests', withUserDatabase, async (req, res) => {
  if (!isClientRoleSession(req)) {
    return res.status(403).json({ error: 'forbidden', message: '僅限客戶端帳號提出申請' });
  }

  const items = Array.isArray(req.body.items) ? req.body.items : null;
  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }

  const validated = [];
  for (const raw of items) {
    const result = validatePermissionRequestItem(raw);
    if (result.error) return res.status(400).json({ error: result.error });
    validated.push(result);
  }

  try {
    // 先確認每筆的資料夾都存在，任何一筆有問題就整批不寫入
    const infos = [];
    for (const item of validated) {
      const info = await dbGet(req.userDb, `
          SELECT f.path as folder_path, f.name as folder_name,
                 u.name as user_name, g.name as group_name
          FROM folders f
          LEFT JOIN users u ON u.id = ?
          LEFT JOIN groups g ON g.id = ?
          WHERE f.id = ?
        `, [item.target_user_id, item.target_group_id, item.folder_id]);
      if (!info) {
        return res.status(404).json({ error: `找不到指定的資料夾 (folder_id=${item.folder_id})` });
      }
      infos.push(info);
    }

    const batchId = crypto.randomUUID();
    const requestedAt = nowISO();
    const insertedIds = [];

    for (let i = 0; i < validated.length; i++) {
      const item = validated[i];
      const info = infos[i];
      const effective = await getEffectivePermissionInfo(req.userDb, item.folder_id, item.target_type, item.target_user_id, item.target_group_id);
      const previousPermissionType = effective ? effective.permission_type : null;
      const previousPermissionSource = effective ? effective.source : null;
      const previousViaGroupId = effective ? effective.via_group_id : null;
      const previousViaGroupName = effective ? effective.via_group_name : null;

      const requestId = (await dbRun(req.userDb, `INSERT INTO permission_requests
            (folder_id, target_type, target_user_id, target_group_id, requested_permission_type, reason,
             status, requested_by_account_id, requested_by_username, requested_at, batch_id,
             previous_permission_type, previous_permission_source, previous_via_group_id, previous_via_group_name)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`, [item.folder_id, item.target_type, item.target_user_id, item.target_group_id, item.requested_permission_type, item.reason,
           req.session.userId, req.session.username, requestedAt, batchId,
           previousPermissionType, previousPermissionSource, previousViaGroupId, previousViaGroupName])).lastID;

      insertedIds.push(requestId);
      const resourceName = `${info.folder_path || info.folder_name || '資料夾'}: ${info.user_name || info.group_name || '未知'}`;

      logAudit(req, 'create', 'permission_request', requestId, resourceName, null, {
        folder_id: item.folder_id,
        target_type: item.target_type,
        target_user_id: item.target_user_id,
        target_group_id: item.target_group_id,
        requested_permission_type: item.requested_permission_type,
        previous_permission_type: previousPermissionType,
        previous_permission_source: previousPermissionSource,
        previous_via_group_name: previousViaGroupName,
        reason: item.reason,
        folder_path: info.folder_path,
        user_name: info.user_name,
        group_name: info.group_name
      });
    }

    res.json({ batch_id: batchId, ids: insertedIds });
  } catch (err) {
    internalError(res, err);
  }
});

// 申請單列表：客戶端帳號只看得到自己送出的，工程師/管理員看得到全部（可用 status／batch_id 篩選）
router.get('/api/permission-requests', withUserDatabase, (req, res) => {
  const isStaff = !isClientRoleSession(req);
  const { status, batch_id } = req.query;

  let sql = `SELECT r.*, f.path as folder_path, f.name as folder_name,
                    u.name as target_user_name, g.name as target_group_name
             FROM permission_requests r
             LEFT JOIN folders f ON r.folder_id = f.id
             LEFT JOIN users u ON r.target_user_id = u.id
             LEFT JOIN groups g ON r.target_group_id = g.id`;
  const conditions = [];
  const params = [];

  if (!isStaff) {
    conditions.push('r.requested_by_account_id = ?');
    params.push(req.session.userId);
  }
  if (status) {
    conditions.push('r.status = ?');
    params.push(status);
  }
  if (batch_id) {
    conditions.push('r.batch_id = ?');
    params.push(batch_id);
  }
  if (conditions.length) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY r.requested_at DESC';

  req.userDb.all(sql, params, (err, rows) => {
    if (err) return internalError(res, err);
    res.json(rows || []);
  });
});

// 核准申請單：把現有權限「更新」成申請的權限（沒有現有權限才新增），維持前後比對的語意成立
router.post('/api/permission-requests/:id/approve', requireStaffRole, withUserDatabase, async (req, res) => {
  const id = parseInt(req.params.id);
  const { review_note } = req.body;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  try {
    const request = await dbGet(req.userDb, 'SELECT * FROM permission_requests WHERE id = ?', [id]);
    if (!request) return res.status(404).json({ error: 'Not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ error: '此申請單已處理過' });
    }

    // 核准當下重新查一次目前實際生效的權限（可能是個人直接權限，也可能是透過群組成員身分取得）
    const effective = await getEffectivePermissionInfo(req.userDb, request.folder_id, request.target_type, request.target_user_id, request.target_group_id);
    const previousPermissionType = effective ? effective.permission_type : null;
    const previousPermissionSource = effective ? effective.source : null;
    const previousViaGroupId = effective ? effective.via_group_id : null;
    const previousViaGroupName = effective ? effective.via_group_name : null;

    let permissionId = null;
    let appliedViaGroupId = null;
    let appliedViaGroupName = null;

    // 對象是人員時，先看這個資料夾上有沒有「剛好一個」群組本來就設定了申請的權限類型，
    // 有的話用搬群組成員的方式套用（更貼近實務上「把人從 RO 群組移到 RW 群組」的做法）；
    // 對象本身就是群組、或找不到唯一對應的群組時，fallback 回直接權限 upsert。
    let candidateGroup = null;
    if (request.target_type === 'user') {
      const candidates = (await dbAll(req.userDb, `SELECT g.id as group_id, g.name as group_name
           FROM permissions p JOIN groups g ON p.group_id = g.id
           WHERE p.folder_id = ? AND p.permission_type = ?`, [request.folder_id, request.requested_permission_type])) || [];
      if (candidates.length === 1) candidateGroup = candidates[0];
    }

    if (candidateGroup) {
      await dbRun(req.userDb, 'INSERT OR IGNORE INTO group_users (group_id, user_id) VALUES (?, ?)', [candidateGroup.group_id, request.target_user_id]);
      if (previousPermissionSource === 'group' && previousViaGroupId && previousViaGroupId !== candidateGroup.group_id) {
        await dbRun(req.userDb, 'DELETE FROM group_users WHERE group_id = ? AND user_id = ?', [previousViaGroupId, request.target_user_id]);
      }
      appliedViaGroupId = candidateGroup.group_id;
      appliedViaGroupName = candidateGroup.group_name;
    } else {
      const existingDirect = await dbGet(req.userDb, 'SELECT id FROM permissions WHERE folder_id = ? AND user_id IS ? AND group_id IS ?', [request.folder_id, request.target_user_id, request.target_group_id]);
      if (existingDirect) {
        await dbRun(req.userDb, 'UPDATE permissions SET permission_type = ? WHERE id = ?', [request.requested_permission_type, existingDirect.id]);
        permissionId = existingDirect.id;
      } else {
        permissionId = await insertPermissionRecord(req.userDb, {
          folder_id: request.folder_id,
          user_id: request.target_user_id,
          group_id: request.target_group_id,
          permission_type: request.requested_permission_type
        });
      }
    }

    const reviewedAt = nowISO();
    await dbRun(req.userDb, `UPDATE permission_requests
         SET status = 'approved', reviewed_by_username = ?, reviewed_at = ?, review_note = ?,
             applied_permission_id = ?, previous_permission_type = ?, previous_permission_source = ?,
             previous_via_group_id = ?, previous_via_group_name = ?, applied_via_group_id = ?, applied_via_group_name = ?
         WHERE id = ?`, [req.session.username, reviewedAt, review_note || null, permissionId,
         previousPermissionType, previousPermissionSource, previousViaGroupId, previousViaGroupName,
         appliedViaGroupId, appliedViaGroupName, id]);

    logAudit(req, 'update', 'permission_request', id, `申請單 #${id}`,
      { status: 'pending', previous_permission_type: previousPermissionType, previous_permission_source: previousPermissionSource, previous_via_group_name: previousViaGroupName },
      { status: 'approved', applied_permission_id: permissionId, applied_via_group_name: appliedViaGroupName, requested_permission_type: request.requested_permission_type, review_note: review_note || null }
    );

    res.json({
      success: true,
      applied_permission_id: permissionId,
      previous_permission_type: previousPermissionType,
      previous_via_group_name: previousViaGroupName,
      applied_via_group_id: appliedViaGroupId,
      applied_via_group_name: appliedViaGroupName
    });
  } catch (err) {
    internalError(res, err);
  }
});

// 駁回申請單：不寫入 permissions，僅記錄駁回原因
router.post('/api/permission-requests/:id/reject', requireStaffRole, withUserDatabase, (req, res) => {
  const id = parseInt(req.params.id);
  const { review_note } = req.body;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  req.userDb.get('SELECT * FROM permission_requests WHERE id = ?', [id], (err, request) => {
    if (err) return internalError(res, err);
    if (!request) return res.status(404).json({ error: 'Not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ error: '此申請單已處理過' });
    }

    const reviewedAt = nowISO();
    req.userDb.run(
      `UPDATE permission_requests
       SET status = 'rejected', reviewed_by_username = ?, reviewed_at = ?, review_note = ?
       WHERE id = ?`,
      [req.session.username, reviewedAt, review_note || null, id],
      (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });

        logAudit(req, 'update', 'permission_request', id, `申請單 #${id}`,
          { status: 'pending' },
          { status: 'rejected', review_note: review_note || null }
        );

        res.json({ success: true });
      }
    );
  });
});

// 匯出申請單前後差異報告（xlsx）；帶 ?batch_id= 匯出單一批次，不帶則匯出目前篩選條件下的全部
router.get('/api/permission-requests/export', requireStaffRole, withUserDatabase, async (req, res) => {
  const { batch_id, status } = req.query;

  let sql = `SELECT r.*, f.path as folder_path, f.name as folder_name,
                    u.name as target_user_name, g.name as target_group_name
             FROM permission_requests r
             LEFT JOIN folders f ON r.folder_id = f.id
             LEFT JOIN users u ON r.target_user_id = u.id
             LEFT JOIN groups g ON r.target_group_id = g.id`;
  const conditions = [];
  const params = [];
  if (batch_id) { conditions.push('r.batch_id = ?'); params.push(batch_id); }
  if (status) { conditions.push('r.status = ?'); params.push(status); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY r.requested_at DESC';

  try {
    const rows = (await dbAll(req.userDb, sql, params)) || [];

    if (rows.length === 0) {
      return res.status(400).json({ error: '沒有符合條件的申請單可匯出' });
    }

    const permLabel = (v) => v === 'read' ? '讀取' : v === 'write' ? '寫入' : (v ? v : '無');
    const statusLabel = { pending: '待審核', approved: '已核准', rejected: '已駁回' };
    const beforeLabel = (r) => {
      const base = permLabel(r.previous_permission_type);
      return r.previous_permission_source === 'group' && r.previous_via_group_name
        ? `${base}（透過群組：${r.previous_via_group_name}）`
        : base;
    };
    const afterLabel = (r) => {
      const base = permLabel(r.requested_permission_type);
      return r.applied_via_group_name
        ? `${base}（加入群組：${r.applied_via_group_name}）`
        : base;
    };

    const workbook = new ExcelJS.Workbook();
    workbook.creator = '資料夾權限文管系統';
    workbook.created = new Date();
    const worksheet = workbook.addWorksheet('權限異動申請單');

    worksheet.columns = [
      { header: '資料夾', key: 'folder', width: 30 },
      { header: '對象類型', key: 'targetType', width: 10 },
      { header: '對象名稱', key: 'targetName', width: 20 },
      { header: '異動前權限', key: 'before', width: 28 },
      { header: '異動後權限', key: 'after', width: 28 },
      { header: '狀態', key: 'status', width: 10 },
      { header: '申請人', key: 'requestedBy', width: 15 },
      { header: '申請時間', key: 'requestedAt', width: 20 },
      { header: '審核人', key: 'reviewedBy', width: 15 },
      { header: '審核時間', key: 'reviewedAt', width: 20 },
      { header: '審核備註', key: 'reviewNote', width: 30 },
      { header: '申請原因', key: 'reason', width: 30 }
    ];

    rows.forEach(r => {
      worksheet.addRow({
        folder: r.folder_path || r.folder_name || `資料夾 ${r.folder_id}`,
        targetType: r.target_type === 'group' ? '群組' : '人員',
        targetName: r.target_type === 'group' ? (r.target_group_name || String(r.target_group_id)) : (r.target_user_name || String(r.target_user_id)),
        before: beforeLabel(r),
        after: afterLabel(r),
        status: statusLabel[r.status] || r.status,
        requestedBy: r.requested_by_username,
        requestedAt: r.requested_at,
        reviewedBy: r.reviewed_by_username || '—',
        reviewedAt: r.reviewed_at || '—',
        reviewNote: r.review_note || '—',
        reason: r.reason
      });
    });
    worksheet.getRow(1).font = { bold: true };

    const tempFile = 'temp_permission_requests_export_' + Date.now() + '.xlsx';
    await workbook.xlsx.writeFile(tempFile);

    const timestamp = nowFileStamp();
    const filename = `權限異動申請單_${timestamp}.xlsx`;
    res.download(tempFile, filename, (err) => {
      if (err) console.error('Download error:', err);
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    });
  } catch (error) {
    console.error('Export permission requests error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: '匯出失敗：' + error.message });
    }
  }
});

// 待審核申請單跨資料庫彙總：讓工程師/管理員登入時不用切換資料庫也能知道
// 「總共有幾筆待審核、分布在哪些資料庫」。刻意不用 withUserDatabase（只綁
// 單一 session 資料庫），也不用會永久快取連線的 getUserDatabase()——這裡
// 一律用 connectDatabase() 開短命連線、查完立刻關閉，避免每次呼叫都佔用
// 使用者連線快取（services/database.js）的名額。
router.get('/api/permission-requests/pending-summary', requireStaffRole, async (req, res) => {
  try {
    const isAdmin = req.session.role === 'admin';
    const roleLevel = req.session.roleLevel || 'user';
    const username = req.session.username;

    let databaseNames;
    if (isAdmin) {
      databaseNames = fs.readdirSync(DB_DIR)
        .filter(f => f.endsWith('.db') && !SYSTEM_DB_NAMES.has(f) && !f.startsWith('deleted_'));
    } else if (roleLevel === 'engineer') {
      databaseNames = req.session.allowedDatabases || [];
    } else {
      databaseNames = listAllDatabaseNames().filter(name => isDatabaseOwnedBy(name, username));
    }

    if (databaseNames.length === 0) {
      return res.json({ total: 0, current: req.session.userDatabase || null, byDatabase: [] });
    }

    const regRows = (await dbAll(getSystemDb(), 'SELECT name, display_name FROM databases', [])) || [];
    const displayNameMap = {};
    regRows.forEach(r => { displayNameMap[r.name] = r.display_name; });

    const counts = await Promise.all(databaseNames.map(async (name) => {
      let database;
      try {
        database = await connectDatabase(name);
        const row = await dbGet(database, "SELECT COUNT(*) as cnt FROM permission_requests WHERE status = 'pending'", []);
        return { name, displayName: displayNameMap[name] || name, count: row ? row.cnt : 0 };
      } catch (err) {
        console.warn(`pending-summary: 查詢 ${name} 失敗:`, err.message);
        return { name, displayName: displayNameMap[name] || name, count: 0 };
      } finally {
        if (database) {
          database.close((err) => { if (err) console.warn(`pending-summary: 關閉 ${name} 連線失敗:`, err.message); });
        }
      }
    }));

    const byDatabase = counts.filter(c => c.count > 0).sort((a, b) => b.count - a.count);
    const total = byDatabase.reduce((sum, c) => sum + c.count, 0);

    res.json({ total, current: req.session.userDatabase || null, byDatabase });
  } catch (error) {
    console.error('pending-summary error:', error);
    internalError(res, error);
  }
});

module.exports = router;
