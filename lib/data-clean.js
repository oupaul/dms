'use strict';
/**
 * 資料清理：把資料健檢（data-audit）發現、且「可以安全自動處理」的問題修正掉。
 *
 * 原則
 *  - 預設只預覽（dry-run）：以唯讀方式（必要時用暫存快照）讀取，不修改任何資料
 *  - 真的套用（--apply）時，每個資料庫：先用 VACUUM INTO 做一份備份 → 單一交易內修正 → 失敗就整個回復
 *  - 只做「有明確規則、不會讓人多拿到權限」的修正；需要人判斷的一律只列出完整清單，不動
 *
 * 可處理的項目（--fix）
 *   orphans            孤兒成員／指向不存在對象的權限 → 刪除
 *   duplicate-permissions
 *                      同資料夾同對象的重複權限：類型相同 → 保留最早一筆；
 *                      read 與 write 並存 → 依群組名稱後綴決定（_RW 留 write、_RO 留 read，一律往名稱的語意走），
 *                      沒有後綴或對象是人員 → 不動，列入人工處理
 *   permission-types   RO／RW（含大小寫變體）→ read／write；其他不認得的值不動
 *   paths              由階層重新計算資料夾路徑（循環中的資料夾不動）
 *   unused-duplicate-groups
 *                      同名群組中「沒有成員、沒有權限、沒有申請單」的多餘複本 → 刪除（至少保留一組）
 *   unused-duplicate-folders
 *                      同層同名資料夾中「沒有子資料夾、沒有權限、沒有申請單」的多餘複本 → 刪除（至少保留一個）
 *   allowed-databases  （system.db）帳號可存取清單中「檔案已不存在」的資料庫名稱 → 移除
 * 'safe' 代表以上全部。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { dbAll, dbGet, dbRun, dbExec } = require('./db');
const { auditTenantDb, openForAudit, hasTable } = require('./data-audit');

const ALL_FIXES = [
  'orphans', 'duplicate-permissions', 'permission-types', 'paths',
  'unused-duplicate-groups', 'unused-duplicate-folders', 'allowed-databases'
];

const TYPE_MAP = { ro: 'read', read: 'read', r: 'read', rw: 'write', write: 'write', w: 'write' };

function result(id, title, count, details = [], manual = []) {
  return { id, title, count, details, manual };
}

// ---------------------------------------------------------------- 各項修正（plan 階段只讀；apply 為 true 時才寫入）

async function fixOrphans(db, apply) {
  const out = [];
  // from 形如 "group_users gu"；DELETE 也用同一個別名，條件式不必改寫
  const q = async (id, title, where, from) => {
    const c = (await dbGet(db, `SELECT COUNT(*) AS c FROM ${from} WHERE ${where}`)).c;
    if (c) {
      if (apply) {
        const [table, alias] = from.split(' ');
        await dbRun(db, `DELETE FROM ${table} AS ${alias} WHERE ${where}`);
      }
      out.push(result(id, title, c));
    }
  };
  if (await hasTable(db, 'group_users')) {
    await q('orphans.group_users', '刪除指向已不存在的群組或人員的成員紀錄',
      'NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = gu.group_id) OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = gu.user_id)',
      'group_users gu');
  }
  if (await hasTable(db, 'permissions')) {
    await q('orphans.permissions', '刪除指向已不存在的資料夾／人員／群組的權限',
      `NOT EXISTS (SELECT 1 FROM folders f WHERE f.id = p.folder_id)
       OR (p.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id))
       OR (p.group_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = p.group_id))`,
      'permissions p');
  }
  return out;
}

async function fixDuplicatePermissions(db, apply) {
  if (!(await hasTable(db, 'permissions'))) return [];
  const rows = await dbAll(db, `
    SELECT p.id, p.folder_id, p.user_id, p.group_id, p.permission_type,
           g.name AS group_name, u.name AS user_name, f.path AS folder_path, f.name AS folder_name
    FROM permissions p
    LEFT JOIN groups g ON g.id = p.group_id
    LEFT JOIN users u ON u.id = p.user_id
    LEFT JOIN folders f ON f.id = p.folder_id
    ORDER BY p.id`);
  // 人員與群組二選一的紀錄才合併；對象不明確的（兩者都有或都沒有）留給人工處理，不在這裡動
  const valid = rows.filter(r => (r.user_id == null) !== (r.group_id == null));
  const byKey = new Map();
  for (const r of valid) {
    const key = `${r.folder_id}|${r.user_id ?? ''}|${r.group_id ?? ''}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }

  const deleteIds = [];
  const details = [];
  const manual = [];
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    const types = [...new Set(list.map(r => r.permission_type))];
    const sample = list[0];
    const label = `${sample.folder_path || sample.folder_name || '資料夾#' + sample.folder_id} ｜ ${sample.group_name ? '群組 ' + sample.group_name : '人員 ' + (sample.user_name || sample.user_id)}`;
    let keepId = null;
    let reason = '';
    if (types.length === 1) {
      keepId = list[0].id;
      reason = `類型相同（${types[0]}），保留最早一筆`;
    } else if (sample.group_name && /_rw$/i.test(sample.group_name)) {
      keepId = (list.find(r => r.permission_type === 'write') || {}).id;
      reason = '群組名稱以 _RW 結尾 → 保留 write';
    } else if (sample.group_name && /_ro$/i.test(sample.group_name)) {
      keepId = (list.find(r => r.permission_type === 'read') || {}).id;
      reason = '群組名稱以 _RO 結尾 → 保留 read';
    }
    if (keepId == null) {
      manual.push({ 項目: label, 紀錄: list.map(r => `#${r.id}=${r.permission_type}`).join('、'), 原因: '類型不同且無法由群組名稱後綴（_RO／_RW）判斷，需人工決定' });
      continue;
    }
    for (const r of list) if (r.id !== keepId) deleteIds.push(r.id);
    details.push({ 項目: label, 保留: `#${keepId}`, 刪除: list.filter(r => r.id !== keepId).map(r => `#${r.id}=${r.permission_type}`).join('、'), 依據: reason });
  }
  if (apply && deleteIds.length) {
    for (let i = 0; i < deleteIds.length; i += 500) {
      const chunk = deleteIds.slice(i, i + 500);
      await dbRun(db, `DELETE FROM permissions WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
    }
  }
  if (!deleteIds.length && !manual.length) return [];
  return [result('duplicate-permissions', '合併重複的權限紀錄', deleteIds.length, details, manual)];
}

async function fixPermissionTypes(db, apply) {
  if (!(await hasTable(db, 'permissions'))) return [];
  const rows = await dbAll(db, "SELECT permission_type AS t, COUNT(*) AS n FROM permissions WHERE permission_type IS NULL OR permission_type NOT IN ('read','write') GROUP BY permission_type");
  if (!rows.length) return [];
  let fixed = 0;
  const details = [];
  const manual = [];
  for (const r of rows) {
    const target = r.t == null ? null : TYPE_MAP[String(r.t).trim().toLowerCase()];
    if (!target) { manual.push({ 值: String(r.t), 筆數: r.n, 原因: '無法對應到 read／write，需人工判斷' }); continue; }
    details.push({ 由: r.t, 改為: target, 筆數: r.n });
    fixed += r.n;
    if (apply) await dbRun(db, 'UPDATE permissions SET permission_type = ? WHERE permission_type = ?', [target, r.t]);
  }
  return [result('permission-types', '修正權限類型（RO／RW 等 → read／write）', fixed, details, manual)];
}

async function fixPaths(db, apply) {
  if (!(await hasTable(db, 'folders'))) return [];
  const folders = await dbAll(db, 'SELECT id, name, parent_id, path FROM folders');
  const byId = new Map(folders.map(f => [f.id, f]));
  const changes = [];
  for (const f of folders) {
    const seen = new Set();
    const parts = [];
    let cur = f;
    let cyclic = false;
    while (cur) {
      if (seen.has(cur.id)) { cyclic = true; break; }
      seen.add(cur.id);
      parts.unshift(cur.name);
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : null;
    }
    if (cyclic) continue;
    const expected = '/' + parts.join('/');
    if (f.path !== expected) changes.push({ id: f.id, from: f.path, to: expected });
  }
  if (!changes.length) return [];
  if (apply) for (const c of changes) await dbRun(db, 'UPDATE folders SET path = ? WHERE id = ?', [c.to, c.id]);
  return [result('paths', '由階層重新計算資料夾路徑', changes.length,
    changes.slice(0, 10).map(c => ({ id: c.id, 原路徑: c.from === null ? 'NULL' : c.from, 新路徑: c.to })))];
}

async function fixUnusedDuplicateGroups(db, apply) {
  if (!(await hasTable(db, 'groups'))) return [];
  const groups = await dbAll(db, `
    SELECT g.id, g.name,
      (SELECT COUNT(*) FROM group_users gu WHERE gu.group_id = g.id) AS members,
      (SELECT COUNT(*) FROM permissions p WHERE p.group_id = g.id) AS perms,
      (SELECT COUNT(*) FROM permission_requests r WHERE r.target_group_id = g.id) AS reqs
    FROM groups g ORDER BY g.id`);
  const byName = new Map();
  for (const g of groups) {
    const k = g.name.trim().toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(g);
  }
  const deleteIds = [];
  const manual = [];
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    const used = list.filter(g => g.members + g.perms + g.reqs > 0);
    const unused = list.filter(g => g.members + g.perms + g.reqs === 0);
    if (used.length >= 2) {
      manual.push({ 群組: list[0].name, 各複本: list.map(g => `#${g.id}（成員${g.members}／權限${g.perms}）`).join('、'), 原因: '兩組以上都有成員或權限，需要合併，需人工確認' });
    }
    // 至少保留一組：有使用中的就全部刪掉未使用的；全部未使用則保留最早的一組
    const removable = used.length ? unused : unused.slice(1);
    for (const g of removable) deleteIds.push(g.id);
  }
  if (apply && deleteIds.length) {
    for (let i = 0; i < deleteIds.length; i += 500) {
      const chunk = deleteIds.slice(i, i + 500);
      await dbRun(db, `DELETE FROM groups WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
    }
  }
  if (!deleteIds.length && !manual.length) return [];
  return [result('unused-duplicate-groups', '刪除同名群組中沒有任何成員／權限的多餘複本', deleteIds.length,
    deleteIds.length ? [{ 說明: `刪除 ${deleteIds.length} 組，每個名稱至少保留一組` }] : [], manual)];
}

async function fixUnusedDuplicateFolders(db, apply) {
  if (!(await hasTable(db, 'folders'))) return [];
  const folders = await dbAll(db, `
    SELECT f.id, f.name, f.parent_id, f.path,
      (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id) AS children,
      (SELECT COUNT(*) FROM permissions p WHERE p.folder_id = f.id) AS perms,
      (SELECT COUNT(*) FROM permission_requests r WHERE r.folder_id = f.id) AS reqs
    FROM folders f ORDER BY f.id`);
  const bySibling = new Map();
  for (const f of folders) {
    const k = `${f.parent_id == null ? 'root' : f.parent_id}\u0000${f.name}`;
    if (!bySibling.has(k)) bySibling.set(k, []);
    bySibling.get(k).push(f);
  }
  const deleteIds = [];
  const manual = [];
  for (const list of bySibling.values()) {
    if (list.length < 2) continue;
    const used = list.filter(f => f.children + f.perms + f.reqs > 0);
    const unused = list.filter(f => f.children + f.perms + f.reqs === 0);
    if (used.length >= 2) {
      manual.push({ 資料夾: list[0].path || list[0].name, 各複本: list.map(f => `#${f.id}（子${f.children}／權限${f.perms}）`).join('、'), 原因: '兩個以上都有子資料夾或權限，需要合併，需人工確認' });
    }
    const removable = used.length ? unused : unused.slice(1);
    for (const f of removable) deleteIds.push(f.id);
  }
  if (apply && deleteIds.length) {
    for (let i = 0; i < deleteIds.length; i += 500) {
      const chunk = deleteIds.slice(i, i + 500);
      await dbRun(db, `DELETE FROM folders WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
    }
  }
  if (!deleteIds.length && !manual.length) return [];
  return [result('unused-duplicate-folders', '刪除同層同名資料夾中沒有子資料夾／權限的多餘複本', deleteIds.length,
    deleteIds.length ? [{ 說明: `刪除 ${deleteIds.length} 個，每組至少保留一個` }] : [], manual)];
}

async function fixAllowedDatabases(db, apply, dbDir) {
  if (!(await hasTable(db, 'accounts'))) return [];
  const files = new Set(fs.readdirSync(dbDir).filter(f => f.endsWith('.db') && !f.startsWith('deleted_')));
  const accounts = await dbAll(db, "SELECT id, username, allowed_databases FROM accounts WHERE allowed_databases IS NOT NULL AND allowed_databases != ''");
  const changes = [];
  for (const a of accounts) {
    let list;
    try { list = JSON.parse(a.allowed_databases); } catch (e) { continue; }
    if (!Array.isArray(list)) continue;
    const kept = list.filter(n => files.has(n));
    if (kept.length !== list.length) {
      changes.push({ id: a.id, username: a.username, 移除: list.filter(n => !files.has(n)).join('、'), 剩餘: kept.length });
    }
  }
  if (!changes.length) return [];
  if (apply) {
    for (const c of changes) {
      const a = accounts.find(x => x.id === c.id);
      const kept = JSON.parse(a.allowed_databases).filter(n => files.has(n));
      await dbRun(db, 'UPDATE accounts SET allowed_databases = ? WHERE id = ?', [JSON.stringify(kept), c.id]);
    }
  }
  const manual = changes.filter(c => c.剩餘 === 0).map(c => ({ 帳號: c.username, 原因: '清單移除後會變成空的（該帳號原本就已經無法存取任何資料庫），請確認是否要重新指派' }));
  return [result('allowed-databases', '移除帳號可存取清單中已不存在的資料庫', changes.length, changes, manual)];
}

const FIXERS = {
  'orphans': (db, apply) => fixOrphans(db, apply),
  'duplicate-permissions': (db, apply) => fixDuplicatePermissions(db, apply),
  'permission-types': (db, apply) => fixPermissionTypes(db, apply),
  'paths': (db, apply) => fixPaths(db, apply),
  'unused-duplicate-groups': (db, apply) => fixUnusedDuplicateGroups(db, apply),
  'unused-duplicate-folders': (db, apply) => fixUnusedDuplicateFolders(db, apply),
  'allowed-databases': (db, apply, dir) => fixAllowedDatabases(db, apply, dir)
};

// 修正的先後順序有意義：先清孤兒與重複權限，再刪「沒有任何東西」的複本，最後重算路徑
const ORDER = ['orphans', 'duplicate-permissions', 'permission-types', 'unused-duplicate-groups', 'unused-duplicate-folders', 'paths', 'allowed-databases'];

// ---------------------------------------------------------------- 單一資料庫

function parseFixes(spec) {
  const list = !spec || spec === 'safe' ? ALL_FIXES : String(spec).split(',').map(s => s.trim()).filter(Boolean);
  const unknown = list.filter(f => !ALL_FIXES.includes(f));
  if (unknown.length) throw new Error(`不認得的 --fix 項目：${unknown.join(', ')}（可用：safe, ${ALL_FIXES.join(', ')}）`);
  return ORDER.filter(f => list.includes(f));
}

function openReadWrite(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READWRITE, (err) => (err ? reject(err) : resolve(db)));
  });
}
const closeDb = (db) => new Promise((resolve) => db.close(() => resolve()));

function backupPath(backupDir, file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(backupDir, `${path.basename(file)}.${stamp}.bak`);
}

/**
 * 預覽或套用單一資料庫的清理。
 * 回傳 { name, applied, backup, fixes:[{id,title,count,details,manual}], after:{...}, error }
 */
