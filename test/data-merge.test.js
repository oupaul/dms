'use strict';
/**
 * data-clean 的選用合併功能（--fix merge）：
 *  - 預覽不修改任何檔案，且會列出「新增成員」與搬移／刪除的權限數量
 *  - 套用：成員取聯集、權限併入編號最小的一份、重複的刪除、申請單改指向保留者、子資料夾遞迴合併
 *  - 類型衝突：群組名稱有 _RW／_RO 後綴才自動決定；否則整組原封不動並列入人工處理
 *  - 預設的 safe 不包含合併；冪等
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepare, hashDir, runNode, query } = require('./helpers/audit-fixture');

const BUILD = `
const sqlite3 = require('sqlite3');
const { initializeTables } = require('./services/schema');
const file = process.argv[2];
const db = new sqlite3.Database(file);
const run = (sql) => new Promise((res, rej) => db.exec(sql, (e) => (e ? rej(e) : res())));
const all = (sql) => new Promise((res, rej) => db.all(sql, (e, r) => (e ? rej(e) : res(r))));
(async () => {
  await new Promise((res, rej) => initializeTables(db, (e) => (e ? rej(e) : res())));
  for (let i = 0; i < 100; i++) { if ((await all('PRAGMA table_info(users)')).some(c => c.name === 'account_key')) break; await new Promise(r => setTimeout(r, 50)); }
  await run(\`
    INSERT INTO users (id, name, email) VALUES (1,'U1','u1@x.com'),(2,'U2','u2@x.com'),(3,'U3','u3@x.com');
    INSERT INTO folders (id, name, parent_id, path) VALUES
      (1,'Root',NULL,'/Root'),
      (2,'Dup',1,'/Root/Dup'),(3,'Dup',1,'/Root/Dup'),
      (4,'Kid',2,'/Root/Dup/Kid'),(5,'Kid',3,'/Root/Dup/Kid'),(6,'Other',3,'/Root/Dup/Other'),
      (7,'Clash',1,'/Root/Clash'),(8,'Clash',1,'/Root/Clash');
    INSERT INTO groups (id, name) VALUES
      (10,'Staff'),(11,'staff'),(12,'Ops_RW'),(13,'ops_rw'),(14,'Plain'),(15,'plain'),
      (16,'GrpA'),(17,'GrpB'),(18,'GrpC');
    INSERT INTO group_users (group_id, user_id) VALUES (10,1),(10,2),(11,2),(11,3);
    INSERT INTO permissions (id, folder_id, user_id, group_id, permission_type) VALUES
      (21,2,NULL,16,'read'),(22,2,NULL,17,'write'),
      (23,3,NULL,16,'read'),(24,3,NULL,18,'read'),
      (25,4,NULL,16,'read'),(26,5,NULL,16,'read'),
      (27,7,1,NULL,'read'),(28,8,1,NULL,'write'),
      (31,1,NULL,10,'read'),(32,2,NULL,11,'read'),(33,1,NULL,11,'read'),
      (34,1,NULL,12,'write'),(35,1,NULL,13,'read'),
      (36,1,NULL,14,'read'),(37,1,NULL,15,'write');
    INSERT INTO permission_requests (id, folder_id, target_type, target_group_id, requested_permission_type, reason, status, requested_by_account_id, requested_by_username, requested_at, applied_permission_id) VALUES
      (1,3,'group',11,'read','r','pending',1,'x','2026-01-01',NULL),
      (2,1,'group',11,'read','r','approved',1,'x','2026-01-01',33);
  \`);
  db.close();
})().catch(e => { console.error(e); process.exit(1); });
`;

function clean(app, dbDir, extra = [], opts = {}) {
  return runNode(app, [path.join(app, 'scripts', 'data-clean.js'), '--json', '--dir', dbDir, ...extra], opts);
}
const json = (p) => JSON.parse(p.stdout);
const fixOf = (r, id) => (r.databases[0] || { fixes: [] }).fixes.find(f => f.id === id);

test('合併同名群組與資料夾（--fix merge）', async (t) => {
  const { app } = prepare();
  t.after(() => fs.rmSync(app, { recursive: true, force: true }));
  const dbDir = path.join(app, 'mergedb');
  fs.mkdirSync(dbDir);
  const file = path.join(dbDir, 'merge.db');
  fs.writeFileSync(path.join(app, 'build-merge.js'), BUILD);
  const built = runNode(app, [path.join(app, 'build-merge.js'), file]);
  assert.equal(built.status, 0, built.stderr);
  const bk = path.join(app, 'bk');
  const q = (sql) => query(app, file, sql);
  const args = ['--only', 'merge.db', '--fix', 'merge'];

  await t.test('safe（預設）不包含合併：不會有 merge 項目', () => {
    const r = json(clean(app, dbDir, ['--only', 'merge.db']));
    assert.ok(!fixOf(r, 'merge-groups') && !fixOf(r, 'merge-folders'));
  });

  await t.test('預覽：不修改檔案，列出新增成員與搬移／刪除數量，衝突列入人工', () => {
    const before = hashDir(dbDir);
    const proc = clean(app, dbDir, args);
    assert.equal(proc.status, 0, proc.stderr);
    assert.deepEqual(hashDir(dbDir), before);
    const r = json(proc);
    const g = fixOf(r, 'merge-groups');
    assert.equal(g.count, 2, 'Staff／staff 與 Ops_RW／ops_rw 各併一組（Plain 衝突不動）');
    const staff = g.details.find(d => d.群組 === 'Staff');
    assert.equal(staff.保留, '#10');
    assert.equal(staff.合併後成員, 3);
    assert.match(staff.新增成員, /1 人（U3）/);
    assert.equal(staff.權限搬入, 1);          // #32（資料夾 2）
    assert.equal(staff.重複權限刪除, 1);      // #33 與 #31 相同
    assert.equal(g.manual.length, 1);
    assert.equal(g.manual[0].群組, 'Plain');

    const f = fixOf(r, 'merge-folders');
    assert.equal(f.count, 2, '#3 併入 #2、#5 併入 #4');
    assert.equal(f.manual.length, 1);
    assert.match(f.manual[0].資料夾, /Clash/);
  });

  await t.test('套用：先備份，再合併；規則正確', () => {
    const proc = clean(app, dbDir, [...args, '--apply', '--yes', '--backup-dir', bk]);
    assert.equal(proc.status, 0, proc.stderr);
    const d = json(proc).databases[0];
    assert.ok(d.applied && d.backup && fs.existsSync(d.backup));

    // 群組：Staff 保留 #10，成員聯集；staff(#11) 消失
    assert.deepEqual(q('SELECT id FROM groups WHERE id IN (10,11,12,13,14,15) ORDER BY id').map(r => r.id), [10, 12, 14, 15]);
    assert.deepEqual(q('SELECT user_id AS u FROM group_users WHERE group_id = 10 ORDER BY user_id').map(r => r.u), [1, 2, 3]);
    assert.equal(q('SELECT COUNT(*) AS c FROM group_users WHERE group_id = 11')[0].c, 0);
    // 權限：#32 搬到 #10；#33 因與 #31 相同被刪；_RW 衝突留 write
    assert.equal(q('SELECT group_id AS g FROM permissions WHERE id = 32')[0].g, 10);
    assert.equal(q('SELECT COUNT(*) AS c FROM permissions WHERE id = 33')[0].c, 0);
    assert.equal(q('SELECT COUNT(*) AS c FROM permissions WHERE id = 35')[0].c, 0, 'ops_rw 的 read 被刪');
    assert.equal(q('SELECT permission_type AS t FROM permissions WHERE id = 34')[0].t, 'write');
    // 申請單改指向保留者；已核准申請單的 applied_permission_id 指向還在的那筆
    assert.equal(q('SELECT target_group_id AS g FROM permission_requests WHERE id = 1')[0].g, 10);
    assert.equal(q('SELECT applied_permission_id AS a FROM permission_requests WHERE id = 2')[0].a, 31);
    // Plain（無後綴、類型衝突）原封不動
    assert.equal(q('SELECT COUNT(*) AS c FROM permissions WHERE id IN (36,37)')[0].c, 2);

    // 資料夾：#3 併入 #2，子資料夾 #6 搬到 #2，#5 併入 #4；權限搬移與去重
    assert.deepEqual(q('SELECT id FROM folders WHERE name IN (\'Dup\',\'Kid\') ORDER BY id').map(r => r.id), [2, 4]);
    assert.equal(q('SELECT parent_id AS p FROM folders WHERE id = 6')[0].p, 2);
    assert.equal(q('SELECT folder_id AS f FROM permissions WHERE id = 24')[0].f, 2);
    assert.equal(q('SELECT COUNT(*) AS c FROM permissions WHERE id IN (23, 26)')[0].c, 0, '重複的權限刪除');
    assert.equal(q('SELECT folder_id AS f FROM permission_requests WHERE id = 1')[0].f, 2);
    // Clash（人員權限衝突）不動
    assert.equal(q("SELECT COUNT(*) AS c FROM folders WHERE name = 'Clash'")[0].c, 2);
    assert.equal(q('SELECT COUNT(*) AS c FROM permissions WHERE id IN (27,28)')[0].c, 2);
    // 沒有孤兒
    assert.equal(q('SELECT COUNT(*) AS c FROM permissions p WHERE NOT EXISTS (SELECT 1 FROM folders f WHERE f.id = p.folder_id) OR (p.group_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = p.group_id))')[0].c, 0);
    assert.equal(q('PRAGMA integrity_check')[0].integrity_check, 'ok');
  });

  await t.test('冪等：再跑一次沒有可合併的項目（只剩人工處理）', () => {
    const before = hashDir(dbDir);
    const proc = clean(app, dbDir, [...args, '--apply', '--yes', '--backup-dir', bk]);
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(json(proc).summary.changed, 0);
    assert.deepEqual(hashDir(dbDir), before);
  });
});
