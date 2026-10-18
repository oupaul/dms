'use strict';
/**
 * 安全性回歸測試（node --test test/）
 *  - lib/security.js 單元測試
 *  - 啟動真實的 app.js（暫存目錄、隨機埠）做整合測試：登入限速、強制改密碼、
 *    CSRF Origin 檢查、資料庫授權、上傳限制、清空前備份、反向代理白名單
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const security = require('../lib/security');

const ROOT = path.join(__dirname, '..');
const INITIAL_PASSWORD = 'Init-Pass-for-Tests-2026!';
const NEW_ADMIN_PASSWORD = 'Brand-New-Root-Pass-77!';
const USER_PASSWORD = 'Zebra-Strong-Pass-2026!';

// ------------------------------------------------------------------ 單元測試

test('validatePassword：長度、字元種類、常見密碼、含使用者名稱', () => {
  assert.ok(security.validatePassword('short1A!', 'bob'));
  assert.ok(security.validatePassword('alllowercaseletters', 'bob'));
  assert.ok(security.validatePassword('admin123', 'x'));
  assert.ok(security.validatePassword('Xbob-Secret-99-bob', 'bob'));
  assert.equal(security.validatePassword('Correct-Horse-Battery-9', 'bob'), null);
});

test('generatePassword：產生的密碼一定通過密碼政策', () => {
  for (let i = 0; i < 300; i++) {
    const pw = security.generatePassword(20);
    assert.equal(pw.length, 20);
    assert.equal(security.validatePassword(pw, 'admin'), null, pw);
  }
});

test('findUsernameCollision：互為底線前綴會被擋下', () => {
  assert.equal(security.findUsernameCollision('a_b', ['a', 'zoe']), 'a');
  assert.equal(security.findUsernameCollision('a', ['a_b']), 'a_b');
  assert.equal(security.findUsernameCollision('ab', ['a']), null);
  assert.equal(security.findUsernameCollision('alice', ['bob']), null);
});

test('isDatabaseOwnedBy：以 user_<name>.db / user_<name>_* 判斷', () => {
  assert.ok(security.isDatabaseOwnedBy('user_alice.db', 'alice'));
  assert.ok(security.isDatabaseOwnedBy('user_alice_proj.db', 'alice'));
  assert.ok(!security.isDatabaseOwnedBy('user_alicia.db', 'alice'));
  assert.ok(!security.isDatabaseOwnedBy('system.db', 'alice'));
  assert.ok(!security.isDatabaseOwnedBy('user_alice_proj.sqlite', 'alice'));
});

test('失敗次數限速器：達上限後鎖定，reset 後解除', () => {
  const limiter = security.createFailureLimiter({ windowMs: 60000, max: 3 });
  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.check('k').blocked, false);
    limiter.fail('k');
  }
  assert.equal(limiter.check('k').blocked, true);
  assert.equal(limiter.check('other').blocked, false);
  limiter.reset('k');
  assert.equal(limiter.check('k').blocked, false);
});

// ------------------------------------------------------------------ 整合測試

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function copyApp(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['app.js', 'package.json', 'login.html', 'index.html', 'megapower-theme.css',
    'csv_generator.html', 'user_csv_generator.html', 'permission_generator.html', 'backup_databases.sh']) {
    if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(dest, f));
  }
  for (const d of ['lib', 'routes', 'middleware', 'services']) {
    if (fs.existsSync(path.join(ROOT, d))) fs.cpSync(path.join(ROOT, d), path.join(dest, d), { recursive: true });
  }
  // 可用 DMS_TEST_NODE_MODULES 指向針對目前 Node 版本編譯過的 node_modules（原生模組 sqlite3/argon2 與 Node 版本相關）
  const nm = process.env.DMS_TEST_NODE_MODULES || path.join(ROOT, 'node_modules');
  fs.symlinkSync(nm, path.join(dest, 'node_modules'), 'dir');
}

async function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dms-test-'));
  copyApp(dir);
  fs.writeFileSync(path.join(dir, '.initial_admin_password'), INITIAL_PASSWORD, { mode: 0o600 });
  const port = await freePort();
  const child = spawn(process.execPath, ['app.js'], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SESSION_SECRET: 'a'.repeat(64),
      PROXY_ALLOWLIST: '',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try {
      const r = await fetch(`${base}/api/auth/has-accounts`);
      if (extraEnv.PROXY_ALLOWLIST) ready = true; // 白名單情境下一律 403，只要有回應就代表已啟動
      else if (r.ok && (await r.json()).hasAccounts) ready = true;
    } catch (e) { /* 尚未啟動 */ }
    if (!ready) await new Promise(r => setTimeout(r, 200));
  }
  if (!ready) {
    child.kill();
    throw new Error('server did not start:\n' + log);
  }
  return {
    dir, base, child, getLog: () => log,
    stop: () => new Promise(resolve => {
      child.once('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); });
      child.kill();
    })
  };
}