async function cleanOne(file, dbDir, { apply, fixes, backupDir, snapshotRoot = os.tmpdir() }) {
  const name = path.basename(file);
  const isSystem = name === 'system.db';
  const wanted = fixes.filter(f => (f === 'allowed-databases') === isSystem);
  const out = { name, applied: false, backup: null, fixes: [], after: null, error: null };
  if (!wanted.length) return out;

  if (!apply) {
    const h = await openForAudit(file, snapshotRoot);
    try {
      for (const f of wanted) out.fixes.push(...await FIXERS[f](h.db, false, dbDir));
    } finally { await h.cleanup(); }
    return out;
  }

  // 先在唯讀（或快照）上算出有沒有事要做；沒有任何可自動處理的變更就不備份、不寫入
  // （只有「需人工處理」的項目也要顯示出來，所以把預覽結果帶回去）
  const probe = await openForAudit(file, snapshotRoot);
  let preview = [];
  try {
    for (const f of wanted) preview.push(...await FIXERS[f](probe.db, false, dbDir));
  } finally { await probe.cleanup(); }
  if (!preview.some(f => f.count > 0)) {
    out.fixes = preview;
    return out;
  }

  // 套用需要對資料庫檔案「與所在目錄」都有寫入權限（WAL 模式要建立 -wal／-shm）；先檢查，給出看得懂的訊息，
  // 且在權限不足時不建立備份目錄、不碰資料庫
  try {
    fs.accessSync(file, fs.constants.W_OK);
    fs.accessSync(path.dirname(file), fs.constants.W_OK);
  } catch (e) {
    out.fixes = preview;
    out.error = `沒有寫入權限（${e.code || e.message}）：請用資料庫檔案的擁有者執行（通常是服務帳號，例如 sudo -u <服務帳號> …），` +
      `或確認檔案與目錄屬於目前的使用者。若是用 sudo cp -a 複製的演練複本，請先 sudo chown -R $(id -un): <複本目錄>`;
    return out;
  }

  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const rw = await openReadWrite(file);
  try {
    await dbExec(rw, 'PRAGMA busy_timeout = 15000;');
    // 備份（VACUUM INTO 產生一致的完整副本，服務執行中也可用）
    const bak = backupPath(backupDir, file);
    await dbRun(rw, `VACUUM INTO '${bak.replace(/'/g, "''")}'`);
    fs.chmodSync(bak, 0o600);
    const chk = await openReadWrite(bak).then(async (b) => { const r = await dbGet(b, 'PRAGMA quick_check'); await closeDb(b); return r; });
    if (!chk || Object.values(chk)[0] !== 'ok') throw new Error('備份檔驗證失敗，已中止，資料庫未被修改');
    out.backup = bak;

    await dbExec(rw, 'BEGIN IMMEDIATE;');
    try {
      for (const f of wanted) out.fixes.push(...await FIXERS[f](rw, true, dbDir));
      await dbExec(rw, 'COMMIT;');
      out.applied = out.fixes.some(f => f.count > 0);
    } catch (err) {
      try { await dbExec(rw, 'ROLLBACK;'); } catch (e) { /* ignore */ }
      out.fixes = [];
      throw err;
    }
    if (!isSystem) {
      const after = await auditTenantDb(rw, { samples: 0, isSystem });
      out.after = Object.fromEntries(after.findings.filter(f => f.severity !== 'info').map(f => [f.id, f.count]));
    }
  } catch (err) {
    out.error = err.message;
  } finally {
    await closeDb(rw);
  }
  return out;
}

