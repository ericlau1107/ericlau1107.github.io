/* 證件與到期日管家
 * 資料只存在這個瀏覽器的 localStorage（toolbox.expiry.v1），不連網。
 * 只記「名稱、類別、到期日、提醒天數、循環、備註」，不收證號卡號。
 */
(function () {
  'use strict';

  var D = window.EXPIRY_DEFAULTS;
  var ID = 'expiry';
  var KEY = 'toolbox.expiry.v1';
  var SHARED_KEY = 'toolbox.backup.v1';
  var KIND = 'toolbox.expiry';
  var UID_SUFFIX = '@ericlau1107.github.io';
  var DRAFT_KEY = 'toolbox.expiry.draft.v1';   // sessionStorage：只在「資料過期、重新整理」時暫存表單草稿
  var MAX_ITEMS = 500, MAX_NAME = 40, MAX_NOTE = 200, MAX_REM = 8, MAX_REM_DAYS = 1095;
  // 輸入與還原：只收 2000–2100 年。讀取已存資料時放寬到 1900–2200，免得一筆日期怪怪的就讓整份資料打不開。
  var MIN_YEAR = 2000, MAX_YEAR = 2100, LOAD_MIN_YEAR = 1900, LOAD_MAX_YEAR = 2200;
  var MAX_DATE = MAX_YEAR + '-12-31';
  var ACTION_LOCK_MS = 700;   // 續約、確認刪除之後的這段時間內，忽略連點
  var MAX_BACKUP_BYTES = 5 * 1024 * 1024;
  var CATS = D.categories;
  var REPEAT_LABEL = { none: '不循環', monthly: '每月', yearly: '每年' };
  var WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
  var ID_MSG = '這裡有一長串數字，看起來像證號、卡號或電話。這裡只需要名稱和日期，請刪掉再存。';

  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------------ 日期（全部用 YYYY-MM-DD 字串，運算走 UTC，避開夏令時間） */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dim(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function toYmd(y, m, d) { return String(y).padStart(4, '0') + '-' + pad(m) + '-' + pad(d); }
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > dim(y, mo)) return null;
    return { y: y, m: mo, d: d };
  }
  function dayNum(s) { var p = parseYmd(s); return Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000); }
  function fromDayNum(n) { var t = new Date(n * 86400000); return toYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
  function addDays(s, n) { return fromDayNum(dayNum(s) + n); }
  // 加月份時日期以「原本登記的日」為準：1/31 每月 → 2/28 → 3/31，不會越推越小
  function addMonths(s, n, anchor) {
    var p = parseYmd(s);
    var idx = p.y * 12 + (p.m - 1) + n;
    var y = Math.floor(idx / 12), m = idx % 12 + 1;
    return toYmd(y, m, Math.min(anchor || p.d, dim(y, m)));
  }
  function daysBetween(a, b) { return dayNum(b) - dayNum(a); }
  function todayStr() { var d = new Date(); return toYmd(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
  function weekdayOf(s) { return WEEKDAY[new Date(dayNum(s) * 86400000).getUTCDay()]; }
  function compact(s) { return s.replace(/-/g, ''); }
  function localYmd(t) { var d = new Date(t); return toYmd(d.getFullYear(), d.getMonth() + 1, d.getDate()); }

  function stepOf(rep) { return rep === 'monthly' ? 1 : rep === 'yearly' ? 12 : 0; }
  // 有循環的項目：登記日期已過，就推算到今天（含）之後的下一次
  function effectiveDue(it, today) {
    var step = stepOf(it.repeat);
    if (!step) return it.date;
    var anchor = it.anchorDay || parseYmd(it.date).d, cur = it.date, guard = 0;
    while (dayNum(cur) < dayNum(today) && guard++ < 5000) cur = addMonths(cur, step, anchor);
    return cur;
  }
  function statusOf(days) {
    if (days < 0) return { key: 'expired', label: '已過期' };
    if (days <= 30) return { key: 'd30', label: '30 天內' };
    if (days <= 90) return { key: 'd90', label: '90 天內' };
    return { key: 'ok', label: '正常' };
  }
  function leftText(days) {
    return days < 0 ? '已過 ' + (-days) + ' 天' : days === 0 ? '今天到期' : '剩 ' + days + ' 天';
  }
  function info(it, today) {
    var due = effectiveDue(it, today), days = daysBetween(today, due);
    return { item: it, due: due, days: days, st: statusOf(days), rolled: due !== it.date };
  }

  /* ------------------------------------------------------------------ 提醒天數與資料檢查 */
  function remSplit(str) {
    var raw = String(str == null ? '' : str).replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).trim();
    return raw ? raw.split(/[\s,，、;；]+/).filter(Boolean) : [];
  }
  function parseReminders(str) {
    var parts = remSplit(str), out = [];
    if (!parts.length) return { ok: true, list: [] };
    for (var i = 0; i < parts.length; i++) {
      if (!/^\d{1,4}$/.test(parts[i])) return { ok: false, msg: '提醒天數請輸入數字，用逗號或空白隔開，例如 60, 30, 7。' };
      var n = +parts[i];
      if (n < 1 || n > MAX_REM_DAYS) return { ok: false, msg: '每個提醒天數要在 1 到 ' + MAX_REM_DAYS + ' 之間。' };
      if (out.indexOf(n) < 0) out.push(n);
    }
    if (out.length > MAX_REM) return { ok: false, msg: '提醒天數最多 ' + MAX_REM + ' 個。' };
    out.sort(function (a, b) { return b - a; });
    return { ok: true, list: out };
  }
  // 欄位裡「看得懂」的天數（忽略寫錯的部分）：快捷鈕用它來顯示與增減
  function remValid(str) {
    var out = [];
    remSplit(str).forEach(function (t) {
      if (/^\d{1,4}$/.test(t)) { var n = +t; if (n >= 1 && n <= MAX_REM_DAYS && out.indexOf(n) < 0) out.push(n); }
    });
    return out;
  }
  // 名稱或備註裡出現長串數字（證號、卡號、電話）就擋下來
  function looksLikeId(s) {
    var t = String(s || '').replace(/(\d)-(?=\d)/g, '$1');
    return /\d{9,}/.test(t) || /(?:\d{3,4} ){2,}\d{3,4}/.test(t) || /[A-Za-z][12]\d{8}/.test(t);
  }
  function newId() {
    var b = new Uint8Array(12), s = '';
    try { crypto.getRandomValues(b); } catch (e) { for (var i = 0; i < 12; i++) b[i] = Math.floor(Math.random() * 256); }
    for (var j = 0; j < 12; j++) s += (b[j] < 16 ? '0' : '') + b[j].toString(16);
    return s;
  }
  // 把一筆資料（來自儲存或備份檔）檢查並整理成標準格式
  function normalizeItem(x, lenient) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { error: '不是有效的項目' };
    var name = typeof x.name === 'string' ? x.name.trim() : '';
    if (!name || Array.from(name).length > MAX_NAME) return { error: '名稱要 1 到 ' + MAX_NAME + ' 個字' };
    if (CATS.indexOf(x.category) < 0) return { error: '類別不在清單內' };
    var p = parseYmd(x.date);
    var lo = lenient ? LOAD_MIN_YEAR : MIN_YEAR, hi = lenient ? LOAD_MAX_YEAR : MAX_YEAR;
    if (!p || p.y < lo || p.y > hi) return { error: '到期日格式不對，或不在 ' + MIN_YEAR + ' 到 ' + MAX_YEAR + ' 年之間' };
    if (!REPEAT_LABEL.hasOwnProperty(x.repeat)) return { error: '循環設定不對' };
    if (!Array.isArray(x.reminders) || x.reminders.length > MAX_REM) return { error: '提醒天數不對' };
    var rem = [];
    for (var i = 0; i < x.reminders.length; i++) {
      var n = x.reminders[i];
      if (!Number.isInteger(n) || n < 1 || n > MAX_REM_DAYS) return { error: '提醒天數不對' };
      if (rem.indexOf(n) < 0) rem.push(n);
    }
    rem.sort(function (a, b) { return b - a; });
    var note = x.note == null ? '' : x.note;
    if (typeof note !== 'string' || Array.from(note).length > MAX_NOTE) return { error: '備註太長或格式不對' };
    return {
      item: {
        id: typeof x.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(x.id) ? x.id : newId(),
        name: name, category: x.category, date: x.date, repeat: x.repeat, reminders: rem, note: note,
        anchorDay: Number.isInteger(x.anchorDay) && x.anchorDay >= 1 && x.anchorDay <= 31 ? x.anchorDay : p.d,
        seq: Number.isInteger(x.seq) && x.seq >= 0 ? x.seq : 0,
        createdAt: typeof x.createdAt === 'string' && !isNaN(Date.parse(x.createdAt)) ? x.createdAt : null
      }
    };
  }

  /* ------------------------------------------------------------------ .ics（RFC 5545） */
  function escapeText(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n');
  }
  // 每一行最多 75 個位元組（含續行開頭的空白），不會把一個中文字切成兩半
  function foldLine(line) {
    var enc = new TextEncoder();
    if (enc.encode(line).length <= 75) return line;
    var out = [], cur = '', bytes = 0, limit = 75;
    for (var ch of line) {
      var b = enc.encode(ch).length;
      if (bytes + b > limit) { out.push(cur); cur = ''; bytes = 0; limit = 74; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join('\r\n ');
  }
  function icsStamp(d) {
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }
  // 每個項目：到期日一個事件，每個提醒日一個事件（Google 行事曆匯入會忽略 VALARM，所以提醒要做成獨立事件）
  function eventList(items, today, futureOnly) {
    var out = [];
    items.forEach(function (it) {
      var due = effectiveDue(it, today);
      var tail = it.note ? '\n備註：' + it.note : '';
      out.push({
        uid: it.id + '-due' + UID_SUFFIX, date: due, seq: it.seq || 0, summary: '到期：' + it.name,
        desc: '類別：' + it.category + '\n循環：' + REPEAT_LABEL[it.repeat] + tail
      });
      it.reminders.forEach(function (n) {
        var d = addDays(due, -n);
        if (futureOnly && dayNum(d) < dayNum(today)) return;
        out.push({
          uid: it.id + '-r' + n + UID_SUFFIX, date: d, seq: it.seq || 0, summary: '提醒：' + it.name + ' 剩 ' + n + ' 天到期',
          desc: it.name + ' 將在 ' + due + ' 到期，這是到期前 ' + n + ' 天的提醒。' + tail
        });
      });
    });
    return out;
  }
  function buildIcs(items, opts) {
    var stamp = icsStamp(opts.now || new Date());
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Eric Toolbox//Expiry//ZH-TW', 'CALSCALE:GREGORIAN'];
    eventList(items, opts.today, !!opts.futureOnly).forEach(function (e) {
      lines.push('BEGIN:VEVENT', 'UID:' + e.uid, 'DTSTAMP:' + stamp,
        'DTSTART;VALUE=DATE:' + compact(e.date), 'DTEND;VALUE=DATE:' + compact(addDays(e.date, 1)),
        'SUMMARY:' + escapeText(e.summary), 'DESCRIPTION:' + escapeText(e.desc),
        'TRANSP:TRANSPARENT', 'SEQUENCE:' + e.seq, 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------ 共用備份紀錄（資料保險箱讀這個；只寫狀態，不寫內容） */
  function markToolbox(patch) {
    try {
      var K = 'toolbox.backup.v1'; var o;
      try { o = JSON.parse(localStorage.getItem(K) || ''); } catch (e) {}
      if (!o || o.v !== 1 || typeof o.tools !== 'object' || !o.tools) o = { v: 1, tools: {} };
      var cur = o.tools[ID] || { hasData: false, updatedAt: null, lastBackupAt: null };
      o.tools[ID] = Object.assign(cur, patch);
      localStorage.setItem(K, JSON.stringify(o));
    } catch (e) {}
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
  //  還原 → hasData 照實際、updatedAt 現在；重設（全部清除）→ {hasData:false, updatedAt:現在, lastBackupAt:null}（舊備份檔不涵蓋重設後才輸入的資料）
  function markNow(patch) {
    var now = Date.now();
    markToolbox(Object.assign({ updatedAt: new Date(now).toISOString() }, patch));
    firstMarkDone = true; lastMarkAt = now; lastMarkHas = patch.hasData;
  }
  // 共用約定：每次載入時，讓紀錄跟實際狀況一致。有資料但紀錄寫 hasData:false（或根本沒有紀錄）就補成 true，
  // 沒資料卻寫 true 就改回 false。updatedAt 已有就保留，沒有才用現在。只在「讀得出來」時動，壞掉或不能存時不猜。
  function readRecord() {
    try {
      var o = JSON.parse(localStorage.getItem(SHARED_KEY) || '');
      return o && o.v === 1 && o.tools && typeof o.tools === 'object' && o.tools[ID] && typeof o.tools[ID] === 'object' ? o.tools[ID] : null;
    } catch (e) { return null; }
  }
  function reconcileRecord() {
    var has = state.items.length > 0, rec = readRecord();
    if (has && (!rec || rec.hasData !== true)) {
      var keep = rec && typeof rec.updatedAt === 'string' && !isNaN(Date.parse(rec.updatedAt)) ? rec.updatedAt : new Date().toISOString();
      markToolbox({ hasData: true, updatedAt: keep });
      lastMarkHas = true;
    } else if (!has && rec && rec.hasData === true) {
      markToolbox({ hasData: false });
      lastMarkHas = false;
    }
  }
  function readBackupTime() {
    try {
      var o = JSON.parse(localStorage.getItem(SHARED_KEY) || '');
      var e = o && o.v === 1 && o.tools && o.tools[ID];
      var t = e && typeof e.lastBackupAt === 'string' ? Date.parse(e.lastBackupAt) : NaN;
      return isNaN(t) ? null : t;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ 儲存層 */
  function emptyState() { return { v: 1, rev: 0, updatedAt: null, items: [], skipped: [] }; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return undefined; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function probe() {
    try { var k = KEY + '.probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch (e) { return false; }
  }
  // 表單草稿只放這個分頁的 sessionStorage（關掉分頁就沒了），而且只在「資料過期、被要求重新整理」時才用到
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
  // 讀取：整份資料的結構壞了才算「讀不出來」。單一項目有問題（例如日期超出範圍）只略過那一筆，
  // 原樣留在 skipped 裡，下次存檔時一起寫回去，不會被悄悄刪掉。
  function readStore() {
    var raw = lsGet(KEY);
    if (raw === undefined) return { status: 'unavailable', raw: null };
    if (raw === null) return { status: 'empty', raw: null, data: emptyState() };
    try {
      var o = JSON.parse(raw);
      var oldSkipped = o && Array.isArray(o.skipped) ? o.skipped : [];
      if (o && o.v === 1 && Number.isInteger(o.rev) && o.rev >= 0 && Array.isArray(o.items) && o.items.length <= MAX_ITEMS && oldSkipped.length <= MAX_ITEMS) {
        var items = [], skipped = [], seen = {};
        o.items.concat(oldSkipped).forEach(function (x) {
          var r = normalizeItem(x, true);
          if (r.error || items.length >= MAX_ITEMS) { skipped.push(x); return; }
          var base = r.item.id, k = 1;
          while (seen[r.item.id]) r.item.id = base.slice(0, 58) + '-' + (++k);   // 理論上不會重複 id；真的重複就補尾碼，兩筆都留著
          seen[r.item.id] = 1;
          items.push(r.item);
        });
        return { status: 'ok', raw: raw, data: { v: 1, rev: o.rev, updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null, items: items, skipped: skipped } };
      }
    } catch (e) { /* 落到下面 */ }
    return { status: 'broken', raw: raw };
  }

  var state = emptyState();
  var storageOk = true, broken = false, brokenRaw = null, stale = false;
  var filter = 'all';
  var form = null, confirmDel = null, pending = null, afterRender = null;
  var undoInfo = null;          // 最近一次「已續約」的復原資料；任何其他寫入或別的分頁更新後就作廢
  var lockUntil = 0;            // performance.now() 的時間點；在這之前，續約／確認刪除的連點一律忽略
  var renderedDay = null;       // 清單上次畫的是哪一天（跨過午夜要重畫）

  function showStale() {
    stale = true;
    renderNotices();
    var b = $('staleBanner');
    try { b.scrollIntoView({ block: 'center' }); } catch (e) {}
  }
  // 回傳 'ok' | 'stale' | 'fail'。寫入前先重讀 rev：別的分頁改過就拒絕，不蓋掉。
  function persist(items, expectedRev, allowBroken, skipped) {
    if (stale) { showStale(); return 'stale'; }
    if (broken && !allowBroken) return 'broken';
    if (storageOk) {
      var cur = readStore();
      if (broken) {
        if (cur.status !== 'broken' || cur.raw !== brokenRaw) { showStale(); return 'stale'; }
      } else {
        var r = cur.status === 'ok' ? cur.data.rev : cur.status === 'empty' ? 0 : -1;
        if (r !== expectedRev) { showStale(); return 'stale'; }
      }
    }
    var sk = skipped === undefined ? state.skipped : skipped;
    var out = { v: 1, rev: broken ? Math.floor(Date.now() / 1000) : expectedRev + 1, updatedAt: new Date().toISOString(), items: items };
    if (sk.length) out.skipped = sk;   // 讀不出來的項目原樣保留，不會被悄悄刪掉
    if (storageOk && !lsSet(KEY, JSON.stringify(out))) return 'fail';
    state = { v: 1, rev: out.rev, updatedAt: out.updatedAt, items: items, skipped: sk };
    if (broken) { broken = false; brokenRaw = null; }
    undoInfo = null;
    noteSaved(items.length > 0);
    return 'ok';
  }
  function failText(res) {
    if (res === 'fail') return '儲存失敗：瀏覽器沒有讓網頁寫入資料（可能是空間不足）。請先下載備份。';
    if (res === 'broken') return '這個瀏覽器裡存的資料讀不出來，已暫停儲存。請先從備份還原，或清除全部資料重新開始。';
    return '這個分頁的資料已過期，請先重新整理。';
  }

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
  function safeName(s) {
    return Array.from(String(s).replace(/[\\/:*?"<>|\s\u0000-\u001f]+/g, '-')).slice(0, 20).join('').replace(/^-+|-+$/g, '') || 'item';
  }
  function byDays(a, b) { return a.days - b.days || a.item.name.localeCompare(b.item.name, 'zh-Hant'); }

  /* ------------------------------------------------------------------ 畫面 */
  function renderNotices() {
    $('staleBanner').hidden = !stale;
    $('noStorage').hidden = storageOk;
    $('brokenBanner').hidden = !broken;
    var n = broken ? 0 : state.skipped.length;
    $('skippedBanner').hidden = !n;
    $('skippedText').textContent = n ? '有 ' + n + ' 項資料讀不出來（例如日期超出範圍），先不顯示，但沒有被刪掉。其他項目都正常。需要清掉的話，可以從備份還原。' : '';
  }

  function renderSummary(all) {
    var sec = $('summarySec');
    sec.hidden = !all.length;
    if (!all.length) return;
    var order = [['expired', '已過期'], ['d30', '30 天內'], ['d90', '90 天內'], ['ok', '正常']];
    var counts = {};
    all.forEach(function (x) { counts[x.st.key] = (counts[x.st.key] || 0) + 1; });
    var ul = $('summary');
    ul.textContent = '';
    order.forEach(function (o) {
      ul.append(h('li', { class: 'tile st-' + o[0] }, h('b', { text: String(counts[o[0]] || 0) }), h('span', { text: o[1] })));
    });
  }

  function buildFilters() {
    var box = $('filters');
    [['all', '全部']].concat(CATS.map(function (c) { return [c, c]; })).forEach(function (c) {
      box.append(h('button', { class: 'pill', type: 'button', 'data-cat': c[0], 'aria-pressed': 'false' }));
    });
  }
  function renderFilters(base) {
    var counts = { all: base.length };
    base.forEach(function (x) { counts[x.item.category] = (counts[x.item.category] || 0) + 1; });
    Array.prototype.forEach.call($('filters').children, function (b) {
      var c = b.getAttribute('data-cat');
      b.textContent = (c === 'all' ? '全部' : c) + ' ' + (counts[c] || 0);
      b.setAttribute('aria-pressed', c === filter ? 'true' : 'false');
    });
  }

  function rowEl(x, today) {
    var it = x.item;
    var tags = h('div', { class: 'row-tags' },
      h('span', { class: 'badge st-' + x.st.key, text: x.st.label }),
      h('span', { class: 'tag', text: it.category }),
      it.repeat !== 'none' ? h('span', { class: 'tag', text: REPEAT_LABEL[it.repeat] }) : null);
    var next = null;
    it.reminders.forEach(function (n) {
      var d = addDays(x.due, -n);
      if (dayNum(d) >= dayNum(today) && (!next || dayNum(d) < dayNum(next))) next = d;
    });
    var remText = it.reminders.length
      ? '提前 ' + it.reminders.join('、') + ' 天提醒' + (next ? '，下次提醒 ' + next : '，提醒日都過了')
      : '只在到期日提醒';
    var main = h('div', { class: 'row-main' },
      h('h3', { class: 'row-name', text: it.name }), tags,
      h('p', { class: 'row-info', text: remText }),
      x.rolled ? h('p', { class: 'row-info', text: '登記日期 ' + it.date + '，已自動推算到下一期；上一期若還沒續約，請確認。' }) : null,
      it.note ? h('p', { class: 'row-note', text: it.note }) : null);
    var date = h('div', { class: 'row-date' },
      h('span', { class: 'date', text: x.due + '（週' + weekdayOf(x.due) + '）' }),
      h('span', { class: 'left', text: leftText(x.days) }));
    var act = h('div', { class: 'row-actions' });
    function btn(a, label, extra) {
      return h('button', { class: 'btn' + (extra ? ' ' + extra : ''), type: 'button', 'data-act': a, 'data-id': it.id, 'aria-label': label + ' ' + it.name, text: label });
    }
    if (it.repeat !== 'none') {
      // 續約鈕記住「畫面上看到的版本」（seq 與到期日）：資料在按下之前變過，就不會照舊算
      var rb = btn('renew', '已續約', 'primary');
      rb.setAttribute('data-seq', String(it.seq || 0));
      rb.setAttribute('data-due', x.due);
      act.append(rb);
    }
    act.append(btn('edit', '編輯'), btn('ics', '匯出 .ics'), btn('del', '刪除', 'danger'));
    var li = h('li', { class: 'row st-' + x.st.key, 'data-id': it.id }, main, date, act);
    if (confirmDel === it.id) {
      li.append(h('div', { class: 'confirm', role: 'group', 'aria-label': '確認刪除' },
        h('p', { text: '確定刪除「' + it.name + '」？刪掉就找不回來了。' }),
        h('div', { class: 'actions' },
          h('button', { class: 'btn danger-solid', type: 'button', 'data-act': 'delok', 'data-id': it.id, text: '確定刪除' }),
          h('button', { class: 'btn', type: 'button', 'data-act': 'delno', 'data-id': it.id, text: '取消' }))));
    }
    return li;
  }

  function renderRows() {
    var today = todayStr();
    renderedDay = today;
    var q = $('q').value.trim().toLowerCase();
    var all = state.items.map(function (it) { return info(it, today); }).sort(byDays);
    var base = all.filter(function (x) { return !q || (x.item.name + ' ' + x.item.note + ' ' + x.item.category).toLowerCase().indexOf(q) >= 0; });
    var shown = base.filter(function (x) { return filter === 'all' || x.item.category === filter; });
    renderSummary(all);
    $('listTools').hidden = !all.length;
    renderFilters(base);
    var ul = $('rows');
    ul.textContent = '';
    shown.forEach(function (x) { ul.append(rowEl(x, today)); });
    $('count').textContent = all.length ? '顯示 ' + shown.length + ' / ' + all.length + ' 項，依剩餘天數排序' : '';
    var empty = $('empty');
    if (!all.length) { empty.hidden = false; empty.textContent = '還沒有項目。從上面「常用名稱」挑一個，或自己輸入名稱和到期日。'; }
    else if (!shown.length) { empty.hidden = false; empty.textContent = '沒有符合的項目。換個關鍵字，或把類別改成「全部」。'; }
    else empty.hidden = true;
    renderExport();
  }

  function renderExport() {
    var n = state.items.length, evs = eventList(state.items, todayStr(), $('futureOnly').checked).length;
    $('exportAll').disabled = !n;
    $('exportAll').textContent = '匯出全部 .ics（' + n + ' 項）';
    $('exportInfo').textContent = n ? '目前會產生 ' + evs + ' 個整天事件：' + n + ' 個到期日，加上 ' + (evs - n) + ' 個提醒日。' : '先新增項目，才能匯出。';
  }

  function renderBackup() {
    var t = readBackupTime(), el = $('backupLine');
    var needs = false;
    if (t == null) { el.textContent = '還沒有備份過'; needs = state.items.length > 0; }
    else {
      var days = Math.max(0, daysBetween(localYmd(t), todayStr()));
      el.textContent = '上次備份：' + localYmd(t) + '（' + (days === 0 ? '今天' : days + ' 天前') + '）';
      needs = state.items.length > 0 && days > 14;
    }
    el.className = 'lastbackup' + (needs ? ' warn' : '');
    $('backupNudge').hidden = !needs;
  }

  function renderPanels() {
    var rp = $('restorePanel');
    rp.textContent = '';
    rp.hidden = !pending;
    if (pending) {
      var by = {};
      pending.items.forEach(function (it) { by[it.category] = (by[it.category] || 0) + 1; });
      var parts = CATS.filter(function (c) { return by[c]; }).map(function (c) { return c + ' ' + by[c]; });
      rp.append(
        h('p', { text: '備份檔裡有 ' + pending.items.length + ' 項' + (parts.length ? '（' + parts.join('、') + '）' : '') + (pending.exportedAt ? '，匯出時間 ' + pending.exportedAt : '') + '。' }),
        h('p', { text: '目前這個瀏覽器有 ' + state.items.length + ' 項。還原會把目前的資料整個換掉，無法復原。' }),
        h('div', { class: 'actions' },
          h('button', { class: 'btn danger-solid', type: 'button', id: 'restoreOk', text: '確定取代目前資料' }),
          h('button', { class: 'btn', type: 'button', id: 'restoreNo', text: '取消' })));
    }
    var cp = $('clearPanel');
    cp.textContent = '';
    cp.hidden = !clearAsk;
    if (clearAsk) {
      cp.append(
        h('p', { text: '確定清除這個瀏覽器裡的全部 ' + state.items.length + ' 項資料？清除後無法復原，建議先下載備份。' }),
        h('div', { class: 'actions' },
          h('button', { class: 'btn danger-solid', type: 'button', id: 'clearOk', text: '確定清除' }),
          h('button', { class: 'btn', type: 'button', id: 'clearNo', text: '取消' })));
    }
  }
  var clearAsk = false;

  function render() {
    if (confirmDel && !state.items.some(function (x) { return x.id === confirmDel; })) confirmDel = null;
    renderNotices();
    renderRows();
    renderBackup();
    renderPanels();
    renderUndo();
    if (afterRender) { var f = afterRender; afterRender = null; f(); }
  }

  /* ------------------------------------------------------------------ 表單 */
  function fillSelects() {
    CATS.forEach(function (c) { $('fCat').append(h('option', { value: c, text: c })); });
    D.repeats.forEach(function (r) { $('fRepeat').append(h('option', { value: r[0], text: r[1] })); });
    D.quick.forEach(function (q) {
      $('quick').append(h('button', { class: 'chip-btn', type: 'button', 'data-name': q.name, text: q.name }));
    });
    D.remPresets.forEach(function (n) {
      $('remChips').append(h('button', { class: 'chip-btn', type: 'button', 'data-days': String(n), 'aria-pressed': 'false', text: n + ' 天' }));
    });
  }
  // 快捷鈕的按下狀態跟著欄位走（欄位是唯一真相，快捷鈕只是替手機省去切鍵盤）
  function syncRemChips() {
    var cur = remValid($('fRem').value);
    Array.prototype.forEach.call($('remChips').children, function (b) {
      b.setAttribute('aria-pressed', cur.indexOf(+b.getAttribute('data-days')) >= 0 ? 'true' : 'false');
    });
  }
  function toggleRemChip(n) {
    var cur = remValid($('fRem').value), i = cur.indexOf(n);
    if (i >= 0) cur.splice(i, 1);
    else {
      if (cur.length >= MAX_REM) { fieldErr('fRem', '提醒天數最多 ' + MAX_REM + ' 個，先取消一個再加。'); return; }
      cur.push(n);
    }
    cur.sort(function (a, b) { return b - a; });
    $('fRem').value = cur.join(', ');
    $('fRem').removeAttribute('aria-invalid'); $('eRem').hidden = true; $('eRem').textContent = '';
    syncRemChips();
  }
  var FIELD_ERR = { fName: 'eName', fDate: 'eDate', fRem: 'eRem', fNote: 'eNote' };
  function clearErrors() {
    Object.keys(FIELD_ERR).forEach(function (f) {
      $(f).removeAttribute('aria-invalid');
      var e = $(FIELD_ERR[f]); e.hidden = true; e.textContent = '';
    });
    $('eForm').hidden = true; $('eForm').textContent = '';
  }
  function fieldErr(f, msg) {
    $(f).setAttribute('aria-invalid', 'true');
    var e = $(FIELD_ERR[f]); e.textContent = msg; e.hidden = false;
  }
  function openForm(mode, id, focus) {
    var it = mode === 'edit' ? state.items.find(function (x) { return x.id === id; }) : null;
    if (mode === 'edit' && !it) return;
    var shownDate = it ? effectiveDue(it, todayStr()) : '';
    form = { mode: mode, id: it ? it.id : null, baseRev: state.rev, prefill: shownDate };
    clearErrors();
    say($('formMsg'), '');
    $('formTitle').textContent = it ? '修改項目' : '填寫項目';
    $('saveBtn').textContent = it ? '儲存修改' : '儲存';
    $('fName').value = it ? it.name : '';
    $('fCat').value = it ? it.category : CATS[0];
    $('fDate').value = shownDate;
    $('fRepeat').value = it ? it.repeat : 'none';
    $('fRem').value = (it ? it.reminders : D.reminders).join(', ');
    $('fNote').value = it ? it.note : '';
    syncRemChips();
    $('quickWrap').hidden = !!it;
    $('itemForm').hidden = false;
    $('openForm').hidden = true;
    if (focus !== false) { $('fName').focus(); try { $('itemForm').scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  }
  function closeForm(focusBtn) {
    form = null;
    ssDel(DRAFT_KEY);
    $('itemForm').hidden = true;
    $('openForm').hidden = false;
    clearErrors();
    if (focusBtn !== false) $('openForm').focus();
  }
  function readForm() {
    clearErrors();
    var bad = [];
    var name = $('fName').value.trim(), note = $('fNote').value.trim(), date = $('fDate').value;
    if (!name) { fieldErr('fName', '請填名稱，例如「護照」。'); bad.push('fName'); }
    else if (looksLikeId(name)) { fieldErr('fName', ID_MSG); bad.push('fName'); }
    var p = parseYmd(date);
    var untouched = !!form && form.mode === 'edit' && date === form.prefill;   // 沒動過的舊日期不再要求在範圍內，才改得了備註
    if (!date) { fieldErr('fDate', '請選到期日。'); bad.push('fDate'); }
    else if (!p || (!untouched && (p.y < MIN_YEAR || p.y > MAX_YEAR))) { fieldErr('fDate', '日期要在 ' + MIN_YEAR + ' 到 ' + MAX_YEAR + ' 年之間。'); bad.push('fDate'); }
    var rem = parseReminders($('fRem').value);
    if (!rem.ok) { fieldErr('fRem', rem.msg); bad.push('fRem'); }
    if (looksLikeId(note)) { fieldErr('fNote', ID_MSG); bad.push('fNote'); }
    if (bad.length) { $(bad[0]).focus(); return null; }
    return { name: name, category: $('fCat').value, date: date, repeat: $('fRepeat').value, reminders: rem.list, note: note };
  }
  function submitForm(ev) {
    ev.preventDefault();
    if (!form) return;
    var v = readForm();
    if (!v) return;
    var items = state.items.slice(), saved;
    if (form.mode === 'edit') {
      var i = items.findIndex(function (x) { return x.id === form.id; });
      if (i < 0) { $('eForm').textContent = '這個項目已經不存在，可能在另一個分頁被刪掉了。'; $('eForm').hidden = false; return; }
      var old = items[i];
      var keep = old.repeat === v.repeat && v.date === form.prefill;   // 日期沒動、循環沒改：保留原本登記的日期與「日」
      saved = Object.assign({}, old, v, {
        date: keep ? old.date : v.date,
        anchorDay: keep ? old.anchorDay : parseYmd(v.date).d,
        seq: (old.seq || 0) + 1
      });
      items[i] = saved;
    } else {
      if (items.length >= MAX_ITEMS) { $('eForm').textContent = '最多 ' + MAX_ITEMS + ' 項。'; $('eForm').hidden = false; return; }
      saved = Object.assign({ id: newId(), anchorDay: parseYmd(v.date).d, seq: 0, createdAt: new Date().toISOString() }, v);
      items.push(saved);
    }
    var res = persist(items, form.baseRev);
    if (res !== 'ok') {
      if (res === 'stale') saveDraft();   // 橫幅讓人重新整理；草稿先收進這個分頁的暫存，重新整理後還會回來
      $('eForm').textContent = failText(res); $('eForm').hidden = false; return;
    }
    var wasEdit = form.mode === 'edit';
    closeForm(false);
    render();
    say($('formMsg'), wasEdit ? '已儲存修改：' + saved.name : '已新增：' + saved.name, 'ok');
    $('openForm').focus();
  }

  /* ------------------------------------------------------------------ 動作 */
  function findItem(id) { return state.items.find(function (x) { return x.id === id; }); }
  function exportIcs(items, one) {
    var today = todayStr(), futureOnly = $('futureOnly').checked;
    var text = buildIcs(items, { today: today, futureOnly: futureOnly, now: new Date() });
    var fname = 'expiry-' + (one ? safeName(one.name) + '-' : '') + compact(today) + '.ics';
    download(fname, 'text/calendar;charset=utf-8', text);
    var n = eventList(items, today, futureOnly).length;
    say($('exportMsg'), '已下載 ' + fname + '：' + items.length + ' 個項目、' + n + ' 個事件。', 'ok');
    if (!one) $('exportAll').focus();
  }
  function lockActions() { lockUntil = performance.now() + ACTION_LOCK_MS; }
  function actionsLocked() { return performance.now() < lockUntil; }
  function undoOk() {
    var it = undoInfo && findItem(undoInfo.id);
    return !!it && (it.seq || 0) === undoInfo.nextSeq && it.date === undoInfo.nd;
  }
  function renderUndo() {
    if (undoInfo && !undoOk()) undoInfo = null;
    $('undoWrap').hidden = !undoInfo;
    if (undoInfo) $('undoBtn').setAttribute('aria-label', '復原這次續約：' + undoInfo.name + '，日期改回 ' + undoInfo.due);
  }
  function renewItem(it, b) {
    var lm = $('listMsg'), id = it.id;
    var today = todayStr(), due = effectiveDue(it, today);
    // 只照「按下的那一刻畫面上看到的」續約：資料在這之前變過（別的分頁、跨過午夜），就不動，請使用者重看
    if (String(it.seq || 0) !== b.getAttribute('data-seq') || due !== b.getAttribute('data-due')) {
      say(lm, '「' + it.name + '」的日期剛剛有變動，這次沒有續約。請看一下清單上的新日期，要的話再按一次。', 'err');
      render();
      return;
    }
    var nd = addMonths(due, stepOf(it.repeat), it.anchorDay);
    if (nd > MAX_DATE) { say(lm, '續約後會超過 ' + MAX_YEAR + ' 年，這個工具只記到 ' + MAX_YEAR + ' 年，所以沒有續約。', 'err'); return; }
    var nextSeq = (it.seq || 0) + 1;
    var items = state.items.map(function (x) { return x.id === id ? Object.assign({}, x, { date: nd, seq: nextSeq }) : x; });
    var r2 = persist(items, state.rev);
    lockActions();
    if (r2 !== 'ok') { say(lm, failText(r2), 'err'); return; }
    undoInfo = { id: id, name: it.name, prevDate: it.date, prevSeq: it.seq || 0, due: due, nd: nd, nextSeq: nextSeq };
    afterRender = function () { var o = document.querySelector('[data-act="renew"][data-id="' + id + '"]'); if (o) o.focus(); };
    render();
    say(lm, '已續約：' + it.name + ' 的到期日從 ' + due + ' 改成 ' + nd + '。按錯了可以按下面的「復原」。', 'ok');
  }
  function undoRenew() {
    if (actionsLocked()) return;
    var lm = $('listMsg');
    if (!undoInfo || !undoOk()) { undoInfo = null; renderUndo(); say(lm, '這個項目之後又有變動，沒辦法復原。', 'err'); return; }
    var u = undoInfo;
    var items = state.items.map(function (x) { return x.id === u.id ? Object.assign({}, x, { date: u.prevDate, seq: u.nextSeq + 1 }) : x; });   // seq 只增不減，行事曆才會當成更新
    var res = persist(items, state.rev);
    lockActions();
    if (res !== 'ok') { say(lm, failText(res), 'err'); return; }
    afterRender = function () { var o = document.querySelector('[data-act="renew"][data-id="' + u.id + '"]'); if (o) o.focus(); };
    render();
    say(lm, '已復原：' + u.name + ' 的到期日改回 ' + u.due + '。', 'ok');
  }
  function onRowClick(ev) {
    var b = ev.target.closest('button[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act'), id = b.getAttribute('data-id'), it = findItem(id);
    var lm = $('listMsg');
    if (!it) return;
    // 會改資料的動作：連點（第二下 detail>1）或剛做完的短時間內，一律忽略。
    // 畫面重畫後清單會重新排序，第二下很可能落在別的項目的按鈕上。
    if ((act === 'renew' || act === 'delok') && (ev.detail > 1 || actionsLocked())) return;
    if (act === 'edit') { openForm('edit', id); return; }
    if (act === 'ics') { exportIcs([it], it); return; }
    if (act === 'del') {
      confirmDel = id;
      afterRender = function () { var o = document.querySelector('[data-act="delok"][data-id="' + id + '"]'); if (o) o.focus(); };
      render(); return;
    }
    if (act === 'delno') {
      confirmDel = null;
      afterRender = function () { var o = document.querySelector('[data-act="del"][data-id="' + id + '"]'); if (o) o.focus(); };
      render(); return;
    }
    if (act === 'delok') {
      var res = persist(state.items.filter(function (x) { return x.id !== id; }), state.rev);
      lockActions();
      confirmDel = null;
      if (res !== 'ok') { say(lm, failText(res), 'err'); render(); return; }
      if (form && form.id === id) closeForm(false);
      afterRender = function () { $('openForm').focus(); };
      render();
      say(lm, '已刪除：' + it.name, 'ok');
      return;
    }
    if (act === 'renew') renewItem(it, b);
  }

  function doBackup() {
    var payload = {
      kind: KIND, v: 1, exportedAt: new Date().toISOString(),
      data: { items: state.items.map(function (it) {
        return { id: it.id, name: it.name, category: it.category, date: it.date, repeat: it.repeat, reminders: it.reminders.slice(),
          note: it.note, anchorDay: it.anchorDay, seq: it.seq, createdAt: it.createdAt };
      }) }
    };
    var fname = 'expiry-backup-' + compact(todayStr()) + '.json';
    download(fname, 'application/json', JSON.stringify(payload, null, 2));
    markToolbox({ lastBackupAt: new Date().toISOString() });
    renderBackup();
    say($('backupMsg'), '已下載 ' + fname + '（' + state.items.length + ' 項）。', 'ok');
  }
  function validateBackup(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: '內容不是這個工具的備份格式。' };
    if (o.kind !== KIND) return { error: '這不是「證件與到期日管家」的備份檔。' };
    if (o.v !== 1) return { error: '備份檔的版本不支援。' };
    if (!o.data || typeof o.data !== 'object' || !Array.isArray(o.data.items)) return { error: '備份檔裡找不到項目清單。' };
    if (o.data.items.length > MAX_ITEMS) return { error: '備份檔的項目超過 ' + MAX_ITEMS + ' 項。' };
    var items = [], seen = {};
    for (var i = 0; i < o.data.items.length; i++) {
      var r = normalizeItem(o.data.items[i]);
      if (r.error) return { error: '第 ' + (i + 1) + ' 項：' + r.error + '。' };
      if (seen[r.item.id]) r.item.id = newId();
      seen[r.item.id] = 1;
      items.push(r.item);
    }
    var t = typeof o.exportedAt === 'string' ? Date.parse(o.exportedAt) : NaN;
    return { items: items, exportedAt: isNaN(t) ? '' : localYmd(t) };
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
  function doRestore() {
    if (!pending) return;
    var res = persist(pending.items, state.rev, true, []);
    if (res !== 'ok') { say($('backupMsg'), failText(res), 'err'); return; }
    var n = pending.items.length;
    pending = null;
    markNow({ hasData: n > 0 });   // 紀錄馬上更新，資料保險箱和首頁提醒不用等重新整理
    if (form) closeForm(false);
    render();
    say($('backupMsg'), '已還原 ' + n + ' 項。', 'ok');
    $('restoreBtn').focus();
  }
  function doClear() {
    var res = persist([], state.rev, true, []);
    clearAsk = false;
    if (res !== 'ok') { renderPanels(); say($('backupMsg'), failText(res), 'err'); return; }
    markNow({ hasData: false, lastBackupAt: null });   // 重設：舊備份檔不涵蓋之後才輸入的資料，所以「上次備份」一併清空
    if (form) closeForm(false);
    render();
    say($('backupMsg'), '已清除全部資料。', 'ok');
    $('clearBtn').focus();
  }

  /* ------------------------------------------------------------------ 別的分頁改了資料 */
  function sync() {
    if (!storageOk) return;
    var r = readStore();
    if (r.status === 'ok') {
      if (r.data.rev !== state.rev) {
        state = r.data;
        undoInfo = null;
        if (broken) { broken = false; brokenRaw = null; }
        render();
      }
    } else if (r.status === 'empty') {
      if (state.rev !== 0 || state.items.length) { state = emptyState(); undoInfo = null; render(); }
    } else if (r.status === 'broken' && !broken) {
      broken = true; brokenRaw = r.raw; renderNotices();
    }
  }

  /* ------------------------------------------------------------------ 表單草稿（資料過期要重新整理時，不讓人白打） */
  function scrub(t) { return looksLikeId(t) ? '' : t; }   // 長串數字（像證號卡號）連暫存都不留
  function saveDraft() {
    if (!form || $('itemForm').hidden) return;
    ssSet(DRAFT_KEY, JSON.stringify({
      v: 1, mode: form.mode, id: form.id, savedAt: new Date().toISOString(),
      name: scrub($('fName').value), category: $('fCat').value, date: $('fDate').value, repeat: $('fRepeat').value,
      rem: $('fRem').value, note: scrub($('fNote').value)
    }));
  }
  function takeDraft() {
    var raw = ssGet(DRAFT_KEY);
    if (raw == null) return null;
    ssDel(DRAFT_KEY);
    try {
      var d = JSON.parse(raw);
      if (!d || d.v !== 1 || (d.mode !== 'add' && d.mode !== 'edit')) return null;
      if (['name', 'date', 'rem', 'note'].some(function (k) { return typeof d[k] !== 'string'; })) return null;
      if (Array.from(d.name).length > MAX_NAME || Array.from(d.note).length > MAX_NOTE || d.rem.length > 80 || d.date.length > 10) return null;
      if (CATS.indexOf(d.category) < 0 || !REPEAT_LABEL.hasOwnProperty(d.repeat)) return null;
      return d;
    } catch (e) { return null; }
  }
  function restoreDraft(d) {
    var it = d.mode === 'edit' && typeof d.id === 'string' ? findItem(d.id) : null;
    openForm(it ? 'edit' : 'add', it ? it.id : null, false);
    $('fName').value = d.name; $('fCat').value = d.category; $('fDate').value = d.date;
    $('fRepeat').value = d.repeat; $('fRem').value = d.rem; $('fNote').value = d.note;
    syncRemChips();
    say($('formMsg'), d.mode === 'edit' && !it
      ? '原本要修改的項目已經不在了。這是你剛才填的內容，按「儲存」會當成新項目加進去。'
      : '已把你剛才填到一半的內容放回來，確認後按「儲存」。', 'ok');
  }

  /* ------------------------------------------------------------------ 跨過午夜：天數要跟著變 */
  function checkDay() { if (renderedDay && todayStr() !== renderedDay) render(); }
  var midnightTimer = null;
  function msToMidnight() {
    var n = new Date(), next = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 0, 0);
    return Math.min(Math.max(next - n + 300, 1000), 26 * 3600 * 1000);
  }
  function scheduleMidnight() {
    clearTimeout(midnightTimer);
    midnightTimer = setTimeout(function () { checkDay(); scheduleMidnight(); }, msToMidnight());
  }

  /* ------------------------------------------------------------------ 啟動 */
  function init() {
    fillSelects();
    buildFilters();
    storageOk = probe();
    if (storageOk) {
      var r = readStore();
      if (r.status === 'ok' || r.status === 'empty') state = r.data;
      else if (r.status === 'broken') { broken = true; brokenRaw = r.raw; }
      else storageOk = false;
    }

    $('openForm').addEventListener('click', function () { openForm('add'); });
    $('cancelBtn').addEventListener('click', function () { closeForm(); });
    $('itemForm').addEventListener('submit', submitForm);
    $('itemForm').addEventListener('keydown', function (e) { if (e.key === 'Escape') closeForm(); });
    $('quick').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-name]');
      if (!b) return;
      var q = D.quick.find(function (x) { return x.name === b.getAttribute('data-name'); });
      if (!q) return;
      $('fName').value = q.name; $('fCat').value = q.category; $('fRepeat').value = q.repeat;
      $('eName').hidden = true; $('fName').removeAttribute('aria-invalid');
      $('fDate').focus();
    });
    $('rows').addEventListener('click', onRowClick);
    // 按住 Enter 會連續觸發按鈕：續約、刪除這類動作不吃連發
    $('rows').addEventListener('keydown', function (e) { if (e.repeat && e.target.closest && e.target.closest('button[data-act]')) e.preventDefault(); });
    $('undoBtn').addEventListener('click', undoRenew);
    $('fRem').addEventListener('input', function () {
      syncRemChips();
      if ($('fRem').getAttribute('aria-invalid') && parseReminders($('fRem').value).ok) { $('fRem').removeAttribute('aria-invalid'); $('eRem').hidden = true; $('eRem').textContent = ''; }
    });
    $('fRem').addEventListener('blur', function () {
      var r = parseReminders($('fRem').value);
      if (!r.ok) fieldErr('fRem', r.msg);
    });
    $('remChips').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-days]');
      if (b) toggleRemChip(+b.getAttribute('data-days'));
    });
    $('q').addEventListener('input', function () { renderRows(); });
    $('filters').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-cat]');
      if (!b) return;
      filter = b.getAttribute('data-cat');
      renderRows();
    });
    $('futureOnly').addEventListener('change', renderExport);
    $('exportAll').addEventListener('click', function () { exportIcs(state.items, null); });
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
    $('reloadBtn').addEventListener('click', function () { saveDraft(); location.reload(); });
    window.addEventListener('pagehide', function () { if (stale) saveDraft(); });
    window.addEventListener('storage', function (e) {
      if (e.key === KEY || e.key === null) sync();
      if (e.key === SHARED_KEY || e.key === null) renderBackup();
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { sync(); checkDay(); } });
    window.addEventListener('focus', checkDay);
    window.addEventListener('pageshow', checkDay);

    if (storageOk && !broken) reconcileRecord();
    render();
    scheduleMidnight();
    var draft = takeDraft();
    if (draft) restoreDraft(draft);
    else if (!state.items.length && !broken) openForm('add', null, false);
  }

  window.ExpiryCore = {
    parseYmd: parseYmd, addDays: addDays, addMonths: addMonths, daysBetween: daysBetween, effectiveDue: effectiveDue,
    statusOf: statusOf, parseReminders: parseReminders, looksLikeId: looksLikeId, normalizeItem: normalizeItem,
    escapeText: escapeText, foldLine: foldLine, eventList: eventList, buildIcs: buildIcs, remValid: remValid, KEY: KEY
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
