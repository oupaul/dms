'use strict';
/**
 * 資料夾權限卡片的計算（public/js/folder-access.js）：本層設定、繼承自上層、類型衝突、重複、孤兒、循環。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const FA = require('../public/js/folder-access');

const folders = [
  { id: 1, name: 'share', parent_id: null, path: '/share' },
  { id: 2, name: 'D0600', parent_id: 1, path: '/share/D0600' },
  { id: 3, name: 'Angel', parent_id: 2, path: '/share/D0600/Angel' },
  { id: 4, name: 'Other', parent_id: 1, path: '/share/Other' }
];
const perm = (id, folder_id, group_id, type, group_name, extra = {}) =>
  ({ id, folder_id, user_id: null, group_id, permission_type: type, group_name, user_name: null, ...extra });
const userPerm = (id, folder_id, user_id, type, user_name) =>
  ({ id, folder_id, user_id, group_id: null, permission_type: type, group_name: null, user_name });

test('本層設定與繼承自上層分開，並合併成「實際有權限」', () => {
  const permissions = [
    perm(1, 1, 10, 'read', 'All_RO'),          // 最上層
    perm(2, 2, 11, 'write', 'Mfg_RW'),         // 中間層
    perm(3, 3, 12, 'write', 'Angel_RW')        // 本層
  ];
  const r = FA.compute({ folderId: 3, folders, permissions, memberCounts: { 12: 5, 11: 20 } });
  assert.deepEqual(r.own.groups.map(g => g.name), ['Angel_RW']);
  assert.equal(r.own.groups[0].memberCount, 5);
  assert.deepEqual(r.inherited.map(l => l.folder.path), ['/share/D0600', '/share'], '由近到遠');
  assert.deepEqual(r.inherited[0].groups.map(g => g.name), ['Mfg_RW']);
  assert.deepEqual(r.effectiveGroups.map(g => `${g.name}:${g.type}`), ['Angel_RW:write', 'Mfg_RW:write', 'All_RO:read'], 'write 在前');
  assert.deepEqual(r.ancestors.map(a => a.path), ['/share', '/share/D0600']);
  assert.equal(r.warnings.length, 0);
});

test('子資料夾本身沒有登記時，仍看得到上層來的群組（不會誤判成沒人能進）', () => {
  const r = FA.compute({ folderId: 3, folders, permissions: [perm(1, 1, 10, 'write', 'All_RW')] });
  assert.equal(r.own.groups.length, 0);
  assert.deepEqual(r.effectiveGroups.map(g => g.name), ['All_RW']);
  assert.ok(!r.warnings.some(w => w.code === 'no_access'));
});

test('整條路徑都沒有登記 → 提示', () => {
  const r = FA.compute({ folderId: 4, folders, permissions: [perm(1, 3, 10, 'read', 'X')] });
  assert.deepEqual(r.warnings.map(w => w.code), ['no_access'], '別的分支的權限不算');
});

test('同一群組在不同層級類型不同 → conflict，不自行猜測結果', () => {
  const r = FA.compute({ folderId: 3, folders, permissions: [perm(1, 2, 10, 'write', 'Team'), perm(2, 3, 10, 'read', 'Team')] });
  const g = r.effectiveGroups[0];
  assert.equal(g.type, 'conflict');
  assert.equal(g.sources.length, 2);
  const w = r.warnings.find(x => x.code === 'type_conflict');
  assert.ok(w && /最後套用/.test(w.text) && /本層=read/.test(w.text));
});

test('本層與上層登記了相同權限 → 冗餘提示；本層重複登記 → 重複提示', () => {
  const red = FA.compute({ folderId: 3, folders, permissions: [perm(1, 2, 10, 'read', 'Team'), perm(2, 3, 10, 'read', 'Team')] });
  assert.equal(red.effectiveGroups[0].type, 'read');
  assert.deepEqual(red.warnings.map(w => w.code), ['redundant']);
  const dup = FA.compute({ folderId: 3, folders, permissions: [perm(1, 3, 10, 'read', 'Team'), perm(2, 3, 10, 'read', 'Team')] });
  assert.deepEqual(dup.warnings.map(w => w.code), ['duplicate']);
});

test('兩個上層都有相同群組、本層沒有 → 不需要提醒', () => {
  const r = FA.compute({ folderId: 3, folders, permissions: [perm(1, 1, 10, 'read', 'Team'), perm(2, 2, 10, 'read', 'Team')] });
  assert.equal(r.warnings.length, 0);
});

test('個人權限：與群組分開顯示，同樣會繼承', () => {
  const r = FA.compute({ folderId: 3, folders, permissions: [userPerm(1, 1, 7, 'write', '王小明'), userPerm(2, 3, 8, 'read', '李小華')] });
  assert.deepEqual(r.own.users.map(u => u.name), ['李小華']);
  assert.deepEqual(r.effectiveUsers.map(u => `${u.name}:${u.type}`), ['王小明:write', '李小華:read']);
});

test('舊資料的類型寫法（RO／RW、大小寫）也能辨識；認不得的原樣顯示', () => {
  assert.equal(FA.normalizeType('RW'), 'write');
  assert.equal(FA.normalizeType(' ro '), 'read');
  assert.equal(FA.normalizeType('admin'), 'admin');
  assert.equal(FA.normalizeType(null), 'unknown');
  const r = FA.compute({ folderId: 1, folders, permissions: [perm(1, 1, 10, 'RW', 'Team')] });
  assert.equal(r.own.groups[0].type, 'write');
});

test('指向已刪除群組／人員的孤兒權限：標示出來而不是顯示 null', () => {
  const r = FA.compute({ folderId: 1, folders, permissions: [perm(1, 1, 99, 'read', null), userPerm(2, 1, 98, 'read', null)] });
  assert.match(r.own.groups[0].name, /已刪除的群組 #99/);
  assert.match(r.own.users[0].name, /已刪除的人員 #98/);
  assert.equal(r.warnings.filter(w => w.code === 'missing_target').length, 2);
});

test('資料夾階層有循環或父層不存在：不會無限迴圈', () => {
  const cyc = [
    { id: 1, name: 'A', parent_id: 2, path: '/A' },
    { id: 2, name: 'B', parent_id: 1, path: '/B' },
    { id: 3, name: 'C', parent_id: 99, path: '/C' }
  ];
  const r = FA.compute({ folderId: 1, folders: cyc, permissions: [] });
  assert.ok(r.ancestors.length <= 2);
  assert.deepEqual(FA.compute({ folderId: 3, folders: cyc, permissions: [] }).ancestors, []);
  assert.equal(FA.compute({ folderId: 404, folders: cyc, permissions: [] }), null, '不存在的資料夾回傳 null');
});

test('parent_id 是字串（資料庫舊資料）也能對上', () => {
  const f = [{ id: 1, name: 'a', parent_id: '', path: '/a' }, { id: 2, name: 'b', parent_id: '1', path: '/a/b' }];
  const r = FA.compute({ folderId: 2, folders: f, permissions: [perm(1, 1, 10, 'read', 'T')] });
  assert.deepEqual(r.effectiveGroups.map(g => g.name), ['T']);
});

test('排序：不一致排最前，其次寫入，再唯讀', () => {
  const r = FA.compute({ folderId: 3, folders, permissions: [
    perm(1, 1, 10, 'read', 'A_RO'), perm(2, 2, 11, 'write', 'B_RW'),
    perm(3, 2, 12, 'write', 'C'), perm(4, 3, 12, 'read', 'C')
  ] });
  assert.deepEqual(r.effectiveGroups.map(g => `${g.name}:${g.type}`), ['C:conflict', 'B_RW:write', 'A_RO:read']);
});
