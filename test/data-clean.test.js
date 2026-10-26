'use strict';
/**
 * data-clean（資料清理）測試：
 *  - 預覽模式不修改任何檔案；沒有 --yes 就拒絕套用
 *  - 套用前先備份（權限 600、內容是修正前的狀態），單一交易修正
 *  - 各項修正的規則正確，需人工判斷的項目原封不動並列出
 *  - 冪等：再跑一次沒有任何變更、也不再產生備份
 *  - 備份失敗時資料庫不會被修改
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepare, hashDir, runNode, query } = require('./helpers/audit-fixture');

function clean(app, dbDir, extra = [], opts = {}) {
  return runNode(app, [path.join(app, 'scripts', 'data-clean.js'), '--json', '--dir', dbDir, ...extra], opts);
}
const json = (proc) => JSON.parse(proc.stdout);
const fixOf = (report, dbName, id) => (report.databases.find(d => d.name === dbName) || { fixes: [] }).fixes.find(f => f.id === id);

test('資料清理', async (t) => {
  const { app, dbDir } = prepare();
  t.after(() => fs.rmSync(app, { recursive: true, force: true }));
  const backupDir = path.join(app, 'bk');
  const dirty = path.join(dbDir, 'dirty.db');
  const q = (sql) => query(app, dirty, sql);

  await t.test('預覽：不修改任何檔案，且列出將處理與需人工處理的項目', () => {
    const before = hashDir(dbDir);
    const proc = clean(app, dbDir, ['--only', 'dirty.db']);
    assert.equal(proc.status, 0, proc.stderr);
    assert.deepEqual(hashDir(dbDir), before, '預覽不可修改任何資料庫');
    assert.ok(!fs.existsSync(backupDir), '預覽不應建立備份目錄');
    const r = json(proc);
    assert.equal(r.apply, false);

    assert.equal(fixOf(r, 'dirty.db', 'orphans.group_users').count, 2);
    assert.equal(fixOf(r, 'dirty.db', 'orphans.permissions').count, 1);
    const dup = fixOf(r, 'dirty.db', 'duplicate-permissions');
    assert.equal(dup.count, 3, '#10（相同類型）、#2（_RW 留 write）、#3 對應的 #4（_RO 留 read）→ 共刪 3 筆');
    assert.equal(dup.manual.length, 1, 'Mix_Plain 沒有後綴 → 人工處理');
    assert.match(dup.manual[0].項目, /Mix_Plain/);
    assert.equal(fixOf(r, 'dirty.db', 'permission-types').count, 2);
    assert.equal(fixOf(r, 'dirty.db', 'unused-duplicate-groups').count, 1);
    assert.equal(fixOf(r, 'dirty.db', 'unused-duplicate-groups').manual.length, 1, 'DupUsed 兩組都有成員 → 人工');
    assert.equal(fixOf(r, 'dirty.db', 'unused-duplicate-folders').count, 1);
    assert.equal(fixOf(r, 'dirty.db', 'unused-duplicate-folders').manual.length, 1, 'Both 兩個都有權限 → 人工');
    assert.equal(fixOf(r, 'dirty.db', 'paths').count, 1);
  });

  await t.test('沒有 --yes 就拒絕套用，資料庫不變', () => {
    const before = hashDir(dbDir);
    const proc = clean(app, dbDir, ['--only', 'dirty.db', '--apply']);
    assert.equal(proc.status, 2);
    assert.match(proc.stderr, /--apply --yes/);
    assert.deepEqual(hashDir(dbDir), before);
  });

  await t.test('--only 名稱：沒寫 .db 也能比對；對不上任何檔案就報錯，不能默默當成沒事', () => {
    const before = hashDir(dbDir);
    const ok = clean(app, dbDir, ['--only', 'dirty']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(fixOf(json(ok), 'dirty.db', 'orphans.group_users'), '省略 .db 仍應比對到 dirty.db');

    const bad = clean(app, dbDir, ['--only', 'dirty.db,不存在的庫', '--apply', '--yes', '--backup-dir', backupDir]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /找不到這些資料庫/);
    assert.match(bad.stderr, /不存在的庫\.db/);
    assert.deepEqual(hashDir(dbDir), before, '名稱有誤時，連名稱正確的庫也不可被修改');
    assert.ok(!fs.existsSync(backupDir));
  });

  await t.test('備份目錄無法建立 → 該資料庫不被修改', () => {
    const blocker = path.join(app, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const before = hashDir(dbDir);
    const proc = clean(app, dbDir, ['--only', 'dirty.db', '--apply', '--yes', '--backup-dir', path.join(blocker, 'sub')]);
    assert.equal(proc.status, 3);
    assert.equal(json(proc).errors.length, 1);
    assert.deepEqual(hashDir(dbDir), before, '備份失敗時不可修改資料庫');
  });

  await t.test('套用：先備份（600、內容是修正前），再修正；規則正確', () => {
    const proc = clean(app, dbDir, ['--only', 'dirty.db', '--apply', '--yes', '--backup-dir', backupDir]);
    assert.equal(proc.status, 0, proc.stderr);
    const r = json(proc);
    const d = r.databases.find(x => x.name === 'dirty.db');
    assert.ok(d.applied);

    // 備份
    assert.ok(d.backup && fs.existsSync(d.backup));
    assert.equal(fs.statSync(d.backup).mode & 0o077, 0, '備份檔不可被其他使用者讀取');
    assert.equal(fs.statSync(backupDir).mode & 0o077, 0, '備份目錄權限 700');
    const inBackup = query(app, d.backup, 'SELECT COUNT(*) AS c FROM group_users');
    assert.equal(inBackup[0].c, 4, '備份是修正前的狀態（含 2 筆孤兒）');

    // 孤兒
    assert.equal(q('SELECT COUNT(*) AS c FROM group_users gu WHERE NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = gu.group_id) OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = gu.user_id)')[0].c, 0);
    assert.equal(q('SELECT COUNT(*) AS c FROM permissions WHERE folder_id = 77')[0].c, 0);

    // 重複權限：#2 刪（Mix_RW 留 write=#1）、#4 刪（Mix_RO 留 read=#3）、#10 刪；Mix_Plain（#5、#6）不動
    const remaining = q('SELECT id FROM permissions ORDER BY id').map(r => r.id);
    for (const gone of [2, 4, 10, 13]) assert.ok(!remaining.includes(gone), `#${gone} 應已刪除`);
    for (const kept of [1, 3, 5, 6, 9]) assert.ok(remaining.includes(kept), `#${kept} 應保留`);
    assert.deepEqual(q('SELECT permission_type AS t FROM permissions WHERE id IN (1,3) ORDER BY id').map(r => r.t), ['write', 'read']);

    // 類型
    assert.deepEqual(q('SELECT permission_type AS t FROM permissions WHERE id IN (7,8) ORDER BY id').map(r => r.t), ['read', 'write']);
    assert.equal(q("SELECT COUNT(*) AS c FROM permissions WHERE permission_type NOT IN ('read','write')")[0].c, 0);

    // 未使用的重複群組／資料夾：保留最早的；使用中的不動
    assert.deepEqual(q("SELECT id FROM groups WHERE LOWER(name) = 'dup'").map(r => r.id), [7]);
    assert.equal(q("SELECT COUNT(*) AS c FROM groups WHERE LOWER(name) = 'dupused'")[0].c, 2);
    assert.deepEqual(q("SELECT id FROM folders WHERE name = 'Lonely'").map(r => r.id), [9]);
    assert.equal(q("SELECT COUNT(*) AS c FROM folders WHERE name = 'Both'")[0].c, 2);

    // 路徑
    assert.equal(q('SELECT path FROM folders WHERE id = 7')[0].path, '/Root/Sub');

    // 套用後複查：只剩需要人工處理的
    assert.equal(d.after['groups.duplicate_name'], 1);                   // DupUsed
    assert.equal(d.after['folders.duplicate_sibling'], 1);               // Both
    assert.equal(d.after['permissions.duplicate'], 1);                   // Mix_Plain
    assert.ok(!('group_users.orphan_group' in d.after));
    assert.ok(!('permissions.bad_type' in d.after));
    assert.ok(!('folders.path_mismatch' in d.after));
  });

  await t.test('冪等：再套用一次，沒有變更、不再備份', () => {
    const before = hashDir(dbDir);
    const filesBefore = fs.readdirSync(backupDir).length;
    const proc = clean(app, dbDir, ['--only', 'dirty.db', '--apply', '--yes', '--backup-dir', backupDir]);
    assert.equal(proc.status, 0, proc.stderr);
    const r = json(proc);
    assert.equal(r.summary.changed, 0);
    assert.deepEqual(hashDir(dbDir), before, '沒有變更就不寫入');
    assert.equal(fs.readdirSync(backupDir).length, filesBefore, '沒有變更就不備份');
  });

  await t.test('沒有寫入權限：給出明確訊息、不建立備份、資料庫不變', (st) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) { st.skip('root 不受檔案權限限制'); return; }
    const { app: app3, dbDir: dbDir3 } = prepare();
    t.after(() => { for (const f of fs.readdirSync(dbDir3)) fs.chmodSync(path.join(dbDir3, f), 0o644); fs.rmSync(app3, { recursive: true, force: true }); });
    for (const f of fs.readdirSync(dbDir3)) fs.chmodSync(path.join(dbDir3, f), 0o444);   // 模擬「複本屬於別人／唯讀」
    const before = hashDir(dbDir3);
    const bk = path.join(app3, 'bk');
    const proc = clean(app3, dbDir3, ['--only', 'dirty.db', '--apply', '--yes', '--backup-dir', bk]);
    assert.equal(proc.status, 3);
    const r = json(proc);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].error, /沒有寫入權限/);
    assert.match(r.errors[0].error, /chown/);
    assert.ok(!fs.existsSync(bk), '權限不足時不應建立備份目錄');
    assert.deepEqual(hashDir(dbDir3), before);
  });

  await t.test('--fix 可限定項目：只處理 paths 時，其餘不動', () => {
    const { app: app2, dbDir: dbDir2 } = prepare();
    t.after(() => fs.rmSync(app2, { recursive: true, force: true }));
    const proc = clean(app2, dbDir2, ['--only', 'dirty.db', '--fix', 'paths', '--apply', '--yes', '--backup-dir', path.join(app2, 'bk')]);
    assert.equal(proc.status, 0, proc.stderr);
    const rows = query(app2, path.join(dbDir2, 'dirty.db'), 'SELECT COUNT(*) AS c FROM permissions');
    assert.equal(rows[0].c, 13, '權限一筆都沒動');
    assert.equal(query(app2, path.join(dbDir2, 'dirty.db'), 'SELECT path FROM folders WHERE id = 7')[0].path, '/Root/Sub');
    const bad = clean(app2, dbDir2, ['--fix', 'nonsense']);
    assert.notEqual(bad.status, 0);
  });

  await t.test('system.db：移除帳號可存取清單中已不存在的資料庫（無法解析的不動）', () => {
    const sys = path.join(dbDir, 'system.db');
    const list = (u) => query(app, sys, `SELECT allowed_databases AS a FROM accounts WHERE username = '${u}'`)[0].a;
    assert.equal(list('bob'), '["clean.db","gone.db"]');
    const proc = clean(app, dbDir, ['--only', 'system.db', '--apply', '--yes', '--backup-dir', backupDir]);
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(list('bob'), '["clean.db"]');
    assert.equal(list('carol'), '{not json', '不是合法 JSON 的不動');
    assert.equal(list('eve'), '["*"]', '工程師「全部資料庫」標記（*）不是資料庫名稱，不可被清掉');
  });

  await t.test('乾淨的資料庫（clean.db）沒有任何需要處理的項目', () => {
    const r = json(clean(app, dbDir, ['--only', 'clean.db']));
    assert.deepEqual(r.databases, []);
  });
});
