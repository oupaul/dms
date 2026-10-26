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
  for (const d of ['lib', 'routes', 'middleware', 'services', 'public']) {
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
    sid: () => cookie,
    cookie: () => cookie
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
    assert.ok(names.includes('user_alice_proj.db'));
  });

  await t.test('一般內部帳號看不到、也不能複製他人／客戶的資料庫；可複製自己的', async () => {
    const created = await admin.post('/api/databases', { name: 'customer_ref.db' });
    assert.equal(created.status, 200, JSON.stringify(created.data));

    const names = (await alice.get('/api/databases')).data.databases.map(d => d.name);
    assert.ok(!names.includes('customer_ref.db'), '不應看到他人的資料庫');
    assert.ok(!names.includes('admin.db'), '不應看到管理員的資料庫');

    const copyOther = await alice.post('/api/databases/copy', { source: 'customer_ref.db', target: 'user_alice_steal.db' });
    assert.equal(copyOther.status, 403);
    assert.equal(fs.existsSync(path.join(srv.dir, 'databases', 'user_alice_steal.db')), false);

    const copyOwn = await alice.post('/api/databases/copy', { source: 'user_alice_proj.db', target: 'user_alice_proj2.db' });
    assert.equal(copyOwn.status, 200, JSON.stringify(copyOwn.data));
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

test('整合：資料夾不會重複（手動新增 409、重複匯入 CSV／xlsx 重用既有資料夾）', async (t) => {
  const NM = process.env.DMS_TEST_NODE_MODULES || path.join(ROOT, 'node_modules');
  const ExcelJS = require(path.join(NM, 'exceljs'));
  const srv = await startServer();
  t.after(() => srv.stop());

  const admin = makeClient(srv.base, '192.0.2.80');
  assert.equal((await admin.post('/api/auth/login', { username: 'admin', password: INITIAL_PASSWORD })).status, 200);
  assert.equal((await admin.post('/api/auth/change-password', { currentPassword: INITIAL_PASSWORD, newPassword: NEW_ADMIN_PASSWORD })).status, 200);

  const count = async () => (await admin.get('/api/folders')).data.length;
  const paths = async () => (await admin.get('/api/folders')).data.map(f => f.path).sort();

  await t.test('手動新增：同一父層同名回 409，不同父層同名可以', async () => {
    const a = await admin.post('/api/folders', { name: 'A', parent_id: null });
    assert.equal(a.status, 200);
    const dupRoot = await admin.post('/api/folders', { name: 'A', parent_id: null });
    assert.equal(dupRoot.status, 409);
    assert.match(dupRoot.data.error, /已有名稱相同/);
    const b = await admin.post('/api/folders', { name: 'B', parent_id: a.data.id });
    assert.equal(b.status, 200);
    assert.equal((await admin.post('/api/folders', { name: 'B', parent_id: a.data.id })).status, 409);
    // 不同父層可以同名
    const other = await admin.post('/api/folders', { name: 'Other', parent_id: null });
    assert.equal((await admin.post('/api/folders', { name: 'B', parent_id: other.data.id })).status, 200);
    assert.equal(await count(), 4);
  });

  await t.test('改名／搬移到同一父層已有同名資料夾 → 409', async () => {
    const all = (await admin.get('/api/folders')).data;
    const otherB = all.find(f => f.path === '/Other/B');
    const rootA = all.find(f => f.path === '/A');
    // 把 /Other/B 搬到 /A 底下，而 /A/B 已存在
    const r = await admin.put(`/api/folders/${otherB.id}`, { name: 'B', parent_id: rootA.id });
    assert.equal(r.status, 409);
    // 改名成同層既有名稱
    const aB = all.find(f => f.path === '/A/B');
    await admin.post('/api/folders', { name: 'C', parent_id: rootA.id });
    const c = (await admin.get('/api/folders')).data.find(f => f.path === '/A/C');
    assert.equal((await admin.put(`/api/folders/${c.id}`, { name: 'B', parent_id: rootA.id })).status, 409);
    // 原地存檔（名稱不變）不應被當成衝突
    assert.equal((await admin.put(`/api/folders/${aB.id}`, { name: 'B', parent_id: rootA.id })).status, 200);
  });

  await t.test('匯出完整 CSV 再匯入：資料夾數量不變', async () => {
    const before = await paths();
    const res = await fetch(`${srv.base}/export_full_csv`, { headers: { Cookie: admin.cookie(), 'X-Forwarded-Proto': 'https' } });
    assert.equal(res.status, 200);
    const csvBlob = await res.blob();
    for (let i = 0; i < 2; i++) {
      const form = new FormData();
      form.append('file', csvBlob, 'roundtrip.csv');
      const r = await admin.raw('POST', '/import_csv', { body: form });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    }
    assert.deepEqual(await paths(), before, '重複匯入不應產生重複資料夾');
  });

  await t.test('xlsx 階層匯入兩次：只建立一次', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('填寫清單');
    ws.addRow(['第一層', '第二層', '第三層']);
    ws.addRow(['說明', '說明', '說明']);
    ws.addRow(['Share', '管理部', '財務組']);
    ws.addRow(['Share', '管理部', '人事組']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const upload = async () => {
      const form = new FormData();
      form.append('file', new Blob([buf]), 'folders.xlsx');
      return admin.raw('POST', '/import_folders_xlsx', { body: form });
    };
    const first = await upload();
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.stats.inserted, 4); // Share、管理部、財務組、人事組
    const afterFirst = await paths();
    const second = await upload();
    assert.equal(second.status, 200);
    assert.equal(second.data.stats.inserted, 0);
    assert.equal(second.data.stats.skipped, 4);
    assert.deepEqual(await paths(), afterFirst);
    assert.ok(afterFirst.includes('/Share/管理部/財務組'));
  });
});

// ------------------------------------------------------------------ 資料關聯完整性（源頭修正）
// 重現 dms-prod 資料健檢（scripts/data-audit.js）發現的問題：
//  - 刪除群組／人員（含批次）留下孤兒成員
//  - 匯入、建立群組與權限沒有檢查是否已存在 → 重複群組、重複權限
//  - 權限可以填任意類型、對象不明確、指向不存在的資料夾／人員

// 在暫存目錄的資料庫上直接執行 SQL（回傳查詢結果；寫入用於塞入無法由 API 產生的情境）
function sqlOn(dir, dbName, sql, { write = false } = {}) {
  const script = `
    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(${JSON.stringify(path.join(dir, 'databases', dbName))});
    const sql = ${JSON.stringify(sql)};
    ${write
      ? "db.exec(sql, (e) => { if (e) { console.error(e.message); process.exit(1); } console.log('[]'); db.close(); });"
      : "db.all(sql, (e, rows) => { if (e) { console.error(e.message); process.exit(1); } console.log(JSON.stringify(rows)); db.close(); });"}
  `;
  const r = require('child_process').spawnSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('整合：資料關聯完整性（不產生重複／孤兒資料）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const admin = makeClient(srv.base, '192.0.2.90');
  assert.equal((await admin.post('/api/auth/login', { username: 'admin', password: INITIAL_PASSWORD })).status, 200);
  assert.equal((await admin.post('/api/auth/change-password', { currentPassword: INITIAL_PASSWORD, newPassword: NEW_ADMIN_PASSWORD })).status, 200);
  const q = (sql) => sqlOn(srv.dir, 'admin.db', sql);

  const folder = (await admin.post('/api/folders', { name: 'F', parent_id: null })).data.id;
  const userA = (await admin.post('/api/users', { name: 'UA', email: 'ua@example.com' })).data.id;
  const userB = (await admin.post('/api/users', { name: 'UB', email: 'ub@example.com' })).data.id;

  await t.test('建立群組：同名（不分大小寫）回 409；改名成既有名稱也回 409', async () => {
    const g = await admin.post('/api/groups', { name: 'Team_RW' });
    assert.equal(g.status, 200);
    assert.equal((await admin.post('/api/groups', { name: 'Team_RW' })).status, 409);
    assert.equal((await admin.post('/api/groups', { name: 'team_rw' })).status, 409);
    assert.equal((await admin.post('/api/groups', { name: '   ' })).status, 400);
    const other = await admin.post('/api/groups', { name: 'Other' });
    assert.equal((await admin.put(`/api/groups/${other.data.id}`, { name: 'TEAM_RW' })).status, 409);
    assert.equal((await admin.put(`/api/groups/${other.data.id}`, { name: 'Other' })).status, 200);  // 原名存檔不算衝突
  });

  await t.test('新增權限：驗證類型、對象、存在性與重複', async () => {
    const gid = (await admin.get('/api/groups')).data.find(g => g.name === 'Team_RW').id;
    const bad = (body) => admin.post('/api/permissions', body);
    assert.equal((await bad({ folder_id: folder, user_id: userA, permission_type: 'banana' })).status, 400);
    assert.equal((await bad({ folder_id: folder, user_id: userA, permission_type: 'RO' })).status, 400);
    assert.equal((await bad({ folder_id: folder, permission_type: 'read' })).status, 400, '沒指定對象');
    assert.equal((await bad({ folder_id: folder, user_id: userA, group_id: gid, permission_type: 'read' })).status, 400, '同時指定人員與群組');
    assert.equal((await bad({ folder_id: 99999, user_id: userA, permission_type: 'read' })).status, 400, '資料夾不存在');
    assert.equal((await bad({ folder_id: folder, user_id: 88888, permission_type: 'read' })).status, 400, '人員不存在');
    assert.equal((await bad({ folder_id: folder, group_id: 77777, permission_type: 'read' })).status, 400, '群組不存在');

    assert.equal((await bad({ folder_id: folder, user_id: userA, permission_type: 'read' })).status, 200);
    const dup = await bad({ folder_id: folder, user_id: userA, permission_type: 'read' });
    assert.equal(dup.status, 409);
    const conflict = await bad({ folder_id: folder, user_id: userA, permission_type: 'write' });
    assert.equal(conflict.status, 409, '同對象改類型也不能再新增一筆，避免 read 與 write 並存');
    assert.match(conflict.data.error, /read/);
    assert.equal((await bad({ folder_id: folder, group_id: gid, permission_type: 'write' })).status, 200);
    assert.equal(q('SELECT COUNT(*) AS c FROM permissions')[0].c, 2);
  });

  await t.test('GET /api/groups 帶 member_count（只算人員仍存在的成員）；權限卡片用的前端檔案可取得', async () => {
    const gid = (await admin.get('/api/groups')).data.find(g => g.name === 'Team_RW').id;
    assert.equal((await admin.get('/api/groups')).data.find(g => g.id === gid).member_count, 0);
    assert.equal((await admin.post(`/api/groups/${gid}/users`, { user_id: userA })).status, 200);
    assert.equal((await admin.post(`/api/groups/${gid}/users`, { user_id: userB })).status, 200);
    assert.equal((await admin.get('/api/groups')).data.find(g => g.id === gid).member_count, 2);
    // 孤兒成員（人員已不存在）不計入
    sqlOn(srv.dir, 'admin.db', `INSERT INTO group_users (group_id, user_id) VALUES (${gid}, 987654)`, { write: true });
    assert.equal((await admin.get('/api/groups')).data.find(g => g.id === gid).member_count, 2);
    sqlOn(srv.dir, 'admin.db', `DELETE FROM group_users WHERE user_id = 987654`, { write: true });

    for (const f of ['/js/folder-access.js', '/js/folder-access-ui.js', '/css/folder-access.css']) {
      assert.equal((await admin.get(f)).status, 200, f);
    }
  });

  await t.test('資料夾樹節點不再把名稱拼進 HTML（避免名稱含標籤被執行）', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(!/\$\(`<span class="folder-item"[^`]*\$\{item\.name\}/.test(html), 'buildTree 不可再以樣板字串插入 item.name');
    assert.match(html, /createTextNode\(String\(item\.name/);
    const ui = fs.readFileSync(path.join(ROOT, 'public', 'js', 'folder-access-ui.js'), 'utf8');
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|\.html\(/.test(ui), '卡片程式不可用 innerHTML／.html() 寫入資料');
  });

  await t.test('刪除群組（單筆）：一併清掉成員關聯', async () => {
    const g = (await admin.post('/api/groups', { name: 'ToDelete1' })).data.id;
    await admin.post(`/api/groups/${g}/users`, { user_id: userA });
    await admin.post(`/api/groups/${g}/users`, { user_id: userB });
    assert.equal(q(`SELECT COUNT(*) AS c FROM group_users WHERE group_id = ${g}`)[0].c, 2);
    assert.equal((await admin.del('/api/groups', { id: g })).status, 200);
    assert.equal(q(`SELECT COUNT(*) AS c FROM group_users WHERE group_id = ${g}`)[0].c, 0, '不應留下孤兒成員');
    assert.equal(q(`SELECT COUNT(*) AS c FROM groups WHERE id = ${g}`)[0].c, 0);
  });

  await t.test('刪除群組（批次）：一併清掉成員關聯', async () => {
    const ids = [];
    for (const n of ['Batch1', 'Batch2']) {
      const g = (await admin.post('/api/groups', { name: n })).data.id;
      await admin.post(`/api/groups/${g}/users`, { user_id: userA });
      ids.push(g);
    }
    const r = await admin.del('/api/groups/batch', { ids });
    assert.equal(r.status, 200);
    assert.equal(r.data.deleted, 2);
    assert.equal(q(`SELECT COUNT(*) AS c FROM group_users WHERE group_id IN (${ids.join(',')})`)[0].c, 0);
  });

  await t.test('刪除人員（單筆與批次）：一併清掉成員關聯', async () => {
    const g = (await admin.post('/api/groups', { name: 'Holder' })).data.id;
    const u1 = (await admin.post('/api/users', { name: 'D1', email: 'd1@example.com' })).data.id;
    const u2 = (await admin.post('/api/users', { name: 'D2', email: 'd2@example.com' })).data.id;
    const u3 = (await admin.post('/api/users', { name: 'D3', email: 'd3@example.com' })).data.id;
    for (const u of [u1, u2, u3]) await admin.post(`/api/groups/${g}/users`, { user_id: u });
    assert.equal((await admin.del('/api/users', { id: u1 })).status, 200);
    assert.equal(q(`SELECT COUNT(*) AS c FROM group_users WHERE user_id = ${u1}`)[0].c, 0);
    const b = await admin.del('/api/users/batch', { ids: [u2, u3] });
    assert.equal(b.status, 200);
    assert.equal(q(`SELECT COUNT(*) AS c FROM group_users WHERE user_id IN (${u2},${u3})`)[0].c, 0);
    assert.equal(q('SELECT COUNT(*) AS c FROM group_users gu WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = gu.user_id) OR NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = gu.group_id)')[0].c, 0,
      '整個資料庫不應有任何孤兒成員');
  });

  await t.test('刪除對象或資料夾時，待審核的申請單自動駁回（不會留到日後核准出孤兒權限）', async () => {
    const g = (await admin.post('/api/groups', { name: 'ReqTarget' })).data.id;
    const u = (await admin.post('/api/users', { name: 'ReqUser', email: 'req@example.com' })).data.id;
    const f = (await admin.post('/api/folders', { name: 'ReqFolder', parent_id: null })).data.id;
    const child = (await admin.post('/api/folders', { name: 'ReqChild', parent_id: f })).data.id;
    const ins = (folderId, type, uid, gid) => `INSERT INTO permission_requests (folder_id, target_type, target_user_id, target_group_id, requested_permission_type, reason, status, requested_by_account_id, requested_by_username, requested_at)
      VALUES (${folderId}, '${type}', ${uid}, ${gid}, 'read', 't', 'pending', 1, 'c', '2026-10-01T00:00:00+08:00');`;
    sqlOn(srv.dir, 'admin.db', ins(folder, 'group', 'NULL', g) + ins(folder, 'user', u, 'NULL') + ins(child, 'user', userA, 'NULL'), { write: true });
    const pending = () => q("SELECT COUNT(*) AS c FROM permission_requests WHERE status = 'pending'")[0].c;
    assert.equal(pending(), 3);

    assert.equal((await admin.del('/api/groups', { id: g })).status, 200);
    assert.equal(pending(), 2);
    assert.equal((await admin.del('/api/users', { id: u })).status, 200);
    assert.equal(pending(), 1);
    // 資料夾（含子孫）：強制刪除 f 時，子資料夾 child 上的待審核申請單也要駁回
    sqlOn(srv.dir, 'admin.db', `UPDATE permission_requests SET folder_id = ${child}, target_user_id = ${userA} WHERE status = 'pending';`, { write: true });
    assert.equal((await admin.del('/api/folders', { id: f, force: true })).status, 200);
    assert.equal(pending(), 0);
    const note = q("SELECT review_note, reviewed_by_username FROM permission_requests WHERE review_note LIKE '%資料夾已刪除%'");
    assert.equal(note.length, 1);
    assert.equal(note[0].reviewed_by_username, '系統');
  });

  await t.test('匯出完整 CSV 再匯入兩次：群組與權限不重複', async () => {
    const f = (await admin.post('/api/folders', { name: 'Roundtrip', parent_id: null })).data.id;
    const g = (await admin.post('/api/groups', { name: 'Roundtrip_RW' })).data.id;
    assert.equal((await admin.post('/api/permissions', { folder_id: f, group_id: g, permission_type: 'write' })).status, 200);
    const counts = () => ({
      groups: q('SELECT COUNT(*) AS c FROM groups')[0].c,
      permissions: q('SELECT COUNT(*) AS c FROM permissions')[0].c,
      folders: q('SELECT COUNT(*) AS c FROM folders')[0].c,
      members: q('SELECT COUNT(*) AS c FROM group_users')[0].c
    });
    const before = counts();
    const res = await fetch(`${srv.base}/export_full_csv`, { headers: { Cookie: admin.cookie(), 'X-Forwarded-Proto': 'https' } });
    assert.equal(res.status, 200);
    const csvBlob = await res.blob();
    for (let i = 0; i < 2; i++) {
      const form = new FormData();
      form.append('file', csvBlob, 'roundtrip.csv');
      const r = await admin.raw('POST', '/import_csv', { body: form });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    }
    assert.deepEqual(counts(), before, '重複匯入不應增加任何群組、權限、資料夾或成員');
    assert.equal(q("SELECT COUNT(*) AS c FROM (SELECT LOWER(name) FROM groups GROUP BY LOWER(name) HAVING COUNT(*) > 1)")[0].c, 0, '不應有同名群組');
    assert.equal(q('SELECT COUNT(*) AS c FROM (SELECT folder_id, user_id, group_id FROM permissions GROUP BY 1,2,3 HAVING COUNT(*) > 1)')[0].c, 0, '不應有重複權限');
  });

  await t.test('自動生成群組並指派權限：連續執行兩次不重複；既有的相反類型權限不會再多塞一筆', async () => {
    const root = (await admin.post('/api/folders', { name: 'AutoRoot', parent_id: null })).data.id;
    await admin.post('/api/folders', { name: 'Sub', parent_id: root });
    // 同名資料夾（舊資料）會產生同名群組；用 SQL 塞入重現
    sqlOn(srv.dir, 'admin.db', `INSERT INTO folders (name, parent_id, path) VALUES ('Sub', ${root}, '/AutoRoot/Sub');`, { write: true });
    const run = async () => (await admin.post('/api/auto-generate-groups', { folders: (await admin.get('/api/folders')).data })).data;
    const first = await run();
    assert.ok(first.success, JSON.stringify(first));
    const afterFirst = { groups: q('SELECT COUNT(*) AS c FROM groups')[0].c, permissions: q('SELECT COUNT(*) AS c FROM permissions')[0].c };
    await run();
    assert.deepEqual({ groups: q('SELECT COUNT(*) AS c FROM groups')[0].c, permissions: q('SELECT COUNT(*) AS c FROM permissions')[0].c }, afterFirst);
    assert.equal(q("SELECT COUNT(*) AS c FROM (SELECT LOWER(name) FROM groups GROUP BY LOWER(name) HAVING COUNT(*) > 1)")[0].c, 0, '重複的資料夾名稱不應產生同名群組');

    // 群組 AutoRoot_RO 若已有 write，再自動生成時不能再多塞一筆 read
    const roId = q("SELECT id FROM groups WHERE name = 'AutoRoot_RO'")[0].id;
    sqlOn(srv.dir, 'admin.db', `UPDATE permissions SET permission_type = 'write' WHERE group_id = ${roId} AND folder_id = ${root};`, { write: true });
    await run();
    assert.equal(q(`SELECT COUNT(*) AS c FROM permissions WHERE group_id = ${roId} AND folder_id = ${root}`)[0].c, 1);
  });
});

// ============================================================================
// 工程師「可存取全部資料庫」
//   - 只有管理員能設定，只有工程師角色有效；客戶、唯讀、一般帳號即使資料庫裡有標記也不生效
//   - 系統資料庫（system.db 掌管所有帳號、admin.db）任何角色都不可被授權或切換
//   - 新資料庫立即生效（不必重新登入）；實習工程師（清單模式）不受影響
//   - 切換資料庫與被拒絕的嘗試都寫稽核日誌
// ============================================================================
test('整合：工程師「可存取全部資料庫」', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const admin = makeClient(srv.base, '192.0.2.130');
  assert.equal((await admin.post('/api/auth/login', { username: 'admin', password: INITIAL_PASSWORD })).status, 200);
  assert.equal((await admin.post('/api/auth/change-password', { currentPassword: INITIAL_PASSWORD, newPassword: NEW_ADMIN_PASSWORD })).status, 200);

  const sys = (sql, write) => sqlOn(srv.dir, 'system.db', sql, { write });
  const dbFiles = () => fs.readdirSync(path.join(srv.dir, 'databases')).filter(f => f.endsWith('.db') && !['system.db', 'admin.db'].includes(f) && !f.startsWith('deleted_')).sort();
  const names = (r) => (r.data.databases || []).map(d => d.name).sort();
  const newPw = 'Zebra-Changed-Pass-88!';
  let ipSeq = 140;
  async function loginAs(username) {
    const c = makeClient(srv.base, `192.0.2.${ipSeq++}`);
    assert.equal((await c.post('/api/auth/login', { username, password: USER_PASSWORD })).status, 200, `${username} 登入`);
    assert.equal((await c.post('/api/auth/change-password', { currentPassword: USER_PASSWORD, newPassword: newPw })).status, 200);
    return c;
  }
  const setPerm = (username, body) => {
    const id = sys(`SELECT id FROM accounts WHERE username = '${username}'`)[0].id;
    return admin.post('/api/admin/accounts/update-permission', { accountId: id, ...body });
  };

  for (const u of ['eng', 'intern', 'cust', 'view']) {
    assert.equal((await admin.post('/api/admin/accounts/create', { username: u, password: USER_PASSWORD, permissionLevel: 'editor' })).status, 200);
  }
  for (const n of ['cust_a.db', 'cust_b.db']) assert.equal((await admin.post('/api/databases', { name: n })).status, 200);

  await t.test('設定：只有工程師角色能設「全部」；其他角色一律拒絕', async () => {
    const asClient = await setPerm('cust', { roleLevel: 'client_user', permissionLevel: 'viewer', allowedDatabases: ['cust_a.db'], allowAllDatabases: true });
    assert.equal(asClient.status, 400);
    const asViewer = await setPerm('view', { permissionLevel: 'viewer', allowedDatabases: ['cust_a.db'], allowAllDatabases: true });
    assert.equal(asViewer.status, 400);
    const asUser = await setPerm('view', { roleLevel: 'user', allowAllDatabases: true });
    assert.equal(asUser.status, 400);

    assert.equal((await setPerm('cust', { roleLevel: 'client_user', permissionLevel: 'viewer', allowedDatabases: ['cust_a.db'] })).status, 200);
    assert.equal((await setPerm('view', { permissionLevel: 'viewer', allowedDatabases: ['cust_a.db'] })).status, 200);
    assert.equal((await setPerm('intern', { roleLevel: 'engineer', allowedDatabases: ['cust_a.db'] })).status, 200);
    const ok = await setPerm('eng', { roleLevel: 'engineer', allowAllDatabases: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.allowAllDatabases, true);

    const list = (await admin.get('/api/admin/accounts')).data;
    const eng = list.find(a => a.username === 'eng');
    assert.equal(eng.allow_all_databases, true);
    assert.deepEqual(eng.allowed_databases, [], '清單裡不會出現標記本身');
    assert.equal(list.find(a => a.username === 'intern').allow_all_databases, false);
    assert.equal(sys("SELECT allowed_databases AS a FROM accounts WHERE username = 'eng'")[0].a, '["*"]');
  });

  await t.test('系統資料庫任何角色都不可被授權', async () => {
    const r = await setPerm('intern', { roleLevel: 'engineer', allowedDatabases: ['system.db', 'admin.db', 'cust_a.db'] });
    assert.equal(r.status, 200);
    assert.equal(sys("SELECT allowed_databases AS a FROM accounts WHERE username = 'intern'")[0].a, '["cust_a.db"]');
    const only = await setPerm('intern', { roleLevel: 'engineer', allowedDatabases: ['system.db'] });
    assert.equal(only.status, 400, '只有系統資料庫等於沒選');
  });

  const eng = await loginAs('eng');
  const intern = await loginAs('intern');

  await t.test('全部資料庫的工程師：看得到所有非系統資料庫，系統資料庫看不到也切不過去', async () => {
    const list = await eng.get('/api/databases');
    assert.deepEqual(names(list), dbFiles());
    assert.ok(!names(list).includes('system.db') && !names(list).includes('admin.db'));
    assert.equal((await eng.post('/api/databases/switch', { name: 'cust_a.db' })).status, 200);
    assert.equal((await eng.get('/api/folders')).status, 200);
    assert.equal((await eng.post('/api/databases/switch', { name: 'system.db' })).status, 403);
    assert.equal((await eng.post('/api/databases/switch', { name: 'admin.db' })).status, 403);
    assert.equal((await eng.post('/api/databases/switch', { name: 'no_such.db' })).status, 403);
    assert.equal((await eng.post('/api/databases/switch', { name: '../databases/system.db' })).status, 400, '路徑跳脫');
    assert.equal((await eng.post('/api/databases/switch', { name: 'cust_a.db/../system.db' })).status, 400);
    assert.equal((await eng.post('/api/databases/copy', { source: 'system.db', target: 'user_eng_loot.db' })).status, 403);
    const me = (await eng.get('/api/auth/status')).data.user;
    assert.equal(me.allowAllDatabases, true);
    assert.deepEqual([...me.allowedDatabases].sort(), dbFiles(), '前端用的清單也是即時計算的、不含系統資料庫');
  });

  await t.test('新資料庫立刻生效：已登入的工程師不必重新登入；實習工程師（清單模式）不受影響', async () => {
    assert.equal((await admin.post('/api/databases', { name: 'later_new.db' })).status, 200);
    assert.ok(names(await eng.get('/api/databases')).includes('later_new.db'));
    assert.equal((await eng.post('/api/databases/switch', { name: 'later_new.db' })).status, 200);
    // 複製：全部資料庫的工程師可以複製任何非系統資料庫（目標仍須是自己名下）
    assert.equal((await eng.post('/api/databases/copy', { source: 'cust_b.db', target: 'user_eng_copy.db' })).status, 200);

    assert.deepEqual(names(await intern.get('/api/databases')), ['cust_a.db']);
    assert.equal((await intern.post('/api/databases/switch', { name: 'later_new.db' })).status, 403);
    assert.equal((await intern.post('/api/databases/switch', { name: 'cust_a.db' })).status, 200);
  });

  await t.test('客戶與唯讀帳號：即使資料庫裡被塞進「全部」標記也不生效', async () => {
    sys(`UPDATE accounts SET allowed_databases = '["*"]' WHERE username IN ('cust', 'view')`, true);
    for (const u of ['cust', 'view']) {
      const c = makeClient(srv.base, `192.0.2.${ipSeq++}`);
      const r = await c.post('/api/auth/login', { username: u, password: USER_PASSWORD });
      assert.equal(r.status, 403, `${u} 不應因標記取得任何資料庫`);
    }
    // 一般帳號（非工程師角色）帶標記：登入後也只看得到自己的資料庫
    assert.equal((await setPerm('view', { roleLevel: 'user', permissionLevel: 'editor' })).status, 200);
    sys(`UPDATE accounts SET allowed_databases = '["*"]' WHERE username = 'view'`, true);
    const v = makeClient(srv.base, `192.0.2.${ipSeq++}`);
    assert.equal((await v.post('/api/auth/login', { username: 'view', password: USER_PASSWORD })).status, 200);
    assert.equal((await v.post('/api/auth/change-password', { currentPassword: USER_PASSWORD, newPassword: newPw })).status, 200);
    assert.ok(!names(await v.get('/api/databases')).includes('cust_a.db'), '一般帳號不會因標記看到他人資料庫');
    assert.equal((await v.post('/api/databases/switch', { name: 'cust_a.db' })).status, 403);
  });

  await t.test('邀請連結不能夾帶「全部」標記', async () => {
    const r = await admin.post('/api/admin/invitations', { roleLevel: 'client_user', permissionLevel: 'viewer', allowedDatabases: ['*', 'cust_a.db'], expiryDays: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const row = sys("SELECT allowed_databases AS a FROM invitations ORDER BY rowid DESC LIMIT 1")[0];
    assert.equal(row.a, '["cust_a.db"]');
  });

  await t.test('稽核：切換資料庫與被拒絕的嘗試都有紀錄；改權限也有紀錄', async () => {
    const rows = sys("SELECT username, action_type AS t, resource_name AS n FROM audit_log WHERE action_type IN ('switch', 'switch_denied') ORDER BY id");
    assert.ok(rows.some(r => r.username === 'eng' && r.t === 'switch' && r.n === 'cust_a.db'));
    assert.ok(rows.some(r => r.username === 'eng' && r.t === 'switch_denied' && r.n === 'system.db'), '被拒絕的 system.db 也要留下紀錄');
    assert.ok(rows.some(r => r.username === 'intern' && r.t === 'switch_denied' && r.n === 'later_new.db'));
    const perm = sys("SELECT new_value AS v FROM audit_log WHERE action_type = 'update' AND resource_type = 'account_permission' AND resource_name = 'eng' ORDER BY id DESC LIMIT 1")[0];
    assert.equal(JSON.parse(perm.v).allDatabases, true);
  });

  await t.test('取消「全部」：既有登入立即失效，重新登入後只剩清單內的資料庫', async () => {
    assert.equal((await setPerm('eng', { roleLevel: 'engineer', allowedDatabases: ['cust_a.db'] })).status, 200);
    assert.equal((await eng.get('/api/databases')).status, 401, '舊登入已被踢出');
    const again = makeClient(srv.base, `192.0.2.${ipSeq++}`);
    assert.equal((await again.post('/api/auth/login', { username: 'eng', password: newPw })).status, 200);
    assert.deepEqual(names(await again.get('/api/databases')), ['cust_a.db']);
    assert.equal(sys("SELECT allowed_databases AS a FROM accounts WHERE username = 'eng'")[0].a, '["cust_a.db"]');
  });
});
