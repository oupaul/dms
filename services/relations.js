'use strict';
/**
 * 資料夾、人員、群組、權限、申請單之間的關聯維護。
 *
 * 資料表宣告了外鍵但從未啟用，也沒有唯一性限制，所以「不產生重複」與「刪除時清掉關聯」
 * 必須由應用程式自己做。實際稽核（scripts/data-audit.js）在正式環境發現：
 *   - 單筆與批次刪除群組／人員都不會清除 group_users → 17 個資料庫、約 1,800 筆孤兒成員
 *   - 匯入與建立群組、權限完全沒有檢查是否已存在 → 重複群組（最多 154 組）、重複權限
 * 這裡集中處理這些規則，讓各個 API 共用同一套邏輯。
 */
const { dbGet, dbRun, dbExec } = require('../lib/db');
const { nowISO } = require('../lib/time');

const VALID_PERMISSION_TYPES = ['read', 'write'];
const SYSTEM_REVIEWER = '系統';

// ---------------------------------------------------------------- 群組

const DUPLICATE_GROUP_ERROR = '已有同名的群組（名稱不分大小寫）';

// 以名稱（不分大小寫）找群組；excludeId 用於改名時排除自己
function findGroupByName(db, name, excludeId = null) {
  return dbGet(
    db,
    'SELECT id, name FROM groups WHERE name = ? COLLATE NOCASE AND (? IS NULL OR id != ?) LIMIT 1',
    [String(name).trim(), excludeId, excludeId]
  );
}

// ---------------------------------------------------------------- 權限

// 找「同一資料夾、同一對象」已存在的權限（不論類型）
function findPermission(db, folderId, userId, groupId) {
  return dbGet(
    db,
    'SELECT id, permission_type FROM permissions WHERE folder_id = ? AND user_id IS ? AND group_id IS ? LIMIT 1',
    [folderId, userId ?? null, groupId ?? null]
  );
}

/**
 * 驗證新增權限的輸入。通過回傳 null；不通過回傳 { status, error, id? }。
 *  - 類型只能是 read／write
 *  - 人員與群組必須「剛好指定一個」
 *  - 資料夾與對象必須存在
 *  - 同一資料夾、同一對象不能重複（要改類型請先刪除舊的，避免同時有 read 與 write 兩筆）
 */
async function validatePermissionInput(db, { folder_id, user_id, group_id, permission_type }) {
  if (!VALID_PERMISSION_TYPES.includes(permission_type)) {
    return { status: 400, error: `permission_type 只能是 ${VALID_PERMISSION_TYPES.join('、')}` };
  }
  const hasUser = user_id !== undefined && user_id !== null && user_id !== '';
  const hasGroup = group_id !== undefined && group_id !== null && group_id !== '';
  if (hasUser === hasGroup) {
    return { status: 400, error: '權限必須指定「人員」或「群組」其中一個，不能同時指定或都不指定' };
  }

  const folderId = parseInt(folder_id, 10);
  const userId = hasUser ? parseInt(user_id, 10) : null;
  const groupId = hasGroup ? parseInt(group_id, 10) : null;
  if (hasUser && !(userId > 0)) return { status: 400, error: 'user_id 格式不正確' };
  if (hasGroup && !(groupId > 0)) return { status: 400, error: 'group_id 格式不正確' };

  if (!(await dbGet(db, 'SELECT id FROM folders WHERE id = ?', [folderId]))) {
    return { status: 400, error: '指定的資料夾不存在' };
  }
  if (hasUser && !(await dbGet(db, 'SELECT id FROM users WHERE id = ?', [userId]))) {
    return { status: 400, error: '指定的人員不存在' };
  }
  if (hasGroup && !(await dbGet(db, 'SELECT id FROM groups WHERE id = ?', [groupId]))) {
    return { status: 400, error: '指定的群組不存在' };
  }

  const existing = await findPermission(db, folderId, userId, groupId);
  if (existing) {
    return {
      status: 409,
      id: existing.id,
      error: `此資料夾已經有這個${hasUser ? '人員' : '群組'}的權限（目前為 ${existing.permission_type}）；要變更請先刪除原有權限再新增`
    };
  }
  return null;
}

// ---------------------------------------------------------------- 刪除時的關聯清理

// 申請單的對象或資料夾已被刪除：把待審核的自動駁回，避免日後核准時寫出孤兒權限
function rejectPendingSql(column, idExpr, reason) {
  return `UPDATE permission_requests
            SET status = 'rejected', reviewed_by_username = '${SYSTEM_REVIEWER}',
                reviewed_at = '${nowISO()}', review_note = '${reason}'
          WHERE status = 'pending' AND ${column} ${idExpr};`;
}

// 在單一交易內執行多段 SQL：BEGIN／COMMIT 與所有語句放在「同一次」db.exec，
// sqlite3 會把它當成一個工作依序執行，不會與同一條連線上其他請求的查詢交錯；
// 任何一句失敗就 ROLLBACK，不會留下「成員清掉了但群組還在」這種半套狀態。
async function execInTransaction(db, statements) {
  try {
    await dbExec(db, `BEGIN IMMEDIATE;\n${statements.join('\n')}\nCOMMIT;`);
  } catch (err) {
    try { await dbExec(db, 'ROLLBACK;'); } catch (e) { /* 交易可能已自動結束 */ }
    throw err;
  }
}

function asId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error('invalid id');
  return n;
}

function callbackify(promise, cb) {
  promise.then(() => cb(null), (err) => cb(err));
}

/** 刪除群組：一併清除成員關聯，並駁回以此群組為對象的待審核申請單。callback(err) 風格以便直接替換原本的 db.run。 */
function deleteGroupCascade(db, id, cb) {
  let n;
  try { n = asId(id); } catch (e) { return cb(e); }
  callbackify(execInTransaction(db, [
    rejectPendingSql('target_group_id', `= ${n}`, '對象（群組）已刪除，自動駁回'),
    `DELETE FROM group_users WHERE group_id = ${n};`,
    `DELETE FROM groups WHERE id = ${n};`
  ]), cb);
}

/** 刪除人員：一併清除成員關聯，並駁回以此人員為對象的待審核申請單。 */
function deleteUserCascade(db, id, cb) {
  let n;
  try { n = asId(id); } catch (e) { return cb(e); }
  callbackify(execInTransaction(db, [
    rejectPendingSql('target_user_id', `= ${n}`, '對象（人員）已刪除，自動駁回'),
    `DELETE FROM group_users WHERE user_id = ${n};`,
    `DELETE FROM users WHERE id = ${n};`
  ]), cb);
}

/** 刪除資料夾（含子孫）之前：駁回這些資料夾上待審核的申請單。 */
function rejectPendingForFolderTree(db, rootId, cb) {
  let n;
  try { n = asId(rootId); } catch (e) { return cb(e); }
  callbackify(dbRun(db, `
    UPDATE permission_requests
       SET status = 'rejected', reviewed_by_username = '${SYSTEM_REVIEWER}',
           reviewed_at = '${nowISO()}', review_note = '資料夾已刪除，自動駁回'
     WHERE status = 'pending' AND folder_id IN (
       WITH RECURSIVE sub(id) AS (
         SELECT ${n} UNION SELECT f.id FROM folders f JOIN sub s ON f.parent_id = s.id
       ) SELECT id FROM sub)`), cb);
}

module.exports = {
  VALID_PERMISSION_TYPES,
  DUPLICATE_GROUP_ERROR,
  findGroupByName,
  findPermission,
  validatePermissionInput,
  deleteGroupCascade,
  deleteUserCascade,
  rejectPendingForFolderTree
};
