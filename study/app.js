/* 語言每日複習：間隔重複單字卡。純前端、不連網；資料只存在這個瀏覽器的 localStorage。
 *
 * 複習間隔（6 格 Leitner 盒子，單位：天）：
 *   格子   1   2   3   4    5    6
 *   間隔   1   3   7   14   30   60
 *   記得   新卡直接進第 2 格（3 天後）；舊卡往下一格（第 6 格維持 60 天）。
 *   模糊   格子不變，間隔減半（至少 1 天）。
 *   忘了   回到第 1 格，這張卡先標成「重學中」，同一次複習裡隔幾張再出現一次，
 *          在重學中答「記得」才算過關（明天再見），答「模糊」就繼續留在這次複習裡。
 * 沒有連續天數、沒有失敗統計，只顯示「今天已複習幾張」與「明天會出現幾張」。
 *
 * 每天複習幾張的歷史（reviewsByDay：{ 'YYYY-MM-DD': 張數 }，台北日期，只留最近 120 天）：給「每週回顧」加總一整週用。
 * 數字和畫面上的「今天已複習幾張」同進同退（評分 +1、復原 −1、重設進度或刪牌組時一起減）。
 * reviewsSince：從這一天起，沒有紀錄就是真的沒複習（舊版資料轉換時，更早的日子沒有紀錄，不能當成 0 張）。
 */
