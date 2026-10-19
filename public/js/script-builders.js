/**
 * NAS（bash）與 AD（PowerShell）腳本產生器：純函式，不碰 DOM；瀏覽器與 Node 測試共用。
 *
 * 安全原則：腳本最後是由管理員以 root／AD 管理權限執行的，而資料夾、群組、人員名稱都可能來自匯入檔，
 * 所以「資料」只能當資料，不能變成指令：
 *   - bash：所有值一律用單引號（單引號內沒有任何展開；值內的單引號改寫成 '\'' ）
 *   - PowerShell：所有值一律用單引號字串（單引號字串不展開 $()、$變數、反引號；值內的單引號重複兩次，
 *     PowerShell 也把 ‘ ’ ‚ ‛ 當成單引號，所以一併處理）
 *   - 註解：# 到行尾為止，值若含換行，換行後的內容就會變成指令，所以註解裡的值一律壓成單行
 * 這些規則有測試把關（真的用 bash 與 pwsh 執行／解析不良名稱）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScriptBuilders = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 控制字元與各種換行（含 U+0085、U+2028、U+2029）一律換成空白
  const CTRL = new RegExp('[\\u0000-\\u001f\\u007f\\u0085\\u2028\\u2029]+', 'g');
  const oneLine = (s) => String(s == null ? '' : s).replace(CTRL, ' ');

  /** 放進註解的值（壓成單行） */
  const comment = oneLine;

  /** bash 單引號字串。保留原值（包含換行；單引號內的換行是安全的），只移除 NUL。 */
  function shq(s) {
    return `'${String(s == null ? '' : s).replace(/\u0000/g, '').replace(/'/g, `'\\''`)}'`;
  }
  /** 放進註解裡的 bash 引號字串（先壓成單行，避免換行讓註解提早結束） */
  const cshq = (s) => shq(oneLine(s));

  /** PowerShell 單引號字串（單行） */
  function psq(s) {
    return `'${oneLine(s).replace(/['‘’‚‛]/g, (c) => c + c)}'`;
  }

  /**
   * 沒有任何群組的資料夾，備援用的群組名稱基底。
   * 與「自動生成群組」同一規則：資料夾名稱由上到下以底線連接，開頭不留底線
   * （/share/D0600 → share_D0600，不是 _share_D0600）。
   */
  function defaultGroupBase(folder) {
    return String(folder.path || folder.name || '').split(/[\/\\]+/).filter(Boolean).join('_');
  }

  /**
   * AD 登入帳號（DOMAIN\username 的 username）：優先用人員的「帳號」欄位（account_key），
   * 沒有才退回 Email 前綴，再沒有就用姓名去掉空白。
   */
  function samOf(user) {
    const key = user.account_key == null ? '' : String(user.account_key).trim();
    if (key) return key;
    return user.email ? user.email.split('@')[0] : String(user.name || '').replace(/\s+/g, '').toLowerCase();
  }

  // sAMAccountName 的限制：最長 20 字元；不可含 " / \ [ ] : ; | = , + * ? < >；不可以空白開頭／結尾或以句點結尾
  function samProblem(sam) {
    if (sam.length > 20) return `超過 20 字元（${sam.length}）`;
    if (/["\/\\\[\]:;|=,+*?<>]/.test(sam)) return '含有 AD 不允許的字元';
    if (/^\s|\s$|\.$/.test(sam)) return '開頭／結尾是空白或結尾是句點';
    return null;
  }

  /** 隨機臨時密碼：16 字元，大小寫、數字、符號各至少一個，避開容易看錯的字與引號、反斜線 */
  function generatePassword(len = 16) {
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues)
      ? globalThis.crypto : require('crypto').webcrypto;
    const pools = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#%^&*-_+=?'];
    const all = pools.join('');
    const rnd = (n) => {                           // 均勻亂數（拒絕取樣，避免取模偏差）
      const limit = Math.floor(0x100000000 / n) * n;
      const buf = new Uint32Array(1);
      do { c.getRandomValues(buf); } while (buf[0] >= limit);
      return buf[0] % n;
    };
    const out = pools.map(p => p[rnd(p.length)]);
    while (out.length < len) out.push(all[rnd(all.length)]);
    for (let i = out.length - 1; i > 0; i--) { const j = rnd(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
    return out.join('');
  }

  // ============================================================ NAS（bash）
  /**
   * @param {object} o
   * @param {'synology'|'qnap'} o.nasType
   * @param {'ad'|'local'} o.adMode
   * @param {string} o.nasIP @param {string} o.domain @param {string} o.volume @param {string} o.tmpPass @param {string} o.now
   * @param {Array} o.folders      選中的資料夾 {id,name,path}
   * @param {Array} o.permissions  /api/permissions
   * @param {Array} o.groups       /api/groups
   * @param {Array} o.users        本地模式選中的人員 {account,name,email}
   */
  function buildNasScript(o) {
    const { nasType, adMode, nasIP, domain, volume, now } = o;
    const tmpPass = o.tmpPass ? String(o.tmpPass) : generatePassword();   // 沒給就隨機產生（只有本地帳號模式會用到）
    const folders = o.folders || [];
    const selIds = new Set(folders.map(f => f.id));

    // 資料夾 → 群組（從權限表；名稱以 _RO／-RO 結尾或權限類型是 read 都視為唯讀）
    const folderGroupMap = {};
    (o.permissions || []).forEach(p => {
      if (!p.group_id || !p.folder_id || !selIds.has(p.folder_id)) return;
      const grp = (o.groups || []).find(g => g.id === p.group_id);
      if (!grp) return;
      if (!folderGroupMap[p.folder_id]) folderGroupMap[p.folder_id] = [];
      if (!folderGroupMap[p.folder_id].find(g => g.name === grp.name)) {
        folderGroupMap[p.folder_id].push({ name: grp.name, isRO: /[_-]ro$/i.test(grp.name) || p.permission_type === 'read' });
      }
    });
    // 沒有對應群組：用路徑推算 _RO／_RW（與自動生成群組同一規則）
    folders.forEach(f => {
      if (!folderGroupMap[f.id] || folderGroupMap[f.id].length === 0) {
        const base = defaultGroupBase(f);
        folderGroupMap[f.id] = [{ name: `${base}_RO`, isRO: true }, { name: `${base}_RW`, isRO: false }];
      }
    });

    const users = adMode === 'local' ? (o.users || []) : [];
    const nasTypeName = nasType === 'synology' ? 'Synology DSM' : 'QNAP QTS';
    const adModeLabel = adMode === 'ad' ? '已加入 AD 網域' : '本地帳號';
    let s = '';

    s += `#!/bin/bash\n`;
    s += `# ${'='.repeat(60)}\n`;
    s += `# NAS 腳本生成 — ${nasTypeName}（${adModeLabel}）\n`;
    s += `# NAS IP   : ${comment(nasIP)}\n`;
    if (adMode === 'ad') s += `# AD 網域  : ${comment(domain)}\n`;
    s += `# Volume   : ${comment(volume)}\n`;
    s += `# 生成時間 : ${comment(now)}\n`;
    s += `# 執行方式 : sudo bash this_script.sh\n`;
    s += `# ${'='.repeat(60)}\n\n`;
    s += `set -e  # 遇到錯誤時停止執行\n`;
    s += `VOLUME=${shq(volume)}\n`;
    if (adMode === 'ad') s += `DOMAIN=${shq(domain)}\n`;
    s += `\n`;
    // 執行前檢查：在改動任何東西（建立群組／帳號、設定 ACL）之前，確認這台 NAS 真的能執行這份腳本
    s += `command -v setfacl >/dev/null 2>&1 || { echo ${shq('✗ 找不到 setfacl：這台 NAS 不支援此腳本設定 ACL 的方式（Synology DSM 通常要改用 synoacltool）。尚未做任何變更。')} >&2; exit 1; }\n`;
    s += `[ -d "\${VOLUME}" ] || { echo ${shq('✗ 找不到磁碟區路徑，尚未做任何變更：')} "\${VOLUME}" >&2; exit 1; }\n\n`;

    if (adMode === 'local') {
      const allGroups = new Set();
      folders.forEach(f => (folderGroupMap[f.id] || []).forEach(g => allGroups.add(g.name)));

      if (allGroups.size > 0) {
        s += `echo "=== 建立本地群組 ==="\n`;
        allGroups.forEach(gname => {
          if (nasType === 'synology') {
            s += `synogroup --add ${shq(gname)} 2>/dev/null && echo ${shq('  ✔ 群組建立: ' + gname)} || echo ${shq('  ⚠ 群組已存在: ' + gname)}\n`;
          } else {
            s += `# QNAP: 請透過 QTS 管理介面或 API 建立群組 ${cshq(gname)}\n`;
            s += `# /sbin/qgroup.sh -a ${cshq(gname)} 2>/dev/null || true\n`;
          }
        });
        s += `\n`;
      }

      if (users.length > 0) {
        s += `echo "=== 建立本地使用者 ==="\n`;
        users.forEach(u => {
          if (nasType === 'synology') {
            // synouser --add <帳號> <密碼> <全名> <是否到期> <Email> <應用程式權限>（密碼在全名之前）
            s += `synouser --add ${shq(u.account)} ${shq(tmpPass)} ${shq(u.name)} 0 ${shq(u.email)} 0 2>/dev/null && echo ${shq('  ✔ 使用者建立: ' + u.account)} || echo ${shq('  ⚠ 使用者已存在: ' + u.account)}\n`;
          } else {
            s += `# QNAP: 請透過 QTS 管理介面建立使用者 ${cshq(u.account)} (${comment(u.name)})\n`;
          }
        });
        s += `\n`;
      }

      if (nasType === 'synology' && users.length > 0) {
        s += `echo "=== 加入群組成員（請依實際需求調整 _RO/_RW）==="\n`;
        s += `# 以下將所有選中人員加入各資料夾的 _RO 群組（唯讀）\n`;
        s += `# 如需 _RW（讀寫）存取，請手動調整或複製對應指令\n`;
        folders.forEach(f => {
          const groups = folderGroupMap[f.id] || [];
          const ro = groups.find(g => g.isRO);
          const rw = groups.find(g => !g.isRO);
          if (ro) users.forEach(u => { s += `# synogroup --memberadd ${cshq(ro.name)} ${cshq(u.account)}  # 唯讀\n`; });
          if (rw) users.forEach(u => { s += `# synogroup --memberadd ${cshq(rw.name)} ${cshq(u.account)}  # 讀寫（取消 # 啟用）\n`; });
        });
        s += `\n`;
      }
    }

    s += `echo "=== 設定資料夾 ACL ==="\n`;
    const adPrefix = "'group:'\"${DOMAIN}\"'\\'";    // 'group:'"${DOMAIN}"'\'  → group:DOMAIN\
    folders.forEach(f => {
      const folderPath = (f.path || f.name).replace(/\\/g, '/');
      const pathExpr = `"\${VOLUME}"${shq('/' + folderPath.replace(/^\/+/, ''))}`;     // "${VOLUME}"'/share/x'（開頭的斜線只留一個）
      const groups = folderGroupMap[f.id] || [];

      s += `\n# 資料夾: ${comment(folderPath)}\n`;
      s += `if [ -d ${pathExpr} ]; then\n`;
      groups.forEach(g => {
        const perms = g.isRO ? 'r-x' : 'rwx';
        const permLabel = g.isRO ? '唯讀 (RO)' : '讀寫 (RW)';
        const groupArg = adMode === 'ad' ? adPrefix + shq(g.name) + shq(':' + perms) : shq('group:' + g.name + ':' + perms);
        s += `    # ${comment(g.name)} — ${permLabel}\n`;
        s += `    setfacl -Rm ${groupArg} ${pathExpr}\n`;
        s += `    setfacl -Rdm ${groupArg} ${pathExpr}\n`;
      });
      s += `    echo ${shq('  ✔ ACL 設定完成: ' + folderPath)}\n`;
      s += `else\n`;
      s += `    echo ${shq('  ✗ 資料夾不存在，略過:')} ${pathExpr}\n`;
      s += `fi\n`;
    });

    s += `\necho ""\necho "✅ 腳本執行完成！"\n`;

    if (adMode === 'ad') {
      s += `\n# ────────────────────────────────────────────────────────\n`;
      s += `# 注意事項：\n`;
      s += `# 1. 請確認 NAS 已正確加入 AD 網域\n`;
      s += `# 2. AD 群組格式因 NAS 版本可能有差異（DOMAIN\\Group 或 DOMAIN+Group）\n`;
      s += `#    若 setfacl 失敗，請改用 NAS 管理介面手動設定\n`;
      s += `# 3. 建議先在單一資料夾測試後再批次執行\n`;
      if (nasType === 'synology') {
        s += `# 4. Synology 亦可用 synoaclset 指令（DSM 7+ 支援較好）\n`;
        s += `#    synoaclset -name "ShareName/SubPath" -user "DOMAIN\\\\Group" -acl "r--" -group\n`;
      }
    } else {
      s += `\n# ────────────────────────────────────────────────────────\n`;
      s += `# 注意事項：\n`;
      s += `# 1. 群組成員指令已用 # 標示，請依需求取消註解後執行\n`;
      s += `# 2. 臨時密碼：${comment(tmpPass)}（請要求使用者首次登入後立即更改）\n`;
      s += `# 3. 建議先確認 Volume 路徑正確（ls \${VOLUME}）\n`;
    }
    return s;
  }

  // ============================================================ AD（PowerShell）
  /**
   * New-ADUser。tempPassword 沒給（或是空字串）就自動產生一組隨機密碼，寫在標頭註解裡；
   * 所有新使用者共用同一組，且一律 -ChangePasswordAtLogon（首次登入必須變更）。
   */
  function buildUsersScript(users, ouPath, tempPassword) {
    const password = tempPassword ? String(tempPassword) : generatePassword();
    let s = '# 產生 AD 使用者的 PowerShell 語法\n';
    s += `# 共 ${users.length} 位人員\n`;
    s += `# OU 路徑: ${comment(ouPath)}\n`;
    s += `# 臨時密碼: ${comment(password)}（所有新使用者相同；首次登入必須變更，請用安全的方式轉交，並在建立後刪除這份語法）\n`;
    s += '# 登入帳號（SamAccountName）：優先使用人員的「帳號」欄位，沒有才用 Email 前綴\n';
    s += '# 注意：如果使用者已存在，會出現錯誤，請先檢查或使用 -ErrorAction SilentlyContinue\n\n';
    s += '# 匯入 ActiveDirectory 模組（如果尚未匯入）\n';
    s += 'Import-Module ActiveDirectory -ErrorAction SilentlyContinue\n\n';

    const seen = new Map();
    users.forEach(user => {
      const sam = samOf(user);
      const displayName = user.name || sam;
      const email = user.email || `${sam}@yourdomain.com`;
      const problem = samProblem(sam);
      const dupOf = seen.get(sam.toLowerCase());
      seen.set(sam.toLowerCase(), displayName);
      if (problem) s += `# ⚠ 帳號 ${comment(sam)} ${problem}，下一行會執行失敗，請先修正人員的「帳號」欄位\n`;
      if (dupOf !== undefined) s += `# ⚠ 帳號 ${comment(sam)} 與前面的 ${comment(dupOf)} 重複，下一行會執行失敗\n`;
      let cmd = `New-ADUser -Name ${psq(displayName)} -SamAccountName ${psq(sam)} -UserPrincipalName ${psq(email)} -DisplayName ${psq(displayName)} -EmailAddress ${psq(email)}`;
      if (user.description) cmd += ` -Description ${psq(user.description)}`;
      if (user.department) cmd += ` -Department ${psq(user.department)}`;
      if (user.company) cmd += ` -Company ${psq(user.company)}`;
      if (user.title) cmd += ` -Title ${psq(user.title)}`;
      if (user.phone) cmd += ` -OfficePhone ${psq(user.phone)}`;
      cmd += ` -Path ${psq(ouPath)} -Enabled $true -AccountPassword (ConvertTo-SecureString ${psq(password)} -AsPlainText -Force) -ChangePasswordAtLogon $true`;
      s += `# 建立使用者: ${comment(displayName)}\n`;
      s += cmd + '\n\n';
    });
    return s;
  }

  /** New-ADGroup。folders：選中的資料夾；permissions／groups 用來找出資料夾對應的群組 */
  function buildGroupsScript({ folders, groups, permissions, rootOU }) {
    const groupById = new Map((groups || []).map(g => [g.id, g]));
    const folderGroups = new Map();
    (permissions || []).forEach(p => {
      if (!p.group_id || !p.folder_id) return;
      if (!folderGroups.has(p.folder_id)) folderGroups.set(p.folder_id, []);
      if (!folderGroups.get(p.folder_id).includes(p.group_id)) folderGroups.get(p.folder_id).push(p.group_id);
    });

    let s = '# 產生 AD 群組（Group）的 PowerShell 語法\n';
    s += `# 共 ${folders.length} 個資料夾\n`;
    s += `# 群組路徑: ${comment(rootOU)}\n\n`;
    s += '# 匯入 ActiveDirectory 模組（如果尚未匯入）\n';
    s += 'Import-Module ActiveDirectory -ErrorAction SilentlyContinue\n\n';

    const toCreate = new Map();   // 群組名稱 → 第一個對應的資料夾
    folders.forEach(folder => {
      const ids = folderGroups.get(folder.id) || [];
      if (ids.length > 0) {
        ids.forEach(id => {
          const g = groupById.get(id);
          if (g && !toCreate.has(g.name)) toCreate.set(g.name, folder);
        });
      } else {
        const base = defaultGroupBase(folder);
        ['RO', 'RW'].forEach(suffix => {
          const name = `${base}_${suffix}`;
          if (!toCreate.has(name)) toCreate.set(name, folder);
        });
      }
    });

    toCreate.forEach((folder, name) => {
      s += `# 建立群組: ${comment(name)} (對應資料夾: ${comment(folder.name)})\n`;
      s += `New-ADGroup -Name ${psq(name)} -GroupScope Global -GroupCategory Security -Path ${psq(rootOU)} -Description ${psq('資料夾: ' + (folder.path || folder.name))}\n\n`;
    });
    if (toCreate.size === 0) s += '# 沒有找到需要建立的群組\n';
    return s;
  }

  /**
   * Add-ADGroupMember。
   * pairs：選中的 {folder_id, group_id}；membersByGroup：{ [groupId]: [{id}] }（群組成員）
   */
  function buildMembersScript({ pairs, users, groups, folders, membersByGroup }) {
    const userById = new Map((users || []).map(u => [u.id, u]));
    const groupById = new Map((groups || []).map(g => [g.id, g]));
    const folderById = new Map((folders || []).map(f => [Number(f.id), f]));

    let s = '# 產生將人員加入 AD 群組的 PowerShell 語法\n';
    s += `# 共 ${pairs.length} 個資料夾-群組組合\n`;
    s += '# 請根據實際環境調整 Domain 和群組名稱格式\n\n';
    s += '# 匯入 ActiveDirectory 模組（如果尚未匯入）\n';
    s += 'Import-Module ActiveDirectory -ErrorAction SilentlyContinue\n\n';

    const byFolder = new Map();
    pairs.forEach(p => {
      if (!byFolder.has(p.folder_id)) byFolder.set(p.folder_id, []);
      byFolder.get(p.folder_id).push(p.group_id);
    });

    const done = new Set();
    byFolder.forEach((groupIds, folderId) => {
      const folder = folderById.get(Number(folderId));
      const folderPath = folder ? (folder.path || folder.name) : '未知資料夾';
      let has = false;
      groupIds.forEach(groupId => {
        const group = groupById.get(groupId);
        if (!group) return;
        const members = (membersByGroup && membersByGroup[groupId]) || [];
        if (members.length === 0) return;
        if (!has) { s += `# ========== 資料夾: ${comment(folderPath)} ==========\n`; has = true; }
        s += `\n# 群組: ${comment(group.name)}\n`;
        members.forEach(m => {
          const user = userById.get(m.id);
          if (!user) return;
          const key = `${groupId}-${m.id}`;
          if (done.has(key)) {
            s += `# 將使用者 ${comment(user.name)} 加入群組 ${comment(group.name)} (已在其他資料夾中處理)\n`;
            return;
          }
          done.add(key);
          s += `Add-ADGroupMember -Identity ${psq(group.name)} -Members ${psq(samOf(user))}\n`;
        });
      });
      if (has) s += '\n';
    });
    if (done.size === 0) s += '# 目前選中的資料夾群組組合沒有成員資料。\n';
    return s;
  }

  return { buildNasScript, buildUsersScript, buildGroupsScript, buildMembersScript, shq, psq, comment, defaultGroupBase, samOf, samProblem, generatePassword };
});
