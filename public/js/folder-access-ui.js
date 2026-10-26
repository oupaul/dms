/**
 * 資料夾管理（階層樹）的「權限卡片」：點資料夾名稱 → 右側浮動卡片顯示目前套用的群組。
 *
 * - 資料來源是現有的 /api/permissions、/api/groups（含 member_count）、/api/groups/:id/users，不需要新的 API
 * - 計算邏輯在 folder-access.js（可單獨測試）；這裡只負責取資料與畫畫面
 * - 所有使用者資料（資料夾／群組／人員名稱）一律用 textContent 寫入，不拼 HTML，避免名稱含標籤時被執行
 * - 資料以記憶體快取（30 秒），任何寫入類請求（POST／PUT／DELETE）成功後自動失效
 */
(function () {
  'use strict';

  const TTL_MS = 30000;
  const MEMBER_LIMIT = 50;
  let getFolders = () => [];
  let cache = null;
  let inflight = null;
  const memberCache = new Map();
  let selectedId = null;
  let renderSeq = 0;
  let refreshTimer = null;

  const card = () => document.getElementById('folder-access-card');
  const layout = () => document.getElementById('folder-layout');

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function icon(name) { return el('i', `bi bi-${name}`); }

  const TYPE_LABEL = { write: '寫入', read: '唯讀', conflict: '不一致' };
  function typeBadge(type) {
    const b = el('span', `fa-type fa-type-${TYPE_LABEL[type] ? type : 'other'}`);
    b.appendChild(icon(type === 'write' ? 'pencil-square' : type === 'read' ? 'eye' : 'exclamation-triangle'));
    b.appendChild(document.createTextNode(' ' + (TYPE_LABEL[type] || String(type))));
    return b;
  }

  // ------------------------------------------------------------ 資料
  function invalidate() { cache = null; memberCache.clear(); }

  function loadSupport() {
    if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache);
    if (inflight) return inflight;
    inflight = Promise.all([$.getJSON('/api/permissions'), $.getJSON('/api/groups')])
      .then(([permissions, groups]) => {
        const memberCounts = {};
        (groups || []).forEach(g => { memberCounts[g.id] = g.member_count; });
        cache = { at: Date.now(), permissions: permissions || [], memberCounts };
        return cache;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  function loadMembers(groupId) {
    if (!memberCache.has(groupId)) memberCache.set(groupId, Promise.resolve($.getJSON(`/api/groups/${encodeURIComponent(groupId)}/users`)));
    return memberCache.get(groupId);
  }

  // ------------------------------------------------------------ 畫面
  function memberToggle(g) {
    const wrap = el('div', 'fa-members-wrap client-hide');
    if (g.missing || !g.memberCount) return wrap;       // 沒有成員就不需要展開
    const btn = el('button', 'btn btn-link btn-sm p-0 fa-members-btn');
    btn.type = 'button';
    btn.appendChild(icon('chevron-right'));
    btn.appendChild(document.createTextNode(' 看成員'));
    const list = el('div', 'fa-members');
    list.hidden = true;
    let loaded = false;
    btn.addEventListener('click', () => {
      list.hidden = !list.hidden;
      btn.firstChild.className = list.hidden ? 'bi bi-chevron-right' : 'bi bi-chevron-down';
      if (list.hidden || loaded) return;
      list.textContent = '載入中…';
      loadMembers(g.groupId).then(users => {
        loaded = true;
        list.textContent = '';
        const shown = (users || []).slice(0, MEMBER_LIMIT);
        shown.forEach(u => list.appendChild(el('span', 'fa-member', u.name || u.email || `#${u.id}`)));
        if ((users || []).length > shown.length) list.appendChild(el('span', 'fa-member text-muted', `…等共 ${users.length} 人`));
      }, () => { list.textContent = '無法載入成員'; });
    });
    wrap.appendChild(btn);
    wrap.appendChild(list);
    return wrap;
  }

  function groupRow(g) {
    const row = el('div', 'fa-row');
    const main = el('div', 'fa-row-main');
    main.appendChild(typeBadge(g.type));
    main.appendChild(el('span', 'fa-name' + (g.missing ? ' text-muted' : ''), g.name));
    if (g.memberCount != null && !g.missing) main.appendChild(el('span', 'fa-count text-muted', `${g.memberCount} 人`));
    row.appendChild(main);
    row.appendChild(memberToggle(g));
    return row;
  }

  function userRow(u) {
    const row = el('div', 'fa-row');
    const main = el('div', 'fa-row-main');
    main.appendChild(typeBadge(u.type));
    main.appendChild(icon('person'));
    main.appendChild(el('span', 'fa-name' + (u.missing ? ' text-muted' : ''), u.name));
    row.appendChild(main);
    return row;
  }

  function section(title, hint) {
    const s = el('section', 'fa-section');
    s.appendChild(el('h6', 'fa-section-title', title));
    if (hint) s.appendChild(el('div', 'fa-hint text-muted', hint));
    return s;
  }

  function render(result) {
    const c = card();
    c.textContent = '';

    const head = el('header', 'fa-head');
    const titles = el('div', 'fa-titles');
    titles.appendChild(el('div', 'fa-title', result.folder.name));
    titles.appendChild(el('div', 'fa-path text-muted', `${result.folder.path}　#${result.folder.id}`));
    head.appendChild(titles);
    const close = el('button', 'btn btn-sm fa-close');
    close.type = 'button';
    close.setAttribute('aria-label', '關閉');
    close.appendChild(icon('x-lg'));
    close.addEventListener('click', closeCard);
    head.appendChild(close);
    c.appendChild(head);

    // 摘要：誰實際上進得來（本層 + 所有上層）
    const sum = section('實際有權限', '本層設定加上所有上層資料夾（NAS 套用時子資料夾會繼承）');
    if (!result.effectiveGroups.length && !result.effectiveUsers.length) {
      sum.appendChild(el('div', 'text-muted', '沒有任何登記'));
    }
    result.effectiveGroups.forEach(g => {
      const r = groupRow(g);
      const inheritedOnly = g.entries.every(e => e.level === 'inherited');
      if (inheritedOnly) r.firstChild.appendChild(el('span', 'fa-from text-muted', '繼承'));
      sum.appendChild(r);
    });
    result.effectiveUsers.forEach(u => {
      const r = userRow(u);
      if (u.entries.every(e => e.level === 'inherited')) r.firstChild.appendChild(el('span', 'fa-from text-muted', '繼承'));
      sum.appendChild(r);
    });
    c.appendChild(sum);

    // 提醒
    if (result.warnings.length) {
      const w = section('提醒');
      result.warnings.forEach(x => {
        const line = el('div', `fa-warning fa-warning-${x.level}`);
        line.appendChild(icon(x.level === 'warn' ? 'exclamation-triangle' : 'info-circle'));
        line.appendChild(document.createTextNode(' ' + x.text));
        w.appendChild(line);
      });
      c.appendChild(w);
    }

    // 本層設定
    const own = section('本層設定', '直接登記在這個資料夾上的權限');
    if (!result.own.groups.length && !result.own.users.length) own.appendChild(el('div', 'text-muted', '（無）'));
    result.own.groups.forEach(g => own.appendChild(groupRow(g)));
    result.own.users.forEach(u => own.appendChild(userRow(u)));
    c.appendChild(own);

    // 繼承自上層（唯讀）
    if (result.inherited.length) {
      const inh = section('繼承自上層', '僅供查看；要修改請到來源資料夾。DMS 沒有「子資料夾覆蓋上層」的設定。');
      result.inherited.forEach(lv => {
        const h = el('button', 'btn btn-link btn-sm p-0 fa-level');
        h.type = 'button';
        h.appendChild(icon('arrow-return-right'));
        h.appendChild(document.createTextNode(' 來自 ' + lv.folder.path));
        h.addEventListener('click', () => reveal(lv.folder.id));
        inh.appendChild(h);
        lv.groups.forEach(g => inh.appendChild(groupRow(g)));
        lv.users.forEach(u => inh.appendChild(userRow(u)));
      });
      c.appendChild(inh);
    }

    c.appendChild(el('footer', 'fa-foot text-muted',
      '顯示的是 DMS 登記的內容，不代表檔案伺服器的現況（NAS 上若有手動調整，這裡看不到）。'));
  }

  function renderMessage(text, retry) {
    const c = card();
    c.textContent = '';
    const head = el('header', 'fa-head');
    head.appendChild(el('div', 'fa-title', '資料夾權限'));
    const close = el('button', 'btn btn-sm fa-close');
    close.type = 'button';
    close.setAttribute('aria-label', '關閉');
    close.appendChild(icon('x-lg'));
    close.addEventListener('click', closeCard);
    head.appendChild(close);
    c.appendChild(head);
    c.appendChild(el('div', 'fa-section text-muted', text));
    if (retry) {
      const b = el('button', 'btn btn-sm btn-outline-secondary', '重試');
      b.type = 'button';
      b.addEventListener('click', retry);
      c.appendChild(b);
    }
  }

  // ------------------------------------------------------------ 選取與顯示
  function markSelected() {
    document.querySelectorAll('#folder-tree .folder-item.selected').forEach(n => n.classList.remove('selected'));
    if (selectedId == null) return;
    const n = Array.from(document.querySelectorAll('#folder-tree .folder-item')).find(x => Number(x.dataset.folderId) === selectedId);
    if (n) n.classList.add('selected');
  }

  function refresh() {
    if (selectedId == null) return;
    const mySeq = ++renderSeq;
    const id = selectedId;
    renderMessage('載入中…');
    loadSupport().then(support => {
      if (mySeq !== renderSeq || selectedId !== id) return;      // 期間又點了別的資料夾
      const result = window.FolderAccess.compute({ folderId: id, folders: getFolders(), permissions: support.permissions, memberCounts: support.memberCounts });
      if (!result) { closeCard(); return; }
      render(result);
    }, () => {
      if (mySeq !== renderSeq) return;
      renderMessage('無法載入權限資料。', refresh);
    });
  }

  function select(id) {
    const wasHidden = card().hidden;
    selectedId = Number(id);
    card().hidden = false;
    layout().classList.add('has-card');
    markSelected();
    refresh();
    // 第一次打開時卡片底部可能超出畫面，捲到看得到（之後卡片是 sticky，會跟著畫面）
    if (wasHidden && card().scrollIntoView) card().scrollIntoView({ block: 'nearest' });
  }

  function closeCard() {
    selectedId = null;
    renderSeq++;
    const c = card();
    if (c) { c.hidden = true; c.textContent = ''; }
    if (layout()) layout().classList.remove('has-card');
    markSelected();
  }

  // 展開樹到指定資料夾並選取（點「來自 /xxx」用）
  function reveal(id) {
    const n = Array.from(document.querySelectorAll('#folder-tree .folder-item')).find(x => Number(x.dataset.folderId) === Number(id));
    if (n) {
      $(n).parents('.sub-ul').each(function () {
        $(this).show();
        $(this).parent().children('.folder-item').find('.folder-icon').css('transform', 'rotate(90deg)');
      });
      n.scrollIntoView({ block: 'nearest' });
    }
    select(id);
  }

  // 樹重建之後（重新進入頁面、新增／刪除資料夾）：資料可能變了，快取失效並更新卡片
  function restore() {
    invalidate();
    if (selectedId == null) return;
    if (!getFolders().some(f => Number(f.id) === selectedId)) { closeCard(); return; }
    markSelected();
    refresh();
  }

  function scheduleRefresh() {
    if (selectedId == null) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { invalidate(); refresh(); }, 300);
  }

  function init(opts) {
    getFolders = opts.getFolders;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && selectedId != null && !document.querySelector('.modal.show')) closeCard();
    });
    // 任何寫入類請求成功後，快取就不可信
    $(document).ajaxSuccess((ev, xhr, settings) => {
      const method = String(settings.type || 'GET').toUpperCase();
      const url = String(settings.url || '');
      if (method === 'GET' || !/\/api\//.test(url)) return;
      invalidate();
      if (/\/api\/databases\/switch/.test(url)) closeCard();
      else scheduleRefresh();
    });
    if (typeof window.fetch === 'function') {
      const orig = window.fetch;
      window.fetch = function (input, init) {
        const p = orig.apply(this, arguments);
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (method !== 'GET') p.then(() => { invalidate(); scheduleRefresh(); }, () => {});
        return p;
      };
    }
  }

  window.FolderAccessUI = { init, select, close: closeCard, restore, invalidate, reveal };
})();
