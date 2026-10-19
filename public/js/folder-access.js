/**
 * 資料夾「目前套用的群組」計算（純函式，不碰 DOM；瀏覽器與 Node 測試共用）。
 *
 * 為什麼要看「繼承自上層」：
 *   DMS 只是登記權限；真正生效的是 NAS 腳本產生器輸出的 `setfacl -Rm`（遞迴套用到所有子資料夾與現有檔案）
 *   加 `setfacl -Rdm`（預設 ACL，之後新增的子項目也繼承）。所以在上層資料夾登記的群組，
 *   實際上對其下所有子資料夾都有效，即使子資料夾本身沒有任何登記。
 *   這裡的計算只反映「DMS 登記的意圖」，不是檔案伺服器的現況。
 *
 * 類型衝突：同一群組在不同層級的類型不同（例如上層 write、本層 read）時，
 *   `setfacl -m` 是「覆寫該群組的項目」，最後的結果取決於腳本套用的先後順序，DMS 無法得知。
 *   所以這裡不去猜，標成 conflict 並列出各層的設定，由使用者判斷。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FolderAccess = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TYPE_ALIASES = { read: 'read', ro: 'read', r: 'read', write: 'write', rw: 'write', w: 'write' };

  // 'RO'／'rw' 等舊資料也能辨識；認不得的原樣保留（會顯示出來，不會被吞掉）
  function normalizeType(t) {
    const k = String(t == null ? '' : t).trim().toLowerCase();
    return TYPE_ALIASES[k] || (k || 'unknown');
  }

  // 從根到「父層」的祖先清單（不含自己）；有循環或父層不存在就在該處停止，不會無限迴圈
  function ancestorsOf(folderId, byId) {
    const chain = [];
    const seen = new Set([Number(folderId)]);
    let cur = byId.get(Number(folderId));
    while (cur && cur.parent_id != null && cur.parent_id !== '') {
      const pid = Number(cur.parent_id);
      if (!Number.isFinite(pid) || seen.has(pid)) break;
      seen.add(pid);
      const parent = byId.get(pid);
      if (!parent) break;
      chain.unshift(parent);
      cur = parent;
    }
    return chain;
  }

  // 不一致最需要注意，排最前面；其次寫入、唯讀
const typeRank = (t) => (t === 'conflict' ? -1 : t === 'write' ? 0 : t === 'read' ? 1 : 2);
  const byTypeThenName = (a, b) => typeRank(a.type) - typeRank(b.type) || String(a.name).localeCompare(String(b.name), 'zh-Hant');

  /**
   * 彙整同一對象在各層的設定。entries：[{ level: 'own'|'inherited', folder:{id,path}, type, ...}]
   * 回傳 { type: 'read'|'write'|'conflict'|..., sources:[...] }
   */
  function mergeTypes(entries) {
    const types = new Set(entries.map(e => e.type));
    return { type: types.size === 1 ? [...types][0] : 'conflict', sources: entries };
  }

  /**
   * @param {object} p
   * @param {number} p.folderId
   * @param {Array}  p.folders      /api/folders：{id,name,parent_id,path}
   * @param {Array}  p.permissions  /api/permissions：{id,folder_id,user_id,group_id,permission_type,group_name,user_name}
   * @param {Object} [p.memberCounts] { [groupId]: 人數 }
   */
  function compute({ folderId, folders, permissions, memberCounts = {} }) {
    const byId = new Map((folders || []).map(f => [Number(f.id), f]));
    const folder = byId.get(Number(folderId));
    if (!folder) return null;

    const ancestors = ancestorsOf(folder.id, byId);                 // 根 → 父層
    const chain = [folder, ...ancestors.slice().reverse()];         // 本層優先，然後由近到遠

    const permsByFolder = new Map();
    for (const p of permissions || []) {
      const k = Number(p.folder_id);
      if (!permsByFolder.has(k)) permsByFolder.set(k, []);
      permsByFolder.get(k).push(p);
    }
    const folderLabel = (f) => f.path || f.name || `#${f.id}`;

    // 依層級整理（供「本層設定」與「繼承自上層」兩塊直接顯示）
    const levels = chain.map((f, i) => {
      const rows = permsByFolder.get(Number(f.id)) || [];
      const groups = [];
      const users = [];
      for (const p of rows) {
        const type = normalizeType(p.permission_type);
        if (p.group_id != null && p.group_id !== '') {
          groups.push({
            permissionId: p.id, groupId: Number(p.group_id), type,
            name: p.group_name != null ? p.group_name : `（已刪除的群組 #${p.group_id}）`,
            missing: p.group_name == null, memberCount: memberCounts[p.group_id]
          });
        } else if (p.user_id != null && p.user_id !== '') {
          users.push({
            permissionId: p.id, userId: Number(p.user_id), type,
            name: p.user_name != null ? p.user_name : `（已刪除的人員 #${p.user_id}）`, missing: p.user_name == null
          });
        }
      }
      groups.sort(byTypeThenName);
      users.sort(byTypeThenName);
      return { own: i === 0, folder: { id: f.id, path: folderLabel(f) }, groups, users };
    });

    const own = levels[0];
    const inherited = levels.slice(1).filter(l => l.groups.length || l.users.length);

    // 實際有權限的對象 = 本層 + 所有祖先（去重）
    const groupMap = new Map();
    const userMap = new Map();
    for (const lv of levels) {
      for (const g of lv.groups) {
        if (!groupMap.has(g.groupId)) groupMap.set(g.groupId, { groupId: g.groupId, name: g.name, missing: g.missing, memberCount: g.memberCount, entries: [] });
        groupMap.get(g.groupId).entries.push({ level: lv.own ? 'own' : 'inherited', folder: lv.folder, type: g.type });
      }
      for (const u of lv.users) {
        if (!userMap.has(u.userId)) userMap.set(u.userId, { userId: u.userId, name: u.name, missing: u.missing, entries: [] });
        userMap.get(u.userId).entries.push({ level: lv.own ? 'own' : 'inherited', folder: lv.folder, type: u.type });
      }
    }
    const effectiveGroups = [...groupMap.values()].map(g => ({ ...g, ...mergeTypes(g.entries) })).sort(byTypeThenName);
    const effectiveUsers = [...userMap.values()].map(u => ({ ...u, ...mergeTypes(u.entries) })).sort(byTypeThenName);

    // 提醒
    const warnings = [];
    const describe = (entries) => entries.map(e => `${e.level === 'own' ? '本層' : folderLabel(e.folder).split('/').slice(-1)[0] || e.folder.path}=${e.type}`).join('、');
    for (const g of effectiveGroups) {
      if (g.type === 'conflict') {
        warnings.push({ code: 'type_conflict', level: 'warn', subject: g.name,
          text: `群組「${g.name}」在不同層級的類型不一致（${describe(g.entries)}）。NAS 腳本以「最後套用」的為準，實際結果取決於套用順序。` });
      } else if (g.entries.length > 1 && g.entries.some(e => e.level === 'own')) {
        const ownCount = g.entries.filter(e => e.level === 'own').length;
        warnings.push({ code: ownCount > 1 ? 'duplicate' : 'redundant', level: 'info', subject: g.name,
          text: ownCount > 1
            ? `群組「${g.name}」在本層登記了 ${ownCount} 筆相同的權限（重複，可刪除多餘的）。`
            : `群組「${g.name}」在上層已有相同的權限（${g.type}），本層的登記是重複的。` });
      }
      if (g.missing) warnings.push({ code: 'missing_target', level: 'warn', subject: g.name, text: `${g.name} 已不存在，這筆權限是孤兒紀錄。` });
    }
    for (const u of effectiveUsers) {
      if (u.type === 'conflict') {
        warnings.push({ code: 'type_conflict', level: 'warn', subject: u.name,
          text: `人員「${u.name}」在不同層級的類型不一致（${describe(u.entries)}）。` });
      }
      if (u.missing) warnings.push({ code: 'missing_target', level: 'warn', subject: u.name, text: `${u.name} 已不存在，這筆權限是孤兒紀錄。` });
    }
    if (!effectiveGroups.length && !effectiveUsers.length) {
      warnings.push({ code: 'no_access', level: 'info', subject: '', text: '這個資料夾與其所有上層都沒有登記任何權限。' });
    }

    return {
      folder: { id: folder.id, name: folder.name, path: folderLabel(folder) },
      ancestors: ancestors.map(a => ({ id: a.id, path: folderLabel(a) })),
      own: { groups: own.groups, users: own.users },
      inherited,
      effectiveGroups,
      effectiveUsers,
      warnings
    };
  }

  return { compute, normalizeType, ancestorsOf };
});
