/**
 * 權限記錄寫入與有效權限判斷。
 */

// 共用：寫入一筆權限紀錄——一般新增權限、核准權限異動申請都會用到
function insertPermissionRecord(userDb, { folder_id, user_id, group_id, permission_type }) {
  return new Promise((resolve, reject) => {
    userDb.run(
      'INSERT INTO permissions (folder_id, user_id, group_id, permission_type) VALUES (?, ?, ?, ?)',
      [folder_id, user_id || null, group_id || null, permission_type],
      function (err) {
        if (err) reject(err); else resolve(this.lastID);
      }
    );
  });
}

// 共用：查某個對象在某資料夾「實際生效」的權限——個人直接權限優先，
// 沒有的話（僅限 target_type='user'）展開這個人所屬的群組，看有沒有群組
// 在這個資料夾上有權限（取較高者，write > read，邏輯照抄
// /export_permission_matrix 既有的權限矩陣展開方式）。都查不到回傳 null。
function getEffectivePermissionInfo(userDb, folder_id, target_type, target_user_id, target_group_id) {
  return new Promise((resolve, reject) => {
    if (target_type === 'group') {
      userDb.get(
        'SELECT permission_type FROM permissions WHERE folder_id = ? AND group_id = ?',
        [folder_id, target_group_id],
        (err, row) => {
          if (err) return reject(err);
          resolve(row ? { permission_type: row.permission_type, source: 'direct', via_group_id: null, via_group_name: null } : null);
        }
      );
      return;
    }

    userDb.get(
      'SELECT permission_type FROM permissions WHERE folder_id = ? AND user_id = ?',
      [folder_id, target_user_id],
      (err, directRow) => {
        if (err) return reject(err);
        if (directRow) {
          return resolve({ permission_type: directRow.permission_type, source: 'direct', via_group_id: null, via_group_name: null });
        }

        userDb.all(
          `SELECT g.id as group_id, g.name as group_name, p.permission_type
           FROM group_users gu
           JOIN groups g ON gu.group_id = g.id
           JOIN permissions p ON p.group_id = g.id AND p.folder_id = ?
           WHERE gu.user_id = ?`,
          [folder_id, target_user_id],
          (err2, rows) => {
            if (err2) return reject(err2);
            if (!rows || rows.length === 0) return resolve(null);

            let best = rows[0];
            rows.forEach(r => {
              if (best.permission_type === 'read' && r.permission_type === 'write') best = r;
            });
            resolve({ permission_type: best.permission_type, source: 'group', via_group_id: best.group_id, via_group_name: best.group_name });
          }
        );
      }
    );
  });
}

module.exports = {
  getEffectivePermissionInfo,
  insertPermissionRecord,
};
