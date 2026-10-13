/* 每週回顧
 * 唯讀：從同一個網站上的其他工具讀資料（個人記帳、健康與健身的 IndexedDB；到期日管家、語言每日複習、拍攝日通告的 localStorage），
 * 絕不寫入、不建立它們的儲存。唯一會寫的是自己的回顧筆記（localStorage 'toolbox.weekly.v1'）
 * 和共用備份紀錄 'toolbox.backup.v1' 裡 'weekly' 那一筆（只放有沒有資料、最後儲存、最後備份）。不連網。
 */
(function () {
  'use strict';

  var C = window.WeeklyCore;
  var ID = 'weekly';
  var KEY = 'toolbox.weekly.v1';
  var SHARED_KEY = 'toolbox.backup.v1';
  var KIND = 'toolbox.weekly';
  var MAX_BACKUP_BYTES = 5 * 1024 * 1024;
  var SOURCE_KEYS = { expiry: 'toolbox.expiry.v1', study: 'toolbox.study.v1', callsheet: 'toolbox.callsheet.v1' };
  var TOOL = {
    money: { id: 'money-report', name: '個人記帳' },
    health: { id: 'health-fitness', name: '健康與健身' },
    expiry: { id: 'expiry', name: '到期日管家' },
    study: { id: 'study', name: '語言每日複習' },
    callsheet: { id: 'callsheet', name: '拍攝日通告' }
  };
  var REPEAT_LABEL = { none: '', monthly: '每月', yearly: '每年' };
  var LIST_CAP = 8;
  var FIRST_WEEK = '2000-01-01', LAST_WEEK = '2099-12-31';

  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------------ 小工具 */
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (/^(aria-|data-)/.test(k) || k === 'role') el.setAttribute(k, v);
      else el[k] = v;
    });
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function say(el, text, kind) {
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }
  function download(name, mime, text) {
    var url = URL.createObjectURL(new Blob([text], { type: mime }));
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function compact(s) { return s.replace(/-/g, ''); }
  // 連到首頁的某個工具（在最上層視窗開，不是在 iframe 裡再開一層）
  function toolLink(id, text, cls) {
    return h('a', { class: cls || 'btn', href: '../#' + id, target: '_top', rel: 'noopener', text: text });
  }

  /* ------------------------------------------------------------------ 讀其他工具的資料（全部唯讀） */
  function readLs(key) {
    var raw;
    try { raw = localStorage.getItem(key); } catch (e) { return { status: 'unavailable' }; }
    if (raw === null) return { status: 'missing' };
    try { return { status: 'ok', value: JSON.parse(raw) }; } catch (e) { return { status: 'broken' }; }
  }

  // 讀 IndexedDB 裡的一筆紀錄。規矩：
  //  1. 沒有 indexedDB.databases() 就不碰（回 unsupported）；先看清單，沒有這個資料庫就不開（開了會把它建出來）。
  //  2. 開的時候不帶版本號；萬一開的瞬間資料庫被刪掉、變成要建新的，立刻中止建立。
  //  3. 只用 readonly 交易；被要求升級時（versionchange）立刻關閉；用完關閉。
  function readIdb(dbName, storeName, key) {
    return new Promise(function (resolve) {
      var idb = window.indexedDB;
      if (!idb || typeof idb.databases !== 'function') { resolve({ status: 'unsupported' }); return; }
      var done = false, db = null, timer = null;
      function finish(r) {
        if (done) return;
        done = true; clearTimeout(timer);
        if (db) { try { db.close(); } catch (e) { /* 已經關了 */ } }
        resolve(r);
      }
      timer = setTimeout(function () { finish({ status: 'error' }); }, 8000);
      var p;
      try { p = idb.databases(); } catch (e) { finish({ status: 'unsupported' }); return; }
      Promise.resolve(p).then(function (list) {
        if (done) return;
        var found = Array.isArray(list) && list.some(function (d) { return d && d.name === dbName; });
        if (!found) { finish({ status: 'missing' }); return; }
        var req;
        try { req = idb.open(dbName); } catch (e) { finish({ status: 'error' }); return; }
        req.onupgradeneeded = function () {
          try { req.transaction.abort(); } catch (e) { /* 中止不了也不往下做 */ }
          finish({ status: 'missing' });
        };
        req.onerror = function () { finish({ status: 'error' }); };
        req.onblocked = function () { /* 我們不升級，不會擋到別人 */ };
        req.onsuccess = function () {
          var opened = req.result;
          opened.onversionchange = function () { try { opened.close(); } catch (e) { /* 已經關了 */ } };
          if (done) { try { opened.close(); } catch (e) { /* 已經結束 */ } return; }
          db = opened;
          if (!db.objectStoreNames.contains(storeName)) { finish({ status: 'empty' }); return; }
          var tx, value;
          try { tx = db.transaction(storeName, 'readonly'); } catch (e) { finish({ status: 'error' }); return; }
          var get = tx.objectStore(storeName).get(key);
          get.onsuccess = function () { value = get.result; };
          tx.oncomplete = function () { finish(value === undefined ? { status: 'empty' } : { status: 'ok', value: value }); };
          tx.onerror = tx.onabort = function () { finish({ status: 'error' }); };
        };
      }, function () { finish({ status: 'unsupported' }); });
    });
  }

  var idbCache = { money: null, health: null };
  var IDB_CFG = {
    money: { db: 'eric-money-ledger', store: 'ledger', key: 'main', reduce: C.reduceLedger },
    health: { db: 'eric-health-training', store: 'health', key: 'main', reduce: C.reduceHealth }
  };
  // 20 秒內換週不重讀；按「重新讀取」或回到分頁時才重讀
  function loadIdb(kind, force) {
    var c = idbCache[kind];
    if (!force && c && Date.now() - c.at < 20000) return c.p;
    var cfg = IDB_CFG[kind];
    var p = readIdb(cfg.db, cfg.store, cfg.key).then(function (r) {
      if (r.status !== 'ok') return r;
      var m = null;
      try { m = cfg.reduce(r.value); } catch (e) { m = null; }
      return m && m.ok ? { status: 'ok', model: m } : { status: 'unreadable' };
    });
    idbCache[kind] = { at: Date.now(), p: p };
    p.then(function (r) { if (r.status === 'error' && idbCache[kind] && idbCache[kind].p === p) idbCache[kind] = null; });
    return p;
  }

  /* ------------------------------------------------------------------ 共用備份紀錄（只寫自己這一筆，只放狀態） */
  function readSharedAll() {
    try {
      var o = JSON.parse(localStorage.getItem(SHARED_KEY) || '');
      return o && o.v === 1 && o.tools && typeof o.tools === 'object' ? o : null;
    } catch (e) { return null; }
  }
  function readSharedEntry() {
    var o = readSharedAll(), e = o && Object.prototype.hasOwnProperty.call(o.tools, ID) ? o.tools[ID] : null;
    return e && typeof e === 'object' ? e : null;
  }
  function markToolbox(patch) {
    try {
      var o = readSharedAll();
      if (!o) o = { v: 1, tools: {} };
      var cur = Object.prototype.hasOwnProperty.call(o.tools, ID) && o.tools[ID] && typeof o.tools[ID] === 'object' ? o.tools[ID] : { hasData: false, updatedAt: null, lastBackupAt: null };
      o.tools[ID] = Object.assign(cur, patch);
      localStorage.setItem(SHARED_KEY, JSON.stringify(o));
    } catch (e) { /* 寫不進去就算了，不影響筆記本身 */ }
  }
  var firstMarkDone = false, lastMarkAt = 0, lastMarkHas = null;
  function noteSaved(hasData) {
    var now = Date.now();
    if (!firstMarkDone || hasData !== lastMarkHas || now - lastMarkAt >= 60000) {
      markToolbox({ hasData: hasData, updatedAt: new Date(now).toISOString() });
      firstMarkDone = true; lastMarkAt = now; lastMarkHas = hasData;
    }
  }
  // 還原或重設成功後，馬上把紀錄對齊（不等 60 秒節流、不用重新整理）：
  //  還原 → hasData 照實際、updatedAt 現在；重設（清除全部筆記）→ {hasData:false, updatedAt:現在, lastBackupAt:null}（舊備份檔不涵蓋重設後才輸入的資料）
  function markNow(patch) {
    var now = Date.now();
    markToolbox(Object.assign({ updatedAt: new Date(now).toISOString() }, patch));
    firstMarkDone = true; lastMarkAt = now; lastMarkHas = patch.hasData;
  }
  // 載入時對帳：紀錄不能說謊。已經有筆記但紀錄寫沒有（或沒有紀錄）→ 補成有；沒有筆記但紀錄寫有 → 改成沒有。
  function reconcileRecord() {
    if (!storageOk || broken) return;
    var has = C.hasAnyNotes(state.weeks), rec = readSharedEntry();
    if (has && !(rec && rec.hasData === true)) {
      var keep = rec && typeof rec.updatedAt === 'string' && !isNaN(Date.parse(rec.updatedAt)) ? rec.updatedAt : new Date().toISOString();
      markToolbox({ hasData: true, updatedAt: keep });
    } else if (!has && rec && rec.hasData === true) {
      markToolbox({ hasData: false });
    }
  }
  function readBackupTime() {
    var e = readSharedEntry(), t = e && typeof e.lastBackupAt === 'string' ? Date.parse(e.lastBackupAt) : NaN;
    return isNaN(t) ? null : t;
  }

  /* ------------------------------------------------------------------ 回顧筆記的儲存層（多分頁安全） */
  function emptyState() { return { v: 1, rev: 0, updatedAt: null, weeks: {} }; }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function readStore() {
    var raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return { status: 'unavailable', raw: null }; }
    if (raw === null) return { status: 'empty', raw: null, data: emptyState() };
    try {
      var o = JSON.parse(raw);
      if (o && o.v === 1 && Number.isInteger(o.rev) && o.rev >= 0) {
        var n = C.normalizeNotes(o.weeks);
        if (!n.error) return { status: 'ok', raw: raw, data: { v: 1, rev: o.rev, updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null, weeks: n.weeks } };
      }
    } catch (e) { /* 落到下面 */ }
    return { status: 'broken', raw: raw };
  }

  var state = emptyState();
  var storageOk = true, broken = false, brokenRaw = null, stale = false;
  var dirty = false, saveTimer = null, editWeek = null;
  var pending = null, clearAsk = false;
  // 沒存成功的文字：{ 週一日期: {good,next,tweak} }，只在記憶體。換週、寫不進去、資料過期時都留著，回到那一週會再試著存。
  var drafts = {};
  // 重新整理後從這個分頁的 sessionStorage 找回、等使用者決定要不要放回去的草稿：{ weeks: {...} }
  var offer = null;
  // 這個頁面開啟之後，使用者在哪幾週的格子裡打過字（{ 週一日期: true }）。「放回去」遇到這幾週要保留新打的，不能用舊草稿蓋掉。
  var touched = {};
  var DRAFT_KEY = 'toolbox.weekly.draft.v1';
  var DRAFT_WEEKS_MAX = 20;
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* 不讓寫就算了 */ } }
  function ssDel(k) { try { if (sessionStorage.getItem(k) !== null) sessionStorage.removeItem(k); } catch (e) { /* 同上 */ } }

  function showStale() {
    stale = true;
    renderNotices();
    var b = $('staleBanner');
    try { b.scrollIntoView({ block: 'center' }); } catch (e) { /* 沒有捲動功能就算了 */ }
  }
  // 回傳 'ok' | 'stale' | 'fail' | 'broken'。寫入前先重讀 rev：別的分頁改過就拒絕，不蓋掉。
  function persist(weeks, expectedRev, allowBroken) {
    if (stale) { showStale(); return 'stale'; }
    if (broken && !allowBroken) return 'broken';
    if (storageOk) {
      var cur = readStore();
      if (cur.status === 'unavailable') return 'fail';
      if (broken) {
        if (cur.status !== 'broken' || cur.raw !== brokenRaw) { showStale(); return 'stale'; }
      } else {
        var r = cur.status === 'ok' ? cur.data.rev : cur.status === 'empty' ? 0 : -1;
        if (r !== expectedRev) { showStale(); return 'stale'; }
      }
    }
    var out = { v: 1, rev: broken ? Math.floor(Date.now() / 1000) : expectedRev + 1, updatedAt: new Date().toISOString(), weeks: weeks };
    if (storageOk && !lsSet(KEY, JSON.stringify(out))) return 'fail';
    state = out;
    if (broken) { broken = false; brokenRaw = null; renderNotices(); lockNotes(); }
    noteSaved(C.hasAnyNotes(weeks));
    return 'ok';
  }
  function failText(res) {
    if (res === 'fail') return '儲存失敗：瀏覽器沒有讓網頁寫入資料（可能是空間不足）。請先把這格內容複製起來，並下載備份。';
    if (res === 'broken') return '這個瀏覽器裡存的筆記讀不出來，已暫停儲存。請先從備份還原，或清除全部筆記重新開始。';
    return '這個分頁的資料已過期，請先重新整理。';
  }

  /* ------------------------------------------------------------------ 週次 */
  var today = C.taipeiToday();
  var pinned = false, pinnedStart = null;
  function curMonday() { return C.mondayOf(today); }
  function weekStart() { return pinned ? pinnedStart : curMonday(); }
  function week() { return C.weekOf(weekStart()); }
  function setWeek(start) {
    if (start < C.mondayOf(FIRST_WEEK) || start > LAST_WEEK) return;
    pinned = start !== curMonday();
    pinnedStart = start;
    refreshAll(false);
  }
  function weekTagText(diff) {
    return diff === 0 ? '本週' : diff === -1 ? '上週' : diff === 1 ? '下週' : diff < 0 ? (-diff) + ' 週前' : diff + ' 週後';
  }
  function renderWeekHead() {
    var wk = week(), diff = C.weekDiff(curMonday(), wk.start);
    $('weekTag').textContent = weekTagText(diff);
    var range = $('weekRange');
    range.textContent = '';
    range.append(h('span', { class: 'nw', text: C.fullDate(wk.start) }), ' 至 ', h('span', { class: 'nw', text: C.fullDate(wk.end) }));
    var prev = $('prevWeek'), next = $('nextWeek'), now = $('thisWeek');
    prev.disabled = C.addDays(wk.start, -7) < FIRST_WEEK;
    next.disabled = C.addDays(wk.start, 7) > LAST_WEEK;
    if (diff === 0) now.setAttribute('aria-current', 'true'); else now.removeAttribute('aria-current');
  }

  /* ------------------------------------------------------------------ 各區塊畫面 */
  function fill(id, nodes) {
    var b = $(id);
    b.textContent = '';
    nodes.forEach(function (n) { if (n) b.append(n); });
    b.setAttribute('aria-busy', 'false');
  }
  function problemView(tool, status) {
    var t = TOOL[tool], msg;
    if (status === 'missing' || status === 'empty') msg = t.name + '還沒有資料。開始使用後，這裡就會顯示。';
    else if (status === 'unsupported') msg = '這個瀏覽器無法安全讀取' + t.name + '的資料，所以這裡不顯示。';
    else if (status === 'unavailable') msg = '這個瀏覽器不讓網頁讀取網站資料，這裡先不顯示。';
    else if (status === 'unreadable' || status === 'broken') msg = t.name + '的資料格式這裡讀不懂（可能工具已經更新），先不顯示，免得給你錯的數字。請直接開啟' + t.name + '查看。';
    else msg = '讀取失敗或逾時，請按上方「重新讀取」再試一次。';
    return h('div', { class: 'blank' }, h('p', { text: msg }), toolLink(t.id, '開啟' + t.name));
  }
  function openLine(tool, label) { return h('div', { class: 'more' }, toolLink(TOOL[tool].id, label || '開啟' + TOOL[tool].name)); }
  function emptyP(text) { return h('p', { class: 'empty', text: text }); }
  function factRow(dt, dd) { return h('div', null, h('dt', { text: dt }), h('dd', { text: dd })); }

  /* 花費 */
  function paintMoney(r) {
    if (r.status !== 'ok') { fill('bodyMoney', [problemView('money', r.status)]); return; }
    var wk = week(), m = r.model, nodes = [], s = null, bu = null;
    try {
      if (wk.start <= today) s = C.moneyWeek(m, wk.start, wk.end);
      bu = C.budgetUsage(m, today);
    } catch (e) { fill('bodyMoney', [problemView('money', 'unreadable')]); return; }

    if (wk.start > today) {
      nodes.push(emptyP('這週還沒開始。記帳工具不能記還沒到的日子，所以沒有數字。'));
    } else if (!s.count) {
      nodes.push(emptyP('這週沒有登錄支出。'));
    } else {
      nodes.push(h('div', null, h('span', { class: 'biglabel', text: '這週淨支出' }), h('p', { class: 'big', text: C.fmtMoney(s.net) })));
      var facts = h('dl', { class: 'facts' }, factRow('支出', C.fmtMoney(s.gross)));
      if (s.refunds) facts.append(factRow('退款', '−' + C.fmtMoney(s.refunds) + '（已從淨支出扣掉）'));
      facts.append(factRow('筆數', s.count + ' 筆'));
      nodes.push(facts);
      if (wk.end > today) nodes.push(h('p', { class: 'hint', text: '這週還沒結束，數字算到今天。' }));
      if (s.top.length) {
        nodes.push(h('h3', { class: 'sub', text: s.top.length > 1 ? '花最多的前 ' + s.top.length + ' 類' : '花最多的類別' }));
        var ol = h('ol', { class: 'cats' });
        s.top.forEach(function (g) {
          var bar = h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i'));
          bar.firstChild.style.width = g.pct + '%';
          ol.append(h('li', null,
            h('div', { class: 'cat-top' }, h('span', { class: 'cat-name', text: g.name }), h('span', { class: 'cat-amt', text: C.fmtMoney(g.amount) }), h('span', { class: 'cat-pct', text: g.pct + '%' })),
            bar));
        });
        nodes.push(ol);
        if (s.groupCount > s.top.length) nodes.push(h('p', { class: 'hint', text: '比例是占這週支出的百分比。另有 ' + (s.groupCount - s.top.length) + ' 類沒列出。' }));
        else nodes.push(h('p', { class: 'hint', text: '比例是占這週支出的百分比。' }));
      }
    }

    if (bu && !bu.unreadable) {
      var meter = h('div', { class: 'meter', role: 'img', 'aria-label': '本月預算已用 ' + bu.pct + '%' }, h('i', { 'aria-hidden': 'true' }));
      meter.firstChild.style.width = Math.max(0, Math.min(100, bu.ratio * 100)) + '%';
      nodes.push(h('div', { class: 'budget' + (bu.over ? ' over' : '') },
        h('h3', { class: 'sub', text: '本月預算（' + bu.month + '）' }), meter,
        h('p', { class: 'budget-text', text: '已用 ' + C.fmtMoney(bu.used) + '／預算 ' + C.fmtMoney(bu.total) + '（' + bu.pct + '%）' +
          (bu.over ? '，已超出 ' + C.fmtMoney(-bu.remaining) : '，還剩 ' + C.fmtMoney(bu.remaining)) })));
    }
    nodes.push(h('p', { class: 'hint', text: '金額都是台幣；外幣照入帳當時存下的匯率算。轉帳和餘額校正不算支出。' }));
    nodes.push(openLine('money'));
    fill('bodyMoney', nodes);
  }

  /* 運動 */
  function paintHealth(r) {
    if (r.status !== 'ok') { fill('bodyHealth', [problemView('health', r.status)]); return; }
    var wk = week(), nodes = [];
    if (wk.start > today) {
      nodes.push(emptyP('這週還沒開始。'));
    } else {
      var s = C.healthWeek(r.model, wk.start, wk.end);
      nodes.push(h('ul', { class: 'tiles' },
        h('li', { class: 'tile' }, h('b', { text: String(s.sessions) }), h('span', { text: '運動次數' })),
        h('li', { class: 'tile' }, h('b', { text: C.fmtNum(s.minutes) }), h('span', { text: '運動分鐘' })),
        h('li', { class: 'tile' }, h('b', { text: String(s.checkinDays) }), h('span', { text: '健康紀錄天數' }))));
      if (!s.sessions && !s.checkinDays) nodes.push(h('p', { class: 'hint', text: '這週沒有登錄訓練或健康紀錄。' }));
      if (wk.end > today) nodes.push(h('p', { class: 'hint', text: '這週還沒結束，數字算到今天。' }));
    }
    nodes.push(h('p', { class: 'hint', text: '只列次數和分鐘，不評斷身體數值。' }));
    nodes.push(openLine('health'));
    fill('bodyHealth', nodes);
  }

  /* 語言 */
  var NEED_NEW_STUDY = '這週的複習數需要新版語言複習才會記錄';
  // 這一週複習了幾張：把語言複習記下的「每天張數」在週一到週日之間加起來；沒有歷史或讀不懂就說明原因，不給數字
  function reviewedNodes(rv, wk) {
    var nodes = [];
    if (rv.state === 'ok') {
      nodes.push(h('p', { class: 'big', text: rv.count + ' 張' }));
      nodes.push(h('p', { class: 'hint', text: rv.count ? '這週有 ' + rv.days + ' 天有複習；每天的張數是當天複習過的不同卡片數。' : '這週沒有複習紀錄。' }));
      if (rv.from) nodes.push(h('p', { class: 'hint', text: '數字只算有紀錄的日子：' + (rv.limit === 'days' ? '語言複習只保留最近 ' + C.STUDY_HISTORY_DAYS + ' 天（從 ' + rv.from + ' 起）' : '語言複習從 ' + rv.from + ' 才開始完整記錄每天的張數') + '，這週更早的日子沒有紀錄。' }));
      if (wk.end > today) nodes.push(h('p', { class: 'hint', text: '這週還沒結束，數字算到今天。' }));
    } else if (rv.state === 'none') {
      nodes.push(emptyP(NEED_NEW_STUDY));
      nodes.push(h('p', { class: 'hint', text: '開啟並使用新版語言複習後，這裡就會開始記錄每天複習的張數。' }));
    } else if (rv.state === 'before') {
      nodes.push(emptyP(rv.limit === 'days' ? '語言複習只保留最近 ' + C.STUDY_HISTORY_DAYS + ' 天的每天張數，這週已經超過，沒有數字。' : '這週在語言複習開始記錄每天張數（' + rv.from + '）之前，沒有數字。'));
    } else if (rv.state === 'future') {
      nodes.push(emptyP('這週還沒開始。'));
    } else {
      nodes.push(emptyP('語言複習存的每天複習張數這裡讀不懂，先不顯示，免得給你錯的數字。'));
    }
    return nodes;
  }
  function paintStudy() {
    var r = readLs(SOURCE_KEYS.study);
    if (r.status !== 'ok') { fill('bodyStudy', [problemView('study', r.status)]); return; }
    var m = C.reduceStudy(r.value);
    if (!m.ok) { fill('bodyStudy', [problemView('study', 'unreadable')]); return; }
    var wk = week(), s = C.studyWeek(m, wk.start, wk.end, today), nodes = [];
    nodes.push(h('h3', { class: 'mini', text: '這週複習的卡片' }));
    reviewedNodes(s.reviewed, wk).forEach(function (n) { nodes.push(n); });
    nodes.push(h('h3', { class: 'mini', text: '下一場考試' }));
    if (s.next) {
      nodes.push(h('ul', { class: 'entries' }, h('li', { class: 'entry is-exam' },
        h('div', null, h('span', { class: 'e-name', text: s.next.name })),
        h('div', { class: 'e-side' }, h('span', { class: 'e-date', text: C.fullDate(s.next.date) }), h('span', { class: 'e-left', text: s.next.left === 0 ? '就是今天' : '還有 ' + s.next.left + ' 天' })))));
      if (s.more) nodes.push(h('p', { class: 'hint', text: '之後還有 ' + s.more + ' 場，到語言複習的「考試」頁看。' }));
    } else {
      nodes.push(emptyP('還沒有設定未來的考試日期。'));
    }
    nodes.push(openLine('study'));
    fill('bodyStudy', nodes);
  }

  /* 到期事項 */
  function paintExpiry() {
    var r = readLs(SOURCE_KEYS.expiry);
    if (r.status !== 'ok') { fill('bodyExpiry', [problemView('expiry', r.status)]); return; }
    var m = C.reduceExpiry(r.value);
    if (!m.ok) { fill('bodyExpiry', [problemView('expiry', 'unreadable')]); return; }
    var wk = week(), future = wk.start > today, anchor = future ? wk.start : today;
    var u = C.expiryUpcoming(m, anchor, 30), nodes = [];
    nodes.push(h('h3', { class: 'mini', text: '接下來 30 天：' + C.shortDate(anchor) + ' 到 ' + C.shortDate(C.addDays(anchor, 30)) }));
    if (!m.items.length) {
      if (!m.skipped) nodes.push(emptyP('還沒有登錄任何項目。'));
    } else if (!u.list.length) {
      nodes.push(emptyP('這段時間沒有項目到期。'));
    } else {
      var ul = h('ul', { class: 'entries' });
      u.list.slice(0, LIST_CAP).forEach(function (x) {
        ul.append(h('li', { class: 'entry ' + (x.left <= 7 ? 'is-soon' : 'is-d30') },
          h('div', null, h('span', { class: 'e-name', text: x.name }),
            h('div', { class: 'e-meta' }, x.category ? h('span', { class: 'tag', text: x.category }) : null, REPEAT_LABEL[x.repeat] ? h('span', { class: 'tag', text: REPEAT_LABEL[x.repeat] }) : null)),
          h('div', { class: 'e-side' }, h('span', { class: 'e-date', text: C.fullDate(x.due) }), h('span', { class: 'e-left', text: x.left === 0 ? '今天到期' : '剩 ' + x.left + ' 天' }))));
      });
      nodes.push(ul);
      if (u.list.length > LIST_CAP) nodes.push(h('p', { class: 'hint', text: '還有 ' + (u.list.length - LIST_CAP) + ' 項沒列出，請到到期日管家看全部。' }));
    }
    if (m.skipped) nodes.push(h('p', { class: 'warnline', text: '另有 ' + m.skipped + ' 項的資料格式這裡讀不懂（例如日期超出範圍或名稱不對），沒有列在上面，請到到期日管家看看。' }));
    if (!future && u.expired) nodes.push(h('p', { class: 'warnline', text: '另有 ' + u.expired + ' 項已經過期，到到期日管家看看。' }));
    if (future) nodes.push(h('p', { class: 'hint', text: '這是還沒到的週，所以從那週的星期一算起。' }));
    nodes.push(openLine('expiry'));
    fill('bodyExpiry', nodes);
  }

  /* 拍攝日 */
  function sheetList(list) {
    if (!list.length) return emptyP('沒有拍攝日通告。');
    var ul = h('ul', { class: 'entries' });
    list.slice(0, LIST_CAP).forEach(function (s) {
      ul.append(h('li', { class: 'entry is-exam' },
        h('div', null, h('span', { class: 'e-name', text: s.title || '（還沒取名）' })),
        h('div', { class: 'e-side' }, h('span', { class: 'e-date', text: C.shortDate(s.date) }), h('span', { class: 'e-left', text: s.callTime ? '集合 ' + s.callTime : '還沒填集合時間' }))));
    });
    var box = h('div', null, ul);
    if (list.length > LIST_CAP) box.append(h('p', { class: 'hint', text: '還有 ' + (list.length - LIST_CAP) + ' 張沒列出，請到拍攝日通告看全部。' }));
    return box;
  }
  function paintSheets() {
    var r = readLs(SOURCE_KEYS.callsheet);
    if (r.status !== 'ok') { fill('bodySheets', [problemView('callsheet', r.status)]); return; }
    var m = C.reduceCallsheet(r.value, today);
    if (!m.ok) { fill('bodySheets', [problemView('callsheet', 'unreadable')]); return; }
    var wk = week(), nx = C.weekOf(C.addDays(wk.start, 7));
    function range(w) { var a = C.parseYmd(w.start), b = C.parseYmd(w.end); return a.m + '/' + a.d + ' 到 ' + b.m + '/' + b.d; }
    fill('bodySheets', [
      h('h3', { class: 'mini', text: '這週（' + range(wk) + '）' }), sheetList(C.sheetsIn(m, wk.start, wk.end)),
      h('h3', { class: 'mini', text: '下一週（' + range(nx) + '）' }), sheetList(C.sheetsIn(m, nx.start, nx.end)),
      openLine('callsheet')
    ]);
  }

  /* 備份提醒（現在的狀況，不跟著選的週） */
  function paintBackup() {
    var r = readLs(SHARED_KEY);
    if (r.status === 'unavailable') { fill('bodyBackup', [h('p', { class: 'empty', text: '這個瀏覽器不讓網頁讀取網站資料，這裡先不顯示。' })]); return; }
    var tools = r.status === 'ok' && r.value && r.value.v === 1 && r.value.tools && typeof r.value.tools === 'object' ? r.value.tools : null;
    var s = C.backupStatus(tools, Date.now()), nodes = [];
    if (!s.known) {
      nodes.push(emptyP('還沒有工具留下備份紀錄。各工具存過資料後，這裡就會出現。'));
    } else if (!s.rows.length) {
      nodes.push(emptyP('目前沒有需要備份的工具。'));
    } else {
      var ul = h('ul', { class: 'bk' });
      s.rows.forEach(function (x) {
        var go = x.id === ID ? h('a', { class: 'btn', href: '#h-backupnotes', text: '去備份' }) : toolLink(x.id, '去備份');
        go.setAttribute('aria-label', '去備份：' + x.name);
        ul.append(h('li', null, h('div', null, h('b', { text: x.name }), ' ', h('span', { text: x.never ? '從沒備份過' : '上次備份是 ' + x.days + ' 天前' })), go));
      });
      nodes.push(ul);
    }
    nodes.push(h('p', { class: 'hint', text: '提醒規則：有存資料，而且從沒備份過或超過 ' + C.STALE_DAYS + ' 天沒備份。這一區是現在的狀況，不跟著選的週。' }));
    nodes.push(h('div', { class: 'more' }, toolLink('vault', '開啟資料保險箱')));
    fill('bodyBackup', nodes);
  }

  /* ------------------------------------------------------------------ 回顧筆記畫面 */
  var FIELD_EL = {};
  function renderNotices() {
    $('staleBanner').hidden = !stale;
    $('noStorage').hidden = storageOk;
    $('brokenBanner').hidden = !broken;
  }
  function lockNotes() {
    C.NOTE_FIELDS.forEach(function (f) { FIELD_EL[f].readOnly = stale || broken; });
  }
  function setSaveState(kind, text) {
    var el = $('saveState');
    el.className = 'savestate' + (kind === 'err' ? ' err' : '');
    el.textContent = text || (kind === 'saving' ? '儲存中…' : kind === 'saved' ? (storageOk ? '已儲存在這個瀏覽器' : '沒有存下來：這個瀏覽器不讓網頁保存資料') : '');
  }
  // 離開正在編輯的這一週：先存；存不起來（空間不足、資料過期、讀不出來）就把文字留在 drafts，不讓換週把它吃掉
  function leaveWeek() {
    if (editWeek === null) return;
    if (!flushNotes() && dirty) drafts[editWeek] = readFields();
  }
  function showNotes(force) {
    var ws = weekStart();
    if (editWeek === ws && !force) return;
    if (editWeek !== null && editWeek !== ws) leaveWeek();
    editWeek = ws;
    var dr = Object.prototype.hasOwnProperty.call(drafts, ws) ? drafts[ws] : null;
    var w = Object.prototype.hasOwnProperty.call(state.weeks, ws) ? state.weeks[ws] : {};
    C.NOTE_FIELDS.forEach(function (f) { FIELD_EL[f].value = (dr ? dr[f] : w[f]) || ''; });
    $('noteWeek').textContent = '寫給 ' + C.fullDate(ws) + '起的這一週';   // 「（週一）」的全形括號後面不再空一格
    dirty = !!dr;
    setSaveState('');
    lockNotes();
    if (dr) flushNotes();   // 上次沒存成功的文字：回到這一週就再試一次，還是不行就把原因顯示出來
    renderDraftNote();
    if (offer) fillOfferWarn();
  }
  function readFields() {
    var o = {};
    C.NOTE_FIELDS.forEach(function (f) { o[f] = C.cleanText(FIELD_EL[f].value); });
    return o;
  }
  function onNoteInput() {
    if (stale || broken) return;
    dirty = true;
    if (editWeek !== null) touched[editWeek] = true;
    if (offer) fillOfferWarn();
    setSaveState('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushNotes, 500);
  }
  function flushNotes() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!dirty || editWeek === null) return true;
    if (stale) { showStale(); setSaveState('err', failText('stale')); return false; }
    if (broken) { setSaveState('err', failText('broken')); return false; }
    var key = editWeek, vals = readFields(), weeks = Object.assign({}, state.weeks);
    var has = Object.prototype.hasOwnProperty.call(weeks, key);
    function settled() { dirty = false; delete drafts[key]; syncSessionDraft(); renderDraftNote(); if (offer) fillOfferWarn(); setSaveState('saved'); return true; }
    if (C.noteEmpty(vals)) {
      if (!has) return settled();
      delete weeks[key];
    } else {
      var old = has ? weeks[key] : null;
      if (old && C.NOTE_FIELDS.every(function (f) { return old[f] === vals[f]; })) return settled();
      if (!has && Object.keys(weeks).length >= C.NOTE_WEEKS_MAX) { setSaveState('err', '最多保留 ' + C.NOTE_WEEKS_MAX + ' 週的筆記，請先清掉舊的。'); return false; }
      weeks[key] = { good: vals.good, next: vals.next, tweak: vals.tweak, t: new Date().toISOString() };
    }
    var res = persist(weeks, state.rev);
    if (res === 'ok') { settled(); renderBackupLine(); paintBackup(); return true; }
    setSaveState('err', failText(res));
    return false;
  }

  /* 還沒存下來的文字：畫面提示、重新整理後找回 */
  function hasText(v) { return !C.noteEmpty(v); }
  function weekLabel(k) { var p = C.parseYmd(k); return p.m + '/' + p.d; }
  // 所有還沒存成功的文字：換週時留下的，加上正在編輯、而且還沒存成功的這一週
  function unsavedAll() {
    var out = {};
    Object.keys(drafts).forEach(function (k) { out[k] = drafts[k]; });
    if (dirty && editWeek !== null) out[editWeek] = readFields();
    return out;
  }
  // #draftNote 外面包著一層一直存在的 role="status"（aria-live="polite"）：提示出現或內容改變時，螢幕閱讀器會念出來。
  // 內容沒變就不重畫，免得每次換週、每次存檔都重念同一句。
  var draftNoteSig = '';
  function renderDraftNote() {
    var box = $('draftNote'), ks = Object.keys(drafts).filter(function (k) { return k !== editWeek && hasText(drafts[k]); }).sort();
    var sig = ks.join(',');
    if (sig === draftNoteSig) return;
    draftNoteSig = sig;
    box.textContent = '';
    box.hidden = !ks.length;
    if (!ks.length) return;
    box.append(h('p', { text: '另外有 ' + ks.length + ' 週的文字還沒存下來（' + ks.map(weekLabel).join('、') + ' 起的那幾週）。回到那一週，會再試著存一次。' }));
    var row = h('div', { class: 'actions' });
    ks.slice(0, 3).forEach(function (k) { row.append(h('button', { class: 'btn', type: 'button', 'data-week': k, text: '回到 ' + weekLabel(k) + ' 那週' })); });
    box.append(row);
  }
  // 重新整理或關頁前，把還沒存成功的文字放進這個分頁的 sessionStorage；全都存好了就把舊的清掉
  function saveSessionDraft() {
    var all = unsavedAll(), keep = {}, n = 0;
    Object.keys(all).sort().forEach(function (k) {
      if (hasText(all[k]) && n < DRAFT_WEEKS_MAX) { keep[k] = { good: all[k].good, next: all[k].next, tweak: all[k].tweak }; n++; }
    });
    if (offer) Object.keys(offer.weeks).forEach(function (k) {   // 還沒回答的「要不要放回去」也留著，下次重新整理還能問
      if (!Object.prototype.hasOwnProperty.call(keep, k) && n < DRAFT_WEEKS_MAX) { keep[k] = offer.weeks[k]; n++; }
    });
    if (n) ssSet(DRAFT_KEY, JSON.stringify({ v: 1, savedAt: new Date().toISOString(), weeks: keep }));
  }
  function syncSessionDraft() {
    var all = unsavedAll();
    if (!offer && !Object.keys(all).some(function (k) { return hasText(all[k]); })) ssDel(DRAFT_KEY);
  }
  function takeOffer() {
    var raw = ssGet(DRAFT_KEY);
    if (raw == null) return null;
    try {
      var d = JSON.parse(raw);
      if (!d || d.v !== 1 || !d.weeks || typeof d.weeks !== 'object' || Array.isArray(d.weeks) || Object.keys(d.weeks).length > DRAFT_WEEKS_MAX) throw new Error('bad');
      var nn = C.normalizeNotes(d.weeks);
      if (nn.error || !Object.keys(nn.weeks).length) throw new Error('bad');
      var weeks = {}, n = 0;
      Object.keys(nn.weeks).forEach(function (k) {
        if (k < C.mondayOf(FIRST_WEEK) || k > LAST_WEEK) return;   // 這個頁面不能切到的週，放回去也看不到
        weeks[k] = { good: nn.weeks[k].good, next: nn.weeks[k].next, tweak: nn.weeks[k].tweak }; n++;
      });
      if (!n) throw new Error('bad');
      return { weeks: weeks };
    } catch (e) { ssDel(DRAFT_KEY); return null; }
  }
  // 這一週在「放回去」時會怎麼處理：這個頁面剛寫了新的文字 → 保留新的；只有先前存好的筆記 → 會被舊草稿取代
  function offerKeepsNew(k) {
    var has = Object.prototype.hasOwnProperty;
    if (dirty && k === editWeek) return true;                        // 正在打、還沒存下來的
    if (has.call(drafts, k) && hasText(drafts[k])) return true;      // 換週時留下、還沒存成功的
    return !!touched[k] && has.call(state.weeks, k) && hasText(state.weeks[k]);   // 這個頁面打過、已經存好的
  }
  function fillOfferWarn() {
    var box = $('draftWarn');
    if (!box || !offer) return;
    var has = Object.prototype.hasOwnProperty, ks = Object.keys(offer.weeks).sort();
    var keep = ks.filter(offerKeepsNew);
    var replaced = ks.filter(function (k) { return has.call(state.weeks, k) && !offerKeepsNew(k); }).length;
    box.textContent = '';
    if (replaced) box.append(h('p', { text: '其中 ' + replaced + ' 週現在已經有存好的筆記，放回去會取代它。' }));
    if (keep.length) box.append(h('p', { text: '其中 ' + keep.length + ' 週（' + keep.map(weekLabel).join('、') + ' 起）你剛剛已經寫了新的文字，放回去時會保留新的，不會用舊的蓋掉。' }));
  }
  function renderOffer() {
    var el = $('draftPanel');
    el.textContent = '';
    el.hidden = !offer;
    if (!offer) return;
    var ks = Object.keys(offer.weeks).sort();
    el.append(h('p', { text: '上次這個分頁有 ' + ks.length + ' 週的回顧文字還沒存下來（' + ks.map(weekLabel).join('、') + ' 起的那幾週）。要放回去嗎？' }));
    el.append(h('div', { id: 'draftWarn' }));
    fillOfferWarn();
    el.append(h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', id: 'draftYes', text: '放回去' }),
      h('button', { class: 'btn', type: 'button', id: 'draftNo', text: '不要，丟掉' })));
  }
  function acceptOffer() {
    if (!offer) return;
    flushNotes();   // 先把正在打的存起來；存不起來就還留在畫面上，不會被蓋掉
    var applied = [], kept = [];
    Object.keys(offer.weeks).sort().forEach(function (k) {
      // 那一週已經有更新的文字（這個頁面剛打的，不管存好了沒有）：留新的，不用上次的舊份蓋掉
      if (offerKeepsNew(k)) { kept.push(k); return; }
      drafts[k] = offer.weeks[k]; applied.push(k);
    });
    offer = null; ssDel(DRAFT_KEY); renderOffer();
    var target = applied.length ? applied[applied.length - 1] : null;
    if (target && weekStart() === target) { if (!dirty) showNotes(true); } else if (target) setWeek(target);
    renderDraftNote();
    FIELD_EL.good.focus();
    if (kept.length) setSaveState('', (applied.length ? '已放回去 ' + applied.length + ' 週。' : '沒有放回去。') + kept.map(weekLabel).join('、') + ' 起的那一週，你剛剛已經寫了新的文字，已保留新的，沒有用舊的蓋掉。');
  }
  function declineOffer() {
    offer = null; ssDel(DRAFT_KEY); renderOffer();
    FIELD_EL.good.focus();
  }

  /* 備份與還原（只管回顧筆記） */
  function renderBackupLine() {
    var t = readBackupTime(), el = $('backupLine'), has = C.hasAnyNotes(state.weeks), needs = false;
    if (t == null) { el.textContent = '還沒有備份過'; needs = has; }
    else {
      var d = C.taipeiDayOf(t), days = Math.max(0, C.daysBetween(d, today));
      el.textContent = '上次備份：' + d + '（' + (days === 0 ? '今天' : days + ' 天前') + '）';
      needs = has && days > C.STALE_DAYS;
    }
    el.className = 'lastbackup' + (needs ? ' warn' : '');
    $('backupNudge').hidden = !needs;
    $('backupBtn').disabled = broken || !has;
    $('clearBtn').disabled = !has && !broken;
  }
  function renderPanels() {
    var rp = $('restorePanel');
    rp.textContent = '';
    rp.hidden = !pending;
    if (pending) {
      rp.append(
        h('p', { text: '備份檔裡有 ' + pending.n + ' 週的筆記' + (pending.exportedAt ? '，匯出時間 ' + pending.exportedAt : '') + '。' }),
        h('p', { text: '目前這個瀏覽器有 ' + Object.keys(state.weeks).length + ' 週。還原會把目前的筆記整個換掉，無法復原。' }),
        h('div', { class: 'actions' },
          h('button', { class: 'btn danger-solid', type: 'button', id: 'restoreOk', text: '確定取代目前筆記' }),
          h('button', { class: 'btn', type: 'button', id: 'restoreNo', text: '取消' })));
    }
    var cp = $('clearPanel');
    cp.textContent = '';
    cp.hidden = !clearAsk;
    if (clearAsk) {
      cp.append(
        h('p', { text: '確定清除這個瀏覽器裡全部 ' + Object.keys(state.weeks).length + ' 週的回顧筆記？清除後無法復原，建議先下載備份。' }),
        h('div', { class: 'actions' },
          h('button', { class: 'btn danger-solid', type: 'button', id: 'clearOk', text: '確定清除' }),
          h('button', { class: 'btn', type: 'button', id: 'clearNo', text: '取消' })));
    }
  }
  function doBackup() {
    if (stale) { say($('backupMsg'), '這個分頁的資料已過期，請先重新整理，再下載備份。', 'err'); return; }
    if (!flushNotes()) { say($('backupMsg'), '還有一格筆記沒存成功，請先處理上面的提示再備份。', 'err'); return; }
    var n = Object.keys(state.weeks).length;
    if (!n) { say($('backupMsg'), '還沒有筆記可以備份。', 'err'); return; }
    var weeks = {};
    Object.keys(state.weeks).sort().forEach(function (k) { var w = state.weeks[k]; weeks[k] = { good: w.good, next: w.next, tweak: w.tweak, t: w.t }; });
    var payload = { kind: KIND, v: 1, exportedAt: new Date().toISOString(), data: { weeks: weeks } };
    var fname = 'weekly-backup-' + compact(today) + '.json';
    download(fname, 'application/json', JSON.stringify(payload, null, 2));
    markToolbox({ lastBackupAt: new Date().toISOString() });
    renderBackupLine();
    renderPanels();
    paintBackup();
    say($('backupMsg'), '已下載 ' + fname + '（' + n + ' 週）。', 'ok');
  }
  function validateBackup(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: '內容不是這個工具的備份格式。' };
    if (o.kind !== KIND) return { error: '這不是「每週回顧」的備份檔。' };
    if (o.v !== 1) return { error: '備份檔的版本不支援。' };
    if (!o.data || typeof o.data !== 'object' || Array.isArray(o.data)) return { error: '備份檔裡找不到筆記。' };
    var n = C.normalizeNotes(o.data.weeks);
    if (n.error) return { error: n.error + '。' };
    var t = typeof o.exportedAt === 'string' ? Date.parse(o.exportedAt) : NaN;
    return { weeks: n.weeks, n: Object.keys(n.weeks).length, exportedAt: isNaN(t) ? '' : C.taipeiDayOf(t) };
  }
  function onRestoreFile() {
    var input = $('restoreFile'), f = input.files && input.files[0];
    input.value = '';
    pending = null; clearAsk = false; renderPanels();
    var bm = $('backupMsg');
    if (!f) return;
    if (f.size > MAX_BACKUP_BYTES) { say(bm, '無法還原：檔案超過 5 MB，這不是這個工具的備份檔。', 'err'); return; }
    f.text().then(function (text) {
      var o;
      try { o = JSON.parse(text); } catch (e) { say(bm, '無法還原：這不是有效的備份檔（讀不出 JSON）。', 'err'); return; }
      var v = validateBackup(o);
      if (v.error) { say(bm, '無法還原：' + v.error, 'err'); return; }
      pending = v;
      say(bm, '');
      renderPanels();
      var no = $('restoreNo'); if (no) no.focus();
    }, function () { say(bm, '無法還原：讀不到這個檔案。', 'err'); });
  }
  function afterReplace() {
    dirty = false; clearTimeout(saveTimer); saveTimer = null;
    showNotes(true);
    renderNotices(); lockNotes(); renderBackupLine(); renderPanels(); paintBackup();
  }
  function doRestore() {
    if (!pending) return;
    var res = persist(pending.weeks, state.rev, true);
    if (res !== 'ok') { say($('backupMsg'), failText(res), 'err'); return; }
    var n = pending.n;
    pending = null;
    markNow({ hasData: C.hasAnyNotes(state.weeks) });   // 紀錄馬上更新，資料保險箱和首頁提醒不用等重新整理
    afterReplace();
    say($('backupMsg'), '已還原 ' + n + ' 週的筆記。', 'ok');
    $('restoreBtn').focus();
  }
  function doClear() {
    var res = persist({}, state.rev, true);
    clearAsk = false;
    if (res !== 'ok') { renderPanels(); say($('backupMsg'), failText(res), 'err'); return; }
    markNow({ hasData: false, lastBackupAt: null });   // 重設：舊備份檔不涵蓋之後才輸入的資料，所以「上次備份」一併清空
    afterReplace();
    say($('backupMsg'), '已清除全部筆記。', 'ok');
    $('clearBtn').focus();
  }

  /* 別的分頁改了資料 */
  function sync() {
    if (!storageOk) return;
    var r = readStore();
    if (r.status === 'ok') {
      if (r.data.rev !== state.rev) {
        if (dirty) { showStale(); lockNotes(); return; }
        state = r.data;
        if (broken) { broken = false; brokenRaw = null; }
        showNotes(true); renderNotices(); renderBackupLine();
      }
    } else if (r.status === 'empty') {
      if (state.rev !== 0 || C.hasAnyNotes(state.weeks)) {
        if (dirty) { showStale(); lockNotes(); return; }
        state = emptyState(); showNotes(true); renderBackupLine();
      }
    } else if (r.status === 'broken' && !broken) {
      broken = true; brokenRaw = r.raw; renderNotices(); lockNotes(); renderBackupLine();
    }
  }

  /* ------------------------------------------------------------------ 整頁更新 */
  var gen = 0, lastLoadAt = 0, chanTimer = null;
  function paintLocal() { paintStudy(); paintExpiry(); paintSheets(); paintBackup(); }
  function refreshAll(force) {
    var g = ++gen;
    if (force) lastLoadAt = Date.now();
    renderWeekHead();
    loadIdb('money', force).then(function (r) { if (g === gen) paintMoney(r); });
    loadIdb('health', force).then(function (r) { if (g === gen) paintHealth(r); });
    paintLocal();
    showNotes(false);
    renderBackupLine();
  }
  // 工具箱首頁切換工具時，是把這一頁的 iframe 藏起來再顯示（頁面不會重載，也收不到「顯示回來」的事件）。
  // 所以記帳與健康每次存檔後會在自己的廣播頻道喊一聲，這裡只「聽」、不「說」，聽到就重讀那一個工具。
  function listenTo(name, kind) {
    try {
      var ch = new BroadcastChannel(name);
      ch.onmessage = function () {
        clearTimeout(chanTimer);
        chanTimer = setTimeout(function () { idbCache[kind] = null; refreshAll(false); }, 300);
      };
    } catch (e) { /* 這個瀏覽器沒有廣播頻道：改靠「重新讀取」與回到分頁時重讀 */ }
  }
  // 回到這個視窗（點進來）時，距離上次重讀超過 2 秒就重讀一次
  function maybeRefresh() {
    if (document.hidden || Date.now() - lastLoadAt < 2000) return;
    today = C.taipeiToday();
    sync();
    refreshAll(true);
  }
  function tickDate() {
    var t = C.taipeiToday();
    if (t !== today) { today = t; refreshAll(false); }
  }

  /* ------------------------------------------------------------------ 啟動 */
  function init() {
    FIELD_EL = { good: $('nGood'), next: $('nNext'), tweak: $('nTweak') };
    var r = readStore();
    if (r.status === 'ok' || r.status === 'empty') state = r.data;
    else if (r.status === 'broken') { broken = true; brokenRaw = r.raw; }
    else storageOk = false;
    reconcileRecord();
    renderNotices();
    offer = takeOffer();

    C.NOTE_FIELDS.forEach(function (f) { FIELD_EL[f].addEventListener('input', onNoteInput); FIELD_EL[f].addEventListener('blur', flushNotes); });
    $('prevWeek').addEventListener('click', function () { var s = C.addDays(weekStart(), -7); setWeek(s); if ($('prevWeek').disabled) $('thisWeek').focus(); });
    $('nextWeek').addEventListener('click', function () { var s = C.addDays(weekStart(), 7); setWeek(s); if ($('nextWeek').disabled) $('thisWeek').focus(); });
    $('thisWeek').addEventListener('click', function () { setWeek(curMonday()); });
    $('reloadData').addEventListener('click', function () { today = C.taipeiToday(); refreshAll(true); });
    $('backupBtn').addEventListener('click', doBackup);
    $('restoreBtn').addEventListener('click', function () { $('restoreFile').click(); });
    $('restoreFile').addEventListener('change', onRestoreFile);
    $('clearBtn').addEventListener('click', function () {
      pending = null; clearAsk = true; renderPanels();
      var no = $('clearNo'); if (no) no.focus();
    });
    $('restorePanel').addEventListener('click', function (e) {
      if (e.target.id === 'restoreOk') doRestore();
      else if (e.target.id === 'restoreNo') { pending = null; renderPanels(); $('restoreBtn').focus(); }
    });
    $('clearPanel').addEventListener('click', function (e) {
      if (e.target.id === 'clearOk') doClear();
      else if (e.target.id === 'clearNo') { clearAsk = false; renderPanels(); $('clearBtn').focus(); }
    });
    $('reloadBtn').addEventListener('click', function () { saveSessionDraft(); location.reload(); });   // 資料過期要重新整理：沒存下來的文字先留在這個分頁，重新整理後問要不要放回去
    $('draftPanel').addEventListener('click', function (e) {
      if (e.target.id === 'draftYes') acceptOffer();
      else if (e.target.id === 'draftNo') declineOffer();
    });
    $('draftNote').addEventListener('click', function (e) {
      var wk = e.target.getAttribute && e.target.getAttribute('data-week');
      if (wk) setWeek(wk);
    });
    window.addEventListener('storage', function (e) {
      if (e.storageArea && e.storageArea !== window.localStorage) return;
      if (e.key === KEY || e.key === null) sync();
      if (e.key === SHARED_KEY || e.key === null) { renderBackupLine(); paintBackup(); }
      if (e.key === null || e.key === SOURCE_KEYS.expiry || e.key === SOURCE_KEYS.study || e.key === SOURCE_KEYS.callsheet) { paintStudy(); paintExpiry(); paintSheets(); }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { flushNotes(); saveSessionDraft(); return; }
      today = C.taipeiToday();
      sync();
      refreshAll(true);
    });
    window.addEventListener('pagehide', function () { flushNotes(); saveSessionDraft(); });
    window.addEventListener('focus', maybeRefresh);
    listenTo('eric-money-ledger-updates', 'money');
    listenTo('eric-health-updates', 'health');
    setInterval(tickDate, 30000);

    refreshAll(true);
    renderPanels();
    renderOffer();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