async function cleanAll(dbDir, options = {}) {
  const fixes = parseFixes(options.fix);
  const apply = !!options.apply;
  const backupDir = options.backupDir || path.join(process.cwd(), 'backups', 'data-clean');
  const only = options.only && options.only.length ? new Set(options.only) : null;
  const files = fs.readdirSync(dbDir).filter(f => f.endsWith('.db') && !f.startsWith('deleted_')).sort();
  const report = { dir: dbDir, apply, fixes, backupDir: apply ? backupDir : null, databases: [], errors: [] };
  for (const f of files) {
    if (only && !only.has(f)) continue;
    try {
      const r = await cleanOne(path.join(dbDir, f), dbDir, { apply, fixes, backupDir, snapshotRoot: options.snapshotRoot });
      if (r.error) report.errors.push({ database: f, error: r.error });
      if (r.fixes.length || r.error) report.databases.push(r);
    } catch (e) {
      report.errors.push({ database: f, error: e.message });
    }
  }
  report.summary = {
    changed: report.databases.filter(d => d.fixes.some(x => x.count > 0)).length,
    manual: report.databases.reduce((n, d) => n + d.fixes.reduce((m, x) => m + x.manual.length, 0), 0)
  };
  return report;
}

module.exports = { cleanAll, cleanOne, parseFixes, ALL_FIXES };
