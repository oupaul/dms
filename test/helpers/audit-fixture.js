'use strict';
// 資料健檢／資料清理測試共用：在暫存目錄建立刻意混入壞資料的資料庫，並提供雜湊與執行 CLI 的小工具。
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function prepare() {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'dms-audit-'));
  for (const d of ['lib', 'scripts', 'services']) fs.cpSync(path.join(ROOT, d), path.join(app, d), { recursive: true });
  fs.mkdirSync(path.join(app, 'test', 'fixtures'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'build-audit-fixture.js'), path.join(app, 'test', 'fixtures', 'build-audit-fixture.js'));
  fs.symlinkSync(process.env.DMS_TEST_NODE_MODULES || path.join(ROOT, 'node_modules'), path.join(app, 'node_modules'), 'dir');
  const dbDir = path.join(app, 'databases');
  fs.mkdirSync(dbDir);
  const build = spawnSync(process.execPath, [path.join(app, 'test', 'fixtures', 'build-audit-fixture.js'), dbDir], { cwd: app, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  return { app, dbDir };
}

const hashDir = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map(f =>
  [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')]));

function runNode(app, args, opts = {}) {
  return spawnSync(process.execPath, args, { cwd: app, encoding: 'utf8', ...opts });
}

// 在指定資料庫上執行查詢（回傳列），用 app 目錄裡的 sqlite3
function query(app, dbFile, sql) {
  const r = runNode(app, ['-e', `
    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(${JSON.stringify(dbFile)}, sqlite3.OPEN_READONLY);
    db.all(${JSON.stringify(sql)}, (e, rows) => { if (e) { console.error(e.message); process.exit(1); } console.log(JSON.stringify(rows)); db.close(); });
  `]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

module.exports = { ROOT, prepare, hashDir, runNode, query };
