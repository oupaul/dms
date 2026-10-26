'use strict';
/**
 * data-audit（資料健檢）測試：
 *  - 在暫存目錄建立刻意混入壞資料的資料庫，確認每一類問題都被抓到、數量正確
 *  - 乾淨的資料庫不會有 error／warn
 *  - 全程唯讀：資料庫檔案的雜湊在檢查前後完全相同
 * 原生模組 sqlite3 與 Node 版本相關，這裡和整合測試一樣把程式複製到暫存目錄並使用 DMS_TEST_NODE_MODULES。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { ROOT, prepare, hashDir } = require('./helpers/audit-fixture');

function runAudit(app, dbDir, extra = []) {
  return spawnSync(process.execPath, [path.join(app, 'scripts', 'data-audit.js'), '--json', '--dir', dbDir, ...extra], { cwd: app, encoding: 'utf8' });
}

test('資料健檢：抓得到各類壞資料，乾淨資料庫沒有問題，且全程唯讀', async (t) => {
  const { app, dbDir } = prepare();
  t.after(() => fs.rmSync(app, { recursive: true, force: true }));

  const before = hashDir(dbDir);
  const proc = runAudit(app, dbDir);
  assert.equal(proc.status, 0, proc.stderr);
  const report = JSON.parse(proc.stdout);
  assert.deepEqual(hashDir(dbDir), before, '健檢不可修改任何資料庫檔案');
  assert.deepEqual(report.errors, []);

  const find = (findings, id) => findings.find(f => f.id === id);
  const bad = report.databases.find(d => d.name === 'bad.db');
  const clean = report.databases.find(d => d.name === 'clean.db');

  await t.test('乾淨的資料庫：沒有 error／warn', () => {
    const serious = clean.findings.filter(f => f.severity !== 'info');
    assert.deepEqual(serious, [], JSON.stringify(serious));
  });

  await t.test('群組成員孤兒', () => {
    assert.equal(find(bad.findings, 'group_users.orphan_group').count, 1);
    assert.equal(find(bad.findings, 'group_users.orphan_user').count, 1);
  });

  await t.test('權限：孤兒、非法值、對象不明確、重複', () => {
    assert.equal(find(bad.findings, 'permissions.orphan_folder').count, 1);
    assert.equal(find(bad.findings, 'permissions.orphan_user').count, 1);
    assert.equal(find(bad.findings, 'permissions.orphan_group').count, 1);
    assert.equal(find(bad.findings, 'permissions.bad_type').count, 1);
    assert.equal(find(bad.findings, 'permissions.bad_target').count, 2);   // 同時指定 1 筆 + 都沒指定 1 筆
    assert.equal(find(bad.findings, 'permissions.duplicate').count, 1);
  });

  await t.test('個人權限與群組權限不一致（影響「取最高值」改版的人數）', () => {
    const f = find(bad.findings, 'permissions.direct_vs_group');
    assert.ok(f, '應該找得到');
    assert.ok(f.count >= 1);
    assert.match(f.hint, /個人 read、群組 write/);
  });

  await t.test('資料夾：父層不存在、循環、同層重名、路徑不符、非法名稱', () => {
    assert.equal(find(bad.findings, 'folders.orphan_parent').count, 1);
    assert.equal(find(bad.findings, 'folders.cycle').count, 2);            // 5 與 6 互為父子
    assert.equal(find(bad.findings, 'folders.duplicate_sibling').count, 1);
    assert.equal(find(bad.findings, 'folders.path_mismatch').count, 1);    // 資料夾 8
    assert.equal(find(bad.findings, 'folders.bad_name').count, 1);
  });

  await t.test('群組、人員', () => {
    assert.equal(find(bad.findings, 'groups.duplicate_name').count, 1);
    assert.equal(find(bad.findings, 'groups.unused').count, 2);            // g 與 Empty（G 有成員與權限）
    assert.equal(find(bad.findings, 'users.duplicate_email').count, 1);
    assert.equal(find(bad.findings, 'users.duplicate_account_key').count, 1);
  });

  await t.test('申請單', () => {
    assert.equal(find(bad.findings, 'requests.orphan_folder').count, 1);
    assert.equal(find(bad.findings, 'requests.stale_pending').count, 1);
    assert.equal(find(bad.findings, 'requests.bad_status').count, 1);
    assert.equal(find(bad.findings, 'requests.applied_missing').count, 1);
  });

  await t.test('結構性提示：缺索引（只針對有資料的表）、空 accounts 表彙整成一則', () => {
    assert.equal(find(bad.findings, 'schema.missing_indexes').count, 6);
    assert.ok(!find(bad.findings, 'schema.empty_accounts'), '空 accounts 表不再逐庫輸出');
    const agg = find(report.system.findings, 'schema.empty_accounts');
    assert.equal(agg.count, 3);                                           // clean.db、bad.db、dirty.db
    assert.ok(!find(report.system.findings, 'schema.accounts_in_tenant'));
    // clean.db 已有 permissions(folder_id) 索引、且 permission_requests 沒資料 → 只剩 4 項
    const cleanIdx = find(clean.findings, 'schema.missing_indexes');
    assert.equal(cleanIdx.count, 4);
    assert.ok(!cleanIdx.samples.some(s => s.table === 'permissions' && s.column === 'folder_id'));
  });

  await t.test('系統層級：帳號與資料庫登記', () => {
    const sys = report.system.findings;
    assert.equal(find(sys, 'accounts.missing_user_database').count, 1);
    assert.equal(find(sys, 'accounts.allowed_database_missing').count, 1);
    assert.equal(find(sys, 'accounts.allowed_databases_invalid').count, 1);
    assert.equal(find(sys, 'accounts.prefix_clash').count, 1);
    assert.equal(find(sys, 'accounts.legacy_status').count, 1);
    assert.equal(find(sys, 'databases.registry_missing_file').count, 1);
    assert.equal(find(sys, 'databases.unregistered_file').count, 2);       // bad.db 與 dirty.db 沒登記
  });

  await t.test('--strict：有 error 時結束碼為 1；--only 只檢查指定資料庫', () => {
    assert.equal(runAudit(app, dbDir, ['--strict']).status, 1);
    const only = JSON.parse(runAudit(app, dbDir, ['--only', 'clean.db']).stdout);
    assert.deepEqual(only.databases.map(d => d.name), ['clean.db']);
    assert.deepEqual(hashDir(dbDir), before);
  });

  await t.test('文字輸出可讀（沒有 --json）', () => {
    const out = spawnSync(process.execPath, [path.join(app, 'scripts', 'data-audit.js'), '--dir', dbDir], { cwd: app, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /■ bad\.db/);
    assert.match(out.stdout, /權限指向已不存在的資料夾：1 筆/);
    assert.match(out.stdout, /共檢查 \d+ 個資料庫：\d+ 項問題/);
  });
});

test('資料健檢：WAL 資料庫在「對目前使用者唯讀」的目錄也能檢查（改用暫存快照），且不碰原檔、不留暫存檔', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root 不受目錄唯讀限制，無法模擬');
    return;
  }
  const { app, dbDir } = prepare();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dms-audit-tmproot-'));
  t.after(() => {
    fs.chmodSync(dbDir, 0o755);
    for (const f of fs.readdirSync(dbDir)) fs.chmodSync(path.join(dbDir, f), 0o644);
    fs.rmSync(app, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // 把 bad.db 轉成 WAL 模式（關閉最後一個連線後 -wal／-shm 會消失，只剩檔頭標記為 WAL）
  const conv = spawnSync(process.execPath, ['-e', `
    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(${JSON.stringify(path.join(dbDir, 'bad.db'))});
    db.run('PRAGMA journal_mode = WAL', (e) => { if (e) { console.error(e); process.exit(1); } db.close(() => process.exit(0)); });
  `], { cwd: app, encoding: 'utf8' });
  assert.equal(conv.status, 0, conv.stderr);
  assert.ok(!fs.existsSync(path.join(dbDir, 'bad.db-wal')), '關閉後不應留下 -wal');

  // 目錄與檔案都改成唯讀：模擬「不是服務帳號、沒有寫入權限」
  for (const f of fs.readdirSync(dbDir)) fs.chmodSync(path.join(dbDir, f), 0o444);
  fs.chmodSync(dbDir, 0o555);
  const before = hashDir(dbDir);

  const proc = spawnSync(process.execPath, [path.join(app, 'scripts', 'data-audit.js'), '--json', '--dir', dbDir, '--only', 'bad.db'], {
    cwd: app, encoding: 'utf8', env: { ...process.env, TMPDIR: tmpRoot }
  });
  assert.equal(proc.status, 0, proc.stderr);
  const report = JSON.parse(proc.stdout);

  assert.deepEqual(report.errors, [], '不應該有無法檢查的資料庫');
  assert.deepEqual(report.snapshots, ['bad.db'], '應該走快照路徑');
  const bad = report.databases.find(d => d.name === 'bad.db');
  assert.equal(bad.snapshot, true);
  assert.equal(bad.findings.find(f => f.id === 'permissions.orphan_folder').count, 1, '快照內容要和原檔一致');
  assert.deepEqual(hashDir(dbDir), before, '原檔不可被修改');
  assert.deepEqual(fs.readdirSync(tmpRoot), [], '暫存快照要被刪除');
  assert.ok(!fs.existsSync(path.join(dbDir, 'bad.db-wal')) && !fs.existsSync(path.join(dbDir, 'bad.db-shm')), '原目錄不可出現 -wal／-shm');
});