// 帶 cookie 的簡易 client；固定帶 X-Forwarded-Proto: https 才會發出 Secure cookie
function makeClient(base, ip = '203.0.113.10') {
  let cookie = '';
  async function request(method, url, { json, headers = {}, body } = {}) {
    const h = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': ip, ...headers };
    if (cookie) h.Cookie = cookie;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(base + url, { method, headers: h, body, redirect: 'manual' });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookie) {
      const pair = c.split(';')[0];
      if (pair.startsWith('connect.sid=')) cookie = pair.endsWith('=') ? '' : pair;
    }
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (u, o) => request('GET', u, o),
    post: (u, json, o) => request('POST', u, { json, ...o }),
    put: (u, json, o) => request('PUT', u, { json, ...o }),
    del: (u, json, o) => request('DELETE', u, { json, ...o }),
    raw: request,
    sid: () => cookie
  };
}

test('整合：登入／強制改密碼／限速／CSRF／授權／上傳／清空備份', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  await t.test('安全標頭與不洩漏 X-Powered-By', async () => {
    const c = makeClient(srv.base);
    const r = await c.get('/login.html');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('strict-transport-security') || '', /max-age/);
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  await t.test('預設密碼 admin123 已不可登入；初始密碼檔已被刪除', async () => {
    const c = makeClient(srv.base, '198.51.100.1');
    const r = await c.post('/api/auth/login', { username: 'admin', password: 'admin123' });
    assert.equal(r.status, 401);
    assert.equal(fs.existsSync(path.join(srv.dir, '.initial_admin_password')), false);
  });

  await t.test('不存在的帳號與錯誤密碼回應相同（不洩漏帳號是否存在）', async () => {
    const c = makeClient(srv.base, '198.51.100.2');
    const a = await c.post('/api/auth/login', { username: 'nobody', password: 'Whatever-Pass-1!' });
    const b = await c.post('/api/auth/login', { username: 'admin', password: 'Whatever-Pass-1!' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.deepEqual(a.data, b.data);
  });

  await t.test('連續失敗 5 次後同 IP+帳號被 429 鎖定，其他 IP 不受影響', async () => {
    const c = makeClient(srv.base, '198.51.100.3');
    for (let i = 0; i < 5; i++) {
      const r = await c.post('/api/auth/login', { username: 'admin', password: 'Wrong-Pass-' + i + '!' });
      assert.equal(r.status, 401);
    }
    const locked = await c.post('/api/auth/login', { username: 'admin', password: INITIAL_PASSWORD });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    const other = makeClient(srv.base, '198.51.100.4');
    const ok = await other.post('/api/auth/login', { username: 'admin', password: INITIAL_PASSWORD });
    assert.equal(ok.status, 200);
  });

  const admin = makeClient(srv.base, '192.0.2.50');

  await t.test('首次登入必須改密碼：其他 API 被擋，弱密碼被拒，改完後解除', async () => {
    const login = await admin.post('/api/auth/login', { username: 'admin', password: INITIAL_PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.data.mustChangePassword, true);

    const blocked = await admin.get('/api/folders');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.code, 'MUST_CHANGE_PASSWORD');

    const status = await admin.get('/api/auth/status');
    assert.equal(status.data.user.mustChangePassword, true);

    const weak = await admin.post('/api/auth/change-password', { currentPassword: INITIAL_PASSWORD, newPassword: 'admin123' });
    assert.equal(weak.status, 400);

    const changed = await admin.post('/api/auth/change-password', { currentPassword: INITIAL_PASSWORD, newPassword: NEW_ADMIN_PASSWORD });
    assert.equal(changed.status, 200);

    const folders = await admin.get('/api/folders');
    assert.equal(folders.status, 200);
  });

  await t.test('登入後 session ID 會換發（防 session fixation）', async () => {
    const c = makeClient(srv.base, '192.0.2.51');
    await c.post('/api/auth/login', { username: 'admin', password: NEW_ADMIN_PASSWORD });
    const first = c.sid();
    assert.ok(first);
    const again = await c.post('/api/auth/login', { username: 'admin', password: NEW_ADMIN_PASSWORD });
    assert.equal(again.status, 200);
    assert.notEqual(c.sid(), first);
  });

  await t.test('CSRF：跨站 Origin 的寫入請求被拒，同站 Origin 通過', async () => {
    const evil = await admin.post('/api/databases/switch', { name: 'admin.db' }, { headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    const fetchSite = await admin.post('/api/databases/switch', { name: 'admin.db' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(fetchSite.status, 403);
    const host = new URL(srv.base).host;
    const good = await admin.post('/api/databases/switch', { name: 'admin.db' }, { headers: { Origin: `http://${host}` } });
    assert.equal(good.status, 200);
  });

  await t.test('管理員建立帳號：弱密碼被拒、互為底線前綴的名稱被拒', async () => {
    const weak = await admin.post('/api/admin/accounts/create', { username: 'alice', password: 'alice123' });
    assert.equal(weak.status, 400);
    const ok = await admin.post('/api/admin/accounts/create', { username: 'alice', password: USER_PASSWORD, permissionLevel: 'editor' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const clash = await admin.post('/api/admin/accounts/create', { username: 'alice_x', password: USER_PASSWORD });
    assert.equal(clash.status, 400);
    assert.match(clash.data.error, /衝突/);
  });

  const alice = makeClient(srv.base, '192.0.2.60');

  await t.test('一般帳號：預設需改密碼，且不能切換／複製他人與系統資料庫', async () => {
    const login = await alice.post('/api/auth/login', { username: 'alice', password: USER_PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.data.mustChangePassword, true);
    const newPw = 'Zebra-Changed-Pass-88!';
    assert.equal((await alice.post('/api/auth/change-password', { currentPassword: USER_PASSWORD, newPassword: newPw })).status, 200);

    const switchOther = await alice.post('/api/databases/switch', { name: 'admin.db' });
    assert.equal(switchOther.status, 403);
    const switchSystem = await alice.post('/api/databases/switch', { name: 'system.db' });
    assert.equal(switchSystem.status, 403);

    const copySystem = await alice.post('/api/databases/copy', { source: 'system.db', target: 'user_alice_loot.db' });
    assert.equal(copySystem.status, 403);

    const createOk = await alice.post('/api/databases', { name: 'user_alice_proj.db' });
    assert.equal(createOk.status, 200, JSON.stringify(createOk.data));
    const createOther = await alice.post('/api/databases', { name: 'user_bob_proj.db' });
    assert.equal(createOther.status, 403);

    const list = await alice.get('/api/databases');
    assert.equal(list.status, 200);
    const names = list.data.databases.map(d => d.name);
    assert.ok(!names.includes('system.db'), '一般帳號不應看到系統資料庫');
  });

  await t.test('非管理員不能呼叫管理 API', async () => {
    assert.equal((await alice.get('/api/admin/accounts')).status, 403);
    assert.equal((await alice.get('/api/admin/email-config')).status, 403);
    assert.equal((await alice.get('/api/admin/backup/list')).status, 403);
  });

  await t.test('上傳：不接受非 xlsx/csv 的副檔名', async () => {
    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'evil.php');
    const r = await alice.raw('POST', '/import_csv', { body: form });
    assert.equal(r.status, 400);
    assert.deepEqual(fs.readdirSync(path.join(srv.dir, 'uploads')), []);
  });

  await t.test('管理員清空資料庫前會先備份；客戶／唯讀不可呼叫', async () => {
    const bad = await admin.post('/api/clear_all', { confirm: 'nope' });
    assert.equal(bad.status, 400);
    const ok = await admin.post('/api/clear_all', { confirm: 'CLEAR_ALL_DATA' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const dir = path.join(srv.dir, 'backups', 'pre-clear');
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o077, 0, '備份檔不可被其他使用者讀取');
  });

  await t.test('管理員重設密碼後，目標使用者舊 session 立即失效並被要求改密碼', async () => {
    const list = await admin.get('/api/admin/accounts');
    const aliceRow = list.data.find ? list.data.find(a => a.username === 'alice') : (list.data.accounts || []).find(a => a.username === 'alice');
    assert.ok(aliceRow);
    const weak = await admin.post('/api/admin/accounts/reset-password', { accountId: aliceRow.id, newPassword: 'abc123' });
    assert.equal(weak.status, 400);
    const reset = await admin.post('/api/admin/accounts/reset-password', { accountId: aliceRow.id, newPassword: 'Temp-Reset-Pass-55!' });
    assert.equal(reset.status, 200);
    const status = await alice.get('/api/auth/status');
    assert.equal(status.data.loggedIn, false);
    const relogin = await alice.post('/api/auth/login', { username: 'alice', password: 'Temp-Reset-Pass-55!' });
    assert.equal(relogin.data.mustChangePassword, true);
  });

  await t.test('設定檔只接受白名單欄位', async () => {
    const r = await admin.post('/api/admin/sso-config', { enabled: false, evil: 'x', __proto__x: 1, redirectUri: 'javascript:alert(1)' });
    assert.equal(r.status, 400);
    const e = await admin.post('/api/admin/email-config', { enabled: false, evil: 'x' });
    assert.equal(e.status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(srv.dir, 'email_config.json'), 'utf8'));
    assert.equal(saved.evil, undefined);
    assert.equal(fs.statSync(path.join(srv.dir, 'email_config.json')).mode & 0o077, 0);
  });

  await t.test('500 錯誤不洩漏內部訊息', async () => {
    const r = await admin.get('/api/admin/backup/download/..%2F..%2Fetc%2Fpasswd');
    assert.ok([403, 404].includes(r.status));
    assert.ok(!JSON.stringify(r.data).includes('/opt/'));
  });
});

test('整合：PUT /api/folders/:id 防循環（設為自己／子孫被拒，合法移動會更新子孫路徑）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const admin = makeClient(srv.base, '192.0.2.70');
  assert.equal((await admin.post('/api/auth/login', { username: 'admin', password: INITIAL_PASSWORD })).status, 200);
  assert.equal((await admin.post('/api/auth/change-password', { currentPassword: INITIAL_PASSWORD, newPassword: NEW_ADMIN_PASSWORD })).status, 200);

  const mk = async (name, parent_id) => {
    const r = await admin.post('/api/folders', { name, parent_id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.id;
  };
  const rename = (id, name, parent_id) => admin.put(`/api/folders/${id}`, { name, parent_id });
  const getFolder = async (id) => (await admin.get(`/api/folders/${id}`)).data;

  // 結構：A ─ B ─ C ─ D，另有獨立的 X 與 Y
  const A = await mk('A', null);
  const B = await mk('B', A);
  const C = await mk('C', B);
  const D = await mk('D', C);
  const X = await mk('X', null);
  const Y = await mk('Y', X);

  const snapshot = async () => JSON.stringify((await admin.get('/api/folders')).data);

  await t.test('設為自己：400 且不寫入', async () => {
    const before = await snapshot();
    const r = await rename(B, 'B', B);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /自己/);
    assert.equal(await snapshot(), before);
  });

  await t.test('設為子孫（子、孫、曾孫）：400 且不寫入，改名也不會生效', async () => {
    const before = await snapshot();
    for (const target of [B, C, D]) {
      const r = await rename(A, 'A-renamed', target);
      assert.equal(r.status, 400, `parent=${target}`);
      assert.match(r.data.error, /子資料夾/);
    }
    assert.equal((await rename(B, 'B-renamed', D)).status, 400);
    assert.equal(await snapshot(), before);
  });

  await t.test('以字串形式傳入的 parent_id 同樣會被擋（"3" 與 3 等價）', async () => {
    const r = await rename(A, 'A', String(C));
    assert.equal(r.status, 400);
  });

  await t.test('格式不正確的 parent_id：400', async () => {
    for (const bad of ['abc', -1, 1.5, '0', {}, [1]]) {
      const r = await rename(A, 'A', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  });

  await t.test('合法移動仍成功，且所有子孫路徑正確更新', async () => {
    // 把 B（含 C、D）移到 Y 底下，同時改名
    const r = await rename(B, 'B2', Y);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data, { success: true });
    assert.equal((await getFolder(B)).path, '/X/Y/B2');
    assert.equal((await getFolder(C)).path, '/X/Y/B2/C');
    assert.equal((await getFolder(D)).path, '/X/Y/B2/C/D');
    assert.equal((await getFolder(A)).path, '/A');
    assert.equal((await getFolder(B)).parent_id, Y);
  });

  await t.test('移動後原本的祖先變成後代：A 不能移到 D 底下，但 X 的子孫仍可正常移回根', async () => {
    assert.equal((await rename(X, 'X', D)).status, 400);
    const toRoot = await rename(C, 'C', null);
    assert.equal(toRoot.status, 200);
    assert.equal((await getFolder(C)).path, '/C');
    assert.equal((await getFolder(D)).path, '/C/D');
    // 原本是 C 的祖先 B 現在不能掛到 D 底下
    assert.equal((await rename(C, 'C', D)).status, 400);
  });

  await t.test('既有壞資料（循環）：PUT 與 POST 都會終止，不會無限遞迴', async () => {
    // 直接寫入資料庫製造 P ⇄ Q 循環（模擬舊版 bug 留下的壞資料）
    const P = await mk('P', null);
    const Q = await mk('Q', P);
    const sqlite3 = require(path.join(process.env.DMS_TEST_NODE_MODULES || path.join(ROOT, 'node_modules'), 'sqlite3'));
    const dbFile = path.join(srv.dir, 'databases', 'admin.db');
    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbFile, (e) => {
        if (e) return reject(e);
        db.run('UPDATE folders SET parent_id = ? WHERE id = ?', [Q, P], (e2) => db.close(() => e2 ? reject(e2) : resolve()));
      });
    });
    assert.equal((await getFolder(P)).parent_id, Q, '壞資料應已寫入');
    const signal = AbortSignal.timeout(10000);
    // 把正常資料夾移到循環鏈底下：必須回應（400 或成功皆可），不能卡死
    const moved = await Promise.race([
      rename(X, 'X', Q),
      new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('PUT hung'))))
    ]);
    assert.ok([200, 400].includes(moved.status), String(moved.status));
    // 修改循環中的資料夾本身：不可無限遞迴
    const fix = await Promise.race([
      rename(P, 'P', null),
      new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('PUT hung'))))
    ]);
    assert.equal(fix.status, 200);
    // POST 建立在壞資料底下：路徑計算會終止
    const created = await Promise.race([
      admin.post('/api/folders', { name: 'child-of-bad', parent_id: Q }),
      new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('POST hung'))))
    ]);
    assert.equal(created.status, 200);
    assert.ok(typeof created.data.path === 'string');
    // 伺服器仍然健康
    assert.equal((await admin.get('/api/folders')).status, 200);
  });
});

test('整合：設定 PROXY_ALLOWLIST 後，非白名單來源直連一律 403', async (t) => {
  const srv = await startServer({ PROXY_ALLOWLIST: '10.250.250.250' });
  t.after(() => srv.stop());
  // 等程序啟動完成
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${srv.base}/login.html`); break; } catch (e) { await new Promise(r => setTimeout(r, 200)); }
  }
  const r = await fetch(`${srv.base}/login.html`);
  assert.equal(r.status, 403);
  const api = await fetch(`${srv.base}/api/auth/has-accounts`);
  assert.equal(api.status, 403);
});

test('整合：未設定 SESSION_SECRET 時產生主機專屬密鑰檔（權限 600），不使用寫死值', async (t) => {
  const srv = await startServer({ SESSION_SECRET: '' });
  t.after(() => srv.stop());
  const file = path.join(srv.dir, '.session_secret');
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.ok(fs.readFileSync(file, 'utf8').trim().length >= 32);
  assert.ok(!fs.readFileSync(path.join(srv.dir, 'app.js'), 'utf8').includes('your-secret-key-change-this'));
});
