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

const ROOT = path.join(__dirname, '..');

function prepare() {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'dms-audit-'));
  fs.cpSync(path.join(ROOT, 'lib'), path.join(app, 'lib'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(app, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'services'), path.join(app, 'services'), { recursive: true });
  fs.mkdirSync(path.join(app, 'test', 'fixtures'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'build-audit-fixture.js'), path.join(app, 'test', 'fixtures', 'build-audit-fixture.js'));
  fs.symlinkSync(process.env.DMS_TEST_NODE_MODULES || path.join(ROOT, 'node_modules'), path.join(app, 'node_modules'), 'dir');
  const dbDir = path.join(app, 'databases');
  fs.mkdirSync(dbDir);
  const build = spawnSync(process.execPath, [path.join(app, 'test', 'fixtures', 'build-audit-fixture.js'), dbDir], { cwd: app, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  return { app, dbDir };
}

const hashDir = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map(f =>
  [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]));

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
    assert.equal(agg.count, 2);                                           // clean.db 與 bad.db
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
    assert.equal(find(sys, 'databases.unregistered_file').count, 1);       // bad.db 沒登記
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
