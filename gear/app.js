/* 出班器材檢查表。
 * 資料只存在這個瀏覽器的 localStorage（鍵 toolbox.gear.v1），不連網、不送任何資料。
 * 畫面全部用 DOM 方法建出來（使用者輸入的文字一律當純文字），不拼 HTML 字串。 */
(function () {
  'use strict';

  var TOOL_ID = 'gear';
  var KEY = 'toolbox.gear.v1';
  var BK = 'toolbox.backup.v1';
  var STALE_DAYS = 14;
  var D = window.GEAR_DEFAULTS;
  var MAX = { runs: 10, templates: 30, sections: 30, items: 120, totalItems: 400, reminders: 20, places: 8,
    name: 50, sec: 30, job: 40, tpl: 40, desc: 240, rem: 300, place: 12, qty: 999, file: 5 * 1024 * 1024 };

  /* ---------- 小工具 ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var isObj = function (o) { return !!o && typeof o === 'object' && !Array.isArray(o); };
  var str = function (s, max) { return typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''; };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var nowIso = function () { return new Date().toISOString(); };
  // 使用者檔案裡的文字要回顯到畫面時，先拿掉雙向文字控制字元（會把後面的字倒過來顯示、假造內容）
  var noBidi = function (s) { return String(s).replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g, ''); };
  var WD = '日一二三四五六';

  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function validDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var p = s.split('-').map(Number), t = new Date(p[0], p[1] - 1, p[2]);
    return t.getFullYear() === p[0] && t.getMonth() === p[1] - 1 && t.getDate() === p[2] && p[0] >= 2000 && p[0] <= 2100;
  }
  function fmtDate(s) {
    if (!validDate(s)) return s || '';
    var p = s.split('-').map(Number);
    return s + '（週' + WD[new Date(p[0], p[1] - 1, p[2]).getDay()] + '）';
  }
  function dateText(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function daysSince(ms) {
    var a = new Date(), b = new Date(ms);
    var d = Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(b.getFullYear(), b.getMonth(), b.getDate())) / 86400000);
    return d < 0 ? 0 : d;
  }
  function uid(taken) {
    var id;
    do { id = 'x' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); } while (taken && taken.has(id));
    if (taken) taken.add(id);
    return id;
  }
  function cleanIso(s, fallback) { var t = typeof s === 'string' ? Date.parse(s) : NaN; return isNaN(t) ? fallback : new Date(t).toISOString(); }

  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('data-') === 0 || k.indexOf('aria-') === 0 || k === 'for' || k === 'novalidate' || k === 'maxlength' || k === 'inputmode' || k === 'tabindex') el.setAttribute(k, v === true ? '' : v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  /* ---------- 與資料保險箱共用的備份紀錄（只記狀態，不記內容） ---------- */
  function markToolbox(patch) { try { var K = 'toolbox.backup.v1'; var ID = TOOL_ID; var o; try { o = JSON.parse(localStorage.getItem(K) || ''); } catch (e) {} if (!o || o.v !== 1 || typeof o.tools !== 'object' || !o.tools) o = { v: 1, tools: {} }; var cur = o.tools[ID] || { hasData: false, updatedAt: null, lastBackupAt: null }; o.tools[ID] = Object.assign(cur, patch); localStorage.setItem(K, JSON.stringify(o)); } catch (e) {} }
  var markedOnce = false, lastMark = 0;
  function markNow() { markToolbox({ hasData: true, updatedAt: nowIso() }); markedOnce = true; lastMark = Date.now(); }
  function markSaved() { if (!markedOnce || Date.now() - lastMark >= 60000) markNow(); }
  // 共用規則：工具自己的清除全部資料之後，紀錄是「沒有資料、現在更新、沒有備份」。清除之前下載的備份檔，不涵蓋清除之後才輸入的資料。
  function markEmpty() { markToolbox({ hasData: false, updatedAt: nowIso(), lastBackupAt: null }); markedOnce = false; }
  // 載入時對帳，讓紀錄跟實際狀況一致：
  //  有使用者資料、紀錄卻寫 hasData:false 或根本沒有 → 補成 true（沿用原本的 updatedAt，沒有才用現在）。
  //  沒有使用者資料、資料鍵確實不存在（不是讀不出來）、紀錄卻寫 hasData:true → 降回 false（同清除全部資料的結果）。
  //  沒有資料又沒有紀錄、或紀錄本來就是 false → 不寫入。
  function holdsUserData() { return !!S && (S.rev > 0 || S.runs.length > 0); }
  function reconcileRecord() {
    if (!storageOK || corruptRaw != null) return;
    var has = holdsUserData(), cur = null;
    try {
      var o = JSON.parse(localStorage.getItem(BK) || '');
      cur = o && o.v === 1 && isObj(o.tools) && isObj(o.tools[TOOL_ID]) ? o.tools[TOOL_ID] : null;
      // 這個工具的那一筆壞掉（不是物件）就先拿掉，免得共用的寫入函式接在壞資料後面；別的工具的紀錄原樣保留。
      if (has && !cur && o && o.v === 1 && isObj(o.tools) && o.tools[TOOL_ID] !== undefined) { delete o.tools[TOOL_ID]; localStorage.setItem(BK, JSON.stringify(o)); }
    } catch (e) { cur = null; }
    if (!has) {
      var gone = false;
      try { gone = localStorage.getItem(KEY) === null; } catch (e) { /* 讀不到：不動紀錄 */ }
      if (gone && cur && cur.hasData === true) markEmpty();
      return;
    }
    if (cur && cur.hasData === true) return;
    var patch = { hasData: true };
    if (!(cur && typeof cur.updatedAt === 'string' && !isNaN(Date.parse(cur.updatedAt)))) patch.updatedAt = nowIso();
    markToolbox(patch);
  }
  function lastBackupMs() {
    try {
      var o = JSON.parse(localStorage.getItem(BK) || '');
      var t = o && o.v === 1 && o.tools && o.tools[TOOL_ID] && o.tools[TOOL_ID].lastBackupAt;
      var ms = Date.parse(t);
      return isNaN(ms) ? null : ms;
    } catch (e) { return null; }
  }

  /* ---------- 資料整理（讀檔、還原備份都會過這一關） ---------- */
  function defOf(id) { for (var i = 0; i < D.templates.length; i++) if (D.templates[i].id === id) return D.templates[i]; return null; }
  function idOk(v) { return typeof v === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(v); }
  function cleanId(v, taken) { if (idOk(v) && !taken.has(v)) { taken.add(v); return v; } return uid(taken); }

  function cleanItem(i, taken, isRun) {
    if (!isObj(i)) return null;
    var name = str(i.name, MAX.name);
    if (!name) return null;
    var q = Number(i.qty);
    var it = { id: cleanId(i.id, taken), name: name, qty: Number.isInteger(q) && q >= 1 && q <= MAX.qty ? q : null, ret: str(i.ret, MAX.place) };
    if (isRun) { if (i.skip === true) it.skip = true; if (i.temp === true) it.temp = true; }
    return it;
  }
  function cleanSections(a, taken, isRun) {
    var out = [], total = 0;
    if (!Array.isArray(a)) return out;
    a.slice(0, MAX.sections).forEach(function (s) {
      if (!isObj(s)) return;
      var items = [];
      (Array.isArray(s.items) ? s.items : []).slice(0, MAX.items).forEach(function (i) {
        if (total >= MAX.totalItems) return;
        var it = cleanItem(i, taken, isRun);
        if (it) { items.push(it); total++; }
      });
      out.push({ id: cleanId(s.id, taken), name: str(s.name, MAX.sec) || '未命名區段', items: items });
    });
    return out;
  }
  function cleanReminders(a, taken) {
    var out = [];
    if (!Array.isArray(a)) return out;
    a.slice(0, MAX.reminders).forEach(function (r) {
      if (!isObj(r)) return;
      var text = str(r.text, MAX.rem);
      if (text) out.push({ id: cleanId(r.id, taken), text: text, done: r.done === true });
    });
    return out;
  }
  function cleanTemplate(t, ids) {
    if (!isObj(t)) return null;
    var id = idOk(t.id) ? t.id : null;
    if (!id || ids.has(id)) id = uid(ids);
    ids.add(id);
    var def = defOf(id), taken = new Set();
    return { id: id, kind: def ? def.kind : 'custom', name: str(t.name, MAX.tpl) || '未命名班型', desc: str(t.desc, MAX.desc),
      reminders: cleanReminders(t.reminders, taken), sections: cleanSections(t.sections, taken, false) };
  }
  function cleanRun(r, ids) {
    if (!isObj(r)) return null;
    var id = idOk(r.id) && !ids.has(r.id) ? r.id : uid(ids);
    ids.add(id);
    var taken = new Set(), sections = cleanSections(r.sections, taken, true), have = new Set();
    sections.forEach(function (s) { s.items.forEach(function (i) { have.add(i.id); }); });
    var ticks = function (m) { var o = {}; if (isObj(m)) Object.keys(m).forEach(function (k) { if (m[k] === true && have.has(k)) o[k] = true; }); return o; };
    var now = nowIso(), created = cleanIso(r.createdAt, now);
    return { id: id, templateId: str(r.templateId, 40), templateName: str(r.templateName, MAX.tpl) || '（班型已不存在）',
      job: str(r.job, MAX.job) || '（未命名的班）', date: validDate(r.date) ? r.date : todayStr(),
      createdAt: created, updatedAt: cleanIso(r.updatedAt, created), sections: sections,
      reminders: cleanReminders(r.reminders, taken), packed: ticks(r.packed), returned: ticks(r.returned) };
  }
  function cleanPlaces(a) {
    if (!Array.isArray(a)) return D.places.slice();
    var out = [];
    a.forEach(function (p) { var s = str(p, MAX.place); if (s && out.indexOf(s) === -1 && out.length < MAX.places) out.push(s); });
    return out;
  }
  function ensureBuiltins(list) { D.templates.forEach(function (d) { if (!list.some(function (t) { return t.id === d.id; })) list.push(clone(d)); }); }
  var byRecent = function (a, b) { return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0; };
  function sanitizeData(d) {
    if (!isObj(d) || !Array.isArray(d.templates) || !Array.isArray(d.runs)) return null;
    var ids = new Set(), templates = [], rids = new Set(), runs = [];
    d.templates.slice(0, MAX.templates).forEach(function (t) { var c = cleanTemplate(t, ids); if (c) templates.push(c); });
    ensureBuiltins(templates);
    d.runs.slice(0, 60).forEach(function (r) { var c = cleanRun(r, rids); if (c) runs.push(c); });
    runs.sort(byRecent);
    return { templates: templates, runs: runs.slice(0, MAX.runs), places: cleanPlaces(d.places) };
  }
  function fresh() { return { v: 1, rev: 0, updatedAt: null, places: D.places.slice(), templates: clone(D.templates), runs: [] }; }

  /* ---------- 讀寫（含多分頁保護） ---------- */
  var S = null, baseRev = 0, storageOK = true, stale = false, corruptRaw = null;
  var ui = { view: 'home', tplId: null, runId: null, pass: 'pack', group: 'section', place: 'all', adjust: false,
    homeTpl: null, nextFocus: null, remOpen: {}, backupMsg: null,
    hold: null,     // 換地點時凍住的清單排法：連點同一格的時候，列不會在手指底下搬家（見 cycle-place）
    anchor: null,   // 重畫前記下被點的那個控制項的位置，重畫後把捲動補回去，讓它留在原地
    pnote: null };  // 換地點的通知（貼在被點的那一列旁邊）：{ id, msg }，見 showPlaceNote

  function revOf(raw) {
    if (raw == null) return 0;
    try { var p = JSON.parse(raw); return isObj(p) && p.v === 1 && Number.isInteger(p.rev) && p.rev >= 0 ? p.rev : -1; } catch (e) { return -1; }
  }
  function loadState() {
    var raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return { state: fresh(), rev: 0, ok: false }; }
    if (raw == null) return { state: fresh(), rev: 0, ok: true };
    var rev = revOf(raw);
    if (rev >= 0) {
      try {
        var p = JSON.parse(raw), d = sanitizeData(p);
        if (d) return { state: { v: 1, rev: rev, updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null, places: d.places, templates: d.templates, runs: d.runs }, rev: rev, ok: true };
      } catch (e) { /* 落到下面 */ }
    }
    return { state: fresh(), rev: rev, ok: true, corrupt: raw };
  }
  function isQuota(e) { return !!e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014); }

  function setNoStore() { storageOK = false; $('#bnNoStore').hidden = false; }
  function flagStale() {
    stale = true;
    $('#bnStale').hidden = false;
    window.scrollTo(0, 0);
    var b = $('#reloadBtn'); if (b) b.focus({ preventScroll: true });
    say('這個分頁的資料已過期，請重新整理');
  }

  // 所有修改都從這裡走：先在複本上改，寫入前重讀儲存裡的版本號，別的分頁動過就拒絕。
  function commit(mutate, opt) {
    opt = opt || {};
    if (stale) { flagStale(); return false; }
    var next = clone(S);
    if (mutate(next) === false) return false;
    next.v = 1; next.rev = Math.max(baseRev, 0) + 1; next.updatedAt = nowIso();
    if (storageOK) {
      var cur;
      try { cur = revOf(localStorage.getItem(KEY)); } catch (e) { cur = null; }
      if (cur === null) setNoStore();
      else if (cur !== baseRev) { flagStale(); return false; }
    }
    if (storageOK) {
      try {
        if (corruptRaw != null) {
          try { localStorage.setItem(KEY + '.bad', corruptRaw); } catch (e) { /* 另存失敗就算了 */ }
          corruptRaw = null; $('#bnCorrupt').hidden = true;
        }
        localStorage.setItem(KEY, JSON.stringify(next));
        markSaved();
      } catch (e) {
        if (isQuota(e)) { toast('儲存空間不足，這次修改沒有存下', { bad: true }); return false; }
        setNoStore();
      }
    }
    baseRev = next.rev;
    S = next;
    if (opt.render !== false) render();
    return true;
  }

  /* ---------- 提示、對話框 ---------- */
  var toastTimer = 0, liveTimer = 0;
  function say(msg) { var l = $('#live'); l.textContent = ''; clearTimeout(liveTimer); liveTimer = setTimeout(function () { l.textContent = msg; }, 40); }
  function toast(msg, opt) {
    opt = opt || {};
    var t = $('#toast'), a = $('#toastAct');
    $('#toastMsg').textContent = msg;
    a.hidden = !opt.action;
    a.textContent = opt.action || '';
    a.onclick = opt.onAction ? function () { hideToast(); opt.onAction(); } : null;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, opt.ms || (opt.bad ? 6500 : 3400));
    say(msg);
  }
  function hideToast() { clearTimeout(toastTimer); $('#toast').hidden = true; }

  /* 換地點的通知：貼在剛點的那一列旁邊，不放在畫面頂端或底部，所以不會蓋住那一格，也不會蓋住上面的「提醒」框。
   * 它是那一列的子元素（絕對定位、不佔版面、不擋點擊），列留在原位、其他列也不會被推開。
   * 預設放在那一列的下方；下方放不下（列靠近畫面底部）就放在上方；兩邊都放得下時選會避開提醒框的那一邊。
   * 通知跟著列走：重畫後會重新貼回去，直到計時結束、或這一列不再被「凍結排法」留在原位（換篩選、分組、階段等）。 */
  var pnoteTimer = 0;
  function clearPlaceNote() {
    clearTimeout(pnoteTimer); ui.pnote = null;
    var n = document.querySelector('#view .pnote'); if (n) n.remove();
  }
  function showPlaceNote(id, msg) {
    clearTimeout(pnoteTimer);
    ui.pnote = { id: id, msg: msg };
    pnoteTimer = setTimeout(clearPlaceNote, 4200);
    mountPlaceNote();
    say(msg);
  }
  function mountPlaceNote() {
    var old = document.querySelector('#view .pnote'); if (old) old.remove();
    var p = ui.pnote; if (!p) return;
    var run = ui.view === 'run' ? curRun() : null, li = null;
    if (run && holdOf(run)) {
      document.querySelectorAll('#view button.hit[data-fk]').forEach(function (b) { if (!li && b.getAttribute('data-fk') === 'place:' + p.id) li = b.closest('li.row'); });
    }
    if (!li) { clearPlaceNote(); return; }
    var n = h('div', { class: 'pnote', text: p.msg });
    li.appendChild(n);
    n.classList.toggle('up', placeNoteGoesUp(li, n));
  }
  // 回答「通知要放在列的上方嗎」：先看哪一邊放得下（不超出畫面、不蓋到黏頂的進度列、不碰到提醒框），都放得下就放下方。
  function placeNoteGoesUp(li, n) {
    var r = li.getBoundingClientRect(), nh = Math.ceil(n.getBoundingClientRect().height), gap = 4, vh = window.innerHeight || document.documentElement.clientHeight;
    var bar = $('#view .runbar'), top = bar && getComputedStyle(bar).position === 'sticky' ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
    var rem = $('#view .remind'), rr = rem ? rem.getBoundingClientRect() : null;
    var apart = function (from, to) { return !rr || to <= rr.top || from >= rr.bottom; };   // 與提醒框在垂直方向上沒有交集
    var belowFrom = r.bottom + gap, aboveTo = r.top - gap;
    var belowOk = belowFrom + nh <= vh && apart(belowFrom, belowFrom + nh);
    var aboveOk = aboveTo - nh >= top && apart(aboveTo - nh, aboveTo);
    if (belowOk) return false;
    if (aboveOk) return true;
    return (r.top - top) > (vh - r.bottom);   // 兩邊都放不下（畫面極矮）：選空間比較大的一邊
  }

  function modal(title, body, buttons, o) {
    o = o || {};
    return new Promise(function (resolve) {
      var dlg = h('dialog', { class: 'dlg', 'aria-labelledby': 'dlgTitle' });
      var done = false, watch = null;
      // 只會結算一次。按鈕直接結算，不靠瀏覽器的 close 事件（有的瀏覽器在按過 Esc 之後不再送 close）；
      // Esc 或其他方式關掉對話框時，由 cancel／close 事件，再加上監看 open 屬性補上，結果是 null（等於取消）。
      function finish(value) {
        if (done) return;
        done = true;
        if (watch) watch.disconnect();
        try { if (dlg.open) dlg.close(); } catch (e) { /* 已經關了 */ }
        dlg.remove();
        resolve(value);
      }
      var els = buttons.map(function (b) {
        return h('button', { type: 'button', class: 'btn ' + (b.kind || ''), text: b.label, onclick: function () { if (b.on) { b.on(); return; } finish(b.value); } });
      });
      dlg.append(h('h2', { id: 'dlgTitle', text: title }));
      append(dlg, body);
      dlg.append(h('div', { class: 'dact' }, els));
      dlg.addEventListener('cancel', function () { finish(null); });
      dlg.addEventListener('close', function () { finish(null); });
      document.body.append(dlg);
      dlg.showModal();
      if (window.MutationObserver) { watch = new MutationObserver(function () { if (!dlg.open) finish(null); }); watch.observe(dlg, { attributes: true, attributeFilter: ['open'] }); }
      if (o.onOpen) o.onOpen(dlg); else (els[o.focus || 0] || els[0]).focus();
    });
  }
  function confirmBox(title, msg, okLabel, danger, extra) {
    return modal(title, [h('p', { text: msg }), extra || null], [{ label: '取消', value: false }, { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' }], { focus: 0 }).then(function (v) { return v === true; });
  }
  function copyText(text, label) {
    var done = function () { toast('已複製：' + label); };
    var manual = function () {
      var ta = h('textarea', { readOnly: true, 'aria-label': '可以選取複製的文字', value: text });
      modal('請手動複製', [h('p', { text: '這個瀏覽器不讓網頁直接複製。下面的文字已經全選，按複製即可。' }), ta],
        [{ label: '全選', on: function () { ta.focus(); ta.select(); } }, { label: '關閉', value: true, kind: 'primary' }],
        { onOpen: function () { ta.focus(); ta.select(); } });
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, manual); return; }
    } catch (e) { /* 走手動 */ }
    manual();
  }
  function undoToast(msg, prev) {
    var rev = S.rev;
    toast(msg, { action: '復原', ms: 8000, onAction: function () {
      if (S.rev !== rev) { toast('資料已經又改過，沒辦法復原', { bad: true }); return; }
      if (commit(function (n) { n.templates = prev.templates; n.runs = prev.runs; n.places = prev.places; })) toast('已復原');
    } });
  }
  function deleteWithUndo(msg, fn) { var prev = clone(S); if (commit(fn)) undoToast(msg, prev); }

  /* ---------- 計算 ---------- */
  var checks = function (run, pass) { return pass === 'pack' ? run.packed : run.returned; };
  function progress(run, pass) {
    var m = checks(run, pass), done = 0, total = 0;
    run.sections.forEach(function (s) { s.items.forEach(function (i) { if (i.skip) return; total++; if (m[i.id]) done++; }); });
    return { done: done, total: total };
  }
  function placeOrder(run) {
    var out = S.places.slice();
    run.sections.forEach(function (s) { s.items.forEach(function (i) { if (i.ret && out.indexOf(i.ret) === -1) out.push(i.ret); }); });
    out.push('');
    return out;
  }
  function tplStats(t) {
    var n = 0; t.sections.forEach(function (s) { n += s.items.length; });
    return { sections: t.sections.length, items: n, open: t.reminders.filter(function (r) { return !r.done; }).length };
  }
  function tplSig(t) {
    return JSON.stringify([t.name, t.desc, t.reminders.map(function (r) { return r.text; }),
      t.sections.map(function (s) { return [s.name, s.items.map(function (i) { return [i.name, i.qty, i.ret]; })]; })]);
  }
  function tplModified(t) { var d = defOf(t.id); return !!d && tplSig(t) !== tplSig(d); }
  var qtyText = function (q) { return q ? '×' + q : ''; };

  function makeRun(t, job, date, id) {
    var now = nowIso();
    return { id: id, templateId: t.id, templateName: t.name, job: job || '（未命名的班）', date: date, createdAt: now, updatedAt: now,
      sections: t.sections.filter(function (s) { return s.items.length; }).map(function (s) {
        return { id: s.id, name: s.name, items: s.items.map(function (i) { return { id: i.id, name: i.name, qty: i.qty, ret: i.ret }; }) };
      }),
      reminders: t.reminders.map(function (r) { return { id: r.id, text: r.text, done: r.done }; }), packed: {}, returned: {} };
  }
  function leftText(run, pass) {
    var m = checks(run, pass), left = [];
    run.sections.forEach(function (s) { s.items.forEach(function (i) { if (!i.skip && !m[i.id]) left.push({ s: s, i: i }); }); });
    var title = (pass === 'pack' ? '【出發前打包】' : '【收班歸還】') + run.job + '（' + run.templateName + '，' + run.date + '）';
    if (!left.length) return title + '\n全部完成。';
    var line = function (i) { return '- ' + i.name + (i.qty ? ' ×' + i.qty : ''); };
    var out = [title, '還沒完成 ' + left.length + ' 項：'];
    if (pass === 'return') {
      placeOrder(run).forEach(function (pl) {
        var g = left.filter(function (x) { return (x.i.ret || '') === pl; });
        if (g.length) { out.push('', (pl || '未指定地點') + '（' + g.length + ' 項）'); g.forEach(function (x) { out.push(line(x.i)); }); }
      });
    } else {
      run.sections.forEach(function (s) {
        var g = left.filter(function (x) { return x.s === s; });
        if (g.length) { out.push('', '[' + s.name + ']'); g.forEach(function (x) { out.push(line(x.i)); }); }
      });
    }
    return out.join('\n');
  }

  /* ---------- 畫面 ---------- */
  var curRun = function () { return S.runs.find(function (r) { return r.id === ui.runId; }); };
  var curTpl = function () { return S.templates.find(function (t) { return t.id === ui.tplId; }); };

  // 一班的畫面上方有一條黏住的進度列（.runbar）。鍵盤焦點（尤其 Shift+Tab 往上走）捲到的列不能被它蓋住，
  // 所以把它的實際高度告訴瀏覽器當 scroll-padding-top。列高會隨字級、換行改變，所以重畫、視窗變動、列本身變高都重量一次。
  var barObs = null;
  function applyBarPad() {
    var bar = $('#view .runbar'), pad = '';
    if (bar) pad = (getComputedStyle(bar).position === 'sticky' ? Math.ceil(bar.getBoundingClientRect().height) + 8 : 0) + 'px';
    document.documentElement.style.scrollPaddingTop = pad;
  }
  function syncBarPad() {
    applyBarPad();
    if (!window.ResizeObserver) return;
    if (!barObs) barObs = new ResizeObserver(applyBarPad);
    barObs.disconnect();
    var bar = $('#view .runbar'); if (bar) barObs.observe(bar);
  }
  // 重畫整個畫面時，瀏覽器沒辦法自動把捲動錨在被點的那一列上；自己記下它離視窗頂端多遠，重畫後把差額捲回去。
  function anchorOf(el) { var fk = el && el.getAttribute && el.getAttribute('data-fk'); return fk ? { fk: fk, top: el.getBoundingClientRect().top } : null; }
  function keepAnchor(a, root) {
    var el = null;
    root.querySelectorAll('[data-fk]').forEach(function (x) { if (!el && x.getAttribute('data-fk') === a.fk) el = x; });
    if (!el) return;
    var d = el.getBoundingClientRect().top - a.top;
    if (Math.abs(d) >= 1) window.scrollBy(0, d);
  }

  function render(keepTyped) {
    var root = $('#view'), ae = document.activeElement;
    var want = ui.nextFocus || (ae && ae.getAttribute && ae.getAttribute('data-fk'));
    var inView = !!(ae && ae !== document.body && root.contains(ae));
    var anchor = ui.anchor; ui.anchor = null;
    var typed = null;
    if (keepTyped && ae && ae.getAttribute && ae.getAttribute('data-fk') && /^(INPUT|TEXTAREA)$/.test(ae.tagName) && ae.type !== 'checkbox') {
      typed = { fk: ae.getAttribute('data-fk'), value: ae.value, s: ae.selectionStart, e: ae.selectionEnd };
    }
    var cands = Array.isArray(want) ? want : (want ? [want] : []);
    ui.nextFocus = null;
    var node;
    if (ui.view === 'run' && !curRun()) ui.view = 'home';
    if (ui.view === 'tpledit' && !curTpl()) ui.view = 'tpl';
    if (ui.view !== 'run') ui.hold = null;
    switch (ui.view) {
      case 'run': node = viewRun(); break;
      case 'tpl': node = viewTpl(); break;
      case 'tpledit': node = viewTplEdit(); break;
      case 'backup': node = viewBackup(); break;
      default: node = viewHome();
    }
    root.replaceChildren(node);
    var nav = ui.view === 'run' ? 'home' : ui.view === 'tpledit' ? 'tpl' : ui.view;
    document.querySelectorAll('#tabs button').forEach(function (b) { if (b.dataset.view === nav) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var all = root.querySelectorAll('[data-fk]');
    if (typed) all.forEach(function (el) { if (el.getAttribute('data-fk') === typed.fk) { el.value = typed.value; } });
    var focused = false;
    for (var c = 0; c < cands.length; c++) {
      var hit = null;
      all.forEach(function (el) { if (!hit && el.getAttribute('data-fk') === cands[c] && !el.disabled) hit = el; });
      if (hit) { hit.focus({ preventScroll: true }); focused = true; if (typed && typed.fk === cands[c] && typed.s != null) { try { hit.setSelectionRange(typed.s, typed.e); } catch (e) { /* 數字欄位不支援 */ } } break; }
    }
    // 原本焦點在畫面裡、要接手的控制項卻不見了（例如那一列離開了目前的篩選）：別讓焦點掉到頁面最上面，
    // 退到目前選著的篩選鈕，再不行退到頁面標題。
    if (!focused && inView && cands.length) {
      var fb = root.querySelector('.fchips [aria-pressed="true"]') || root.querySelector('h2');
      if (fb) { if (fb.tagName === 'H2') fb.setAttribute('tabindex', '-1'); fb.focus({ preventScroll: true }); }
    }
    stabilizeChips();
    if (anchor) keepAnchor(anchor, root);
    syncBarPad();
    mountPlaceNote();   // 捲動位置定下來之後才量，通知才會選對放在列的上方還是下方
  }
  function go(view) {
    ui.view = view; ui.adjust = false; ui.backupMsg = null;
    if (view === 'home') ui.runId = null;
    render();
    window.scrollTo(0, 0);
    var hd = $('#view h2'); if (hd) { hd.setAttribute('tabindex', '-1'); hd.focus({ preventScroll: true }); }
  }

  /* --- 出班首頁 --- */
  function runItem(r) {
    var p = progress(r, 'pack'), q = progress(r, 'return');
    var done = p.total > 0 && p.done === p.total && q.done === q.total;
    return h('li', { class: 'card item' + (done ? '' : ' attn') },
      h('div', null,
        h('h3', null, r.job, done ? h('span', { class: 'chip', text: '完成' }) : h('span', { class: 'flag', text: '未完成' })),
        h('p', { class: 'meta', text: fmtDate(r.date) + '・' + r.templateName }),
        h('p', { class: 'prog', text: '打包 ' + p.done + '／' + p.total + '　歸還 ' + q.done + '／' + q.total })),
      h('div', { class: 'ops' },
        h('button', { type: 'button', class: 'btn primary', 'data-act': 'open-run', 'data-id': r.id, 'data-fk': 'open:' + r.id, 'aria-label': '打開：' + r.job, text: '打開' }),
        h('button', { type: 'button', class: 'btn danger', 'data-act': 'del-run', 'data-id': r.id, 'data-fk': 'delrun:' + r.id, 'aria-label': '刪除紀錄：' + r.job, text: '刪除' })));
  }
  function viewHome() {
    var tpls = S.templates;
    if (!tpls.some(function (t) { return t.id === ui.homeTpl; })) ui.homeTpl = tpls.length ? tpls[0].id : null;
    var oldest = S.runs.length >= MAX.runs ? S.runs.slice().sort(function (a, b) { return -byRecent(a, b); })[0] : null;
    var form = h('form', { class: 'card', 'data-form': 'newrun', novalidate: true, 'aria-labelledby': 'h-new' },
      h('div', { class: 'fld' }, h('label', { class: 'lbl', for: 'nr-tpl', text: '班型' }),
        h('select', { id: 'nr-tpl', name: 'tpl', 'data-fk': 'nr-tpl' }, tpls.map(function (t) {
          return h('option', { value: t.id, selected: t.id === ui.homeTpl, text: t.name + (t.kind === 'sample' ? '（範本）' : '') });
        }))),
      h('div', { class: 'grid2' },
        h('div', { class: 'fld' }, h('label', { class: 'lbl', for: 'nr-date', text: '日期' }), h('input', { type: 'date', id: 'nr-date', name: 'date', value: todayStr(), 'data-fk': 'nr-date' })),
        h('div', { class: 'fld' }, h('label', { class: 'lbl', for: 'nr-job', text: '工作名稱' }), h('input', { type: 'text', id: 'nr-job', name: 'job', maxlength: MAX.job, autocomplete: 'off', placeholder: '例：品牌短片外景', 'data-fk': 'nr-job' }))),
      h('p', { class: 'err', role: 'alert', id: 'nr-err', hidden: true }),
      oldest ? h('p', { class: 'note', text: '歷史最多保留 ' + MAX.runs + ' 筆，開新的一班會捨棄最舊的一筆（' + oldest.job + '，' + oldest.date + '）。' }) : null,
      h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn primary', text: '開始出班' })));
    var sorted = S.runs.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : -byRecent(a, b); });
    return h('div', null,
      h('h2', { class: 'tape', id: 'h-new', text: '開一班' }), form,
      h('h2', { class: 'tape', text: '最近的出班' }),
      sorted.length ? h('ul', { class: 'list', 'aria-label': '最近的出班' }, sorted.map(runItem))
        : h('p', { class: 'empty', text: '還沒有出班紀錄。選好班型、日期，按「開始出班」就會有一份可以勾的清單。' }),
      sorted.length ? h('p', { class: 'note', text: '最多保留最近 ' + MAX.runs + ' 筆。邊框加粗的是還沒全部勾完的。' }) : null);
  }

  /* --- 一班的清單 --- */
  function remindBox(run) {
    if (!run.reminders.length) return null;
    var open = run.reminders.filter(function (r) { return !r.done; }).length;
    var d = h('details', { class: 'remind', open: !!ui.remOpen[run.id] },
      h('summary', { 'data-fk': 'remsum' }, h('span', { class: 'flag', text: '提醒' }),
        h('span', { text: open ? open + ' 則還沒處理（共 ' + run.reminders.length + ' 則），點開來看' : '全部處理過了（共 ' + run.reminders.length + ' 則）' })),
      h('ul', null, run.reminders.map(function (r) {
        var id = 'rm-' + r.id;
        return h('li', null, h('label', { class: 'rem' + (r.done ? ' done' : ''), for: id },
          h('input', { type: 'checkbox', class: 'sr', id: id, checked: r.done, 'data-chg': 'run-rem', 'data-id': r.id, 'data-fk': 'rem:' + r.id }),
          h('span', { class: 'box', 'aria-hidden': 'true' }),
          h('span', { class: 'tx' }, r.text, h('em', { text: r.done ? '已處理' : '標成已處理' }))));
      })));
    d.addEventListener('toggle', function () { ui.remOpen[run.id] = d.open; });
    return d;
  }
  function itemRow(run, s, it, pass, o) {
    var m = checks(run, pass), id = 'cb-' + pass + '-' + it.id, parts = [];
    if (o.showSec) parts.push(s.name);
    if (pass === 'return' && Object.keys(run.packed).length && !run.packed[it.id] && !it.skip) parts.push('出發前沒勾到');
    if (it.skip) parts.push('這次不帶');
    if (it.temp) parts.push('臨時加的');
    var label = h('label', { class: 'main', for: id },
      h('input', { type: 'checkbox', class: 'sr', id: id, checked: !it.skip && !!m[it.id], disabled: !!it.skip, 'data-chg': 'tick', 'data-id': it.id, 'data-fk': 'row:' + pass + ':' + it.id }),
      h('span', { class: 'box', 'aria-hidden': 'true' }),
      h('span', { class: 'nm' }, h('span', { class: 't', text: it.name }), parts.length ? h('span', { class: 'sub', text: parts.join('・') }) : null),
      it.qty ? h('span', { class: 'qty', text: qtyText(it.qty) }) : null);
    var acts = [], cellClass = 'racts';
    if (ui.adjust) {
      cellClass = 'racts adj';
      acts.push(h('button', { type: 'button', class: 'btn sm', 'data-act': 'skip-item', 'data-id': it.id, 'data-fk': 'skip:' + it.id, 'aria-label': (it.skip ? '改回要帶：' : '這次不帶：') + it.name, text: it.skip ? '改回要帶' : '這次不帶' }));
      if (it.temp) acts.push(h('button', { type: 'button', class: 'btn sm danger', 'data-act': 'del-temp', 'data-id': it.id, 'data-fk': 'deltmp:' + it.id, 'aria-label': '刪除臨時項目：' + it.name, text: '刪除' }));
    } else if (pass === 'return' && o.places) {
      cellClass = 'racts pcell';
      acts.push(h('button', { type: 'button', class: 'hit' + (it.ret ? '' : ' none'), 'data-act': 'cycle-place', 'data-id': it.id, 'data-fk': 'place:' + it.id,
        'aria-label': '歸還地點：' + (it.ret || '未指定') + '。按一下換成下一個', title: '歸還地點：' + (it.ret || '未指定') + '（點一下換成下一個）' },
        h('span', { class: 'pn', text: it.ret || '未指定' })));
    }
    return h('li', { class: 'row' + (it.skip ? ' skipped' : '') }, label, acts.length ? h('div', { class: cellClass }, acts) : null);
  }
  /* 換地點時的「凍結排法」：在收班歸還頁點地點格換地點，這一列依規則可能要搬到別的分組、或被目前的篩選藏起來。
   * 但使用者常常是連點同一個位置（未指定→家→成為→山上），如果列在第一下之後就搬走，第二下就點到別的列了。
   * 所以第一次換地點時把目前畫面上的分組與列記下來（hold），之後重畫都照這份排，列留在原位；
   * 等使用者自己換篩選、分組、階段、進調整模式或離開這一班，才照新的地點重排。 */
  function holdOf(run) {
    var k = ui.hold;
    return k && !ui.adjust && ui.pass === 'return' && k.runId === run.id && k.group === ui.group && k.place === ui.place ? k : null;
  }
  function layoutSnapshot(run) {
    return liveGroups(run, 'return').map(function (g) { return { key: g.key, title: g.title, showSec: g.showSec, ids: g.entries.map(function (x) { return x.i.id; }) }; });
  }
  function groupKeyOf(groups, id) {
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i], has = g.ids ? g.ids.indexOf(id) !== -1 : g.entries.some(function (x) { return x.i.id === id; });
      if (has) return g.key;
    }
    return null;
  }
  function groupsFor(run, pass) {
    var k = pass === 'return' ? holdOf(run) : null;
    if (!k) return liveGroups(run, pass);
    var byId = {};
    run.sections.forEach(function (s) { s.items.forEach(function (i) { byId[i.id] = { s: s, i: i }; }); });
    var out = [];
    k.groups.forEach(function (g) {
      var e = g.ids.map(function (id) { return byId[id]; }).filter(Boolean);
      if (e.length) out.push({ key: g.key, title: g.title, entries: e, showSec: g.showSec });
    });
    return out;
  }
  // 篩選鈕那一排在凍結期間只准變高、不准變矮：變矮會把下面的列往上推，手指底下又換了一列。
  function stabilizeChips() {
    var fc = $('#view .fchips'), run = ui.view === 'run' ? curRun() : null, k = run && holdOf(run);
    if (!fc || !k) return;
    if (k.chipH) fc.style.minHeight = k.chipH + 'px';
    k.chipH = Math.max(k.chipH || 0, Math.ceil(fc.getBoundingClientRect().height));
  }
  function liveGroups(run, pass) {
    var all = [];
    run.sections.forEach(function (s) { s.items.forEach(function (i) { all.push({ s: s, i: i }); }); });
    var byPlace = pass === 'return' && ui.group === 'place' && !ui.adjust;
    var list = all;
    if (pass === 'return' && !ui.adjust && ui.place !== 'all') list = all.filter(function (x) { return ui.place === '__none' ? !x.i.ret : ('p:' + x.i.ret) === ui.place; });
    var groups = [];
    if (byPlace) {
      placeOrder(run).forEach(function (pl) {
        var e = list.filter(function (x) { return (x.i.ret || '') === pl; });
        if (e.length) groups.push({ key: 'p:' + pl, title: pl || '未指定地點', entries: e, showSec: true });
      });
    } else {
      run.sections.forEach(function (s) {
        var e = list.filter(function (x) { return x.s === s; });
        if (e.length || (ui.adjust)) groups.push({ key: 's:' + s.id, title: s.name, entries: e, showSec: false, sec: s });
      });
    }
    return groups;
  }
  function viewRun() {
    var run = curRun(), pass = ui.pass;
    var p = progress(run, 'pack'), q = progress(run, 'return'), cur = pass === 'pack' ? p : q;
    var pct = cur.total ? Math.round(cur.done / cur.total * 100) : 0;
    var passName = pass === 'pack' ? '出發前打包' : '收班歸還';
    var meter = h('div', { class: 'meter', role: 'progressbar', 'aria-label': passName + '進度', 'aria-valuemin': '0', 'aria-valuemax': String(cur.total), 'aria-valuenow': String(cur.done) }, h('i'));
    meter.firstChild.style.width = pct + '%';
    var bar = h('div', { class: 'runbar' },
      h('div', { class: 'seg', role: 'group', 'aria-label': '清單階段' },
        h('button', { type: 'button', 'aria-pressed': String(pass === 'pack'), 'data-act': 'pass', 'data-pass': 'pack', 'data-fk': 'pass:pack' }, '出發前打包', h('small', { text: p.done + '／' + p.total })),
        h('button', { type: 'button', 'aria-pressed': String(pass === 'return'), 'data-act': 'pass', 'data-pass': 'return', 'data-fk': 'pass:return' }, '收班歸還', h('small', { text: q.done + '／' + q.total }))),
      h('div', { class: 'prog-line' }, meter, h('span', { class: 'ptxt', text: '已勾 ' + cur.done + '／' + cur.total + ' 項' })));

    var tools = null, hasPl = pass === 'return' && placeOrder(run).length > 1;   // placeOrder 最後一定多一個「未指定」，所以 >1 才代表真的有地點
    if (pass === 'return' && !ui.adjust && !hasPl) {
      // 一個歸還地點都沒有（班型頁的地點全刪光、這一班的器材也沒標地點）：地點格、分組、篩選都沒有東西可選，整組收起來並說明去哪裡加。
      ui.group = 'section'; ui.place = 'all';
      tools = h('div', { class: 'tools' }, h('p', { class: 'fine', text: '還沒有歸還地點。到「班型」頁最下面的「歸還地點」加上之後，這裡就能點地點格換地點、依地點分組。' }));
    } else if (pass === 'return' && !ui.adjust) {
      var m = run.returned, counts = { all: { d: 0, t: 0 } };
      var pk = function (ret) { return ret ? 'p:' + ret : '__none'; };
      run.sections.forEach(function (s) { s.items.forEach(function (i) {
        if (i.skip) return;
        var k = pk(i.ret); if (!counts[k]) counts[k] = { d: 0, t: 0 };
        counts[k].t++; counts.all.t++; if (m[i.id]) { counts[k].d++; counts.all.d++; }
      }); });
      // 凍結排法期間，目前選著的篩選就算已經沒有器材了也要留著（那一列還在畫面上，等使用者自己換篩選）。
      if (ui.place !== 'all' && !(counts[ui.place] && counts[ui.place].t) && !holdOf(run)) ui.place = 'all';
      var chip = function (key, label) {
        var c = counts[key] || { d: 0, t: 0 };
        return h('button', { type: 'button', 'aria-pressed': String(ui.place === key), 'data-act': 'fplace', 'data-place': key, 'data-fk': 'fp:' + key, text: label + ' ' + c.d + '／' + c.t });
      };
      var chips = [chip('all', '全部')], haveSel = ui.place === 'all';
      placeOrder(run).forEach(function (pl) {
        var k = pk(pl);
        if ((counts[k] && counts[k].t) || k === ui.place) { chips.push(chip(k, pl || '未指定')); if (k === ui.place) haveSel = true; }
      });
      if (!haveSel) chips.push(chip(ui.place, ui.place === '__none' ? '未指定' : ui.place.slice(2)));
      tools = h('div', { class: 'tools' },
        h('div', { class: 'seg two', role: 'group', 'aria-label': '分組方式' },
          h('button', { type: 'button', 'aria-pressed': String(ui.group === 'section'), 'data-act': 'group', 'data-group': 'section', 'data-fk': 'grp:section', text: '依區段' }),
          h('button', { type: 'button', 'aria-pressed': String(ui.group === 'place'), 'data-act': 'group', 'data-group': 'place', 'data-fk': 'grp:place', text: '依歸還地點' })),
        h('div', { class: 'fchips', role: 'group', 'aria-label': '只看某個歸還地點' }, chips),
        h('p', { class: 'fine', text: '每一列右邊的地點格：點一下換歸還地點。點列的其他地方是勾選。' }));
    }

    var adjustCard = ui.adjust ? h('div', { class: 'card adjust' },
      h('p', { class: 'note', text: '調整這次的清單：每件器材可以「這次不帶」（不計入進度），也能在區段底下加只這次用的臨時項目。班型本身不會被改。' }),
      h('div', { class: 'grid2' },
        h('div', { class: 'fld' }, h('label', { class: 'lbl', for: 'run-date', text: '日期' }), h('input', { type: 'date', id: 'run-date', value: run.date, 'data-chg': 'run-date', 'data-fk': 'run-date' })),
        h('div', { class: 'fld' }, h('label', { class: 'lbl', for: 'run-job', text: '工作名稱' }), h('input', { type: 'text', id: 'run-job', value: run.job, maxlength: MAX.job, 'data-chg': 'run-job', 'data-fk': 'run-job' })))) : null;

    var groups = groupsFor(run, pass), m2 = checks(run, pass);
    var secs = groups.map(function (g, gi) {
      var act = g.entries.filter(function (x) { return !x.i.skip; }), dn = act.filter(function (x) { return m2[x.i.id]; }).length;
      var rows = g.entries.map(function (x) { return itemRow(run, x.s, x.i, pass, { showSec: g.showSec, places: hasPl }); });
      var add = null;
      if (ui.adjust && g.sec) {
        add = h('form', { class: 'addrow', 'data-form': 'addtemp', 'data-sec': g.sec.id },
          h('input', { type: 'text', name: 'name', maxlength: MAX.name, autocomplete: 'off', placeholder: '臨時加一項（只這次）', 'aria-label': '臨時加一項到「' + g.title + '」', 'data-fk': 'tmp:' + g.sec.id }),
          h('button', { type: 'submit', class: 'btn', text: '加入' }));
      }
      return h('section', { class: 'sec', 'aria-labelledby': 'g' + gi },
        h('h3', { id: 'g' + gi }, h('span', { text: g.title }), h('span', { class: 'cnt' + (act.length && dn === act.length ? ' full' : ''), text: act.length ? (dn === act.length ? '全部完成 ' : '') + dn + '／' + act.length : '' })),
        h('ul', null, rows), add);
    });
    var empty = !secs.length ? h('p', { class: 'empty', text: pass === 'return' && ui.place !== 'all' ? '這個地點沒有器材。' : '這一班沒有器材。到「班型」加上器材之後再開一班。' }) : null;

    var actions = h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn', 'data-act': 'copy-left', 'data-fk': 'copy', text: '複製還沒完成的項目' }),
      h('button', { type: 'button', class: 'btn', 'aria-pressed': String(ui.adjust), 'data-act': 'toggle-adjust', 'data-fk': 'adjust', text: ui.adjust ? '完成調整' : '調整這次清單' }),
      h('button', { type: 'button', class: 'btn danger', 'data-act': 'clear-ticks', 'data-fk': 'clear', text: '全部清除勾選' }));
    var del = h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn danger', 'data-act': 'del-run', 'data-id': run.id, 'data-fk': 'delthis', text: '刪除這筆紀錄' }));

    return h('div', null,
      h('div', { class: 'pagehead' },
        h('button', { type: 'button', class: 'textbtn', 'data-act': 'back-home', 'data-fk': 'back', text: '← 回出班首頁' }),
        h('h2', { text: run.job }),
        h('p', { class: 'meta', text: fmtDate(run.date) + '・' + run.templateName })),
      bar,
      cur.total && cur.done === cur.total ? h('p', { class: 'alldone', role: 'status', text: passName + '：全部勾完了' }) : null,
      remindBox(run), adjustCard, tools, secs, empty, actions, del);
  }

  /* --- 班型 --- */
  function viewTpl() {
    var items = S.templates.map(function (t) {
      var st = tplStats(t);
      return h('li', { class: 'card item' },
        h('div', null,
          h('h3', null, t.name, h('span', { class: 'chip', text: t.kind === 'builtin' ? '內建' : t.kind === 'sample' ? '範本' : '自訂' }), tplModified(t) ? h('span', { class: 'chip mod', text: '已修改' }) : null),
          t.desc ? h('p', { text: t.desc }) : null,
          h('p', { class: 'meta', text: st.sections + ' 個區段・' + st.items + ' 件器材・提醒 ' + t.reminders.length + ' 則' + (st.open ? '（' + st.open + ' 則還沒處理）' : '') })),
        h('div', { class: 'ops' },
          h('button', { type: 'button', class: 'btn primary', 'data-act': 'use-tpl', 'data-id': t.id, 'data-fk': 'use:' + t.id, 'aria-label': '用這個班型開一班：' + t.name, text: '開一班' }),
          h('button', { type: 'button', class: 'btn', 'data-act': 'edit-tpl', 'data-id': t.id, 'data-fk': 'edit:' + t.id, 'aria-label': '編輯班型：' + t.name, text: '編輯' })));
    });
    var places = S.places.map(function (pl, i) {
      return h('li', { class: 'pl' },
        h('input', { type: 'text', value: pl, maxlength: MAX.place, 'aria-label': '歸還地點名稱', 'data-chg': 'place-name', 'data-idx': String(i), 'data-fk': 'pln:' + i }),
        h('button', { type: 'button', class: 'btn danger sm', 'data-act': 'place-del', 'data-idx': String(i), 'data-fk': 'pld:' + i, 'aria-label': '刪除歸還地點：' + pl, text: '刪除' }));
    });
    return h('div', null,
      h('h2', { class: 'tape', text: '班型' }),
      h('p', { class: 'note', text: '班型是一份可以重複使用的器材清單。開一班時會複製一份，之後改班型不會動到已經開出的清單。' }),
      h('ul', { class: 'list', 'aria-label': '班型列表' }, items),
      h('div', { class: 'actions' }, S.templates.length >= MAX.templates ? h('p', { class: 'note', text: '班型已達上限 ' + MAX.templates + ' 個。' }) : h('button', { type: 'button', class: 'btn', 'data-act': 'new-tpl', 'data-fk': 'newtpl', text: '新增空白班型' })),
      h('h2', { class: 'tape', text: '歸還地點' }),
      h('div', { class: 'card' },
        h('p', { class: 'note', text: '收班歸還時，可以依地點分組或只看某個地點。這裡的名稱改了，班型裡的器材會跟著改；刪掉的話，用到它的器材變成「未指定」。' }),
        h('ul', { 'aria-label': '歸還地點' }, places),
        S.places.length < MAX.places
          ? h('form', { class: 'pl', 'data-form': 'addplace' },
            h('input', { type: 'text', name: 'name', maxlength: MAX.place, autocomplete: 'off', placeholder: '新增地點，例：工作室', 'aria-label': '新增歸還地點', 'data-fk': 'newpl' }),
            h('button', { type: 'submit', class: 'btn', text: '加入' }))
          : h('p', { class: 'fine', text: '最多 ' + MAX.places + ' 個地點。' }),
        h('p', { class: 'err', role: 'alert', id: 'pl-err', hidden: true })));
  }

  // 編輯器裡的歸還地點下拉：窄螢幕上它和三顆 44px 的按鈕擠在同一行，只剩約 90–130px。
  // 選項只寫地點本身（「歸還地點」放在 aria-label、title 和區段上方的說明），名稱太長的獨佔一行，才不會被切掉。
  var textPx = function (t) { var w = 0; for (var k = 0; k < t.length; k++) w += t.charCodeAt(k) >= 0x2e80 ? 16 : 9; return w; };
  var retLong = function (t) { return textPx(t || '未指定') > 80; };
  function retSelect(cur, s, i) {
    var opts = [h('option', { value: '', text: '未指定', selected: !i.ret })];
    var seen = false;
    S.places.forEach(function (pl) { if (pl === i.ret) seen = true; opts.push(h('option', { value: pl, text: pl, selected: pl === i.ret })); });
    if (i.ret && !seen) opts.push(h('option', { value: i.ret, text: i.ret, selected: true }));
    return h('select', { class: 'f-ret' + (retLong(i.ret) ? ' long' : ''), title: '歸還地點', 'aria-label': '歸還地點：' + i.name, 'data-chg': 'it-ret', 'data-sec': s.id, 'data-id': i.id, 'data-fk': 'itr:' + i.id }, opts);
  }
  function tplChips(t) {
    var chips = [h('span', { class: 'chip', text: t.kind === 'builtin' ? '內建' : t.kind === 'sample' ? '範本' : '自訂' })];
    if (tplModified(t)) chips.push(h('span', { class: 'chip mod', text: '已修改' }));
    return chips;
  }
  function refreshEditorMeta() {   // 欄位就地改完不重畫整頁，標籤（已修改）要自己更新
    if (ui.view !== 'tpledit') return;
    var t = curTpl(), m = $('#view .pagehead .meta');
    if (t && m) m.replaceChildren.apply(m, tplChips(t));
  }
  function viewTplEdit() {
    var t = curTpl();
    var d = defOf(t.id);
    var chips = tplChips(t);

    var rems = t.reminders.map(function (r) {
      var rid = 'trd-' + r.id;
      return h('li', { class: 'ed-rem' },
        h('textarea', { rows: 2, maxlength: MAX.rem, 'aria-label': '提醒內容', value: r.text, 'data-chg': 'rem-text', 'data-id': r.id, 'data-fk': 'rt:' + r.id }),
        h('div', { class: 'ops' },
          h('label', { class: 'rem', for: rid },
            h('input', { type: 'checkbox', class: 'sr', id: rid, checked: r.done, 'data-chg': 'trem-done', 'data-id': r.id, 'data-fk': 'rd:' + r.id }),
            h('span', { class: 'box', 'aria-hidden': 'true' }), h('span', { class: 'tx', text: '已處理' })),
          h('button', { type: 'button', class: 'btn danger sm', 'data-act': 'rem-del', 'data-id': r.id, 'data-fk': 'rx:' + r.id, 'aria-label': '刪除提醒', text: '刪除' })));
    });

    var secs = t.sections.map(function (s, si) {
      var its = s.items.map(function (i, ii) {
        return h('li', { class: 'ed-it' },
          h('input', { type: 'text', class: 'f-name', value: i.name, maxlength: MAX.name, 'aria-label': '器材名稱', 'data-chg': 'it-name', 'data-sec': s.id, 'data-id': i.id, 'data-fk': 'itn:' + i.id }),
          h('input', { type: 'number', class: 'f-qty', value: i.qty == null ? '' : i.qty, min: 0, max: MAX.qty, inputmode: 'numeric', placeholder: '數量', 'aria-label': '數量：' + i.name + '（留空代表不寫數量）', 'data-chg': 'it-qty', 'data-sec': s.id, 'data-id': i.id, 'data-fk': 'itq:' + i.id }),
          retSelect(null, s, i),
          h('button', { type: 'button', class: 'btn mv', 'data-act': 'it-up', 'data-sec': s.id, 'data-id': i.id, 'data-fk': 'itu:' + i.id, disabled: ii === 0, 'aria-label': '上移：' + i.name, text: '↑' }),
          h('button', { type: 'button', class: 'btn mv', 'data-act': 'it-down', 'data-sec': s.id, 'data-id': i.id, 'data-fk': 'itd:' + i.id, disabled: ii === s.items.length - 1, 'aria-label': '下移：' + i.name, text: '↓' }),
          h('button', { type: 'button', class: 'btn danger sm', 'data-act': 'it-del', 'data-sec': s.id, 'data-id': i.id, 'data-fk': 'itx:' + i.id, 'aria-label': '刪除器材：' + i.name, text: '刪除' }));
      });
      return h('section', { class: 'ed-sec', 'aria-label': '區段：' + s.name },
        h('div', { class: 'ed-head' },
          h('input', { type: 'text', value: s.name, maxlength: MAX.sec, 'aria-label': '區段名稱', 'data-chg': 'sec-name', 'data-sec': s.id, 'data-fk': 'sn:' + s.id }),
          h('button', { type: 'button', class: 'btn mv', 'data-act': 'sec-up', 'data-sec': s.id, 'data-fk': 'su:' + s.id, disabled: si === 0, 'aria-label': '區段上移：' + s.name, text: '↑' }),
          h('button', { type: 'button', class: 'btn mv', 'data-act': 'sec-down', 'data-sec': s.id, 'data-fk': 'sd:' + s.id, disabled: si === t.sections.length - 1, 'aria-label': '區段下移：' + s.name, text: '↓' }),
          h('button', { type: 'button', class: 'btn danger sm', 'data-act': 'sec-del', 'data-sec': s.id, 'data-fk': 'sx:' + s.id, 'aria-label': '刪除區段：' + s.name, text: '刪除區段' })),
        h('ul', { 'aria-label': s.name + '的器材' }, its),
        h('form', { class: 'addrow', 'data-form': 'additem', 'data-sec': s.id },
          h('input', { type: 'text', name: 'name', maxlength: MAX.name, autocomplete: 'off', placeholder: '新增器材到「' + s.name + '」', 'aria-label': '新增器材到「' + s.name + '」', 'data-fk': 'add:' + s.id }),
          h('input', { type: 'number', name: 'qty', min: 1, max: MAX.qty, inputmode: 'numeric', placeholder: '數量', 'aria-label': '新器材的數量（可留空）' }),
          h('button', { type: 'submit', class: 'btn', text: '加入' })));
    });

    var acts = [h('button', { type: 'button', class: 'btn primary', 'data-act': 'use-tpl', 'data-id': t.id, 'data-fk': 'use2', text: '用這個班型開一班' }),
      h('button', { type: 'button', class: 'btn', 'data-act': 'dup-tpl', 'data-fk': 'dup', text: '複製這個班型' })];
    if (d) acts.push(h('button', { type: 'button', class: 'btn', 'data-act': 'restore-tpl', 'data-fk': 'restore', text: '還原成預設內容' }));
    else acts.push(h('button', { type: 'button', class: 'btn danger', 'data-act': 'del-tpl', 'data-fk': 'deltpl', text: '刪除這個班型' }));

    return h('div', null,
      h('div', { class: 'pagehead' },
        h('button', { type: 'button', class: 'textbtn', 'data-act': 'back-tpl', 'data-fk': 'backtpl', text: '← 回班型列表' }),
        h('h2', { id: 'tplTitle', text: t.name }), h('p', { class: 'meta' }, chips)),
      h('div', { class: 'card ed-top' },
        h('div', { class: 'fld' }, h('label', { class: 'lbl', for: 'tpl-name', text: '班型名稱' }), h('input', { type: 'text', id: 'tpl-name', value: t.name, maxlength: MAX.tpl, 'data-chg': 'tpl-name', 'data-fk': 'tpl-name' })),
        h('div', { class: 'fld' }, h('label', { class: 'lbl', for: 'tpl-desc', text: '說明（選填）' }), h('textarea', { id: 'tpl-desc', rows: 3, maxlength: MAX.desc, value: t.desc, 'data-chg': 'tpl-desc', 'data-fk': 'tpl-desc' }))),
      h('h3', { class: 'tape', text: '提醒' }),
      h('div', { class: 'card' },
        h('p', { class: 'note', text: '已知的缺口或待確認的事，開一班時會顯示在清單上方。處理完就標成已處理。' }),
        rems.length ? h('ul', { 'aria-label': '提醒' }, rems) : h('p', { class: 'fine', text: '目前沒有提醒。' }),
        t.reminders.length < MAX.reminders ? h('form', { class: 'addrow', 'data-form': 'addrem' },
          h('input', { type: 'text', name: 'text', maxlength: MAX.rem, autocomplete: 'off', placeholder: '新增一則提醒', 'aria-label': '新增一則提醒', 'data-fk': 'addrem' }),
          h('button', { type: 'submit', class: 'btn', text: '加入' })) : null),
      h('h3', { class: 'tape', text: '區段與器材' }),
      h('p', { class: 'note', text: '每件器材的下拉選單是收班歸還時要放的地點；數量留空代表不寫數量。' }),
      secs,
      h('form', { class: 'ed-sec addrow', 'data-form': 'addsec' },
        h('input', { type: 'text', name: 'name', maxlength: MAX.sec, autocomplete: 'off', placeholder: '新增區段，例：機身', 'aria-label': '新增區段', 'data-fk': 'addsec' }),
        h('button', { type: 'submit', class: 'btn', text: '加入區段' })),
      h('p', { class: 'err', role: 'alert', id: 'ed-err', hidden: true }),
      h('div', { class: 'actions' }, acts));
  }

  /* --- 備份 --- */
  function viewBackup() {
    var lb = lastBackupMs(), age = lb == null ? null : daysSince(lb);
    var line = lb == null ? '還沒有備份過' : '上次備份：' + dateText(lb) + '（' + (age === 0 ? '今天' : age + ' 天前') + '）';
    var hasData = S.rev > 0 || S.runs.length > 0;
    var hint = null;
    if (hasData && (lb == null || age > STALE_DAYS)) hint = lb == null ? '有資料但還沒備份過，建議現在下載一份。' : '已經超過 ' + STALE_DAYS + ' 天沒備份，建議現在下載一份。';
    var customN = S.templates.filter(function (t) { return t.kind === 'custom'; }).length;
    var size = 0; try { size = JSON.stringify(S).length; } catch (e) { /* 忽略 */ }
    return h('div', null,
      h('h2', { class: 'tape', text: '備份與還原' }),
      h('div', { class: 'card' },
        h('p', { id: 'lastBackup', text: line }),
        hint ? h('p', { class: 'msg bad', text: hint }) : null,
        h('dl', { class: 'facts' },
          h('div', null, h('dt', { text: '目前資料' }), h('dd', { text: S.templates.length + ' 個班型（自訂 ' + customN + ' 個）、' + S.runs.length + ' 筆出班紀錄、' + S.places.length + ' 個歸還地點' })),
          h('div', null, h('dt', { text: '大小' }), h('dd', { text: '約 ' + Math.max(1, Math.round(size / 1024)) + ' KB' })),
          h('div', null, h('dt', { text: '存放' }), h('dd', { text: storageOK ? '只存在這個瀏覽器，沒有雲端副本' : '這個瀏覽器不讓網頁存資料，目前內容不會被保留' }))),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn primary', 'data-act': 'backup-dl', 'data-fk': 'dl', text: '下載備份' }),
          h('button', { type: 'button', class: 'btn', 'data-act': 'restore-pick', 'data-fk': 'pick', text: '從備份還原' })),
        h('p', { class: 'msg' + (ui.backupMsg && ui.backupMsg.bad ? ' bad' : ''), id: 'backupMsg', role: 'status', text: ui.backupMsg ? ui.backupMsg.text : '' }),
        h('p', { class: 'note', text: '備份檔是一般的 JSON 文字檔，裡面有你的班型、出班紀錄和工作名稱，請當成私人檔案保管。換手機或清除瀏覽器資料之前，記得先下載一份。' })),
      h('h2', { class: 'tape', text: '清除' }),
      h('div', { class: 'zone' },
        h('p', { text: '清除全部資料會刪掉你改過的班型、所有出班紀錄和歸還地點，內建班型回到預設內容。這個瀏覽器裡沒有其他副本。' }),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn danger', 'data-act': 'clear-all', 'data-fk': 'clearall', text: '清除全部資料' }))));
  }

  /* ---------- 動作 ---------- */
  function showErr(id, msg) { var e = document.getElementById(id); if (!e) return; e.textContent = msg; e.hidden = !msg; }
  var runMut = function (fn, opt) {
    return commit(function (n) { var r = n.runs.find(function (x) { return x.id === ui.runId; }); if (!r) return false; var x = fn(r, n); r.updatedAt = nowIso(); return x; }, opt);
  };
  var tplMut = function (fn, opt) {
    return commit(function (n) { var t = n.templates.find(function (x) { return x.id === ui.tplId; }); if (!t) return false; return fn(t, n); }, opt);
  };
  var findSec = function (t, id) { return t.sections.find(function (s) { return s.id === id; }); };
  function move(arr, idx, d) { var j = idx + d; if (j < 0 || j >= arr.length) return false; var x = arr[idx]; arr[idx] = arr[j]; arr[j] = x; return true; }

  function openRun(id) {
    var r = S.runs.find(function (x) { return x.id === id; });
    if (!r) return;
    var p = progress(r, 'pack'), q = progress(r, 'return');
    ui.runId = id; ui.view = 'run'; ui.adjust = false; ui.group = 'section'; ui.place = 'all'; ui.hold = null;
    ui.pass = p.total && p.done === p.total && q.done < q.total ? 'return' : 'pack';
    render(); window.scrollTo(0, 0);
    var hd = $('#view h2'); if (hd) { hd.setAttribute('tabindex', '-1'); hd.focus({ preventScroll: true }); }
  }

  var ACT = {
    'open-run': function (b) { openRun(b.dataset.id); },
    'back-home': function () { go('home'); },
    'del-run': function (b) {
      var id = b.dataset.id, r = S.runs.find(function (x) { return x.id === id; });
      if (!r) return;
      confirmBox('刪除這筆出班紀錄', '「' + r.job + '」（' + r.date + '）的勾選紀錄會被刪掉，班型不受影響。', '刪除', true).then(function (ok) {
        if (!ok) return;
        var prev = clone(S);
        ui.nextFocus = ui.view === 'run' ? null : 'nr-tpl';
        if (commit(function (n) { n.runs = n.runs.filter(function (x) { return x.id !== id; }); })) {
          if (ui.view === 'run') go('home');
          undoToast('已刪除「' + r.job + '」', prev);
        }
      });
    },
    'pass': function (b) { ui.pass = b.dataset.pass; ui.hold = null; ui.nextFocus = 'pass:' + ui.pass; render(); },
    'group': function (b) { ui.group = b.dataset.group; ui.hold = null; ui.nextFocus = 'grp:' + ui.group; render(); },
    'fplace': function (b) { ui.place = b.dataset.place; ui.hold = null; ui.nextFocus = 'fp:' + ui.place; render(); },
    'cycle-place': function (b) {
      var id = b.dataset.id, run = curRun(), nm = '', to = '';
      if (!run) return;
      // 點一下只換這一格的字：列的位置、高度、分組、篩選都先不動（凍結排法，見 holdOf）。
      // 沒有凍結過就把現在畫面上的排法記下來；重畫後再把這一格補回原本的螢幕位置，連點同一個位置才會一直點到同一列。
      if (!holdOf(run)) {
        var fc = $('#view .fchips');
        ui.hold = { runId: run.id, group: ui.group, place: ui.place, groups: layoutSnapshot(run), chipH: fc ? Math.ceil(fc.getBoundingClientRect().height) : 0 };
      }
      ui.anchor = anchorOf(b);
      ui.nextFocus = ['place:' + id, 'fp:' + ui.place, 'grp:' + ui.group];
      var ok = runMut(function (r) {
        var it = null;
        r.sections.forEach(function (s) { s.items.forEach(function (i) { if (i.id === id) it = i; }); });
        if (!it) return false;
        var list = [''].concat(placeOrder(r).filter(Boolean));   // 未指定、設定好的地點，再接上這一班裡出現過但已不在設定裡的名稱
        if (list.length < 2) return false;                         // 沒有任何地點可換（畫面上本來就不會出現這一格）
        var k = list.indexOf(it.ret); it.ret = list[(k + 1) % list.length];
        nm = it.name; to = it.ret || '未指定';
      });
      if (!ok) { ui.hold = null; ui.anchor = null; render(); return; }
      // 這一列依目前的篩選或分組已經不屬於原本那裡了：它還留在原位，用提示講清楚去了哪裡，不要讓人以為它不見了。
      var cur = curRun(), now = groupKeyOf(liveGroups(cur, 'return'), id), was = groupKeyOf(ui.hold.groups, id);
      if (now !== was) showPlaceNote(id, nm + ' 已移到「' + to + '」。這一列先留在原位，換篩選或分組後才會歸到新地點。');
      else { clearPlaceNote(); say(nm + '的歸還地點：' + to); }   // 又回到原本的分組：先前那則「已移到…」就不對了，收掉
    },
    'skip-item': function (b) {
      var id = b.dataset.id;
      var ok = runMut(function (r) {
        var it = null; r.sections.forEach(function (s) { s.items.forEach(function (i) { if (i.id === id) it = i; }); });
        if (!it) return false;
        if (it.skip) delete it.skip; else { it.skip = true; delete r.packed[id]; delete r.returned[id]; }
      });
      if (!ok) render();
    },
    'del-temp': function (b) {
      var id = b.dataset.id, nm = '', sid = null, cr = curRun();
      var prev = clone(S);
      if (cr) cr.sections.forEach(function (s) { s.items.forEach(function (i) { if (i.id === id) sid = s.id; }); });
      ui.nextFocus = ['tmp:' + sid, 'adjust'];   // 刪掉的那一列不在了，焦點留在同一區段的「臨時加一項」欄，不要掉到頁面頂端
      if (runMut(function (r) {
        r.sections.forEach(function (s) { s.items = s.items.filter(function (i) { if (i.id === id && i.temp) { nm = i.name; return false; } return true; }); });
        delete r.packed[id]; delete r.returned[id];
      })) undoToast('已刪除臨時項目「' + nm + '」', prev);
      else ui.nextFocus = null;
    },
    'toggle-adjust': function () { ui.adjust = !ui.adjust; ui.hold = null; ui.nextFocus = 'adjust'; render(); },
    'clear-ticks': function () {
      var pass = ui.pass, name = pass === 'pack' ? '出發前打包' : '收班歸還';
      confirmBox('全部清除勾選', '要把「' + name + '」的勾選全部清掉嗎？（' + (pass === 'pack' ? '收班歸還' : '出發前打包') + '的勾選不受影響。）', '全部清除', true).then(function (ok) {
        if (!ok) return;
        var prev = clone(S);
        if (runMut(function (r) { if (pass === 'pack') r.packed = {}; else r.returned = {}; })) undoToast('已清除「' + name + '」的勾選', prev);
      });
    },
    'copy-left': function () { var r = curRun(); if (r) copyText(leftText(r, ui.pass), ui.pass === 'pack' ? '還沒打包的項目' : '還沒歸還的項目'); },

    'use-tpl': function (b) { ui.homeTpl = b.dataset.id; go('home'); var s = $('#nr-tpl'); if (s) s.focus({ preventScroll: true }); },
    'edit-tpl': function (b) { ui.tplId = b.dataset.id; ui.view = 'tpledit'; render(); window.scrollTo(0, 0); var hd = $('#view h2'); if (hd) { hd.setAttribute('tabindex', '-1'); hd.focus({ preventScroll: true }); } },
    'back-tpl': function () { go('tpl'); },
    'new-tpl': function () {
      var id = uid(new Set(S.templates.map(function (t) { return t.id; })));
      if (commit(function (n) { n.templates.push({ id: id, kind: 'custom', name: '新班型', desc: '', reminders: [], sections: [] }); }, { render: false })) { ui.tplId = id; ui.view = 'tpledit'; ui.nextFocus = 'tpl-name'; render(); window.scrollTo(0, 0); var el = $('#tpl-name'); if (el) el.select(); }
    },
    'dup-tpl': function () {
      var t = curTpl(); if (!t) return;
      if (S.templates.length >= MAX.templates) { toast('班型已達上限 ' + MAX.templates + ' 個', { bad: true }); return; }
      var id = uid(new Set(S.templates.map(function (x) { return x.id; })));
      var copy = clone(t), tk = new Set();
      copy.id = id; copy.kind = 'custom'; copy.name = str(t.name + '（複本）', MAX.tpl);
      copy.reminders.forEach(function (r) { r.id = uid(tk); });
      copy.sections.forEach(function (s) { s.id = uid(tk); s.items.forEach(function (i) { i.id = uid(tk); }); });
      if (commit(function (n) { n.templates.push(copy); }, { render: false })) { ui.tplId = id; ui.nextFocus = 'tpl-name'; render(); window.scrollTo(0, 0); toast('已複製成「' + copy.name + '」，現在編輯的是複本'); }
    },
    'restore-tpl': function () {
      var t = curTpl(), d = t && defOf(t.id); if (!d) return;
      confirmBox('還原成預設內容', '「' + t.name + '」會回到內建的預設內容，你對它做過的修改（名稱、區段、器材、提醒）都會被蓋掉。已經開出的清單不受影響。', '還原', true).then(function (ok) {
        if (!ok) return;
        var prev = clone(S);
        if (tplMut(function (x) {
          var dn = {}; x.reminders.forEach(function (r) { dn[r.id] = r.done; });
          var c = clone(d); c.reminders.forEach(function (r) { if (dn[r.id]) r.done = true; });
          x.name = c.name; x.desc = c.desc; x.reminders = c.reminders; x.sections = c.sections;
        })) undoToast('已還原「' + d.name + '」', prev);
      });
    },
    'del-tpl': function () {
      var t = curTpl(); if (!t || defOf(t.id)) return;
      confirmBox('刪除班型', '「' + t.name + '」會被刪掉。已經用它開出的清單不受影響。', '刪除', true).then(function (ok) {
        if (!ok) return;
        var prev = clone(S), id = t.id, nm = t.name;
        if (commit(function (n) { n.templates = n.templates.filter(function (x) { return x.id !== id; }); })) { go('tpl'); undoToast('已刪除「' + nm + '」', prev); }
      });
    },
    'sec-up': function (b) { secMove(b.dataset.sec, -1, ['su:', 'sd:']); },
    'sec-down': function (b) { secMove(b.dataset.sec, 1, ['sd:', 'su:']); },
    'sec-del': function (b) {
      var sid = b.dataset.sec, t = curTpl(), s = t && findSec(t, sid); if (!s) return;
      var del = function () {
        var prev = clone(S);
        ui.nextFocus = 'addsec';
        if (tplMut(function (x) { x.sections = x.sections.filter(function (y) { return y.id !== sid; }); })) undoToast('已刪除區段「' + s.name + '」', prev);
      };
      if (!s.items.length) del();
      else confirmBox('刪除區段', '「' + s.name + '」連同裡面的 ' + s.items.length + ' 件器材會被刪掉。', '刪除', true).then(function (ok) { if (ok) del(); });
    },
    'it-up': function (b) { itMove(b.dataset.sec, b.dataset.id, -1, ['itu:', 'itd:']); },
    'it-down': function (b) { itMove(b.dataset.sec, b.dataset.id, 1, ['itd:', 'itu:']); },
    'it-del': function (b) {
      var sid = b.dataset.sec, id = b.dataset.id, nm = '';
      var prev = clone(S);
      ui.nextFocus = 'add:' + sid;
      if (tplMut(function (t) { var s = findSec(t, sid); if (!s) return false; s.items = s.items.filter(function (i) { if (i.id === id) nm = i.name; return i.id !== id; }); })) undoToast('已刪除「' + nm + '」', prev);
    },
    'rem-del': function (b) {
      var id = b.dataset.id, prev = clone(S);
      ui.nextFocus = 'addrem';
      if (tplMut(function (t) { t.reminders = t.reminders.filter(function (r) { return r.id !== id; }); })) undoToast('已刪除一則提醒', prev);
    },
    'place-del': function (b) {
      var idx = +b.dataset.idx, name = S.places[idx], prev = clone(S);
      if (name == null) return;
      ui.nextFocus = ['pld:' + idx, 'newpl'];
      if (commit(function (n) {
        n.places.splice(idx, 1);
        n.templates.forEach(function (t) { t.sections.forEach(function (s) { s.items.forEach(function (i) { if (i.ret === name) i.ret = ''; }); }); });
      })) undoToast('已刪除地點「' + name + '」', prev);
    },
    'backup-dl': function () { downloadBackup(); },
    'restore-pick': function () { var f = $('#restoreFile'); f.value = ''; f.click(); },
    'clear-all': function () { clearAll(); }
  };
  function secMove(sid, d, fk) {
    ui.nextFocus = fk.map(function (p) { return p + sid; });
    var ok = tplMut(function (t) { var i = t.sections.findIndex(function (s) { return s.id === sid; }); return move(t.sections, i, d) ? undefined : false; });
    if (!ok) ui.nextFocus = null;
  }
  function itMove(sid, id, d, fk) {
    ui.nextFocus = fk.map(function (p) { return p + id; });
    var ok = tplMut(function (t) { var s = findSec(t, sid); if (!s) return false; var i = s.items.findIndex(function (x) { return x.id === id; }); return move(s.items, i, d) ? undefined : false; });
    if (!ok) ui.nextFocus = null;
  }

  var CHG = {
    'tick': function (el) {
      var id = el.dataset.id, on = el.checked, pass = ui.pass;
      ui.anchor = anchorOf(el);   // 勾到最後一項時上方會多出「全部勾完了」那一行：補捲動，被勾的那一列不會跳走
      var ok = runMut(function (r) { var m = checks(r, pass); if (on) m[id] = true; else delete m[id]; });
      if (!ok) render();
    },
    'run-rem': function (el) {
      var id = el.dataset.id, on = el.checked;
      var ok = runMut(function (r, n) {
        var x = r.reminders.find(function (y) { return y.id === id; }); if (!x) return false; x.done = on;
        var t = n.templates.find(function (y) { return y.id === r.templateId; });
        var tr = t && t.reminders.find(function (y) { return y.id === id; });
        if (tr) tr.done = on;
      });
      if (!ok) render();
    },
    'run-job': function (el) {
      var v = str(el.value, MAX.job);
      if (!v) { el.value = curRun().job; toast('工作名稱不能空白', { bad: true }); return; }
      if (runMut(function (r) { r.job = v; }, { render: false })) { el.value = v; var t = $('#view .pagehead h2'); if (t) t.textContent = v; }
    },
    'run-date': function (el) {
      if (!validDate(el.value)) { el.value = curRun().date; toast('日期格式不對', { bad: true }); return; }
      var v = el.value;
      if (runMut(function (r) { r.date = v; }, { render: false })) { var m = $('#view .pagehead .meta'); if (m) m.textContent = fmtDate(v) + '・' + curRun().templateName; }
    },
    'tpl-name': function (el) {
      var v = str(el.value, MAX.tpl), t = curTpl();
      if (!v) { el.value = t.name; toast('班型名稱不能空白', { bad: true }); return; }
      if (tplMut(function (x) { x.name = v; }, { render: false })) { el.value = v; var h2 = $('#tplTitle'); if (h2) h2.textContent = v; }
    },
    'tpl-desc': function (el) { var v = str(el.value, MAX.desc); if (tplMut(function (x) { x.desc = v; }, { render: false })) el.value = v; },
    'sec-name': function (el) {
      var sid = el.dataset.sec, v = str(el.value, MAX.sec), t = curTpl(), s = t && findSec(t, sid);
      if (!s) return;
      if (!v) { el.value = s.name; toast('區段名稱不能空白', { bad: true }); return; }
      if (tplMut(function (x) { var y = findSec(x, sid); if (!y) return false; y.name = v; }, { render: false })) el.value = v;
    },
    'it-name': function (el) {
      var sid = el.dataset.sec, id = el.dataset.id, v = str(el.value, MAX.name);
      var t = curTpl(), s = t && findSec(t, sid), it = s && s.items.find(function (i) { return i.id === id; });
      if (!it) return;
      if (!v) { el.value = it.name; toast('器材名稱不能空白', { bad: true }); return; }
      if (tplMut(function (x) { var y = findSec(x, sid); var z = y && y.items.find(function (i) { return i.id === id; }); if (!z) return false; z.name = v; }, { render: false })) el.value = v;
    },
    'it-qty': function (el) {
      var sid = el.dataset.sec, id = el.dataset.id, raw = el.value.trim(), q = null;
      if (raw !== '') { var n = Number(raw); q = Number.isInteger(n) && n >= 1 ? Math.min(n, MAX.qty) : null; }
      if (tplMut(function (x) { var y = findSec(x, sid); var z = y && y.items.find(function (i) { return i.id === id; }); if (!z) return false; z.qty = q; }, { render: false })) el.value = q == null ? '' : q;
    },
    'it-ret': function (el) {
      var sid = el.dataset.sec, id = el.dataset.id, v = el.value;
      var ok = tplMut(function (x) { var y = findSec(x, sid); var z = y && y.items.find(function (i) { return i.id === id; }); if (!z) return false; z.ret = v; }, { render: false });
      if (!ok) render(); else el.classList.toggle('long', retLong(v));
    },
    'rem-text': function (el) {
      var id = el.dataset.id, v = str(el.value, MAX.rem), t = curTpl(), r = t && t.reminders.find(function (x) { return x.id === id; });
      if (!r) return;
      if (!v) { el.value = r.text; toast('提醒內容不能空白（不要的話請按刪除）', { bad: true }); return; }
      if (tplMut(function (x) { var y = x.reminders.find(function (z) { return z.id === id; }); if (!y) return false; y.text = v; }, { render: false })) el.value = v;
    },
    'trem-done': function (el) {
      var id = el.dataset.id, on = el.checked;
      var ok = tplMut(function (x) { var y = x.reminders.find(function (z) { return z.id === id; }); if (!y) return false; y.done = on; }, { render: false });
      if (!ok) render();
    },
    'place-name': function (el) {
      var idx = +el.dataset.idx, old = S.places[idx], v = str(el.value, MAX.place);
      if (old == null) return;
      if (!v) { el.value = old; showErr('pl-err', '地點名稱不能空白（不要的話請按刪除）'); return; }
      if (S.places.some(function (p, i) { return i !== idx && p === v; })) { el.value = old; showErr('pl-err', '已經有叫「' + v + '」的地點了'); return; }
      showErr('pl-err', '');
      if (v === old) { el.value = v; return; }
      if (commit(function (n) {
        n.places[idx] = v;
        n.templates.forEach(function (t) { t.sections.forEach(function (s) { s.items.forEach(function (i) { if (i.ret === old) i.ret = v; }); }); });
      }, { render: false })) el.value = v;
    }
  };

  var FORM = {
    'newrun': function (f) {
      var tplId = f.elements.tpl.value, date = f.elements.date.value, job = str(f.elements.job.value, MAX.job);
      var t = S.templates.find(function (x) { return x.id === tplId; });
      if (!t) { showErr('nr-err', '請先選一個班型'); return; }
      if (!validDate(date)) { showErr('nr-err', '日期不對，請選一個日期'); f.elements.date.focus(); return; }
      if (!t.sections.some(function (s) { return s.items.length; })) { showErr('nr-err', '這個班型還沒有器材，請先到「班型」加幾項再開班'); return; }
      showErr('nr-err', '');
      var id = uid(new Set(S.runs.map(function (r) { return r.id; })));
      ui.homeTpl = tplId;
      if (commit(function (n) {
        n.runs.push(makeRun(n.templates.find(function (x) { return x.id === tplId; }), job, date, id));
        n.runs.sort(byRecent);
        n.runs = n.runs.slice(0, MAX.runs);
      }, { render: false })) { openRun(id); }
    },
    'addtemp': function (f) {
      var sid = f.dataset.sec, name = str(f.elements.name.value, MAX.name);
      if (!name) { f.elements.name.focus(); return; }
      ui.nextFocus = 'tmp:' + sid;
      runMut(function (r) {
        var s = r.sections.find(function (x) { return x.id === sid; }); if (!s) return false;
        var taken = new Set(); r.sections.forEach(function (x) { taken.add(x.id); x.items.forEach(function (i) { taken.add(i.id); }); });
        s.items.push({ id: uid(taken), name: name, qty: null, ret: '', temp: true });
      });
    },
    'additem': function (f) {
      var sid = f.dataset.sec, name = str(f.elements.name.value, MAX.name), qn = Number(f.elements.qty.value);
      var q = f.elements.qty.value.trim() !== '' && Number.isInteger(qn) && qn >= 1 ? Math.min(qn, MAX.qty) : null;
      if (!name) { f.elements.name.focus(); return; }
      var t = curTpl(), total = 0; t.sections.forEach(function (s) { total += s.items.length; });
      var s0 = findSec(t, sid);
      if (total >= MAX.totalItems || (s0 && s0.items.length >= MAX.items)) { showErr('ed-err', '器材數量已達上限'); return; }
      showErr('ed-err', '');
      ui.nextFocus = 'add:' + sid;
      tplMut(function (x) {
        var s = findSec(x, sid); if (!s) return false;
        var taken = new Set(); x.sections.forEach(function (y) { taken.add(y.id); y.items.forEach(function (i) { taken.add(i.id); }); }); x.reminders.forEach(function (r) { taken.add(r.id); });
        s.items.push({ id: uid(taken), name: name, qty: q, ret: '' });
      });
    },
    'addsec': function (f) {
      var name = str(f.elements.name.value, MAX.sec), t = curTpl();
      if (!name) { f.elements.name.focus(); return; }
      if (t.sections.length >= MAX.sections) { showErr('ed-err', '區段數量已達上限'); return; }
      showErr('ed-err', '');
      var nid = null;
      if (tplMut(function (x) {
        var taken = new Set(); x.sections.forEach(function (y) { taken.add(y.id); y.items.forEach(function (i) { taken.add(i.id); }); });
        nid = uid(taken); x.sections.push({ id: nid, name: name, items: [] });
      }, { render: false })) { ui.nextFocus = 'add:' + nid; render(); }
    },
    'addrem': function (f) {
      var text = str(f.elements.text.value, MAX.rem);
      if (!text) { f.elements.text.focus(); return; }
      ui.nextFocus = 'addrem';
      tplMut(function (x) {
        if (x.reminders.length >= MAX.reminders) return false;
        var taken = new Set(); x.reminders.forEach(function (r) { taken.add(r.id); }); x.sections.forEach(function (y) { taken.add(y.id); y.items.forEach(function (i) { taken.add(i.id); }); });
        x.reminders.push({ id: uid(taken), text: text, done: false });
      });
    },
    'addplace': function (f) {
      var v = str(f.elements.name.value, MAX.place);
      if (!v) { f.elements.name.focus(); return; }
      if (S.places.indexOf(v) !== -1) { showErr('pl-err', '已經有叫「' + v + '」的地點了'); return; }
      showErr('pl-err', '');
      ui.nextFocus = 'newpl';
      commit(function (n) { if (n.places.length >= MAX.places) return false; n.places.push(v); });
    }
  };

  /* ---------- 備份與還原、清除 ---------- */
  function downloadBackup() {
    var payload = { kind: 'toolbox.gear', v: 1, exportedAt: nowIso(), data: { templates: S.templates, runs: S.runs, places: S.places } };
    var d = new Date(), name = 'gear-backup-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json';
    var url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    var a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    markToolbox({ lastBackupAt: nowIso() });
    ui.backupMsg = { bad: false, text: '已下載 ' + name };
    if (ui.view === 'backup') { ui.nextFocus = 'dl'; render(); }
    say('已下載備份檔 ' + name);
  }
  function backupFail(text) {
    text = noBidi(text);   // 訊息裡若回顯了備份檔的文字，最後一道也把雙向控制字元濾掉
    ui.backupMsg = { bad: true, text: text };
    if (ui.view === 'backup') render();
    toast(text, { bad: true });
  }
  async function onRestoreFile(file) {
    if (!file) return;
    if (file.size > MAX.file) return backupFail('這個檔案太大了（超過 5 MB），不是這個工具匯出的備份檔。');
    var obj;
    try { obj = JSON.parse(await file.text()); } catch (e) { return backupFail('讀不出這個檔案：它不是有效的 JSON。'); }
    if (!isObj(obj) || obj.kind !== 'toolbox.gear') return backupFail('這不是「出班器材檢查表」的備份檔，沒有還原。');
    if (obj.v !== 1) {
      // 錯誤訊息裡不能出現 undefined／null／NaN／Infinity 這種原始字眼：沒有版本、版本欄位型別不對、
      // 版本是別的數字、完全看不懂，各說各的。字串版本（連 "1" 也是）要明講「是文字、不是數字」，不能寫成「版本 1 不認得」。
      var v = obj.v;
      if (v === undefined) return backupFail('備份檔缺少版本資訊，沒有還原。');
      if (typeof v === 'number' && isFinite(v)) return backupFail('備份檔的版本（' + str(String(v), 12) + '）這個頁面不認得，沒有還原。');
      var vs = typeof v === 'string' ? str(noBidi(v), 10) : '';
      if (!vs || /^(undefined|null|nan|[+-]?infinity)$/i.test(vs)) return backupFail('備份檔的版本資訊看不懂，沒有還原。');
      return backupFail('備份檔的版本欄位是文字「' + vs + (str(noBidi(v), 4000).length > 10 ? '…' : '') + '」，應該是數字 1，沒有還原。');
    }
    var d = sanitizeData(obj.data);
    if (!d) return backupFail('備份檔的內容格式不對，沒有還原。');
    var custom = d.templates.filter(function (t) { return t.kind === 'custom'; }).length;
    var when = Date.parse(obj.exportedAt);
    var list = h('ul', null,
      h('li', { text: '班型：' + d.templates.length + ' 個（自訂 ' + custom + ' 個）' }),
      h('li', { text: '出班紀錄：' + d.runs.length + ' 筆' }),
      h('li', { text: '歸還地點：' + d.places.length + ' 個' }),
      isNaN(when) ? null : h('li', { text: '備份時間：' + dateText(when) }));
    var ok = await confirmBox('還原備份', '還原會取代目前所有的班型、出班紀錄和歸還地點，取代之後沒辦法還原回現在這份。備份檔裡有：', '取代並還原', true, list);
    if (!ok) { ui.backupMsg = { bad: false, text: '已取消，資料沒有改變。' }; if (ui.view === 'backup') render(); return; }
    if (commit(function (n) { n.templates = d.templates; n.runs = d.runs; n.places = d.places; }, { render: false })) {
      markNow();   // 共用規則：還原成功就馬上更新紀錄（有資料、現在更新），不等 60 秒節流、也不等下次載入；lastBackupAt 維持原樣，備份頁的「上次備份」讀的就是它
      ui.backupMsg = { bad: false, text: '已還原：' + d.templates.length + ' 個班型、' + d.runs.length + ' 筆出班紀錄。' };
      if (ui.view === 'run' || ui.view === 'tpledit') ui.view = 'backup';
      render();
      toast('已還原備份');
    }
  }
  async function clearAll() {
    var ok = await confirmBox('清除全部資料', '會刪掉你改過的班型、所有出班紀錄和歸還地點，內建班型回到預設內容。這個瀏覽器裡沒有其他副本，清掉就回不來了。建議先下載備份。', '全部清除', true);
    if (!ok) return;
    if (stale) { flagStale(); return; }
    if (storageOK) {
      try {
        if (revOf(localStorage.getItem(KEY)) !== baseRev) { flagStale(); return; }
        localStorage.removeItem(KEY); localStorage.removeItem(KEY + '.bad');
      } catch (e) { setNoStore(); }
    }
    S = fresh(); baseRev = 0; corruptRaw = null; $('#bnCorrupt').hidden = true;
    markEmpty();
    ui.view = 'backup'; ui.runId = null; ui.tplId = null; ui.homeTpl = null; ui.backupMsg = { bad: false, text: '已清除全部資料。' };
    render(); toast('已清除全部資料');
  }

  /* ---------- 事件 ---------- */
  function bind() {
    var view = $('#view');
    view.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || b.disabled || !view.contains(b)) return;
      var fn = ACT[b.dataset.act];
      if (fn) { e.preventDefault(); fn(b, e); }
    });
    view.addEventListener('change', function (e) {
      var el = e.target.closest('[data-chg]');
      if (!el) return;
      var fn = CHG[el.dataset.chg];
      if (fn) { fn(el, e); refreshEditorMeta(); }
    });
    view.addEventListener('submit', function (e) {
      var f = e.target.closest('form[data-form]');
      if (!f) return;
      e.preventDefault();
      var fn = FORM[f.dataset.form];
      if (fn) fn(f);
    });
    $('#tabs').addEventListener('click', function (e) { var b = e.target.closest('button[data-view]'); if (b) go(b.dataset.view); });
    $('#reloadBtn').addEventListener('click', function () { location.reload(); });
    window.addEventListener('resize', applyBarPad);
    $('#restoreFile').addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; e.target.value = ''; onRestoreFile(f); });
    window.addEventListener('storage', function (e) {
      try { if (e.storageArea && e.storageArea !== window.localStorage) return; } catch (x) { return; }
      if (e.key === BK) { if (ui.view === 'backup') render(); return; }
      if (e.key !== null && e.key !== KEY) return;
      var r = loadState();
      S = r.state; baseRev = r.rev; stale = false; ui.hold = null; $('#bnStale').hidden = true;
      if (r.corrupt) { corruptRaw = r.corrupt; $('#bnCorrupt').hidden = false; }
      reconcileRecord();
      render(true);
      toast('另一個分頁更新了資料，這一頁已經同步');
    });
  }

  function init() {
    var r = loadState();
    S = r.state; baseRev = r.rev; storageOK = r.ok;
    if (!storageOK) $('#bnNoStore').hidden = false;
    if (r.corrupt) { corruptRaw = r.corrupt; $('#bnCorrupt').hidden = false; }
    reconcileRecord();
    bind();
    render();
  }
  init();
})();
