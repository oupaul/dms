'use strict';
/**
 * NAS（bash）與 AD（PowerShell）腳本產生器（public/js/script-builders.js）：
 *  - 名稱含 $()、反引號、引號、換行、反斜線時，只能當資料，不可被執行
 *  - bash：真的執行產生的腳本（假的 synogroup／synouser／setfacl 只記錄收到的參數），逐一比對參數
 *  - PowerShell：用真的 pwsh 解析器檢查（沒有 pwsh 就略過這組）
 *  - synouser 參數順序：帳號、密碼、全名
 *  - 沒有群組的資料夾，備援群組名稱與「自動生成群組」同一規則（開頭沒有底線）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const SB = require('../public/js/script-builders');

const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0;

// 不良名稱：每一種都嘗試在被執行時建立一個證據檔
const evil = (dir) => ({
  subst: `a$(touch ${dir}/p1)b`,
  backtick: 'x`touch ' + dir + '/p2`y',
  dq: `q"; touch ${dir}/p3; echo "`,
  sq: `it's'; touch ${dir}/p4; '`,
  newline: `nl\ntouch ${dir}/p5`,
  vars: '$HOME ${VOLUME} $USER',
  backslash: 'back\\slash\\',
  dash: '-leading'
});

function makeFakeBin(dir, log) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const cmd of ['synogroup', 'synouser', 'setfacl']) {
    fs.writeFileSync(path.join(bin, cmd), `#!/bin/bash\n{ printf '%s\\x1f' ${cmd} "$@"; printf '\\x1e'; } >> "${log}"\nexit 0\n`, { mode: 0o755 });
  }
  return bin;
}
const readCalls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\x1e').filter(Boolean).map(r => r.split('\x1f').slice(0, -1)) : []);

test('shq／psq：單引號字串，引號與換行被正確處理', () => {
  assert.equal(SB.shq("it's"), "'it'\\''s'");
  assert.equal(SB.shq('$(x)`y`'), "'$(x)`y`'");
  assert.equal(SB.psq("it's"), "'it''s'");
  assert.equal(SB.psq('a\nb'), "'a b'", 'PowerShell 值壓成單行');
  assert.equal(SB.psq('\u2018x\u2019'), "'\u2018\u2018x\u2019\u2019'", '全形單引號也要重複（PowerShell 把它們當單引號）');
  assert.equal(SB.comment('a\nb\u2028c'), 'a b c');
});

test('備援群組名稱：與自動生成群組同一規則，開頭沒有底線', () => {
  assert.equal(SB.defaultGroupBase({ path: '/share/D0600/Angel', name: 'Angel' }), 'share_D0600_Angel');
  assert.equal(SB.defaultGroupBase({ path: null, name: 'Solo' }), 'Solo');
  assert.equal(SB.defaultGroupBase({ path: 'a\\b', name: 'b' }), 'a_b');
});

for (const nasType of ['synology', 'qnap']) {
  for (const adMode of ['local', 'ad']) {
    test(`NAS（${nasType}／${adMode}）：不良名稱不會被執行，參數原樣傳給指令`, (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dms-sb-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const proofDir = path.join(dir, 'proof'); fs.mkdirSync(proofDir);
      const E = evil(proofDir);
      const volume = path.join(dir, 'vol' + E.subst);          // 磁碟區路徑本身也是不良名稱
      const folders = Object.values(E).map((n, i) => ({ id: i + 1, name: n, path: `/share/${n}` }));
      folders.push({ id: 99, name: 'NoGroup', path: '/share/D0600/NoGroup' });          // 沒有群組 → 備援命名
      const groups = Object.values(E).map((n, i) => ({ id: i + 1, name: n + '_RW' }));
      const permissions = folders.slice(0, -1).map((f, i) => ({ folder_id: f.id, group_id: i + 1, permission_type: 'write' }));
      const users = [{ account: E.subst, name: E.newline, email: E.dq }];
      const nasPath = (f) => f.path.replace(/\\/g, '/');          // 沿用原本行為：路徑中的反斜線一律當成斜線
      for (const f of folders) fs.mkdirSync(path.join(volume, nasPath(f)), { recursive: true });

      const script = SB.buildNasScript({ nasType, adMode, nasIP: E.subst, domain: E.dq.toUpperCase().replace(/[^A-Z0-9]/g, 'X'), volume, tmpPass: E.sq, now: E.newline, folders, permissions, groups, users });
      const file = path.join(dir, 'gen.sh');
      fs.writeFileSync(file, script);

      assert.equal(spawnSync('bash', ['-n', file], { encoding: 'utf8' }).status, 0, 'bash 語法檢查');
      const log = path.join(dir, 'calls.log');
      const run = spawnSync('bash', [file], { encoding: 'utf8', env: { ...process.env, PATH: `${makeFakeBin(dir, log)}:${process.env.PATH}` } });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(fs.readdirSync(proofDir), [], '不良名稱裡的指令不可被執行（沒有任何證據檔）');

      const calls = readCalls(log);
      // ACL：每個群組兩次（-Rm、-Rdm），路徑與群組名稱與原值逐字相同
      const acl = calls.filter(c => c[0] === 'setfacl');
      const expectedGroupArg = (name, perms) => (adMode === 'ad' ? `group:${E.dq.toUpperCase().replace(/[^A-Z0-9]/g, 'X')}\\${name}:${perms}` : `group:${name}:${perms}`);
      for (const f of folders.slice(0, -1)) {
        const g = groups[f.id - 1].name;
        const mine = acl.filter(c => c[3] === `${volume}/${nasPath(f).replace(/^\/+/, '')}`);
        const perms = /[_-]ro$/i.test(g) ? 'r-x' : 'rwx';
        assert.deepEqual(mine.map(c => c.slice(1, 3)), [['-Rm', expectedGroupArg(g, perms)], ['-Rdm', expectedGroupArg(g, perms)]], `ACL：${JSON.stringify(f.name)}`);
      }
      // 沒有群組的資料夾：備援群組名稱沒有開頭底線
      const noGroup = acl.filter(c => c[3] === `${volume}/share/D0600/NoGroup`);
      assert.ok(noGroup.some(c => c[2].includes('share_D0600_NoGroup_RO:r-x')) && noGroup.some(c => c[2].includes('share_D0600_NoGroup_RW:rwx')), '備援群組名稱');
      assert.ok(!acl.some(c => c[2].includes('group:_share') || c[2].includes('\\_share')), '不可有開頭底線的群組名稱');

      if (nasType === 'synology' && adMode === 'local') {
        const users_ = calls.filter(c => c[0] === 'synouser');
        assert.deepEqual(users_, [['synouser', '--add', E.subst, E.sq, E.newline, '0', E.dq, '0']], '參數順序：帳號、密碼、全名、到期、Email、權限');
        const added = calls.filter(c => c[0] === 'synogroup').map(c => c[2]);
        for (const g of groups) assert.ok(added.includes(g.name), `建立群組 ${JSON.stringify(g.name)}`);
        assert.ok(added.includes('share_D0600_NoGroup_RO'));
      }
    });
  }
}

test('NAS：只出現在註解裡的值（IP、時間、臨時密碼、QNAP 帳號與姓名）含換行，也不會讓後面的內容被執行', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dms-sb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const proof = path.join(dir, 'PWNED');
  const nl = `x\ntouch ${proof}`;
  const script = SB.buildNasScript({ nasType: 'qnap', adMode: 'local', nasIP: nl, domain: 'D', volume: path.join(dir, 'v'), tmpPass: nl, now: nl,
    folders: [{ id: 1, name: 'f', path: '/share/f' }], permissions: [], groups: [], users: [{ account: nl, name: nl, email: 'e' }] });
  fs.writeFileSync(path.join(dir, 'g.sh'), script);
  spawnSync('bash', [path.join(dir, 'g.sh')], { encoding: 'utf8' });
  assert.equal(fs.existsSync(proof), false, '註解裡的換行不可讓後面的內容被執行');
});

test('index.html 不再內嵌腳本範本（全部由 script-builders.js 產生）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('/js/script-builders.js'));
  for (const bad of ['New-ADUser -Name "', 'New-ADGroup -Name "', 'Add-ADGroupMember -Identity "', 'synouser --add "', 'synogroup --add "', 'setfacl -Rm "']) {
    assert.ok(!html.includes(bad), `index.html 不應再含有 ${bad}`);
  }
});

// ------------------------------------------------------------ PowerShell（需要 pwsh）
const PS_INSPECT = `
param([string]$File)
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($File, [ref]$tokens, [ref]$errors)
$bad = @()
if ($errors.Count) { $bad += ($errors | ForEach-Object { 'ParseError: ' + $_.Message }) }
$bad += $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -or $n -is [System.Management.Automation.Language.SubExpressionAst] -or $n -is [System.Management.Automation.Language.ScriptBlockExpressionAst] -or $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true) | ForEach-Object { 'Dangerous: ' + $_.GetType().Name + ' ' + $_.Extent.Text }
$bad += $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.VariableExpressionAst] -and $n.VariablePath.UserPath -notin @('true','false') }, $true) | ForEach-Object { 'Variable: ' + $_.Extent.Text }
$cmds = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
  $el = @()
  foreach ($e in $_.CommandElements) {
    if ($e -is [System.Management.Automation.Language.CommandParameterAst]) { $el += ('-' + $e.ParameterName) }
    elseif ($e -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $el += ('S:' + $e.Value + '|' + $e.StringConstantType) }
    elseif ($e -is [System.Management.Automation.Language.ParenExpressionAst]) { $el += 'PAREN' }
    elseif ($e -is [System.Management.Automation.Language.ConstantExpressionAst]) { $el += ('C:' + $e.Value) }
    else { $el += ('OTHER:' + $e.GetType().Name) }
  }
  ,$el
}
[pscustomobject]@{ bad = @($bad); cmds = @($cmds) } | ConvertTo-Json -Depth 6 -Compress
`;

function inspectPs(dir, script) {
  const file = path.join(dir, 'gen.ps1');
  fs.writeFileSync(file, script);
  const insp = path.join(dir, 'inspect.ps1');
  fs.writeFileSync(insp, PS_INSPECT);
  const r = spawnSync('pwsh', ['-NoProfile', '-File', insp, '-File', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout);
  return { bad: [].concat(out.bad || []), cmds: [].concat(out.cmds || []).map(c => [].concat(c)) };
}
const param = (cmd, name) => { const i = cmd.indexOf('-' + name); return i < 0 ? undefined : cmd[i + 1]; };
const strVal = (el) => { assert.match(el, /^S:/); assert.match(el, /\|SingleQuoted$/, '一定要是單引號字串'); return el.slice(2, el.lastIndexOf('|')); };

test('PowerShell：不良名稱只會是單引號字串，沒有任何可展開或可執行的結構', { skip: !hasPwsh && '沒有 pwsh' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dms-ps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const E = evil('/tmp/dms-ps-proof');
  const oneLine = (s) => s.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ');
  const weirdQuotes = 'smart\u2019quote\u2018 and \u201Cdq\u201D';

  const users = [{ id: 1, name: E.subst + E.newline, email: `${E.backtick}@x.com`, description: E.dq, department: E.sq, company: E.vars, title: weirdQuotes, phone: E.backslash }];
  const groups = Object.values(E).map((n, i) => ({ id: i + 1, name: n }));
  const folders = Object.values(E).map((n, i) => ({ id: i + 1, name: n, path: `/share/${n}` }));
  const permissions = folders.map((f, i) => ({ folder_id: f.id, group_id: i + 1, permission_type: 'write' }));

  // New-ADUser
  const u = inspectPs(dir, SB.buildUsersScript(users, E.dq, E.sq));
  assert.deepEqual(u.bad, [], '沒有錯誤、沒有可展開字串／子運算式／變數');
  const nu = u.cmds.find(c => c[0] === 'S:New-ADUser|BareWord');
  assert.ok(nu, '有 New-ADUser 指令');
  assert.equal(strVal(param(nu, 'Name')), oneLine(users[0].name));
  assert.equal(strVal(param(nu, 'SamAccountName')), SB.samOf(users[0]));
  assert.equal(strVal(param(nu, 'Description')), oneLine(E.dq));
  assert.equal(strVal(param(nu, 'Department')), oneLine(E.sq));
  assert.equal(strVal(param(nu, 'Company')), E.vars);
  assert.equal(strVal(param(nu, 'Title')), weirdQuotes);
  assert.equal(strVal(param(nu, 'OfficePhone')), E.backslash);
  assert.equal(strVal(param(nu, 'Path')), oneLine(E.dq));
  const sec = u.cmds.find(c => c[0] === 'S:ConvertTo-SecureString|BareWord');
  assert.equal(strVal(sec[1]), E.sq, '臨時密碼逐字保留（含單引號）');

  // New-ADGroup（含沒有群組的資料夾 → 備援名稱）
  const g = inspectPs(dir, SB.buildGroupsScript({ folders: [...folders, { id: 50, name: 'Lone', path: '/a/Lone' }], groups, permissions, rootOU: E.sq }));
  assert.deepEqual(g.bad, []);
  const names = g.cmds.filter(c => c[0] === 'S:New-ADGroup|BareWord').map(c => strVal(param(c, 'Name')));
  for (const gr of groups) assert.ok(names.includes(oneLine(gr.name)), `群組 ${JSON.stringify(gr.name)}`);
  assert.ok(names.includes('a_Lone_RO') && names.includes('a_Lone_RW'), '備援群組名稱沒有開頭底線');

  // Add-ADGroupMember
  const m = inspectPs(dir, SB.buildMembersScript({
    pairs: [{ folder_id: 1, group_id: 1 }], users: [{ id: 7, name: E.newline, email: `${E.dq}@x.com` }],
    groups, folders, membersByGroup: { 1: [{ id: 7 }] }
  }));
  assert.deepEqual(m.bad, []);
  const add = m.cmds.find(c => c[0] === 'S:Add-ADGroupMember|BareWord');
  assert.equal(strVal(param(add, 'Identity')), oneLine(groups[0].name));
  assert.equal(strVal(param(add, 'Members')), oneLine(E.dq));
});

test('PowerShell：註解裡的名稱含換行也不會讓後面的內容變成指令', { skip: !hasPwsh && '沒有 pwsh' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dms-ps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = inspectPs(dir, SB.buildUsersScript([{ id: 1, name: 'x\nRemove-ADUser -Identity admin\u2028Stop-Computer', email: 'a@b.com' }], 'OU=x\nGet-Process'));
  assert.deepEqual(r.bad, []);
  assert.deepEqual(r.cmds.map(c => c[0]), ['S:Import-Module|BareWord', 'S:New-ADUser|BareWord', 'S:ConvertTo-SecureString|BareWord'], '只有產生器自己寫的三個指令，名稱裡的 Remove-ADUser／Stop-Computer／Get-Process 都不是指令');
});

// ------------------------------------------------------------ 這一輪新增
test('samOf：優先用「帳號」欄位（account_key），沒有才用 Email 前綴，再沒有用姓名', () => {
  assert.equal(SB.samOf({ account_key: ' ann.lee ', email: 'x@y.com' }), 'ann.lee');
  assert.equal(SB.samOf({ account_key: '', email: 'x@y.com' }), 'x');
  assert.equal(SB.samOf({ account_key: null, email: '', name: 'Ann Lee' }), 'annlee');
});

test('samProblem：超過 20 字元、含不允許字元、空白或句點結尾', () => {
  assert.match(SB.samProblem('a'.repeat(21)), /20/);
  for (const bad of ['a/b', 'a\\b', 'a[b', 'a:b', 'a;b', 'a|b', 'a=b', 'a,b', 'a+b', 'a*b', 'a?b', 'a<b', 'a>b', 'a"b']) assert.ok(SB.samProblem(bad), bad);
  assert.ok(SB.samProblem('abc.'));
  assert.equal(SB.samProblem('ann.lee'), null);
  assert.equal(SB.samProblem('a'.repeat(20)), null);
});

test('generatePassword：長度、四種字元、不含引號與反斜線，每次不同', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const p = SB.generatePassword();
    assert.equal(p.length, 16);
    assert.ok(/[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p), p);
    assert.ok(!/['"`\\$ ]/.test(p), '不含引號、反引號、反斜線、$、空白');
    seen.add(p);
  }
  assert.equal(seen.size, 50);
});

test('buildUsersScript：沒給臨時密碼就隨機產生並寫在標頭；帳號用 account_key；有問題的帳號會警示', () => {
  const users = [
    { id: 1, name: 'Ann', email: 'ann.long@x.com', account_key: 'ann' },
    { id: 2, name: 'Bob', email: 'bob@x.com' },
    { id: 3, name: 'Long', email: 'l@x.com', account_key: 'a'.repeat(25) },
    { id: 4, name: 'Dup', email: 'd@x.com', account_key: 'ANN' }
  ];
  const a = SB.buildUsersScript(users, 'OU=x');
  const b = SB.buildUsersScript(users, 'OU=x');
  const pw = (t) => t.match(/^# 臨時密碼: (\S+)（/m)[1];
  assert.notEqual(pw(a), pw(b), '每次生成的臨時密碼不同');
  assert.ok(a.includes(`ConvertTo-SecureString '${pw(a)}'`), '指令使用標頭那組密碼');
  assert.ok(!a.includes('TempPassword123!'), '不再有寫死的密碼');
  assert.ok(a.includes("-SamAccountName 'ann'") && a.includes("-SamAccountName 'bob'"), '帳號欄位優先，沒有才用 Email 前綴');
  assert.ok(!a.includes("-SamAccountName 'ann.long'"));
  assert.match(a, /# ⚠ 帳號 a{25} 超過 20 字元/);
  assert.match(a, /# ⚠ 帳號 ANN 與前面的 Ann 重複/);
  const c = SB.buildUsersScript(users.slice(0, 1), 'OU=x', 'My-Own#Pass9');
  assert.ok(c.includes("ConvertTo-SecureString 'My-Own#Pass9'") && c.includes('# 臨時密碼: My-Own#Pass9'));
});

test('buildMembersScript：群組成員也用帳號欄位', () => {
  const s = SB.buildMembersScript({ pairs: [{ folder_id: 1, group_id: 1 }], users: [{ id: 7, name: 'Ann', email: 'ann.long@x.com', account_key: 'ann' }],
    groups: [{ id: 1, name: 'G' }], folders: [{ id: 1, name: 'F', path: '/F' }], membersByGroup: { 1: [{ id: 7 }] } });
  assert.ok(s.includes("Add-ADGroupMember -Identity 'G' -Members 'ann'"));
});

test('NAS：執行前檢查——沒有 setfacl 或磁碟區不存在，就在改動任何東西之前停止', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dms-sb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  for (const cmd of ['synogroup', 'synouser']) {   // 故意不放 setfacl
    fs.writeFileSync(path.join(bin, cmd), `#!/bin/bash\necho ${cmd} >> "${log}"\n`, { mode: 0o755 });
  }
  const vol = path.join(dir, 'vol'); fs.mkdirSync(path.join(vol, 'share'), { recursive: true });
  const mk = (volume) => SB.buildNasScript({ nasType: 'synology', adMode: 'local', nasIP: 'x', domain: 'D', volume, tmpPass: 't', now: 'n',
    folders: [{ id: 1, name: 'share', path: '/share' }], permissions: [], groups: [], users: [{ account: 'a', name: 'A', email: 'e' }] });

  fs.writeFileSync(path.join(dir, 'a.sh'), mk(vol));
  let r = spawnSync('/bin/bash', [path.join(dir, 'a.sh')], { encoding: 'utf8', env: { PATH: bin } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /找不到 setfacl/);
  assert.equal(fs.existsSync(log), false, '沒有建立任何群組或使用者');

  // 有 setfacl、但磁碟區路徑不存在
  fs.writeFileSync(path.join(bin, 'setfacl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'b.sh'), mk(path.join(dir, 'no-such-volume')));
  r = spawnSync('/bin/bash', [path.join(dir, 'b.sh')], { encoding: 'utf8', env: { PATH: bin } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /找不到磁碟區路徑/);
  assert.equal(fs.existsSync(log), false);

  // 都具備才會往下做
  r = spawnSync('/bin/bash', [path.join(dir, 'a.sh')], { encoding: 'utf8', env: { PATH: bin } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(log));
});

test('NAS 本地帳號：臨時密碼留空就隨機產生，指令與註解用同一組；不再有固定密碼', () => {
  const mk = () => SB.buildNasScript({ nasType: 'synology', adMode: 'local', nasIP: 'x', domain: 'D', volume: '/v', tmpPass: '', now: 'n',
    folders: [{ id: 1, name: 'share', path: '/share' }], permissions: [], groups: [], users: [{ account: 'a', name: 'A', email: 'e' }] });
  const a = mk(); const b = mk();
  const pw = (t) => t.match(/^# 2\. 臨時密碼：(\S+)（/m)[1];
  assert.notEqual(pw(a), pw(b));
  assert.ok(a.includes(`synouser --add 'a' '${pw(a)}' 'A' 0 'e' 0`), '密碼在全名之前，且與註解那組相同');
  assert.ok(!a.includes('TempPass123!'));
});