(function () {
  'use strict';

  var TOOL_ID = 'study';
  var KEY = 'toolbox.' + TOOL_ID + '.v1';
  var SHARED_KEY = 'toolbox.backup.v1';
  var INTERVALS = [0, 1, 3, 7, 14, 30, 60];
  var DEFAULT_NEW = 10, MAX_NEW = 50, SESSION_CAP = 100, REQUEUE_GAP = 3;
  var LIM = { deckName: 30, front: 60, reading: 100, meaning: 200, example: 300, rows: 2000, userDecks: 20, exams: 30, examName: 40, csvBytes: 1048576, backupBytes: 5 * 1048576, seen: 5000 };
  var HIST_DAYS = 120, HIST_MAX = 400, HIST_N_MAX = 100000;   // 歷史留幾天、最多幾筆、單日張數上限（超過視為壞資料）
  var LANGS = { ja: '日語', ko: '韓語', en: '英語', none: '其他' };
  var SPEAK = { ja: 'ja-JP', ko: 'ko-KR', en: 'en-GB' };
  var READ_LABEL = { ja: '讀音', ko: '羅馬拼音', en: '詞性・音標', none: '讀音／註記' };
  var DEFAULT_OFF = { 'ja-n4': true };   // N5 還沒熟之前，N4 預設先關著
  var EXAM_PRESETS = ['JLPT N5', 'JLPT N4', 'TOPIK I', 'IELTS'];

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /* ---------- 日期（一律用本機日曆日） ---------- */
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return ymd(new Date()); }
  function parseYmd(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (!m) return null; return [+m[1], +m[2], +m[3]]; }
  function validDate(s) { if (typeof s !== 'string') return false; var p = parseYmd(s); if (!p) return false; var d = new Date(p[0], p[1] - 1, p[2]); return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2] && p[0] >= 1900 && p[0] <= 2200; }
  function addDays(s, n) { var p = parseYmd(s); return ymd(new Date(p[0], p[1] - 1, p[2] + n)); }
  function dayDiff(a, b) { var A = parseYmd(a), B = parseYmd(b); return Math.round((Date.UTC(B[0], B[1] - 1, B[2]) - Date.UTC(A[0], A[1] - 1, A[2])) / 864e5); }
  function compactDate() { return today().replace(/-/g, ''); }
  // 複習歷史用台北日期（UTC+8，台灣沒有夏令時間），這樣「每週回顧」換算週次時不受瀏覽器所在時區影響
  function taipeiDay() { var d = new Date(Date.now() + 8 * 36e5); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }

  /* ---------- 內建牌組 ---------- */
  var BUILTIN = [];
  (function () {
    var src = window.STUDY_DECKS;
    if (!Array.isArray(src)) return;
    src.forEach(function (d) {
      BUILTIN.push({
        id: d.id, name: d.name, lang: d.lang, builtin: true,
        cards: d.cards.map(function (c) { return { front: c[0], reading: c[1] || '', meaning: c[2], example: c[3] || '' }; })
      });
    });
  })();

  /* ---------- 狀態與儲存 ---------- */
  function blank() {
    return { v: 1, rev: 0, updatedAt: null, settings: { enabled: {}, newPerDay: {} }, progress: {}, daily: { date: '', seen: {}, newByDeck: {} }, userDecks: [], exams: [], reviewsByDay: {}, reviewsSince: null };
  }
  var S = blank();
  var storageOk = true, corrupt = null, stale = false;
  var lastMark = 0, lastHas = null;
  var ui = { tab: 'home', session: null, imp: null, draft: { examName: '', examDate: '' }, focus: null };

  function cleanStr(v, max, keepNewlines) {
    if (typeof v !== 'string') return null;
    var s = v;
    s = s.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\t/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '');
    try { s = s.normalize('NFC'); } catch (e) { /* 舊瀏覽器 */ }
    s = s.trim();
    if (s.length > max) return null;
    return s;
  }
  function cleanDeck(d, tally) {   // tally.cut：這副牌組裡被丟掉的卡片張數
    if (!isObj(d) || typeof d.id !== 'string' || !/^u[a-z0-9]{4,24}$/.test(d.id)) return null;
    var name = cleanStr(d.name, LIM.deckName); if (!name) return null;
    var lang = hasOwn(LANGS, d.lang) ? d.lang : 'none';
    if (!Array.isArray(d.cards) || !d.cards.length || d.cards.length > LIM.rows) return null;
    var seen = Object.create(null), cards = [];
    for (var i = 0; i < d.cards.length; i++) {
      var c = d.cards[i]; if (!isObj(c)) { tally.cut++; continue; }
      var front = cleanStr(c.front, LIM.front), meaning = cleanStr(c.meaning, LIM.meaning);
      var reading = c.reading == null || c.reading === '' ? '' : cleanStr(c.reading, LIM.reading);
      var example = c.example == null || c.example === '' ? '' : cleanStr(c.example, LIM.example);
      if (!front || !meaning || reading === null || example === null || seen[front]) { tally.cut++; continue; }
      seen[front] = 1; cards.push({ front: front, reading: reading, meaning: meaning, example: example });
    }
    if (!cards.length) return null;
    return { id: d.id, name: name, lang: lang, cards: cards };
  }
  function cleanProg(p) {
    if (!isObj(p)) return null;
    if (!Number.isInteger(p.b) || p.b < 1 || p.b > 6 || !validDate(p.d)) return null;
    var n = Number.isInteger(p.n) && p.n >= 0 && p.n <= 1e6 ? p.n : 0, x = Number.isInteger(p.x) && p.x >= 0 && p.x <= 1e6 ? p.x : 0;
    return { b: p.b, d: p.d, l: p.l ? 1 : 0, n: n, x: x };
  }
  /* 把「儲存的資料」或「備份檔裡的 data」整理成乾淨的資料，不合格的項目丟掉並計數 */
  function normalizeData(src, restoring) {
    var out = { settings: { enabled: {}, newPerDay: {} }, progress: {}, daily: { date: '', seen: {}, newByDeck: {} }, userDecks: [], exams: [], reviewsByDay: {}, reviewsSince: null };
    var dropped = 0;
    if (!isObj(src)) return { data: out, dropped: 1 };
    var ids = Object.create(null);
    BUILTIN.forEach(function (d) { ids[d.id] = 1; });
    if (Array.isArray(src.userDecks)) {
      src.userDecks.forEach(function (d) {
        var tally = { cut: 0 };
        var nd = out.userDecks.length < LIM.userDecks ? cleanDeck(d, tally) : null;
        if (!nd || ids[nd.id]) { dropped++; return; }
        dropped += tally.cut;   // 牌組留下來，但裡面被丟掉的卡片也要算進去
        ids[nd.id] = 1; out.userDecks.push(nd);
      });
    } else if (src.userDecks != null) dropped++;
    if (isObj(src.settings)) {
      if (isObj(src.settings.enabled)) Object.keys(src.settings.enabled).forEach(function (k) {
        if (ids[k] && typeof src.settings.enabled[k] === 'boolean') out.settings.enabled[k] = src.settings.enabled[k]; else dropped++;
      });
      if (isObj(src.settings.newPerDay)) Object.keys(src.settings.newPerDay).forEach(function (k) {
        var v = src.settings.newPerDay[k];
        if (ids[k] && Number.isInteger(v) && v >= 0 && v <= MAX_NEW) out.settings.newPerDay[k] = v; else dropped++;
      });
    } else if (src.settings != null) dropped++;
    if (isObj(src.progress)) {
      Object.keys(src.progress).forEach(function (k) {
        var cut = k.indexOf('|'), did = cut > 0 ? k.slice(0, cut) : '';
        var p = ids[did] ? cleanProg(src.progress[k]) : null;
        if (p) out.progress[k] = p; else dropped++;
      });
    } else if (src.progress != null) dropped++;
    if (isObj(src.daily) && validDate(src.daily.date)) {
      var dl = { date: src.daily.date, seen: {}, newByDeck: {} }, cnt = 0;
      if (isObj(src.daily.seen)) Object.keys(src.daily.seen).forEach(function (k) { if (cnt < LIM.seen && out.progress[k]) { dl.seen[k] = 1; cnt++; } });
      if (isObj(src.daily.newByDeck)) Object.keys(src.daily.newByDeck).forEach(function (k) {
        var v = src.daily.newByDeck[k]; if (ids[k] && Number.isInteger(v) && v >= 0 && v <= 5000) dl.newByDeck[k] = v;
      });
      out.daily = dl;
    }
    if (Array.isArray(src.exams)) {
      var used = Object.create(null);
      src.exams.forEach(function (e) {
        if (out.exams.length >= LIM.exams || !isObj(e)) { dropped++; return; }
        var name = cleanStr(e.name, LIM.examName);
        if (!name || !validDate(e.date)) { dropped++; return; }
        var id = typeof e.id === 'string' && /^[a-z0-9]{3,24}$/i.test(e.id) && !used[e.id] ? e.id : uid('e');
        used[id] = 1; out.exams.push({ id: id, name: name, date: e.date });
      });
    } else if (src.exams != null) dropped++;

    /* 每天複習張數的歷史。超過 120 天的舊紀錄與 0 張不留；格式不對的丟掉並計數。 */
    var tp = taipeiDay(), cutoff = addDays(tp, -(HIST_DAYS - 1)), hist = {}, since = null;
    if (isObj(src.reviewsByDay)) {
      var kept = 0;
      Object.keys(src.reviewsByDay).forEach(function (k) {
        var v = src.reviewsByDay[k];
        if (!validDate(k) || !Number.isInteger(v) || v < 0 || v > HIST_N_MAX) { dropped++; return; }
        if (k < cutoff || v === 0) return;
        if (kept >= HIST_MAX) { dropped++; return; }
        hist[k] = v; kept++;
      });
      if (validDate(src.reviewsSince)) since = src.reviewsSince; else if (src.reviewsSince != null) dropped++;
    } else {
      /* 舊版資料或舊備份：只有「最近一天」的張數。那一天的張數變成那一天的紀錄（今天的就是今天），
       * 從那一天起才算有完整紀錄；從備份還原時中間隔了多久不知道，所以改從還原那天起算。 */
      if (src.reviewsByDay != null) dropped++;
      var d0 = out.daily.date, c0 = d0 ? Object.keys(out.daily.seen).length : 0, k0 = d0 === today() ? tp : d0;
      if (c0 > 0 && k0 >= cutoff) hist[k0] = c0;
      since = restoring ? tp : (d0 && d0 < tp ? d0 : tp);
    }
    out.reviewsByDay = hist; out.reviewsSince = since;
    return { data: out, dropped: dropped };
  }
  function uid(prefix) { return prefix + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); }

  function readStore() {
    var raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return { status: 'unavailable' }; }
    if (raw === null) return { status: 'empty' };
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { return { status: 'corrupt', raw: raw }; }
    if (!isObj(obj) || obj.v !== 1) return { status: 'corrupt', raw: raw };
    var n = normalizeData(obj);
    var st = blank();
    st.settings = n.data.settings; st.progress = n.data.progress; st.daily = n.data.daily; st.userDecks = n.data.userDecks; st.exams = n.data.exams;
    st.reviewsByDay = n.data.reviewsByDay; st.reviewsSince = n.data.reviewsSince;
    st.rev = Number.isInteger(obj.rev) && obj.rev >= 0 ? obj.rev : 0;
    st.updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt : null;
    return { status: 'ok', state: st, legacy: !isObj(obj.reviewsByDay) };
  }
  function applyStore(r) {
    storageOk = r.status !== 'unavailable';
    corrupt = r.status === 'corrupt' ? r.raw : null;
    if (r.status === 'ok') { S = r.state; stale = false; }
    else if (r.status === 'empty') { S = blank(); stale = false; }
    else if (r.status === 'corrupt') { S = blank(); stale = false; }
  }

  /* 共用備份紀錄（資料保險箱讀這個）：只存「有沒有資料、最後儲存、最後備份」，不存內容 */
  function markToolbox(patch) {
    try {
      var K = SHARED_KEY, o;
      try { o = JSON.parse(localStorage.getItem(K) || ''); } catch (e) { /* 壞掉就重建 */ }
      if (!o || o.v !== 1 || !isObj(o.tools)) o = { v: 1, tools: {} };
      var cur = hasOwn(o.tools, TOOL_ID) && isObj(o.tools[TOOL_ID]) ? o.tools[TOOL_ID] : { hasData: false, updatedAt: null, lastBackupAt: null };   // 這一筆不是物件（字串、陣列、null）就重建
      o.tools[TOOL_ID] = Object.assign(cur, patch);
      localStorage.setItem(K, JSON.stringify(o));
    } catch (e) { /* 寫不進去就算了，不影響工具本身 */ }
  }
  function hasMeaningful(st) {
    return Object.keys(st.progress).length > 0 || st.userDecks.length > 0 || st.exams.length > 0 ||
      Object.keys(st.settings.enabled).length > 0 || Object.keys(st.settings.newPerDay).length > 0;
  }
  function noteSaved() {
    var has = hasMeaningful(S), now = Date.now();
    if (lastMark === 0 || has !== lastHas || now - lastMark >= 60000) {
      markToolbox({ hasData: has, updatedAt: new Date(now).toISOString() });
      lastMark = now; lastHas = has;
    }
  }
  // 還原或重設成功後，馬上把紀錄對齊（不等 60 秒節流、不用重新整理）：
  //  還原 → hasData 照實際、updatedAt 現在；重設（全部清除、讀不出來後重新開始）→ {hasData:false, updatedAt:現在, lastBackupAt:null}（舊備份檔不涵蓋重設後才輸入的資料）
  function markNow(patch) {
    var now = Date.now();
    markToolbox(Object.assign({ updatedAt: new Date(now).toISOString() }, patch));
    lastMark = now; lastHas = patch.hasData;
  }
  /* 載入時對一次帳：紀錄不能宣稱工具沒有的資料，也不能漏掉工具已有的資料（讀不到或壞掉時不確定，不動） */
  function reconcileShared(r) {
    if (r.status !== 'ok' && r.status !== 'empty') return;
    var has = r.status === 'ok' && hasMeaningful(S), rec = null, junk = false;
    try {
      var o = JSON.parse(localStorage.getItem(SHARED_KEY) || ''), ent = o && o.v === 1 && isObj(o.tools) && hasOwn(o.tools, TOOL_ID) ? o.tools[TOOL_ID] : undefined;
      rec = isObj(ent) ? ent : null;
      junk = ent !== undefined && !isObj(ent);   // 有這一筆，但不是物件（字串、陣列、null）：重建
    } catch (e) { /* 沒有或壞掉：當作沒有紀錄 */ }
    if (junk) markToolbox(has ? { hasData: true, updatedAt: new Date().toISOString() } : { hasData: false });
    else if (has && !(rec && rec.hasData === true)) {
      var keep = rec && typeof rec.updatedAt === 'string' && !isNaN(Date.parse(rec.updatedAt));
      markToolbox({ hasData: true, updatedAt: keep ? rec.updatedAt : new Date().toISOString() });
    } else if (!has && rec && rec.hasData === true) markToolbox({ hasData: false });
  }
  function lastBackupMs() {
    try {
      var o = JSON.parse(localStorage.getItem(SHARED_KEY) || '');
      var t = o && o.v === 1 && o.tools && o.tools[TOOL_ID] && o.tools[TOOL_ID].lastBackupAt;
      var ms = typeof t === 'string' ? Date.parse(t) : NaN;
      return isNaN(ms) ? null : ms;
    } catch (e) { return null; }
  }

  /* 寫入：先複製一份、改完、確認沒有別的分頁動過（rev 相同）才真的存 */
  function persist(next) {
    if (corrupt) { say('存放的資料讀不出來，為了保護它，這次沒有寫入。'); return false; }
    if (stale) return false;
    if (storageOk) {
      var curRev = 0, raw = null, readable = true;
      try { raw = localStorage.getItem(KEY); } catch (e) { readable = false; }
      if (readable) {
        if (raw !== null) {
          try { var o = JSON.parse(raw); curRev = isObj(o) && Number.isInteger(o.rev) ? o.rev : 0; } catch (e) { curRev = -1; }
        }
        if (curRev !== S.rev) { stale = true; render(); return false; }
        next.rev = S.rev + 1; next.updatedAt = new Date().toISOString();
        try { localStorage.setItem(KEY, JSON.stringify(next)); }
        catch (e) { say('這個瀏覽器存不下（空間不足或被禁止），這次的變更沒有留下。'); return false; }
        S = next; noteSaved(); return true;
      }
      storageOk = false;
    }
    next.rev = S.rev + 1; next.updatedAt = new Date().toISOString(); S = next; return true;   // 只存在這個分頁的記憶體
  }
  /* 今天（本機日曆日）已複習的張數：和畫面上的「今天已複習幾張」是同一個數字 */
  function seenToday(st) { return st.daily && st.daily.date === today() && isObj(st.daily.seen) ? Object.keys(st.daily.seen).length : 0; }
  /* 每天複習張數的歷史跟著「今天已複習幾張」同進同退，記在台北日期上，並刪掉超過 120 天的舊紀錄 */
  function trackReviews(next, prev) {
    if (!isObj(next.reviewsByDay)) next.reviewsByDay = {};
    var k = taipeiDay(), delta = seenToday(next) - seenToday(prev);
    if (!next.reviewsSince && !Object.keys(next.reviewsByDay).length) next.reviewsSince = k;   // 全新的資料：從第一次寫入這天起算
    if (delta) {
      var v = (next.reviewsByDay[k] || 0) + delta;
      if (v > 0) next.reviewsByDay[k] = v; else delete next.reviewsByDay[k];
    }
    var cutoff = addDays(k, -(HIST_DAYS - 1));
    Object.keys(next.reviewsByDay).forEach(function (d) { if (d < cutoff) delete next.reviewsByDay[d]; });
  }
  function commit(fn) { var next = clone(S); fn(next); trackReviews(next, S); return persist(next); }
  /* 舊版存的資料沒有每天的複習張數：載入時補上一次（學習內容不變、updatedAt 不動，只多了 reviewsByDay／reviewsSince）。
   * 不然「每週回顧」要等到下一次評分，才看得到今天已經複習的張數。 */
  function upgradeLegacy(r) {
    if (r.status !== 'ok' || !r.legacy || !storageOk) return;
    var next = clone(S); next.rev = S.rev + 1;
    try { localStorage.setItem(KEY, JSON.stringify(next)); S = next; } catch (e) { /* 寫不進去：這次先不補，下次載入再試 */ }
  }

  /* ---------- 牌組與查詢 ---------- */
  function allDecks() { return BUILTIN.concat(S.userDecks.map(function (d) { return { id: d.id, name: d.name, lang: d.lang, builtin: false, cards: d.cards }; })); }
  function deckById(id) { var a = allDecks(); for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i]; return null; }
  function cardKey(deckId, front) { return deckId + '|' + front; }
  function isEnabled(id) { if (hasOwn(S.settings.enabled, id)) return !!S.settings.enabled[id]; return !DEFAULT_OFF[id]; }
  function newLimit(id) { return hasOwn(S.settings.newPerDay, id) ? S.settings.newPerDay[id] : DEFAULT_NEW; }
  function daily() { var t = today(); return S.daily && S.daily.date === t ? S.daily : { date: t, seen: {}, newByDeck: {} }; }
  function deckStats(d) {
    var t = today(), dl = daily(), due = 0, learned = 0, unseen = 0;
    d.cards.forEach(function (c) {
      var p = S.progress[cardKey(d.id, c.front)];
      if (p) { learned++; if (p.d <= t) due++; } else unseen++;
    });
    var room = Math.max(0, newLimit(d.id) - (dl.newByDeck[d.id] || 0));
    return { total: d.cards.length, due: due, learned: learned, unseen: unseen, newAvail: Math.min(unseen, room) };
  }
  function tomorrowCount() {
    var tm = addDays(today(), 1), n = 0;
    allDecks().forEach(function (d) {
      if (!isEnabled(d.id)) return;
      d.cards.forEach(function (c) { var p = S.progress[cardKey(d.id, c.front)]; if (p && p.d === tm) n++; });
    });
    return n;
  }

  /* ---------- 間隔重複 ---------- */
  function applyGrade(prev, g, t) {
    var b = prev ? prev.b : 0, learning = prev ? !!prev.l : false, n = (prev ? prev.n : 0) + 1, x = prev ? prev.x : 0, due = t;
    if (g === 'again') {
      if (prev && !learning) x++;
      b = 1; learning = true; due = t;
    } else if (g === 'hard') {
      if (learning) due = t;
      else { b = Math.max(1, b); due = addDays(t, Math.max(1, Math.floor(INTERVALS[b] / 2))); }
    } else {
      if (learning) { learning = false; b = 1; due = addDays(t, INTERVALS[1]); }
      else { b = b === 0 ? 2 : Math.min(6, b + 1); due = addDays(t, INTERVALS[b]); }
    }
    return { b: b, d: due, l: learning ? 1 : 0, n: n, x: x };
  }
  function hint(prev, g) {
    var r = applyGrade(prev, g, '2000-01-01');
    if (r.l) return '稍後再看';
    var n = dayDiff('2000-01-01', r.d);
    return n <= 1 ? '明天' : n + ' 天後';
  }

  /* ---------- 小工具：提示、對話框、下載 ---------- */
  var toastTimer = null;
  function say(msg) {
    var t = $('#toast'); t.textContent = msg;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.textContent = ''; }, 6000);
  }
  function ask(o) {
    return new Promise(function (resolve) {
      var dlg = $('#dlg'), yes = $('#dlgYes'), no = $('#dlgNo'), done = false;
      $('#dlgT').textContent = o.title;
      var body = $('#dlgB'); body.textContent = '';
      (o.body || []).forEach(function (line) { var p = document.createElement('p'); p.textContent = line; body.appendChild(p); });
      yes.textContent = o.ok || '確認'; no.textContent = o.cancel || '取消';
      function finish(v) { if (done) return; done = true; cleanup(); if (dlg.open) dlg.close(); resolve(v); }
      function onYes() { finish(true); } function onNo() { finish(false); } function onClose() { finish(false); }
      function cleanup() { yes.removeEventListener('click', onYes); no.removeEventListener('click', onNo); dlg.removeEventListener('close', onClose); }
      yes.addEventListener('click', onYes); no.addEventListener('click', onNo); dlg.addEventListener('close', onClose);
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
      no.focus();
    });
  }
  function download(name, blob) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }
  function readText(file) {
    if (file.text) return file.text();
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result)); }; r.onerror = function () { rej(r.error); }; r.readAsText(file, 'utf-8'); });
  }

  /* ---------- 發音（只用本機語音，不走網路） ---------- */
  var voices = [];
  function refreshVoices() { try { voices = (window.speechSynthesis && speechSynthesis.getVoices()) || []; } catch (e) { voices = []; } }
  function voiceFor(lang) {
    var tag = SPEAK[lang]; if (!tag) return null;
    var prim = tag.slice(0, 2).toLowerCase();
    var local = voices.filter(function (v) { return v && v.localService === true; });
    var norm = function (v) { return String(v.lang || '').replace('_', '-'); };
    for (var i = 0; i < local.length; i++) if (norm(local[i]).toLowerCase() === tag.toLowerCase()) return local[i];
    for (var j = 0; j < local.length; j++) if (norm(local[j]).toLowerCase().indexOf(prim) === 0) return local[j];
    return null;
  }
  function speakCard(item) {
    var v = voiceFor(item.deck.lang); if (!v) return;
    var text = item.deck.lang === 'ja' && item.card.reading ? item.card.reading : item.card.front;
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.voice = v; u.lang = v.lang; u.rate = 0.9;
      speechSynthesis.speak(u);
    } catch (e) { /* 沒有聲音就算了 */ }
  }

  /* ---------- 畫面 ---------- */
  var TABS = [['home', '複習'], ['decks', '牌組'], ['exams', '考試'], ['backup', '備份']];
  function render() {
    var a = document.activeElement, fk = a && a.getAttribute ? a.getAttribute('data-fk') : null;
    if (!ui.focus && fk) ui.focus = fk;
    renderBanners();
    var tabs = $('#tabs');
    tabs.hidden = !!ui.session;
    var lede = $('header .lede'); if (lede) lede.hidden = !!ui.session;
    tabs.innerHTML = TABS.map(function (t) { return '<button type="button" data-act="tab" data-tab="' + t[0] + '" data-fk="tab:' + t[0] + '"' + (ui.tab === t[0] ? ' aria-current="page"' : '') + '>' + t[1] + '</button>'; }).join('');
    var v = $('#view');
    if (ui.session) v.innerHTML = sessionHTML();
    else if (ui.tab === 'decks') v.innerHTML = decksHTML();
    else if (ui.tab === 'exams') v.innerHTML = examsHTML();
    else if (ui.tab === 'backup') v.innerHTML = backupHTML();
    else v.innerHTML = homeHTML();
    if (ui.session && !ui.session.done) {
      var target = ui.session.flipped ? $('.ans', v) : $('[data-act="flip"]', v);
      if (target && ui.session.focusNext) target.focus({ preventScroll: true });
      ui.session.focusNext = false;
    } else if (ui.focus) {
      var el = v.querySelector('[data-fk="' + ui.focus.replace(/"/g, '\\"') + '"]') || $('#tabs [data-fk="' + ui.focus.replace(/"/g, '\\"') + '"]');
      if (el) el.focus({ preventScroll: true });
    }
    ui.focus = null;
  }
  function renderBanners() {
    var h = '';
    if (stale) h += '<div class="banner" role="alert"><p>這個分頁的資料已過期（另一個分頁有更新），請重新整理</p><button class="bbtn" type="button" data-act="reload">重新整理</button></div>';
    if (corrupt) h += '<div class="banner" role="alert"><p>存放的學習資料讀不出來，可能已經損毀。為了保護它，這個工具暫時不會寫入任何東西。</p><button class="bbtn" type="button" data-act="dlcorrupt">下載原始內容</button><button class="bbtn" type="button" data-act="resetcorrupt">重新開始</button></div>';
    if (!storageOk) h += '<div class="banner soft" role="status"><p>這個瀏覽器沒辦法儲存資料（可能是無痕視窗，或封鎖了網站資料）。你還是可以複習，但關掉頁面後進度不會留下。</p></div>';
    $('#banners').innerHTML = h;
  }

  function fmtDays(n) { return n === 0 ? '就是今天' : n > 0 ? '還有 ' + n + ' 天' : '已過 ' + (-n) + ' 天'; }
  function sortedExams() {
    var t = today();
    return S.exams.map(function (e) { return { e: e, n: dayDiff(t, e.date) }; }).sort(function (a, b) {
      if ((a.n >= 0) !== (b.n >= 0)) return a.n >= 0 ? -1 : 1;
      return a.n >= 0 ? a.n - b.n : b.n - a.n;
    });
  }

  function homeHTML() {
    var dl = daily(), reviewed = Object.keys(dl.seen).length;
    var rows = allDecks().filter(function (d) { return isEnabled(d.id); }).map(function (d) { return { d: d, st: deckStats(d) }; });
    var due = 0, fresh = 0;
    rows.forEach(function (r) { due += r.st.due; fresh += r.st.newAvail; });
    var tm = tomorrowCount();
    var h = '<section aria-labelledby="h-today"><h2 class="tape" id="h-today">今天</h2><div class="card">';
    h += '<p class="big">今天已複習 ' + reviewed + ' 張</p>';
    h += '<dl class="facts"><div><dt>現在可複習</dt><dd>' + (due + fresh) + ' 張（舊卡 ' + due + '、新卡 ' + fresh + '）</dd></div>';
    h += '<div><dt>明天會出現</dt><dd>' + tm + ' 張</dd></div></dl>';
    if (!rows.length) h += '<p class="note">還沒有啟用任何牌組，到「牌組」分頁打開想學的牌組。</p>';
    else if (due + fresh === 0) h += '<p class="note">現在沒有要複習的卡，今天先到這裡。</p>';
    else h += '<div class="actions"><button class="btn primary" type="button" data-act="start" data-fk="start">開始複習</button></div>';
    h += '</div></section>';

    h += '<section aria-labelledby="h-exam"><h2 class="tape" id="h-exam">考試倒數</h2>';
    var ex = sortedExams();
    if (!ex.length) h += '<p class="note">還沒有設定考試日期。到「考試」分頁加上去，這裡就會顯示還有幾天。</p>';
    else h += '<ul class="list" aria-label="考試倒數">' + ex.map(function (x) {
      return '<li class="item' + (x.n < 0 ? ' dim' : '') + '"><div><h3>' + esc(x.e.name) + '</h3><p class="meta">' + esc(x.e.date) + '</p></div><p class="left' + (x.n < 0 ? ' past' : '') + '">' + fmtDays(x.n) + '</p></li>';
    }).join('') + '</ul>';
    h += '</section>';

    if (rows.length) {
      h += '<section aria-labelledby="h-decks"><h2 class="tape" id="h-decks">各牌組</h2><ul class="list" aria-label="各牌組">' + rows.map(function (r) {
        var can = r.st.due + r.st.newAvail > 0;
        return '<li class="item"><div><h3>' + esc(r.d.name) + '</h3><p class="meta">到期 ' + r.st.due + ' 張・新卡 ' + r.st.newAvail + ' 張・已學 ' + r.st.learned + ' / ' + r.st.total + '</p></div>' +
          (can ? '<button class="btn" type="button" data-act="start" data-deck="' + esc(r.d.id) + '" data-fk="start:' + esc(r.d.id) + '">只複習這副</button>' : '') + '</li>';
      }).join('') + '</ul></section>';
    }
    h += '<details class="how"><summary>複習間隔怎麼算</summary><div class="body">' +
      '<p>每張卡有 6 格，間隔依序是 1、3、7、14、30、60 天。按「記得」往下一格，間隔拉長；新卡一開始就記得，直接從第 2 格（3 天後）開始。</p>' +
      '<p>按「模糊」留在原本那一格，間隔減半（至少 1 天）。按「忘了」回到第 1 格，這次複習裡過幾張會再出現，答「記得」之後明天再見。</p>' +
      '<p>每天的新卡數量可以在「牌組」分頁調整，預設每副 10 張。</p></div></details>';
    return h;
  }

  function langChip(l) { return '<span class="chip">' + LANGS[l] + '</span>'; }
  function decksHTML() {
    var h = '<section aria-labelledby="h-dk"><h2 class="tape" id="h-dk">我的牌組</h2><ul class="list" aria-label="牌組列表">';
    allDecks().forEach(function (d) {
      var st = deckStats(d), on = isEnabled(d.id), pct = st.total ? Math.round(st.learned * 100 / st.total) : 0;
      h += '<li class="deck' + (on ? '' : ' off') + '" data-deck="' + esc(d.id) + '"><div class="deck-head"><h3>' + esc(d.name) + ' ' + langChip(d.lang) + (d.builtin ? '' : ' <span class="chip">自己匯入</span>') + '</h3>' +
        '<label class="chk"><input type="checkbox" data-act="toggle" data-id="' + esc(d.id) + '" data-fk="toggle:' + esc(d.id) + '"' + (on ? ' checked' : '') + '> 啟用</label></div>' +
        '<p class="meta">共 ' + st.total + ' 張・已學 ' + st.learned + ' 張・今天到期 ' + st.due + ' 張</p><div class="bar" aria-hidden="true"><i style="width:' + pct + '%"></i></div>' +
        '<div class="deck-controls"><label class="lim">每天新卡 <input type="number" min="0" max="' + MAX_NEW + '" step="1" inputmode="numeric" data-act="limit" data-id="' + esc(d.id) + '" data-fk="limit:' + esc(d.id) + '" value="' + newLimit(d.id) + '" aria-label="' + esc(d.name) + ' 每天新卡張數"> 張</label>' +
        '<button class="btn" type="button" data-act="export" data-id="' + esc(d.id) + '" data-fk="export:' + esc(d.id) + '">匯出 CSV</button>' +
        '<button class="btn" type="button" data-act="reset" data-id="' + esc(d.id) + '" data-fk="reset:' + esc(d.id) + '">重設進度</button>' +
        (d.builtin ? '' : '<button class="btn" type="button" data-act="deldeck" data-id="' + esc(d.id) + '" data-fk="deldeck:' + esc(d.id) + '">刪除牌組</button>') + '</div></li>';
    });
    h += '</ul></section>';
    h += '<section aria-labelledby="h-imp"><h2 class="tape" id="h-imp">匯入自己的牌組</h2><div class="card">' +
      '<p class="msg">用 CSV 檔匯入，欄位是 <b>front, reading, meaning, example</b>（單字、讀音、中文意思、例句）。front 和 meaning 一定要有，reading 和 example 可以留空。第一列寫欄位名稱也可以，不寫就照這個順序讀。編碼請用 UTF-8（有沒有 BOM 都可以），檔案上限 1 MB、每副最多 ' + LIM.rows + ' 張。</p>' +
      '<label class="field"><span>選擇 CSV 檔</span><input type="file" id="csvFile" accept=".csv,text/csv,text/plain" data-fk="csvFile"></label>' +
      '<div class="actions"><button class="textbtn" type="button" data-act="template" data-fk="template">下載範本</button></div>';
    if (ui.imp) h += importHTML(ui.imp);
    h += '</div></section>';
    return h;
  }
  function importHTML(m) {
    if (m.fatal) return '<div class="banner soft" role="alert" style="margin-top:12px"><p>' + esc(m.fatal) + '</p></div>';
    var h = '<div id="impBox" style="margin-top:14px"><p class="msg" role="status"><b>' + esc(m.file) + '</b>：讀到 ' + m.total + ' 列，可匯入 ' + m.rows.length + ' 張' + (m.errors.length ? '，有 ' + m.errors.length + ' 列有問題會被略過' : '') + '。</p>';
    if (m.rows.length) {
      h += '<p class="small" style="margin-top:8px">預覽前 ' + Math.min(10, m.rows.length) + ' 張</p><ul class="prev" aria-label="匯入預覽">' + m.rows.slice(0, 10).map(function (r) {
        return '<li><b>' + esc(r.front) + '</b><span>' + esc(r.reading) + '</span><span>' + esc(r.meaning) + '</span>' + (r.example ? '<span class="ex">' + esc(r.example) + '</span>' : '') + '</li>';
      }).join('') + '</ul>';
    }
    if (m.errors.length) {
      h += '<p class="small" style="margin-top:10px">有問題的列（前 10 筆）</p><ul class="errs" aria-label="匯入問題">' + m.errors.slice(0, 10).map(function (e) { return '<li>第 ' + e.line + ' 行：' + esc(e.msg) + '</li>'; }).join('') + '</ul>';
      if (m.errors.length > 10) h += '<p class="small">還有 ' + (m.errors.length - 10) + ' 列沒有列出。</p>';
    }
    if (m.rows.length) {
      h += '<label class="field"><span>牌組名稱（最多 ' + LIM.deckName + ' 字）</span><input type="text" id="impName" maxlength="' + LIM.deckName + '" value="' + esc(ui.draft.impName != null ? ui.draft.impName : m.name) + '" data-draft="impName"></label>' +
        '<label class="field"><span>語言（決定有沒有發音按鈕）</span><select id="impLang" data-draft="impLang">' + Object.keys(LANGS).map(function (k) { return '<option value="' + k + '"' + ((ui.draft.impLang || 'none') === k ? ' selected' : '') + '>' + LANGS[k] + '</option>'; }).join('') + '</select></label>' +
        '<div class="actions"><button class="btn primary" type="button" data-act="doimport" data-fk="doimport">匯入 ' + m.rows.length + ' 張</button><button class="btn" type="button" data-act="cancelimport" data-fk="cancelimport">取消</button></div>';
    } else h += '<div class="actions"><button class="btn" type="button" data-act="cancelimport">關閉</button></div>';
    return h + '</div>';
  }

  function examsHTML() {
    var ex = sortedExams();
    var h = '<section aria-labelledby="h-ex"><h2 class="tape" id="h-ex">我的考試</h2>';
    if (!ex.length) h += '<p class="note">還沒有考試。在下面加上名稱和日期，首頁就會倒數。</p>';
    else h += '<ul class="list" aria-label="考試列表">' + ex.map(function (x) {
      return '<li class="item' + (x.n < 0 ? ' dim' : '') + '"><div><h3>' + esc(x.e.name) + '</h3><p class="meta">' + esc(x.e.date) + '・' + fmtDays(x.n) + '</p></div>' +
        '<button class="btn" type="button" data-act="delexam" data-id="' + esc(x.e.id) + '" data-fk="delexam:' + esc(x.e.id) + '" aria-label="刪除 ' + esc(x.e.name) + '">刪除</button></li>';
    }).join('') + '</ul>';
    h += '</section><section aria-labelledby="h-addex"><h2 class="tape" id="h-addex">新增考試</h2><div class="card"><form id="examForm" novalidate>' +
      '<div class="row" role="group" aria-label="常用名稱">' + EXAM_PRESETS.map(function (n) { return '<button class="btn" type="button" data-act="preset" data-name="' + esc(n) + '" data-fk="preset:' + esc(n) + '">' + esc(n) + '</button>'; }).join('') + '</div>' +
      '<label class="field"><span>考試名稱（最多 ' + LIM.examName + ' 字）</span><input type="text" id="examName" maxlength="' + LIM.examName + '" value="' + esc(ui.draft.examName) + '" data-draft="examName" autocomplete="off"></label>' +
      '<label class="field"><span>考試日期</span><input type="date" id="examDate" value="' + esc(ui.draft.examDate) + '" data-draft="examDate"></label>' +
      '<p class="msg" id="examErr" role="alert" style="margin-top:8px"></p>' +
      '<div class="actions"><button class="btn primary" type="submit" data-fk="addexam">加入</button></div></form></div></section>';
    return h;
  }

  function backupHTML() {
    var lb = lastBackupMs(), lbText = '還沒有備份過';
    var lbOdd = false, lbLater = false;
    if (lb != null) {
      var lbDate = new Date(lb), lbYear = lbDate.getFullYear();
      if (lbYear < 1000 || lbYear > 9999) {   // 年份不是 4 位數：算不出「幾天前」，也寫不成 YYYY-MM-DD，只說時間異常
        lbOdd = true; lbLater = lb > Date.now(); lbText = '上次備份：時間異常';
      } else {
        var dd = dayDiff(ymd(lbDate), today());
        lbLater = lb > Date.now();   // 比現在還晚：電腦時間被調過或紀錄有誤，不能說「今天」
        lbOdd = lbLater;
        lbText = '上次備份：' + ymd(lbDate) + '（' + (lbOdd ? '時間異常' : dd <= 0 ? '今天' : dd + ' 天前') + '）';
      }
    }
    var nProg = Object.keys(S.progress).length;
    return '<section aria-labelledby="h-bk"><h2 class="tape" id="h-bk">備份與還原</h2><div class="card">' +
      '<p class="msg">學習進度、自己匯入的牌組和考試日期只存在這個瀏覽器裡。換電腦、清除網站資料，或瀏覽器自動清理時都可能消失，所以請定期下載備份檔。</p>' +
      '<p class="big" id="lastBackup" style="margin-top:12px;font-size:17px">' + esc(lbText) + '</p>' +
      (lbOdd ? '<p class="small" id="lastBackupOdd">' + (lbLater ? '這個日期比現在還晚，可能是電腦時間被調過。' : '這個日期看起來不對。') + '建議再下載一次備份。</p>' : '') +
      '<p class="small">目前有 ' + nProg + ' 張卡的學習紀錄、' + S.userDecks.length + ' 副自己匯入的牌組、' + S.exams.length + ' 場考試。</p>' +
      '<div class="actions"><button class="btn primary" type="button" data-act="backup" data-fk="backup">下載備份</button></div>' +
      '<label class="field"><span>從備份還原（會取代目前的資料）</span><input type="file" id="restoreFile" accept=".json,application/json" data-fk="restoreFile"></label></div></section>' +
      '<section aria-labelledby="h-clr"><h2 class="tape" id="h-clr">清除</h2><div class="card"><p class="msg">清除這個工具在這個瀏覽器裡的全部資料（進度、自己的牌組、考試）。建議先下載備份。</p>' +
      '<div class="actions"><button class="btn" type="button" data-act="clearall" data-fk="clearall">清除全部資料</button></div></div></section>';
  }

  function exampleHTML(ex, lang) {
    if (!ex) return '';
    var m = /^([\s\S]*?)（([\s\S]+)）\s*$/.exec(ex), main = m ? m[1] : ex, tr = m ? m[2] : '';
    return '<p class="example"><span lang="' + (lang === 'none' ? 'zh-Hant' : lang) + '">' + esc(main) + '</span>' + (tr ? '<span class="tr" lang="zh-Hant">' + esc(tr) + '</span>' : '') + '</p>';
  }
  /* 評分鈕的名稱只有「忘了／模糊／記得」；下次間隔當成說明（aria-describedby），數字鍵放 aria-keyshortcuts */
  function gradeBtn(prev, g, label, key, extra) {
    return '<button class="grade' + extra + '" type="button" data-act="grade" data-g="' + g + '" aria-label="' + label + '" aria-keyshortcuts="' + key + '" aria-describedby="gh-' + g + '">' +
      label + '<small id="gh-' + g + '">' + hint(prev, g) + '</small><kbd aria-hidden="true">' + key + '</kbd></button>';
  }
  function sessionHTML() {
    var ss = ui.session;
    if (ss.done) {
      var dl = daily(), n = Object.keys(dl.seen).length;
      return '<section aria-labelledby="h-done"><div class="card done"><h2 class="big" id="h-done">這次複習完了</h2><p class="msg" style="margin-top:8px">今天已複習 ' + n + ' 張。明天會出現 ' + tomorrowCount() + ' 張。</p>' +
        (ss.capped ? '<p class="small" style="margin-top:6px">還有一些到期的卡留到下次，一次最多先複習 ' + SESSION_CAP + ' 張。</p>' : '') +
        '<div class="actions"><button class="btn primary" type="button" data-act="end" data-fk="end">回到首頁</button></div></div>' +
        (ss.last ? '<div class="session-tools"><button class="textbtn" type="button" data-act="undo" data-fk="undo">復原上一個答案</button></div>' : '') + '</section>';
    }
    var it = ss.queue[0], isNew = !S.progress[it.key], prev = S.progress[it.key], lang = it.deck.lang;
    var h = '<section aria-label="複習中"><div class="sbar"><span class="msg" id="remain">還剩 ' + ss.queue.length + ' 張</span><span class="where">' + esc(it.deck.name) + '</span><button class="textbtn" type="button" data-act="end" data-fk="end">結束複習</button></div>';
    h += '<div class="face"><span class="flag">' + (isNew ? '新卡' : '複習') + '</span><p class="front" lang="' + (lang === 'none' ? 'zh-Hant' : lang) + '">' + esc(it.card.front) + '</p>';
    if (ss.flipped) {
      h += '<div class="ans" tabindex="-1" role="group" aria-label="答案">';
      if (it.card.reading) h += '<p class="reading" lang="' + (lang === 'none' ? 'zh-Hant' : lang === 'ko' || lang === 'en' ? 'en' : lang) + '"><span class="small" lang="zh-Hant">' + READ_LABEL[lang] + '　</span>' + esc(it.card.reading) + '</p>';
      h += '<p class="meaning" lang="zh-Hant">' + esc(it.card.meaning) + '</p>' + exampleHTML(it.card.example, lang);
      if (voiceFor(lang)) h += '<div><button class="btn speak" type="button" data-act="speak" aria-label="播放發音">發音</button></div>';
      h += '</div>';
    }
    h += '</div>';
    if (!ss.flipped) h += '<button class="btn primary reveal" type="button" data-act="flip" data-fk="flip" aria-keyshortcuts="Space">顯示答案<span aria-hidden="true">　<kbd>Space</kbd></span></button>';
    else h += '<div class="grades" role="group" aria-label="這張卡你記得嗎">' +
      gradeBtn(prev, 'again', '忘了', '1', '') + gradeBtn(prev, 'hard', '模糊', '2', '') + gradeBtn(prev, 'good', '記得', '3', ' good') + '</div>';
    h += '<div class="session-tools"><button class="textbtn" type="button" data-act="undo" data-fk="undo"' + (ss.last ? '' : ' disabled') + '>復原上一個答案</button>' +
      '<span class="small">今天已複習 ' + Object.keys(daily().seen).length + ' 張</span></div></section>';
    return h;
  }

  /* ---------- 複習流程 ---------- */
  function startSession(onlyId) {
    var t = today(), dl = daily(), due = [], fresh = [];
    allDecks().forEach(function (d) {
      if (!isEnabled(d.id) || (onlyId && d.id !== onlyId)) return;
      var room = Math.max(0, newLimit(d.id) - (dl.newByDeck[d.id] || 0));
      d.cards.forEach(function (c, i) {
        var key = cardKey(d.id, c.front), p = S.progress[key];
        if (p) { if (p.d <= t) due.push({ key: key, deck: d, card: c, i: i, d: p.d, b: p.b }); }
        else if (room > 0) { fresh.push({ key: key, deck: d, card: c, i: i }); room--; }
      });
    });
    due.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : (a.b - b.b) || (a.i - b.i); });
    var queue = due.slice(0, SESSION_CAP).concat(fresh);
    if (!queue.length) { say('現在沒有要複習的卡。'); render(); return; }
    ui.session = { queue: queue, flipped: false, total: queue.length, answered: 0, last: null, done: false, capped: due.length > SESSION_CAP, focusNext: true };
    render();
  }
  function flip() { var ss = ui.session; if (!ss || ss.done || ss.flipped) return; ss.flipped = true; ss.focusNext = true; render(); }
  function grade(g) {
    var ss = ui.session; if (!ss || ss.done || !ss.flipped) return;
    var item = ss.queue[0], t = today(), prev = S.progress[item.key] ? clone(S.progress[item.key]) : null, prevDaily = clone(daily());
    var res = applyGrade(prev, g, t);
    var ok = commit(function (n) {
      if (n.daily.date !== t) n.daily = { date: t, seen: {}, newByDeck: {} };
      n.progress[item.key] = res; n.daily.seen[item.key] = 1;
      if (!prev) n.daily.newByDeck[item.deck.id] = (n.daily.newByDeck[item.deck.id] || 0) + 1;
    });
    if (!ok) { render(); return; }
    ss.last = { key: item.key, prev: prev, daily: prevDaily, item: item };
    ss.queue.shift(); ss.answered++;
    if (res.l) ss.queue.splice(Math.min(ss.queue.length, REQUEUE_GAP), 0, item);
    ss.flipped = false; ss.focusNext = true;
    if (!ss.queue.length) { ss.done = true; ui.focus = 'end'; }
    render();
  }
  function undo() {
    var ss = ui.session, L = ss && ss.last; if (!L) return;
    var ok = commit(function (n) {
      if (L.prev) n.progress[L.key] = L.prev; else delete n.progress[L.key];
      n.daily = L.daily;
    });
    if (!ok) { render(); return; }
    var at = ss.queue.indexOf(L.item); if (at >= 0) ss.queue.splice(at, 1);
    ss.queue.unshift(L.item); ss.last = null; ss.answered = Math.max(0, ss.answered - 1); ss.done = false; ss.flipped = false; ss.focusNext = true;
    render();
  }

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    var first = text.split(/\r\n|\n|\r/, 1)[0] || '';
    var delim = first.split('\t').length > first.split(',').length ? '\t' : ',';
    var rows = [], row = [], field = '', inQ = false, line = 1, start = 1;
    function pushRow() {
      var empty = row.every(function (c) { return c.trim() === ''; });
      if (!empty) rows.push({ cells: row, line: start });
      row = []; start = line;
    }
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else { field += c; if (c === '\n') line++; }
      } else if (c === '"' && field === '') inQ = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = ''; line++; pushRow();
      } else field += c;
    }
    if (inQ) return { error: '引號沒有結束（從第 ' + start + ' 行開始），請檢查檔案。' };
    if (field !== '' || row.length) { row.push(field); pushRow(); }
    return { rows: rows };
  }
  function cell(v, max) {
    var s = String(v == null ? '' : v).replace(/\s*[\r\n]+\s*/g, ' ').replace(/\t/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '').trim();
    try { s = s.normalize('NFC'); } catch (e) { /* 舊瀏覽器 */ }
    s = s.replace(/^'(?=[=+\-@])/, '');
    return s.length > max ? null : s;
  }
  function analyzeCSV(text, fileName) {
    text = text.replace(/^﻿/, '');
    if (text.indexOf('�') >= 0) return { fatal: '這個檔案看起來不是 UTF-8 編碼（有無法辨識的字）。請用試算表另存成「CSV UTF-8」再匯入。' };
    var p = parseCSV(text); if (p.error) return { fatal: p.error };
    if (!p.rows.length) return { fatal: '檔案是空的。' };
    var map = { front: 0, reading: 1, meaning: 2, example: 3 }, from = 0, ncols = 4;
    var head = p.rows[0].cells.map(function (c) { return c.trim().toLowerCase(); });
    if (head.indexOf('front') >= 0) {
      if (head.indexOf('meaning') < 0) return { fatal: '第一列有 front 欄，但缺少 meaning 欄。' };
      map = { front: head.indexOf('front'), reading: head.indexOf('reading'), meaning: head.indexOf('meaning'), example: head.indexOf('example') };
      from = 1; ncols = head.length;
    }
    var rows = [], errors = [], seen = Object.create(null), total = 0;
    for (var i = from; i < p.rows.length; i++) {
      var r = p.rows[i], cs = r.cells; total++;
      var extra = cs.slice(ncols).some(function (x) { return x.trim() !== ''; });
      if (extra) { errors.push({ line: r.line, msg: '欄位超過 ' + ncols + ' 個。內容裡有逗號的話，請用雙引號把那一格包起來。' }); continue; }
      var get = function (k, max) { return map[k] >= 0 ? cell(cs[map[k]], max) : ''; };
      var front = get('front', LIM.front), meaning = get('meaning', LIM.meaning), reading = get('reading', LIM.reading), example = get('example', LIM.example);
      var bad = null;
      if (front === null) bad = 'front 太長（最多 ' + LIM.front + ' 字）';
      else if (front === '' || front === undefined) bad = 'front 是空的';
      else if (meaning === null) bad = 'meaning 太長（最多 ' + LIM.meaning + ' 字）';
      else if (!meaning) bad = 'meaning 是空的';
      else if (reading === null) bad = 'reading 太長（最多 ' + LIM.reading + ' 字）';
      else if (example === null) bad = 'example 太長（最多 ' + LIM.example + ' 字）';
      else if (seen[front]) bad = 'front「' + front + '」重複（和第 ' + seen[front] + ' 行相同），已略過';
      else if (rows.length >= LIM.rows) bad = '超過每副 ' + LIM.rows + ' 張的上限，已略過';
      if (bad) { errors.push({ line: r.line, msg: bad }); continue; }
      seen[front] = r.line; rows.push({ front: front, reading: reading || '', meaning: meaning, example: example || '' });
    }
    var name = (fileName || '').replace(/\.[^.]*$/, '').trim().slice(0, LIM.deckName);
    return { file: fileName || '', total: total, rows: rows, errors: errors, name: name };
  }
  function csvCell(s) {
    s = String(s == null ? '' : s);
    if (/^[=+\-@]/.test(s) || /^[\t\r]/.test(s)) s = "'" + s;      // 擋掉試算表公式注入；匯入時會把這個單引號拿掉
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function deckToCSV(d) {
    var lines = ['front,reading,meaning,example'].concat(d.cards.map(function (c) { return [c.front, c.reading, c.meaning, c.example].map(csvCell).join(','); }));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  /* ---------- 動作 ---------- */
  function setLimit(id, v) {
    var n = parseInt(v, 10);
    if (!Number.isInteger(n) || n < 0) n = 0;
    if (n > MAX_NEW) n = MAX_NEW;
    commit(function (s) { s.settings.newPerDay[id] = n; });
    render();
  }
  async function resetDeck(id) {
    var d = deckById(id); if (!d) return;
    var learned = deckStats(d).learned;
    var yes = await ask({ title: '重設「' + d.name + '」的進度？', body: ['這副牌已學的 ' + learned + ' 張會全部回到沒學過的狀態，無法復原。', '單字本身不會被刪除。'], ok: '重設進度' });
    if (!yes) return;
    var ok = commit(function (n) {
      Object.keys(n.progress).forEach(function (k) { if (k.indexOf(id + '|') === 0) delete n.progress[k]; });
      if (n.daily.newByDeck) delete n.daily.newByDeck[id];
      Object.keys(n.daily.seen || {}).forEach(function (k) { if (k.indexOf(id + '|') === 0) delete n.daily.seen[k]; });
    });
    if (ok) say('已重設「' + d.name + '」。');
    render();
  }
  async function deleteDeck(id) {
    var d = deckById(id); if (!d || d.builtin) return;
    var yes = await ask({ title: '刪除「' + d.name + '」？', body: ['這副牌的 ' + d.cards.length + ' 張卡和學習進度都會刪掉，無法復原。建議先匯出 CSV。'], ok: '刪除牌組' });
    if (!yes) return;
    var ok = commit(function (n) {
      n.userDecks = n.userDecks.filter(function (x) { return x.id !== id; });
      delete n.settings.enabled[id]; delete n.settings.newPerDay[id]; delete n.daily.newByDeck[id];
      Object.keys(n.progress).forEach(function (k) { if (k.indexOf(id + '|') === 0) delete n.progress[k]; });
      Object.keys(n.daily.seen || {}).forEach(function (k) { if (k.indexOf(id + '|') === 0) delete n.daily.seen[k]; });
    });
    if (ok) say('已刪除「' + d.name + '」。');
    render();
  }
  function exportDeck(id) {
    var d = deckById(id); if (!d) return;
    var safe = d.name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
    download('study-' + safe + '-' + compactDate() + '.csv', new Blob([deckToCSV(d)], { type: 'text/csv;charset=utf-8' }));
    say('已匯出「' + d.name + '」。');
  }
  function downloadTemplate() {
    var t = '﻿front,reading,meaning,example\r\nexample,/ɪɡˈzɑːmpl/,例子,This is an example.（這是一個例子。）\r\n"hello, world",,哈囉，世界,\r\n';
    download('study-template.csv', new Blob([t], { type: 'text/csv;charset=utf-8' }));
  }
  async function onCsvFile(input) {
    var f = input.files && input.files[0]; input.value = '';
    ui.draft.impName = null; ui.draft.impLang = 'none';
    if (!f) return;
    if (f.size > LIM.csvBytes) { ui.imp = { fatal: '檔案太大了（' + (f.size / 1048576).toFixed(1) + ' MB），上限是 1 MB。' }; render(); return; }
    try { ui.imp = analyzeCSV(await readText(f), f.name); }
    catch (e) { ui.imp = { fatal: '讀不了這個檔案。' }; }
    render();
  }
  function doImport() {
    var m = ui.imp; if (!m || !m.rows || !m.rows.length) return;
    var name = cleanStr($('#impName').value, LIM.deckName), lang = $('#impLang').value;
    ui.draft.impName = $('#impName').value; ui.draft.impLang = lang;
    if (!name) { say('請輸入牌組名稱（最多 ' + LIM.deckName + ' 字）。'); $('#impName').focus(); return; }
    if (allDecks().some(function (d) { return d.name.toLowerCase() === name.toLowerCase(); })) { say('已經有同名的牌組，請換一個名稱。'); $('#impName').focus(); return; }
    if (S.userDecks.length >= LIM.userDecks) { say('自己匯入的牌組最多 ' + LIM.userDecks + ' 副，請先刪掉不用的。'); return; }
    var id = uid('u'), cards = m.rows.map(function (r) { return { front: r.front, reading: r.reading, meaning: r.meaning, example: r.example }; });
    var ok = commit(function (n) { n.userDecks.push({ id: id, name: name, lang: hasOwn(LANGS, lang) ? lang : 'none', cards: cards }); n.settings.enabled[id] = true; });
    if (!ok) return;
    ui.imp = null; ui.draft.impName = null; ui.draft.impLang = null;
    say('已匯入「' + name + '」，共 ' + cards.length + ' 張。');
    render();
  }
  function addExam(ev) {
    ev.preventDefault();
    var name = cleanStr($('#examName').value, LIM.examName), date = $('#examDate').value, err = $('#examErr');
    ui.draft.examName = $('#examName').value; ui.draft.examDate = date;
    var msg = '';
    if (!name) msg = '請輸入考試名稱（最多 ' + LIM.examName + ' 字）。';
    else if (!validDate(date)) msg = '請選擇考試日期。';
    else if (S.exams.length >= LIM.exams) msg = '考試最多 ' + LIM.exams + ' 場，請先刪掉過期的。';
    if (msg) { err.textContent = msg; return; }
    var ok = commit(function (n) { n.exams.push({ id: uid('e'), name: name, date: date }); });
    if (!ok) return;
    ui.draft.examName = ''; ui.draft.examDate = '';
    say('已加入「' + name + '」。');
    render();
  }
  function backupNow() {
    var payload = { kind: 'toolbox.' + TOOL_ID, v: 1, exportedAt: new Date().toISOString(),
      data: { settings: S.settings, progress: S.progress, daily: S.daily, userDecks: S.userDecks, exams: S.exams, reviewsByDay: S.reviewsByDay, reviewsSince: S.reviewsSince } };
    download(TOOL_ID + '-backup-' + compactDate() + '.json', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    markToolbox({ lastBackupAt: new Date().toISOString() });
    say('備份檔已下載。');
    render();
  }
  async function onRestoreFile(input) {
    var f = input.files && input.files[0]; input.value = '';
    if (!f) return;
    if (f.size > LIM.backupBytes) { say('這個檔案超過 5 MB，不是這個工具的備份檔。'); return; }
    var obj;
    try { obj = JSON.parse(await readText(f)); } catch (e) { say('這個檔案不是有效的備份檔（JSON 讀不出來）。'); return; }
    if (!isObj(obj) || obj.kind !== 'toolbox.' + TOOL_ID || obj.v !== 1 || !isObj(obj.data)) { say('這不是「語言每日複習」的備份檔（格式或版本不符）。'); return; }
    var n = normalizeData(obj.data, true);
    var np = Object.keys(n.data.progress).length;
    if (!np && !n.data.userDecks.length && !n.data.exams.length && n.dropped) { say('備份檔裡沒有可用的資料。'); return; }
    var body = ['備份檔內容：' + np + ' 張卡的學習紀錄、' + n.data.userDecks.length + ' 副自己匯入的牌組、' + n.data.exams.length + ' 場考試。',
      '還原會取代這個瀏覽器目前的全部資料（目前有 ' + Object.keys(S.progress).length + ' 張卡的紀錄、' + S.userDecks.length + ' 副自己的牌組、' + S.exams.length + ' 場考試）。'];
    if (n.dropped) body.push('有 ' + n.dropped + ' 筆資料格式不正確，已略過。');
    if (typeof obj.exportedAt === 'string') body.push('備份時間：' + obj.exportedAt.slice(0, 10));
    var yes = await ask({ title: '要用這份備份還原嗎？', body: body, ok: '還原' });
    if (!yes) return;
    var next = blank(); next.settings = n.data.settings; next.progress = n.data.progress; next.daily = n.data.daily; next.userDecks = n.data.userDecks; next.exams = n.data.exams;
    next.reviewsByDay = n.data.reviewsByDay; next.reviewsSince = n.data.reviewsSince;
    ui.session = null; ui.imp = null;
    if (persist(next)) { markNow({ hasData: hasMeaningful(S) }); say('已還原。'); }   // 紀錄馬上更新，資料保險箱和首頁提醒不用等重新整理
    render();
  }
  async function clearAll() {
    var yes = await ask({ title: '清除全部資料？', body: ['學習進度、自己匯入的牌組、考試日期和設定都會從這個瀏覽器刪掉，無法復原。', '建議先按「下載備份」。'], ok: '全部清除' });
    if (!yes) return;
    ui.session = null; ui.imp = null;
    if (persist(blank())) { markNow({ hasData: false, lastBackupAt: null }); say('已清除。'); }
    render();
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null; if (!el || el.disabled) return;
    var act = el.getAttribute('data-act');
    switch (act) {
      case 'tab': ui.tab = el.getAttribute('data-tab'); ui.imp = ui.tab === 'decks' ? ui.imp : null; ui.focus = 'tab:' + ui.tab; render(); break;
      case 'start': startSession(el.getAttribute('data-deck') || null); break;
      case 'flip': flip(); break;
      case 'grade': grade(el.getAttribute('data-g')); break;
      case 'undo': undo(); break;
      case 'end': ui.session = null; ui.focus = 'start'; render(); break;
      case 'speak': if (ui.session && ui.session.queue[0]) speakCard(ui.session.queue[0]); break;
      case 'reload': location.reload(); break;
      case 'dlcorrupt': download('study-corrupt-' + compactDate() + '.txt', new Blob([corrupt || ''], { type: 'text/plain' })); break;
      case 'resetcorrupt':
        ask({ title: '重新開始？', body: ['目前存放的資料會被清掉，換成一份全新的空白資料。建議先按「下載原始內容」留一份。'], ok: '重新開始' }).then(function (yes) {
          if (!yes) return;
          var removed = true;
          try { localStorage.removeItem(KEY); } catch (err) { removed = false; }
          corrupt = null; S = blank();
          if (removed) markNow({ hasData: false, lastBackupAt: null });   // 共用紀錄馬上跟著改，不等到下次載入
          render();
        });
        break;
      case 'reset': resetDeck(el.getAttribute('data-id')); break;
      case 'deldeck': deleteDeck(el.getAttribute('data-id')); break;
      case 'export': exportDeck(el.getAttribute('data-id')); break;
      case 'template': downloadTemplate(); break;
      case 'doimport': doImport(); break;
      case 'cancelimport': ui.imp = null; ui.draft.impName = null; ui.draft.impLang = null; render(); break;
      case 'preset': { var nm = $('#examName'); nm.value = el.getAttribute('data-name'); ui.draft.examName = nm.value; nm.focus(); break; }
      case 'delexam': {
        var xid = el.getAttribute('data-id');
        commit(function (n) { n.exams = n.exams.filter(function (x) { return x.id !== xid; }); });
        render(); break;
      }
      case 'backup': backupNow(); break;
      case 'clearall': clearAll(); break;
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target; if (!t || !t.getAttribute) return;
    var act = t.getAttribute('data-act');
    if (act === 'toggle') { var id = t.getAttribute('data-id'), on = t.checked; commit(function (n) { n.settings.enabled[id] = on; }); render(); }
    else if (act === 'limit') setLimit(t.getAttribute('data-id'), t.value);
    else if (t.id === 'csvFile') onCsvFile(t);
    else if (t.id === 'restoreFile') onRestoreFile(t);
  });
  document.addEventListener('input', function (e) {
    var t = e.target; var k = t && t.getAttribute && t.getAttribute('data-draft');
    if (k) ui.draft[k] = t.value;
  });
  document.addEventListener('submit', function (e) { if (e.target && e.target.id === 'examForm') addExam(e); else e.preventDefault(); });
  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    var ss = ui.session; if (!ss || ss.done || $('#dlg').open) return;
    var t = e.target;
    if (t && t.matches && t.matches('input,textarea,select,[contenteditable="true"]')) return;
    if (e.key === ' ' || e.code === 'Space') {
      if (t && t.closest && t.closest('button,a,summary')) return;   // 按鈕上的空白鍵交給按鈕自己處理
      e.preventDefault(); if (!ss.flipped) flip();
    } else if (ss.flipped && (e.key === '1' || e.key === '2' || e.key === '3')) {
      e.preventDefault(); grade(e.key === '1' ? 'again' : e.key === '2' ? 'hard' : 'good');
    }
  });
  window.addEventListener('storage', function (e) {
    if (e.storageArea && e.storageArea !== window.localStorage) return;
    if (e.key !== null && e.key !== KEY) return;
    applyStore(readStore());
    if (ui.session) ui.session.queue = ui.session.queue.filter(function (it) { return !!deckById(it.deck.id); });
    var a = document.activeElement;
    if (a && a.matches && a.matches('#view input[type="text"], #view input[type="date"], #view input[type="number"], #view select') ) { ui.pending = true; return; }
    render();
  });
  document.addEventListener('focusout', function () {
    if (!ui.pending) return;
    setTimeout(function () { var a = document.activeElement; if (!(a && a.matches && a.matches('#view input[type="text"], #view input[type="date"], #view input[type="number"], #view select'))) { ui.pending = false; render(); } }, 0);
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !ui.session) render(); });
  try { if (window.speechSynthesis) { refreshVoices(); speechSynthesis.addEventListener('voiceschanged', function () { refreshVoices(); if (ui.session && !ui.session.done) render(); }); } } catch (e) { /* 沒有語音功能 */ }

  /* ---------- 啟動 ---------- */
  var firstRead = readStore();
  applyStore(firstRead);
  upgradeLegacy(firstRead);
  reconcileShared(firstRead);
  if (!BUILTIN.length) say('內建牌組沒有載入成功，請重新整理。');
  render();
})();
