'use strict';
/**
 * 資料健檢（唯讀）：檢查資料庫、資料夾、人員、群組、權限、申請單之間的關聯是否一致。
 *
 * 目的：資料表宣告了外鍵但從未啟用（PRAGMA foreign_keys = 0），也沒有唯一性與合法值限制，
 * 舊資料裡可能已經有孤兒、重複或不合法的紀錄。要加限制（唯一索引、開外鍵）之前，
 * 必須先知道實際有多少、在哪裡，這支只負責「看」，絕不修改任何資料。
 *
 * 嚴重度
 *   error：資料已經不一致，會造成錯誤的權限判斷或匯出結果
 *   warn ：有疑慮，建議處理
 *   info ：僅供參考（不一定要改）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { dbAll, dbGet } = require('./db');

const SAMPLE_LIMIT_DEFAULT = 5;
const STALE_PENDING_DAYS = 30;
const FORBIDDEN_FOLDER_CHARS = /[\\/:*?"<>|]/;

// ---------------------------------------------------------------- 工具

function openReadOnly(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (err) => (err ? reject(err) : resolve(db)));
  });
}

function closeDb(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

// WAL 模式的資料庫，唯讀連線需要能讀寫 -shm（或它已存在）。服務沒有開著那個資料庫、
// 且目前使用者對資料庫目錄沒有寫入權限時，會得到 SQLITE_READONLY。這時改成：
// 把資料庫（連同 -wal／-shm）複製到權限 700 的暫存目錄，對「副本」檢查，原檔完全不碰。
// 異常中止（Ctrl+C、kill）時也要把暫存快照刪掉
const activeSnapshotDirs = new Set();
function removeActiveSnapshots() {
  for (const d of activeSnapshotDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  activeSnapshotDirs.clear();
}
process.on('exit', removeActiveSnapshots);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { removeActiveSnapshots(); process.exit(130); });

const SNAPSHOT_FALLBACK_CODES = new Set(['SQLITE_READONLY', 'SQLITE_CANTOPEN', 'SQLITE_BUSY', 'SQLITE_LOCKED']);

async function openForAudit(file, snapshotRoot) {
  let db;
  try {
    db = await openReadOnly(file);
    await dbGet(db, 'SELECT name FROM sqlite_master LIMIT 1');   // 錯誤通常在第一次查詢才出現
    return { db, snapshot: false, cleanup: async () => closeDb(db) };
  } catch (err) {
    if (db) await closeDb(db);
    if (!SNAPSHOT_FALLBACK_CODES.has(err.code)) throw err;
  }

  const dir = fs.mkdtempSync(path.join(snapshotRoot, 'dms-audit-'));
  fs.chmodSync(dir, 0o700);
  activeSnapshotDirs.add(dir);
  const base = path.basename(file);
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const src = file + suffix;
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, path.join(dir, base + suffix));
      fs.chmodSync(path.join(dir, base + suffix), 0o600);
    }
  } catch (copyErr) {
    fs.rmSync(dir, { recursive: true, force: true });
    activeSnapshotDirs.delete(dir);
    const e = new Error(`無法讀取資料庫檔案（${copyErr.code || copyErr.message}）；請改用服務帳號執行，例如 sudo -u <服務帳號> node scripts/data-audit.js`);
    e.code = copyErr.code;
    throw e;
  }
  const copy = await new Promise((resolve, reject) => {
    const d = new sqlite3.Database(path.join(dir, base), (err) => (err ? reject(err) : resolve(d)));
  });
  await dbGet(copy, 'SELECT name FROM sqlite_master LIMIT 1');
  return {
    db: copy,
    snapshot: true,
    cleanup: async () => { await closeDb(copy); fs.rmSync(dir, { recursive: true, force: true }); activeSnapshotDirs.delete(dir); }
  };
}

async function tableColumns(db, table) {
  const rows = await dbAll(db, `PRAGMA table_info(${table})`);
  return rows.map(r => r.name);
}

async function hasTable(db, table) {
  const row = await dbGet(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  return !!row;
}

function finding(severity, id, title, count, samples, hint) {
  return { severity, id, title, count, samples: samples || [], hint: hint || '' };
}

// 以 SQL 做的檢查：count 與樣本用同一個 FROM/WHERE
async function sqlCheck(db, { severity, id, title, from, where, select, hint, samples }) {
  const row = await dbGet(db, `SELECT COUNT(*) AS c FROM ${from} WHERE ${where}`);
  const count = row ? row.c : 0;
  if (!count) return null;
  const rows = await dbAll(db, `SELECT ${select} FROM ${from} WHERE ${where} LIMIT ${samples}`);
  return finding(severity, id, title, count, rows, hint);
}

// ---------------------------------------------------------------- 單一資料庫（資料夾／人員／群組／權限／申請單）

async function auditTenantDb(db, { samples = SAMPLE_LIMIT_DEFAULT, isSystem = false } = {}) {
  const findings = [];
  const add = (f) => { if (f) findings.push(f); };

  const has = {};
  for (const t of ['folders', 'users', 'groups', 'group_users', 'permissions', 'permission_requests', 'accounts']) {
    has[t] = await hasTable(db, t);
  }
  const cols = {};
  for (const t of ['users', 'permission_requests']) cols[t] = has[t] ? await tableColumns(db, t) : [];

  const stats = {};
  for (const t of ['folders', 'users', 'groups', 'group_users', 'permissions', 'permission_requests']) {
    stats[t] = has[t] ? (await dbGet(db, `SELECT COUNT(*) AS c FROM ${t}`)).c : null;
  }

  // ---- group_users 孤兒
  if (has.group_users && has.groups) {
    add(await sqlCheck(db, {
      severity: 'error', id: 'group_users.orphan_group', samples,
      title: '群組成員紀錄指向已不存在的群組',
      from: 'group_users gu', where: 'NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = gu.group_id)',
      select: 'gu.group_id, gu.user_id',
      hint: '刪除群組時沒有同步清除成員關聯；可安全刪除這些列'
    }));
  }
  if (has.group_users && has.users) {
    add(await sqlCheck(db, {
      severity: 'error', id: 'group_users.orphan_user', samples,
      title: '群組成員紀錄指向已不存在的人員',
      from: 'group_users gu', where: 'NOT EXISTS (SELECT 1 FROM users u WHERE u.id = gu.user_id)',
      select: 'gu.group_id, gu.user_id',
      hint: '刪除人員時沒有同步清除成員關聯；可安全刪除這些列'
    }));
  }

  // ---- permissions
  if (has.permissions) {
    if (has.folders) {
      add(await sqlCheck(db, {
        severity: 'error', id: 'permissions.orphan_folder', samples,
        title: '權限指向已不存在的資料夾',
        from: 'permissions p', where: 'NOT EXISTS (SELECT 1 FROM folders f WHERE f.id = p.folder_id)',
        select: 'p.id, p.folder_id, p.user_id, p.group_id, p.permission_type',
        hint: '無對應資料夾，這些權限不會出現在任何畫面，但匯出可能受影響；確認後刪除'
      }));
    }
    if (has.users) {
      add(await sqlCheck(db, {
        severity: 'error', id: 'permissions.orphan_user', samples,
        title: '權限指向已不存在的人員',
        from: 'permissions p', where: 'p.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id)',
        select: 'p.id, p.folder_id, p.user_id, p.permission_type',
        hint: '確認後刪除'
      }));
    }
    if (has.groups) {
      add(await sqlCheck(db, {
        severity: 'error', id: 'permissions.orphan_group', samples,
        title: '權限指向已不存在的群組',
        from: 'permissions p', where: 'p.group_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = p.group_id)',
        select: 'p.id, p.folder_id, p.group_id, p.permission_type',
        hint: '確認後刪除'
      }));
    }
    add(await sqlCheck(db, {
      severity: 'error', id: 'permissions.bad_type', samples,
      title: '權限類型不是 read／write',
      from: 'permissions', where: "permission_type IS NULL OR permission_type NOT IN ('read', 'write')",
      select: 'id, folder_id, user_id, group_id, permission_type',
      hint: '有效值只有 read、write；請人工判斷要改成哪一種或刪除'
    }));
    add(await sqlCheck(db, {
      severity: 'error', id: 'permissions.bad_target', samples,
      title: '權限的對象不明確（人員與群組同時指定，或兩者都沒指定）',
      from: 'permissions', where: '(user_id IS NULL AND group_id IS NULL) OR (user_id IS NOT NULL AND group_id IS NOT NULL)',
      select: 'id, folder_id, user_id, group_id, permission_type',
      hint: '一筆權限只能對一個對象；請人工判斷拆成兩筆或刪除'
    }));
    const dup = await dbAll(db, `SELECT folder_id, user_id, group_id, COUNT(*) AS n, GROUP_CONCAT(id) AS ids,
                                        GROUP_CONCAT(DISTINCT permission_type) AS types
                                 FROM permissions GROUP BY folder_id, user_id, group_id HAVING COUNT(*) > 1`);
    if (dup.length) {
      add(finding('error', 'permissions.duplicate', '同一資料夾、同一對象有重複的權限紀錄', dup.length,
        dup.slice(0, samples),
        '保留一筆即可；若 types 欄位有 read,write 並存，要先決定保留哪一個（目前系統取第一筆，不一定是較高者）'));
    }
  }

  // ---- 資料夾結構
  if (has.folders) {
    const folders = await dbAll(db, 'SELECT id, name, parent_id, path FROM folders');
    const byId = new Map(folders.map(f => [f.id, f]));

    const missingParent = folders.filter(f => f.parent_id != null && !byId.has(f.parent_id));
    if (missingParent.length) {
      add(finding('error', 'folders.orphan_parent', '資料夾的父資料夾不存在', missingParent.length,
        missingParent.slice(0, samples).map(f => ({ id: f.id, name: f.name, parent_id: f.parent_id, path: f.path })),
        '這些資料夾在階層樹上看不到；請改掛到正確的父層或刪除'));
    }

    // 循環與路徑重算
    const computed = new Map();
    const cyclic = [];
    for (const f of folders) {
      const seen = new Set();
      let cur = f;
      const parts = [];
      let loop = false;
      while (cur) {
        if (seen.has(cur.id)) { loop = true; break; }
        seen.add(cur.id);
        parts.unshift(cur.name);
        cur = cur.parent_id != null ? byId.get(cur.parent_id) : null;
      }
      if (loop) cyclic.push(f); else computed.set(f.id, '/' + parts.join('/'));
    }
    if (cyclic.length) {
      add(finding('error', 'folders.cycle', '資料夾的父子關係形成循環', cyclic.length,
        cyclic.slice(0, samples).map(f => ({ id: f.id, name: f.name, parent_id: f.parent_id })),
        '循環中的資料夾無法顯示，移動／改名時可能卡死；請把其中一個的父層改為空（根層）'));
    }
    const badPath = folders.filter(f => computed.has(f.id) && f.path !== computed.get(f.id));
    if (badPath.length) {
      add(finding('warn', 'folders.path_mismatch', '資料夾儲存的路徑與實際階層不一致', badPath.length,
        badPath.slice(0, samples).map(f => ({ id: f.id, stored: f.path, expected: computed.get(f.id) })),
        '路徑是由階層推算的快取欄位；移動資料夾後若中途失敗會不一致。可由階層重新計算'));
    }

    // 同層重名
    const groupsBySibling = new Map();
    for (const f of folders) {
      const key = `${f.parent_id == null ? 'root' : f.parent_id}\u0000${f.name}`;
      if (!groupsBySibling.has(key)) groupsBySibling.set(key, []);
      groupsBySibling.get(key).push(f);
    }
    const dupSiblings = [...groupsBySibling.values()].filter(a => a.length > 1);
    if (dupSiblings.length) {
      add(finding('warn', 'folders.duplicate_sibling', '同一父層底下有同名資料夾', dupSiblings.length,
        dupSiblings.slice(0, samples).map(a => ({ name: a[0].name, parent_id: a[0].parent_id, ids: a.map(x => x.id).join(',') })),
        '多半是重複匯入造成；權限分散在不同的重複資料夾上時，合併前要先搬移權限'));
    }

    const badName = folders.filter(f => FORBIDDEN_FOLDER_CHARS.test(f.name) || /[ .]$/.test(f.name) || /^\s/.test(f.name));
    if (badName.length) {
      add(finding('warn', 'folders.bad_name', '資料夾名稱含有 Windows 檔案系統不允許的字元，或首尾有空白／結尾為句點', badName.length,
        badName.slice(0, samples).map(f => ({ id: f.id, name: f.name })),
        '產生 PowerShell／NAS 腳本與實際建立資料夾時會出錯'));
    }
  }

  // ---- 群組
  if (has.groups) {
    const dupGroups = await dbAll(db, `SELECT name, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
                                       FROM groups GROUP BY LOWER(name) HAVING COUNT(*) > 1`);
    if (dupGroups.length) {
      add(finding('warn', 'groups.duplicate_name', '有同名（不分大小寫）的群組', dupGroups.length, dupGroups.slice(0, samples),
        '同名群組的成員與權限是分開的，容易誤用；合併前先確認各自的成員與權限'));
    }
    if (has.group_users && has.permissions) {
      add(await sqlCheck(db, {
        severity: 'info', id: 'groups.unused', samples,
        title: '沒有任何成員、也沒有任何權限的群組',
        from: 'groups g',
        where: 'NOT EXISTS (SELECT 1 FROM group_users gu WHERE gu.group_id = g.id) AND NOT EXISTS (SELECT 1 FROM permissions p WHERE p.group_id = g.id)',
        select: 'g.id, g.name',
        hint: '可能是匯入殘留或未使用的群組'
      }));
    }
  }

  // ---- 人員
  if (has.users) {
    if (cols.users.includes('account_key')) {
      const dupKey = await dbAll(db, `SELECT LOWER(account_key) AS account_key, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
                                      FROM users WHERE account_key IS NOT NULL AND account_key != ''
                                      GROUP BY LOWER(account_key) HAVING COUNT(*) > 1`);
      if (dupKey.length) {
        add(finding('warn', 'users.duplicate_account_key', '帳號（account_key）只有大小寫不同的重複', dupKey.length, dupKey.slice(0, samples),
          '資料庫的唯一索引區分大小寫，但 AD 的帳號不分大小寫'));
      }
    }
    const dupEmail = await dbAll(db, `SELECT LOWER(email) AS email, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
                                      FROM users GROUP BY LOWER(email) HAVING COUNT(*) > 1`);
    if (dupEmail.length) {
      add(finding('warn', 'users.duplicate_email', 'Email 只有大小寫不同的重複', dupEmail.length, dupEmail.slice(0, samples),
        '很可能是同一個人建立了兩次'));
    }
    if (has.group_users && has.permissions) {
      add(await sqlCheck(db, {
        severity: 'info', id: 'users.unused', samples,
        title: '沒有加入任何群組、也沒有任何個人權限的人員',
        from: 'users u',
        where: 'NOT EXISTS (SELECT 1 FROM group_users gu WHERE gu.user_id = u.id) AND NOT EXISTS (SELECT 1 FROM permissions p WHERE p.user_id = u.id)',
        select: 'u.id, u.name, u.email',
        hint: '可能是離職或尚未設定權限的人員'
      }));
    }
  }

  // ---- 有效權限語意：個人直接權限 vs 群組權限
  if (has.permissions && has.group_users) {
    const conflicts = await dbAll(db, `
      SELECT d.folder_id, d.user_id, d.permission_type AS direct_permission,
             gp.permission_type AS group_permission, gp.group_id
      FROM permissions d
      JOIN group_users gu ON gu.user_id = d.user_id
      JOIN permissions gp ON gp.group_id = gu.group_id AND gp.folder_id = d.folder_id
      WHERE d.user_id IS NOT NULL AND d.group_id IS NULL AND d.permission_type != gp.permission_type`);
    if (conflicts.length) {
      const lower = conflicts.filter(c => c.direct_permission === 'read' && c.group_permission === 'write').length;
      add(finding('warn', 'permissions.direct_vs_group', '同一人在同一資料夾，個人權限與所屬群組的權限不一致', conflicts.length,
        conflicts.slice(0, samples),
        `目前系統以「個人權限優先」判斷；其中 ${lower} 筆是「個人 read、群組 write」，改成「取最高值」時這些人的有效權限會變高`));
    }
  }

  // ---- 申請單
  if (has.permission_requests) {
    if (has.folders) {
      add(await sqlCheck(db, {
        severity: 'warn', id: 'requests.orphan_folder', samples,
        title: '申請單指向已不存在的資料夾',
        from: 'permission_requests r', where: 'NOT EXISTS (SELECT 1 FROM folders f WHERE f.id = r.folder_id)',
        select: 'r.id, r.status, r.folder_id, r.requested_by_username',
        hint: '待審核的這類申請單核准時會寫出孤兒權限；請駁回'
      }));
    }
    if (has.users) {
      add(await sqlCheck(db, {
        severity: 'warn', id: 'requests.orphan_user', samples,
        title: '申請單的對象人員已不存在',
        from: 'permission_requests r', where: 'r.target_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.target_user_id)',
        select: 'r.id, r.status, r.target_user_id',
        hint: '待審核的請駁回'
      }));
    }
    if (has.groups) {
      add(await sqlCheck(db, {
        severity: 'warn', id: 'requests.orphan_group', samples,
        title: '申請單的對象群組已不存在',
        from: 'permission_requests r', where: 'r.target_group_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = r.target_group_id)',
        select: 'r.id, r.status, r.target_group_id',
        hint: '待審核的請駁回'
      }));
    }
    if (has.permissions) {
      add(await sqlCheck(db, {
        severity: 'warn', id: 'requests.applied_missing', samples,
        title: '已核准的申請單所套用的權限已不存在',
        from: 'permission_requests r',
        where: "r.status = 'approved' AND r.applied_permission_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM permissions p WHERE p.id = r.applied_permission_id)",
        select: 'r.id, r.applied_permission_id, r.reviewed_at',
        hint: '之後被手動刪除或改動；僅供稽核參考'
      }));
    }
    add(await sqlCheck(db, {
      severity: 'warn', id: 'requests.stale_pending', samples,
      title: `待審核超過 ${STALE_PENDING_DAYS} 天的申請單`,
      from: 'permission_requests',
      where: `status = 'pending' AND julianday('now') - julianday(substr(requested_at, 1, 19)) > ${STALE_PENDING_DAYS}`,
      select: 'id, requested_by_username, requested_at, folder_id',
      hint: '請審核或駁回'
    }));
    add(await sqlCheck(db, {
      severity: 'error', id: 'requests.bad_status', samples,
      title: '申請單狀態不是 pending／approved／rejected',
      from: 'permission_requests', where: "status NOT IN ('pending', 'approved', 'rejected')",
      select: 'id, status',
      hint: '請人工判斷'
    }));
  }

  // ---- 結構性資訊
  if (has.accounts) {
    const acc = await dbGet(db, 'SELECT COUNT(*) AS c FROM accounts');
    stats.accounts = acc ? acc.c : 0;
    if (!isSystem && stats.accounts > 0) {
      add(finding('info', 'schema.accounts_in_tenant', '此資料庫內的 accounts 表有資料', stats.accounts, [],
        '登入認證只讀 system.db；這裡的資料不會被使用'));
    }
  } else {
    stats.accounts = null;
  }
  const indexRows = await dbAll(db, "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'");
  const indexedCols = (table) => indexRows.filter(i => i.tbl_name === table).map(i => (i.sql || '').toLowerCase());
  const wanted = [
    ['permissions', 'folder_id'], ['permissions', 'user_id'], ['permissions', 'group_id'],
    ['group_users', 'user_id'], ['folders', 'parent_id'], ['permission_requests', 'status']
  ];
  // 沒資料的表不需要索引，不提示
  const missing = wanted.filter(([t, c]) => has[t] && stats[t] > 0 && !indexedCols(t).some(sql => new RegExp(`\\(\\s*"?${c}"?\\s*[,)]`).test(sql)));
  if (missing.length) {
    add(finding('info', 'schema.missing_indexes', '缺少常用查詢的索引（目前都是全表掃描）', missing.length,
      missing.map(([t, c]) => ({ table: t, column: c, rows: stats[t] })), '資料量大時匯出、權限判斷會變慢；建立索引不會改變資料'));
  }

  return { stats, findings };
}

// ---------------------------------------------------------------- 系統資料庫（帳號、資料庫登記）與目錄

async function auditSystem(systemDb, dbDir, { samples = SAMPLE_LIMIT_DEFAULT } = {}) {
  const findings = [];
  const files = fs.readdirSync(dbDir).filter(f => f.endsWith('.db') && !f.startsWith('deleted_'));
  const fileSet = new Set(files);

  if (await hasTable(systemDb, 'accounts')) {
    const accounts = await dbAll(systemDb, 'SELECT id, username, status, user_database, allowed_databases, role, role_level FROM accounts');

    const noDb = accounts.filter(a => a.user_database && !fileSet.has(a.user_database));
    if (noDb.length) {
      findings.push(finding('error', 'accounts.missing_user_database', '帳號的預設資料庫檔案不存在', noDb.length,
        noDb.slice(0, samples).map(a => ({ id: a.id, username: a.username, user_database: a.user_database })),
        '這些帳號登入時會失敗；請恢復檔案或改指派到存在的資料庫'));
    }

    const badAllowed = [];
    const unparsable = [];
    for (const a of accounts) {
      if (!a.allowed_databases) continue;
      let list;
      try { list = JSON.parse(a.allowed_databases); } catch (e) { unparsable.push({ id: a.id, username: a.username }); continue; }
      if (!Array.isArray(list)) { unparsable.push({ id: a.id, username: a.username }); continue; }
      const gone = list.filter(n => !fileSet.has(n));
      if (gone.length) badAllowed.push({ id: a.id, username: a.username, 不存在的資料庫: gone.join(',') });
    }
    if (badAllowed.length) {
      findings.push(finding('warn', 'accounts.allowed_database_missing', '帳號的可存取資料庫清單含有不存在的資料庫', badAllowed.length,
        badAllowed.slice(0, samples), '登入時會被自動過濾，但清單本身需要整理'));
    }
    if (unparsable.length) {
      findings.push(finding('error', 'accounts.allowed_databases_invalid', '帳號的可存取資料庫欄位不是合法的 JSON 陣列', unparsable.length,
        unparsable.slice(0, samples), '該帳號會被視為沒有任何可存取資料庫'));
    }

    // 帳號名稱互為 "_" 前綴（個人資料庫歸屬會有歧義）
    const names = accounts.map(a => a.username);
    const clashes = [];
    for (const a of names) for (const b of names) {
      if (a !== b && b.toLowerCase().startsWith(a.toLowerCase() + '_')) clashes.push({ 帳號: a, 與: b });
    }
    if (clashes.length) {
      findings.push(finding('error', 'accounts.prefix_clash', '帳號名稱互為底線前綴（個人資料庫 user_<帳號>_*.db 的歸屬會混淆）', clashes.length,
        clashes.slice(0, samples), '請將其中一個帳號改名，否則其中一方可能存取到另一方的個人資料庫'));
    }
    const pending = accounts.filter(a => a.status === 'pending' || a.status === 'rejected');
    if (pending.length) {
      findings.push(finding('info', 'accounts.legacy_status', '狀態為 pending／rejected 的舊式申請帳號', pending.length,
        pending.slice(0, samples).map(a => ({ id: a.id, username: a.username, status: a.status })),
        '自助註冊已停用，這些帳號無法登入；確認後可刪除'));
    }
  }

  if (await hasTable(systemDb, 'databases')) {
    const reg = await dbAll(systemDb, 'SELECT name, created_by FROM databases');
    const regNames = new Set(reg.map(r => r.name));
    const regMissingFile = reg.filter(r => !fileSet.has(r.name));
    if (regMissingFile.length) {
      findings.push(finding('warn', 'databases.registry_missing_file', '資料庫登記表有登記，但檔案不存在', regMissingFile.length,
        regMissingFile.slice(0, samples), '可從登記表移除'));
    }
    const SYSTEM = new Set(['system.db', 'admin.db']);
    const unregistered = files.filter(f => !SYSTEM.has(f) && !regNames.has(f));
    if (unregistered.length) {
      findings.push(finding('info', 'databases.unregistered_file', '資料庫檔案存在，但沒有登記在登記表', unregistered.length,
        unregistered.slice(0, samples).map(name => ({ name })), '服務啟動時會自動補登記'));
    }
  }

  return { findings, files };
}

// ---------------------------------------------------------------- 全部資料庫

async function auditAll(dbDir, options = {}) {
  const result = { dir: dbDir, startedAt: new Date().toISOString(), databases: [], system: null, errors: [], snapshots: [] };
  const snapshotRoot = options.snapshotRoot || os.tmpdir();
  const samples = options.samples || SAMPLE_LIMIT_DEFAULT;

  const files = fs.readdirSync(dbDir).filter(f => f.endsWith('.db') && !f.startsWith('deleted_')).sort();
  const only = options.only && options.only.length ? new Set(options.only) : null;

  const systemFile = path.join(dbDir, 'system.db');
  if (fs.existsSync(systemFile)) {
    let sys;
    try {
      sys = await openForAudit(systemFile, snapshotRoot);
      result.system = await auditSystem(sys.db, dbDir, { samples });
      if (sys.snapshot) result.snapshots.push('system.db');
    } catch (e) {
      result.errors.push({ database: 'system.db', error: e.message });
    } finally {
      if (sys) await sys.cleanup();
    }
  }

  for (const file of files) {
    if (only && !only.has(file)) continue;
    let h;
    try {
      h = await openForAudit(path.join(dbDir, file), snapshotRoot);
      const audit = await auditTenantDb(h.db, { samples, isSystem: file === 'system.db' });
      result.databases.push({ name: file, snapshot: h.snapshot, ...audit });
      if (h.snapshot && file !== 'system.db') result.snapshots.push(file);
    } catch (e) {
      result.errors.push({ database: file, error: e.message });
    } finally {
      if (h) await h.cleanup();
    }
  }

  const emptyAcc = result.databases.filter(d => d.name !== 'system.db' && d.stats.accounts === 0).map(d => d.name);
  if (emptyAcc.length) {
    const f = finding('info', 'schema.empty_accounts', `${emptyAcc.length} 個資料庫內有一張永遠是空的 accounts 表（帳號實際存放在 system.db）`, emptyAcc.length,
      emptyAcc.slice(0, samples).map(name => ({ database: name })), '歷史遺留，不影響運作，之後整理結構時可移除');
    if (result.system) result.system.findings.push(f);
    else result.system = { findings: [f], files: [] };
  }

  const all = [
    ...(result.system ? result.system.findings : []),
    ...result.databases.flatMap(d => d.findings)
  ];
  result.summary = {
    error: all.filter(f => f.severity === 'error').length,
    warn: all.filter(f => f.severity === 'warn').length,
    info: all.filter(f => f.severity === 'info').length,
    databases: result.databases.length
  };
  result.finishedAt = new Date().toISOString();
  return result;
}

module.exports = { auditAll, auditTenantDb, auditSystem, openForAudit, hasTable };
