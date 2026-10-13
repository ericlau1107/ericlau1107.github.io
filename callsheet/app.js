/* 拍攝日通告
 * 資料只存在這個瀏覽器的 localStorage（toolbox.callsheet.v1），不連網、不上傳。
 * 區塊：共用備份紀錄 → 日照計算（NOAA）→ 座標解析 → 資料與儲存 → 畫面 → 事件 → 啟動
 */
(function () {
  'use strict';

  var D = window.CALLSHEET_DATA;
  var ID = 'callsheet';
  var KEY = 'toolbox.callsheet.v1';
  var BKEY = 'toolbox.backup.v1';
  var cfg = { debounceMs: 400 };
  var $ = function (id) { return document.getElementById(id); };
  var pad = function (n) { return String(n).padStart(2, '0'); };

  // ───────── 共用備份紀錄（資料保險箱讀這個；只放狀態，不放內容） ─────────
  function markToolbox(patch){ try{ const K='toolbox.backup.v1'; let o; try{o=JSON.parse(localStorage.getItem(K)||'')}catch(e){} if(!o||o.v!==1||typeof o.tools!=='object'||!o.tools) o={v:1,tools:{}}; const cur=(o.tools[ID]&&typeof o.tools[ID]==='object'&&!Array.isArray(o.tools[ID]))?o.tools[ID]:{hasData:false,updatedAt:null,lastBackupAt:null}; o.tools[ID]=Object.assign(cur,patch); localStorage.setItem(K,JSON.stringify(o)); }catch(e){} }

  var lastMarkAt = 0, lastMarkHas = null, markedOnce = false;
  // 存檔成功後記一筆：每次載入後的第一次一定記；之後每 60 秒最多一次；有沒有資料改變時馬上記
  function noteSaved() {
    var has = savedSheets().length > 0, now = Date.now();
    if (!markedOnce || has !== lastMarkHas || now - lastMarkAt >= 60000) {
      markToolbox({ hasData: has, updatedAt: new Date(now).toISOString() });
      markedOnce = true; lastMarkAt = now; lastMarkHas = has;
    }
  }
  // 還原或重設成功後，馬上把紀錄對齊（不等 60 秒節流、不用重新整理）：
  //  還原 → hasData 照實際、updatedAt 現在；重設（全部清除）→ {hasData:false, updatedAt:現在, lastBackupAt:null}（舊備份檔不涵蓋重設後才輸入的資料）
  function markNow(patch) {
    var now = Date.now();
    markToolbox(Object.assign({ updatedAt: new Date(now).toISOString() }, patch));
    markedOnce = true; lastMarkAt = now; lastMarkHas = patch.hasData;
  }
  function readRecord() {
    try {
      var o = JSON.parse(localStorage.getItem(BKEY) || '');
      return o && o.v === 1 && o.tools && typeof o.tools === 'object' && o.tools[ID] && typeof o.tools[ID] === 'object' ? o.tools[ID] : null;
    } catch (e) { return null; }
  }
  // 載入時對一次帳（共用約定）：已經有通告、但紀錄沒寫或寫 hasData:false → 補成 true（原本的 updatedAt 保留，沒有才用現在）；
  // 反過來，紀錄說有資料、實際一張都沒有 → 改成 false。讀不到或資料壞掉時什麼都不動，免得亂宣稱。
  function syncRecordOnLoad() {
    if (!storageOK || corrupt) return;
    var has = savedSheets().length > 0, rec = readRecord();
    if (has && (!rec || rec.hasData !== true)) {
      var keep = rec && typeof rec.updatedAt === 'string' && !isNaN(Date.parse(rec.updatedAt)) ? rec.updatedAt : new Date().toISOString();
      markToolbox({ hasData: true, updatedAt: keep });
    } else if (!has && rec && rec.hasData === true) markToolbox({ hasData: false });
  }
  function readBackupAt() {
    try {
      var o = JSON.parse(localStorage.getItem(BKEY) || '');
      var t = o && o.v === 1 && o.tools && o.tools[ID] && o.tools[ID].lastBackupAt;
      var ms = typeof t === 'string' ? Date.parse(t) : NaN;
      return isNaN(ms) ? null : ms;
    } catch (e) { return null; }
  }

  // ───────── 日期時間小工具 ─────────
  var WD = ['日', '一', '二', '三', '四', '五', '六'];
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function isDateStr(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var p = s.split('-').map(Number), t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return t.getUTCFullYear() === p[0] && t.getUTCMonth() === p[1] - 1 && t.getUTCDate() === p[2] && p[0] >= 1900 && p[0] <= 2200;
  }
  function weekday(s) { var p = s.split('-').map(Number); return WD[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()]; }
  function dateLabel(s) { return isDateStr(s) ? s + '（' + weekday(s) + '）' : ''; }
  function isTime(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
  function localDateText(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function localStamp(ms) { var d = new Date(ms); return localDateText(ms) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function daysSince(ms, now) {
    var a = new Date(now), b = new Date(ms), DAY = 86400000;
    var d = Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(b.getFullYear(), b.getMonth(), b.getDate())) / DAY);
    return d < 0 ? 0 : d;
  }

  // ───────── 日照計算：NOAA 太陽位置演算法（自己實作，不用函式庫） ─────────
  // 依 NOAA General Solar Position Calculations：幾何平均黃經與近點角 → 中心差 → 視黃經 → 赤緯與時差 →
  // 真太陽時 → 時角 → 太陽高度。找日出日落與黃金／藍調時刻的方式：把「台北當天 00:00–24:00」每 2 分鐘算一次高度，
  // 看哪裡穿過門檻，再用二分法磨到 1 毫秒。高度一律是幾何高度（不加大氣折射）：日出日落用 -0.833°
  // （已含折射與太陽半徑），黃金時刻 -4°～+6°，藍調時刻 -6°～-4°。時間一律用台北時間（UTC+8，台灣沒有夏令時間）。
  var Solar = (function () {
    var R = Math.PI / 180, TZ_MS = 8 * 3600000;
    function mod(a, n) { return ((a % n) + n) % n; }
    function position(ms) {
      var jd = ms / 86400000 + 2440587.5, T = (jd - 2451545) / 36525;
      var L0 = mod(280.46646 + T * (36000.76983 + T * 0.0003032), 360);
      var M = 357.52911 + T * (35999.05029 - 0.0001537 * T), Mr = M * R;
      var e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
      var C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289;
      var omega = 125.04 - 1934.136 * T;
      var lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * R);
      var eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
      var eps = (eps0 + 0.00256 * Math.cos(omega * R)) * R;
      var decl = Math.asin(Math.sin(eps) * Math.sin(lambda * R));
      var y = Math.tan(eps / 2) * Math.tan(eps / 2), L0r = L0 * R;
      var eqTime = 4 * (180 / Math.PI) * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) - 0.5 * y * y * Math.sin(4 * L0r) - 1.25 * e * e * Math.sin(2 * Mr));
      return { decl: decl, eqTime: eqTime };   // decl：弧度；eqTime：分鐘
    }
    function elevation(ms, lat, lng) {   // 太陽幾何高度（度）
      var p = position(ms), d = new Date(ms);
      var utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 + d.getUTCMilliseconds() / 60000;
      var tst = mod(utcMin + p.eqTime + 4 * lng, 1440);     // 真太陽時（分）
      var ha = (tst / 4 - 180) * R;                          // 時角
      var la = lat * R;
      var cz = Math.sin(la) * Math.sin(p.decl) + Math.cos(la) * Math.cos(p.decl) * Math.cos(ha);
      return 90 - Math.acos(Math.max(-1, Math.min(1, cz))) / R;
    }
    var LEVELS = [-6, -4, -0.833, 6];
    function crossings(dateStr, lat, lng) {
      var p = dateStr.split('-').map(Number);
      var start = Date.UTC(p[0], p[1] - 1, p[2]) - TZ_MS, end = start + 86400000, step = 120000;
      var out = {}; LEVELS.forEach(function (l) { out[l] = { rise: null, set: null }; });
      var tPrev = start, ePrev = elevation(tPrev, lat, lng);
      for (var t = start + step; t <= end; t += step) {
        var e = elevation(t, lat, lng);
        for (var i = 0; i < LEVELS.length; i++) {
          var lv = LEVELS[i], o = out[lv];
          if (ePrev < lv && e >= lv && o.rise === null) o.rise = bisect(tPrev, t, lv, true, lat, lng);
          else if (ePrev >= lv && e < lv && o.set === null) o.set = bisect(tPrev, t, lv, false, lat, lng);
        }
        tPrev = t; ePrev = e;
      }
      return out;
    }
    function bisect(a, b, lv, rising, lat, lng) {
      for (var i = 0; i < 40 && b - a > 1; i++) {
        var m = (a + b) / 2, above = elevation(m, lat, lng) >= lv;
        if (above === rising) b = m; else a = m;
      }
      return (a + b) / 2;
    }
    function pair(a, b) { return a !== null && b !== null ? [a, b] : null; }
    function compute(dateStr, lat, lng) {
      if (!isDateStr(dateStr) || typeof lat !== 'number' || typeof lng !== 'number') return null;
      var c = crossings(dateStr, lat, lng), sr = c[-0.833].rise, ss = c[-0.833].set;
      return {
        sunrise: sr, sunset: ss,
        blueAM: pair(c[-6].rise, c[-4].rise), goldAM: pair(c[-4].rise, c[6].rise),
        goldPM: pair(c[6].set, c[-4].set), bluePM: pair(c[-4].set, c[-6].set),
        dayMinutes: sr !== null && ss !== null ? Math.round((ss - sr) / 60000) : null
      };
    }
    function fmt(ms) {   // 台北時間 HH:MM（四捨五入到分）
      var d = new Date(Math.round(ms / 60000) * 60000 + TZ_MS);
      return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
    }
    return { elevation: elevation, position: position, compute: compute, fmt: fmt };
  })();

  // 把算好的結果整理成「一列一列」：給預覽和文字版共用，順序就是當天的時間順序
  function sunRows(sun) {
    if (!sun) return [];
    var range = function (p) { return p ? Solar.fmt(p[0]) + '–' + Solar.fmt(p[1]) : '—'; };
    var one = function (t) { return t === null ? '—' : Solar.fmt(t); };
    var dl = sun.dayMinutes === null ? '—' : Math.floor(sun.dayMinutes / 60) + ' 小時 ' + pad(sun.dayMinutes % 60) + ' 分';
    return [
      { label: '晨間藍調時刻', value: range(sun.blueAM) },
      { label: '晨間黃金時刻', value: range(sun.goldAM) },
      { label: '日出', value: one(sun.sunrise), strong: true },
      { label: '日落', value: one(sun.sunset), strong: true },
      { label: '傍晚黃金時刻', value: range(sun.goldPM) },
      { label: '傍晚藍調時刻', value: range(sun.bluePM) },
      { label: '日照長度', value: dl }
    ];
  }

  // ───────── 座標解析 ─────────
  var NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
  function inRange(lat, lng) { return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180; }
  function round6(v) { return Math.round(v * 1e6) / 1e6; }
  // 回傳 { lat, lng, how } 或 { error: 'empty' | 'short' | 'none' | 'range' }
  function parseCoords(input) {
    var s = String(input == null ? '' : input).trim();
    if (!s) return { error: 'empty' };
    var dec = s;
    try { dec = decodeURIComponent(s); } catch (e) { dec = s; }
    var m, pairs = [
      [new RegExp('!3d' + NUM + '!4d' + NUM), 'pin'],                                                   // 地點針的位置（最準）
      [new RegExp('[?&#](?:q|query|ll|destination|daddr|saddr|sll|center)=\\s*(?:loc:)?\\s*' + NUM + '\\s*,\\s*' + NUM, 'i'), 'param'],
      [new RegExp('[?&]mlat=' + NUM + '&mlon=' + NUM, 'i'), 'osm'],
      [new RegExp('@' + NUM + ',' + NUM), 'view'],                                                       // 畫面中心
      [new RegExp('#map=\\d+/' + NUM + '/' + NUM), 'osm'],
      [new RegExp('^[+\\s]*' + NUM + '\\s*[,，\\s]\\s*' + NUM + '\\s*$'), 'plain']                      // 直接貼 25.04, 121.5
    ];
    for (var i = 0; i < pairs.length; i++) {
      m = dec.match(pairs[i][0]);
      if (m) {
        var lat = parseFloat(m[1]), lng = parseFloat(m[2]);
        if (!isFinite(lat) || !isFinite(lng) || !inRange(lat, lng)) return { error: 'range' };
        return { lat: round6(lat), lng: round6(lng), how: pairs[i][1] };
      }
    }
    if (/(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|share\.google)/i.test(dec)) return { error: 'short' };
    return { error: 'none' };
  }
  var COORD_ERR = {
    short: '這是短網址，這裡沒辦法展開。請先在瀏覽器打開它，再複製網址列裡的完整網址。',
    none: '讀不到座標。請貼 Google 地圖的完整網址，或直接貼「25.0478, 121.5170」，也可以用下面的緯度、經度欄位自己填。',
    range: '座標超出範圍（緯度要在 -90 到 90，經度要在 -180 到 180）。'
  };
  function fmtNum(v) { return String(Math.round(v * 1e5) / 1e5); }
  function mapUrl(s) { return 'https://www.google.com/maps?q=' + fmtNum(s.lat) + ',' + fmtNum(s.lng); }
  function hasCoords(s) { return typeof s.lat === 'number' && typeof s.lng === 'number'; }
  // 座標不在「台灣附近」：日照是用台北時間（UTC+8）算的，換到別的地方不一定適用
  function farFromTaiwan(s) {
    var b = D.taiwanBox;
    return hasCoords(s) && !(s.lat >= b.latMin && s.lat <= b.latMax && s.lng >= b.lngMin && s.lng <= b.lngMax);
  }
  var FAR_FORM = '這個座標不在台灣附近。日出日落是用台北時間（UTC+8）算的，不一定適合那個地方，請自己確認當地時間。';
  var FAR_PAPER = '注意：這個座標不在台灣附近，以上時間是用台北時間（UTC+8）算的，不一定適合那個地方。';

  // ───────── 資料 ─────────
  function newId() {
    try { return Array.from(crypto.getRandomValues(new Uint8Array(8))).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
    catch (e) { return (Math.random().toString(36).slice(2, 10) + Date.now().toString(36)).slice(0, 16); }
  }
  function nowISO() { return new Date().toISOString(); }
  function blankSheet() {
    var t = nowISO();
    return { id: newId(), title: '', date: todayStr(), callTime: '', wrapTime: '', locName: '', lat: null, lng: null, contacts: [],
      gearName: '', transport: '', weather: '', food: '', notes: '', createdAt: t, updatedAt: t };
  }
  function cut(v, max) { return (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').slice(0, max); }
  function num(v, lo, hi) { return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? v : null; }
  function isoOr(v, fallback) { return typeof v === 'string' && !isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : fallback; }
  function cleanSheet(x, seen) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
    var b = blankSheet(), L = D.limits;
    var id = typeof x.id === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(x.id) && !seen[x.id] ? x.id : b.id;
    seen[id] = true;
    var contacts = (Array.isArray(x.contacts) ? x.contacts : []).slice(0, L.contacts).filter(function (c) { return c && typeof c === 'object'; })
      .map(function (c) { return { name: cut(c.name, L.short), role: cut(c.role, L.short), phone: cut(c.phone, L.short) }; });
    return {
      id: id, title: cut(x.title, L.title), date: isDateStr(x.date) ? x.date : '',
      callTime: isTime(x.callTime) ? x.callTime : '', wrapTime: isTime(x.wrapTime) ? x.wrapTime : '',
      locName: cut(x.locName, L.loc), lat: num(x.lat, -90, 90), lng: num(x.lng, -180, 180),
      contacts: contacts, gearName: cut(x.gearName, L.loc), transport: cut(x.transport, L.long), weather: cut(x.weather, L.long),
      food: cut(x.food, L.long), notes: cut(x.notes, L.long),
      createdAt: isoOr(x.createdAt, b.createdAt), updatedAt: isoOr(x.updatedAt, b.updatedAt)
    };
  }
  function cleanSheets(arr) {
    var seen = {}, out = [];
    (Array.isArray(arr) ? arr : []).slice(0, D.limits.sheets).forEach(function (x) { var s = cleanSheet(x, seen); if (s) out.push(s); });
    return out;
  }
  // 剛按「新增通告」、還沒填任何東西的空白通告（draft）只放在記憶體：存進瀏覽器的永遠不含它，
  // 填了東西才開始存；全部清空回到空白，下一次存檔又會把它從已存的資料裡拿掉。
  var draftId = null, draftDate = '';
  function untouched(s) {
    return !s.title && !s.callTime && !s.wrapTime && !s.locName && s.lat === null && s.lng === null && !s.contacts.length &&
      !s.gearName && !s.transport && !s.weather && !s.food && !s.notes && s.date === (s.id === draftId ? draftDate : todayStr());
  }
  function isDraft(s) { return !!s && s.id === draftId && untouched(s); }
  function savedSheets() { return store.sheets.filter(function (x) { return !isDraft(x); }); }

  // ───────── 儲存（多分頁安全：每次寫入前重讀 rev） ─────────
  var store = { rev: 0, updatedAt: null, sheets: [] };
  var storageOK = true, corrupt = false, stale = false, saveFail = false, dirty = false, saveTimer = null, curId = null;

  function emptyStore() { return { rev: 0, updatedAt: null, sheets: [] }; }
  function loadStore() {
    var raw;
    try { raw = localStorage.getItem(KEY); storageOK = true; }
    catch (e) { storageOK = false; store = emptyStore(); return; }
    corrupt = false;
    if (raw == null) { store = emptyStore(); return; }
    var o; try { o = JSON.parse(raw); } catch (e) { o = null; }
    if (!o || typeof o !== 'object' || o.v !== 1 || !Array.isArray(o.sheets) || !Number.isInteger(o.rev) || o.rev < 0) {
      corrupt = true; store = emptyStore(); return;
    }
    store = { rev: o.rev, updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null, sheets: cleanSheets(o.sheets) };
  }
  // force：還原或清除時用。只有「已存的資料壞掉」這一種情況可以被它蓋掉（呼叫前使用者已確認）；
  // 資料被別的分頁改過（rev 對不上）一律照樣拒絕，不會蓋掉別人的更新。
  function persist(force) {
    var bypass = !!force && corrupt;
    if (!bypass && (stale || corrupt)) return false;
    if (!storageOK) { store.rev++; return true; }
    var raw, curRev = 0;
    try { raw = localStorage.getItem(KEY); }
    catch (e) { storageOK = false; renderNotices(); store.rev++; return true; }
    if (raw != null) {
      try { var o = JSON.parse(raw); if (o && Number.isInteger(o.rev) && o.rev >= 0) curRev = o.rev; else throw new Error('bad'); }
      catch (e) { if (!bypass) { corrupt = true; renderNotices(); renderLocks(); return false; } }
    }
    if (!bypass && curRev !== store.rev) { setStale(); return false; }
    var next = { v: 1, rev: curRev + 1, updatedAt: nowISO(), sheets: savedSheets() };
    try { localStorage.setItem(KEY, JSON.stringify(next)); }
    catch (e) { saveFail = true; renderNotices(); return false; }
    store.rev = next.rev; store.updatedAt = next.updatedAt;
    saveFail = false; corrupt = false;
    return true;
  }
  function setStale() { stale = true; renderNotices(); renderLocks(); renderSaveState(); }
  function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!dirty) return true;
    var s = cur(); if (s) s.updatedAt = nowISO();
    var ok = persist(false);
    if (ok) { dirty = false; noteSaved(); }
    renderNotices(); renderSaveState();
    return ok;
  }
  function edited() {   // 欄位改動：先更新預覽，稍後存檔
    dirty = true; renderSaveState(); renderPaper(); renderSunMini();
    clearTimeout(saveTimer); saveTimer = setTimeout(flush, cfg.debounceMs);
  }
  function commit(force) {   // 立刻存（新增、複製、刪除、還原、清除）
    dirty = true; clearTimeout(saveTimer);
    var ok = force ? persist(true) : flush();
    if (force) { if (ok) { dirty = false; noteSaved(); } renderNotices(); renderLocks(); renderSaveState(); }
    return ok;
  }
  function cur() { for (var i = 0; i < store.sheets.length; i++) if (store.sheets[i].id === curId) return store.sheets[i]; return null; }

  // ───────── 小工具：蓋 DOM（使用者輸入一律當純文字） ─────────
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) for (var k in props) { if (k === 'class') el.className = props[k]; else if (k === 'text') el.textContent = props[k]; else el.setAttribute(k, props[k]); }
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null || c === false) continue; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return el;
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.textContent = ''; }, 4500);
  }
  function setMsg(el, text, kind) { el.textContent = text || ''; el.className = 'msg' + (kind ? ' ' + kind : ''); }

  function confirmDlg(opts) {
    return new Promise(function (resolve) {
      var dlg = $('dlg'), body = $('dlgBody'), ok = $('dlgOk');
      $('dlgTitle').textContent = opts.title;
      body.textContent = '';
      (opts.lines || []).forEach(function (t) { body.appendChild(h('p', { text: t })); });
      ok.textContent = opts.okText || '確定';
      ok.classList.toggle('danger', !!opts.danger);
      dlg.returnValue = '';
      dlg.addEventListener('close', function () { resolve(dlg.returnValue === 'ok'); }, { once: true });
      dlg.showModal();
    });
  }

  // ───────── 畫面：提醒與鎖定 ─────────
  function renderNotices() {
    $('staleBanner').hidden = !stale;
    $('nCorrupt').hidden = !corrupt;
    $('nStorage').hidden = storageOK;
    $('nSaveFail').hidden = !saveFail;
  }
  function renderLocks() {
    var editLocked = stale || corrupt, replaceLocked = stale;
    document.querySelectorAll('[data-lock]').forEach(function (el) { el.disabled = el.dataset.lock === 'edit' ? editLocked : replaceLocked; });
    $('formWrap').disabled = editLocked;
    var n = savedSheets().length;
    $('btnBackup').disabled = editLocked || n === 0;
    $('btnClear').disabled = replaceLocked || (n === 0 && !corrupt);
  }
  function renderSaveState() {
    var el = $('saveState');
    el.textContent = stale ? '沒有儲存：資料已過期' : corrupt ? '沒有儲存：已存的資料壞掉了' : !storageOK ? '沒有儲存：瀏覽器不允許存資料'
      : saveFail ? '儲存失敗' : dirty ? '儲存中…' : isDraft(cur()) ? '還沒填任何東西，填了才會儲存' : '已儲存在這個瀏覽器';
  }

  // ───────── 畫面：清單與備份 ─────────
  function sortedSheets() {
    return savedSheets().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;     // 日期新的在上；沒填日期的排最後
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
  }
  function renderList() {
    var ul = $('sheetList'); ul.textContent = '';
    var list = sortedSheets();
    $('listEmpty').hidden = list.length > 0;
    list.forEach(function (s) {
      var name = s.title || '（未命名）';
      var meta = [s.callTime ? '集合 ' + s.callTime : '', s.locName].filter(Boolean).join('・');
      ul.appendChild(h('li', { class: 'sheet' },
        h('button', { class: 'sheet-open', type: 'button', 'data-act': 'open', 'data-id': s.id },
          h('span', { class: 'sheet-date', text: dateLabel(s.date) || '日期未填' }),
          h('span', { class: 'sheet-title', text: name }),
          meta ? h('span', { class: 'sheet-meta', text: meta }) : null),
        h('span', { class: 'sheet-acts' },
          h('button', { class: 'textbtn', type: 'button', 'data-act': 'dup', 'data-id': s.id, 'data-lock': 'edit', 'aria-label': '複製「' + name + '」', text: '複製' }),
          h('button', { class: 'textbtn danger', type: 'button', 'data-act': 'del', 'data-id': s.id, 'data-lock': 'replace', 'aria-label': '刪除「' + name + '」', text: '刪除' }))));
    });
    renderLocks();
  }
  function renderBackupStatus() {
    var el = $('backupStatus'), t = readBackupAt(), now = Date.now();
    el.textContent = '';
    if (t === null) el.appendChild(document.createTextNode('還沒有備份過'));
    else {
      var d = daysSince(t, now);
      el.appendChild(document.createTextNode('上次備份：' + localDateText(t) + '（' + (d === 0 ? '今天' : d + ' 天前') + '）'));
    }
    var needs = savedSheets().length > 0 && (t === null || daysSince(t, now) >= D.staleDays);
    if (needs) el.appendChild(h('span', { class: 'warn', text: '建議現在備份一次' }));
  }

  // ───────── 畫面：通告預覽（也是列印的內容） ─────────
  function sunFor(s) {
    if (!isDateStr(s.date) || !hasCoords(s)) return null;
    try { return Solar.compute(s.date, s.lat, s.lng); } catch (e) { return null; }
  }
  function wrapText(s) { return s.wrapTime ? s.wrapTime + (s.callTime && s.wrapTime < s.callTime ? '（隔日）' : '') : ''; }
  function block(title, node) { return h('section', { class: 'p-block' }, h('h3', { text: title }), node); }
  function ph(text) { return h('span', { class: 'ph screen-only', text: text }); }

  function renderPaper() {
    var s = cur(), box = $('paper'); box.textContent = '';
    if (!s) return;
    var sun = sunFor(s);
    box.appendChild(h('header', { class: 'p-head' },
      h('p', { class: 'p-kicker', text: '拍攝日通告' }),
      h('h2', { class: 'p-title' }, s.title || ph('（還沒填案名）')),
      h('p', { class: 'p-date' }, dateLabel(s.date) || ph('（還沒填日期）'))));

    if (s.callTime || s.wrapTime) {
      var dl = h('dl', { class: 'p-times' });
      dl.appendChild(h('div', {}, h('dt', { text: '集合' }), h('dd', { text: s.callTime || '—' })));
      dl.appendChild(h('div', {}, h('dt', { text: '預計收工' }), h('dd', { text: wrapText(s) || '—' })));
      box.appendChild(dl);
    }
    if (s.locName || hasCoords(s)) {
      var loc = h('div', {});
      if (s.locName) loc.appendChild(h('p', { class: 'p-loc', text: s.locName }));
      if (hasCoords(s)) {
        loc.appendChild(h('p', { class: 'p-coord', text: fmtNum(s.lat) + ', ' + fmtNum(s.lng) }));
        loc.appendChild(h('p', { class: 'p-map screen-only' }, h('a', { href: mapUrl(s), target: '_blank', rel: 'noopener noreferrer', text: '在 Google 地圖開啟' })));
      }
      box.appendChild(block('地點', loc));
    }
    if (sun) {
      var tb = h('table', { class: 'p-table sun' });
      sunRows(sun).forEach(function (r) { tb.appendChild(h('tr', { class: r.strong ? 'strong' : '' }, h('th', { scope: 'row', text: r.label }), h('td', { text: r.value }))); });
      box.appendChild(block('日照與光線（台北時間）', h('div', {}, tb,
        farFromTaiwan(s) ? h('p', { class: 'p-far', text: FAR_PAPER }) : null,
        h('p', { class: 'p-fine', text: '依日期和座標計算，沒有算進山和建築的遮擋，現場請多預留 10 分鐘。' }))));
    } else {
      box.appendChild(h('p', { class: 'p-fine screen-only', text: '填好日期和座標，這裡會列出日出、日落、黃金時刻和藍調時刻。' }));
    }
    var cs = s.contacts.filter(function (c) { return c.name || c.role || c.phone; });
    if (cs.length) {
      var ct = h('table', { class: 'p-table contacts' }, h('tr', {}, h('th', { scope: 'col', text: '姓名' }), h('th', { scope: 'col', text: '職稱' }), h('th', { scope: 'col', text: '電話' })));
      cs.forEach(function (c) { ct.appendChild(h('tr', {}, h('td', { text: c.name }), h('td', { text: c.role }), h('td', { text: c.phone }))); });
      box.appendChild(block('聯絡人', ct));
    }
    [['器材', s.gearName], ['交通與停車', s.transport], ['天氣備註', s.weather], ['附近吃的', s.food], ['其他備註', s.notes]].forEach(function (r) {
      if (r[1]) box.appendChild(block(r[0], h('p', { class: 'pre', text: r[1] })));
    });
    box.appendChild(h('p', { class: 'p-foot', text: '更新於 ' + localStamp(Date.parse(s.updatedAt) || Date.now()) }));
  }
  function renderSunMini() {
    var s = cur(), el = $('sunMini'); if (!s) return;
    var sun = sunFor(s);
    el.textContent = sun ? '當天（台北時間）日出 ' + (sun.sunrise === null ? '—' : Solar.fmt(sun.sunrise)) + '，日落 ' + (sun.sunset === null ? '—' : Solar.fmt(sun.sunset))
      : '填好日期和座標，這裡會顯示當天的日出日落。';
    var far = $('farNote'), isFar = farFromTaiwan(s);
    far.hidden = !isFar; far.textContent = isFar ? FAR_FORM : '';
    var hint = $('wrapHint'); hint.hidden = !(s.callTime && s.wrapTime && s.wrapTime < s.callTime);
  }

  // ───────── 文字版（貼到 LINE） ─────────
  function buildText(s) {
    var L = [], sun = sunFor(s), one = function (label, v) { if (!v) return; L.push(v.indexOf('\n') >= 0 ? label + '：\n' + v : label + '：' + v); };
    L.push('【拍攝通告】' + (s.title || '（未填案名）'));
    if (isDateStr(s.date)) L.push('日期：' + dateLabel(s.date));
    var times = [s.callTime ? '集合 ' + s.callTime : '', s.wrapTime ? '預計收工 ' + wrapText(s) : ''].filter(Boolean);
    if (times.length) L.push(times.join('　'));
    one('地點', s.locName);
    if (hasCoords(s)) { L.push('座標：' + fmtNum(s.lat) + ', ' + fmtNum(s.lng)); L.push('地圖：' + mapUrl(s)); }
    if (sun) {
      L.push('日照（台北時間）：'); sunRows(sun).forEach(function (r) { L.push('・' + r.label + ' ' + r.value); });
      if (farFromTaiwan(s)) L.push(FAR_PAPER);
    }
    var cs = s.contacts.filter(function (c) { return c.name || c.role || c.phone; });
    if (cs.length) { L.push('聯絡人：'); cs.forEach(function (c) { L.push('・' + [c.name, c.role ? '（' + c.role + '）' : '', c.phone ? ' ' + c.phone : ''].join('').trim()); }); }
    one('器材', s.gearName); one('交通與停車', s.transport); one('天氣', s.weather); one('附近吃的', s.food); one('其他備註', s.notes);
    return L.join('\n');
  }

  // ───────── 畫面：編輯表單 ─────────
  function setField(el, v) { if (el.value !== v) el.value = v; }
  function fillForm() {
    var s = cur(); if (!s) return;
    document.querySelectorAll('#formWrap [data-f]').forEach(function (el) {
      var f = el.dataset.f, v = s[f];
      if (f === 'lat' || f === 'lng') {
        var parsed = parseCoordField(el.value, f);
        if (parsed.value !== v) el.value = v === null ? '' : String(v);
        el.removeAttribute('aria-invalid'); $('err-' + f).hidden = true;
      } else setField(el, v);
    });
    renderContacts(); renderSunMini(); renderPaper();
  }
  function renderContacts() {
    var s = cur(), box = $('contactList'); box.textContent = '';
    if (!s) return;
    s.contacts.forEach(function (c, i) {
      var n = i + 1, fld = function (cls, key, label, ph2, extra) {
        var id = 'c-' + key + '-' + i;
        return h('div', { class: 'field ' + cls }, h('label', { for: id, text: label }),
          h('input', Object.assign({ type: 'text', id: id, 'data-ci': String(i), 'data-cf': key, maxlength: '40', autocomplete: 'off', placeholder: ph2, value: c[key] }, extra || {})));
      };
      // 姓名、職稱並排一列；電話自己一列（再加上移除鈕），整列寬度都給電話，號碼才看得到全部
      var row = h('div', { class: 'contact' },
        fld('f-name', 'name', '姓名', '例：測試王小明'), fld('f-role', 'role', '職稱', '例：導演'),
        h('div', { class: 'contact-phone' },
          fld('f-phone', 'phone', '電話', '0900-000-000', { inputmode: 'tel' }),
          h('button', { class: 'textbtn danger rm', type: 'button', 'data-act': 'rm-contact', 'data-ci': String(i), 'aria-label': '移除第 ' + n + ' 位聯絡人', text: '移除' })));
      box.appendChild(row);
    });
    $('btnAddContact').disabled = s.contacts.length >= D.limits.contacts;
  }
  var COORD_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
  function parseCoordField(text, which) {
    var t = String(text).trim();
    if (!t) return { value: null, err: '' };
    if (!COORD_RE.test(t)) return { value: null, err: which === 'lat' ? '緯度要是數字，例如 25.0478' : '經度要是數字，例如 121.5170' };
    var v = parseFloat(t), lim = which === 'lat' ? 90 : 180;
    if (!isFinite(v) || v < -lim || v > lim) return { value: null, err: (which === 'lat' ? '緯度' : '經度') + '要在 -' + lim + ' 到 ' + lim + ' 之間' };
    return { value: v, err: '' };
  }
  function applyCoordText(which, text) {
    var s = cur(); if (!s) return;
    var r = parseCoordField(text, which), inp = $('f-' + which), err = $('err-' + which);
    s[which] = r.value;
    err.hidden = !r.err; err.textContent = r.err;
    if (r.err) inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid');
  }
  function setCoords(lat, lng) {
    var s = cur(); if (!s) return;
    s.lat = lat; s.lng = lng;
    $('f-lat').value = String(lat); $('f-lng').value = String(lng);
    ['lat', 'lng'].forEach(function (w) { $('err-' + w).hidden = true; $('f-' + w).removeAttribute('aria-invalid'); });
    edited();
  }

  // ───────── 畫面切換 ─────────
  function showView(name) {
    $('viewList').hidden = name !== 'list';
    $('viewEdit').hidden = name !== 'edit';
    var target = name === 'list' ? $('hList') : $('hEdit');
    return target;
  }
  function goList(opts) {
    flush();
    var s = cur();
    if (s && untouched(s)) {
      if (isDraft(s)) store.sheets = store.sheets.filter(function (x) { return x !== s; });   // 空白新通告從來沒存過，直接丟掉就好
      else if (!stale && !corrupt) { store.sheets = store.sheets.filter(function (x) { return x !== s; }); dirty = true; flush(); }   // 舊資料裡的空白通告
    }
    draftId = null; curId = null;
    var t = showView('list'); renderAll(); if (!opts || !opts.quiet) t.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  function openSheet(id, focusTitle) {
    curId = id; if (!cur()) { curId = null; return; }
    showView('edit'); setPane('form'); $('printHint').hidden = window.top === window;
    fillForm(); renderSaveState(); renderLocks();
    window.scrollTo(0, 0);
    (focusTitle ? $('f-title') : $('hEdit')).focus({ preventScroll: true });
  }
  function setPane(p) {
    $('viewEdit').dataset.pane = p;
    $('paneForm').setAttribute('aria-pressed', String(p === 'form'));
    $('panePreview').setAttribute('aria-pressed', String(p === 'preview'));
  }
  function renderAll() {
    renderList(); renderBackupStatus(); renderNotices(); renderLocks(); renderSaveState();
    if (cur()) fillForm();
  }

  // ───────── 動作 ─────────
  function newSheet() {
    if (stale || corrupt) return;
    if (store.sheets.length >= D.limits.sheets) { toast('通告已經滿 ' + D.limits.sheets + ' 張，請先刪掉不用的'); return; }
    // 只放在記憶體：使用者填了東西才會存（見 savedSheets）
    var s = blankSheet(); store.sheets.push(s); curId = s.id; draftId = s.id; draftDate = s.date;
    openSheet(s.id, true);
  }
  // 動手改整批資料前先記下現況；存不進去（空間滿了、別的分頁已經更新…）就整個退回去，
  // 讓記憶體裡的資料永遠等於存進去的那份，之後的存檔不會把被拒絕的內容寫進去。
  function snapshot() { return { sheets: store.sheets, curId: curId, draftId: draftId, dirty: dirty, saveFail: saveFail }; }
  function rollback(p) { store.sheets = p.sheets; curId = p.curId; draftId = p.draftId; dirty = p.dirty; saveFail = p.saveFail; renderNotices(); renderSaveState(); }
  function dupSheet(id) {
    if (stale || corrupt) return;
    var src = store.sheets.filter(function (x) { return x.id === id; })[0]; if (!src) return;
    if (store.sheets.length >= D.limits.sheets) { toast('通告已經滿 ' + D.limits.sheets + ' 張，請先刪掉不用的'); return; }
    var c = cleanSheet(JSON.parse(JSON.stringify(src)), {});
    c.id = newId(); c.title = cut((src.title || '（未命名）') + '（副本）', D.limits.title); c.createdAt = c.updatedAt = nowISO();
    var prev = snapshot();
    store.sheets = store.sheets.concat([c]); dirty = true;
    if (!flush()) { rollback(prev); renderAll(); toast(stale ? '資料已過期，沒有複製。請重新整理。' : '複製失敗：存不進瀏覽器。'); return; }
    renderAll(); toast('已複製成「' + c.title + '」');
  }
  async function delSheet(id) {
    if (stale) return;
    var s = store.sheets.filter(function (x) { return x.id === id; })[0]; if (!s) return;
    var ok = await confirmDlg({ title: '刪除這張通告？', lines: ['「' + (s.title || '（未命名）') + '」（' + (dateLabel(s.date) || '日期未填') + '）會被刪掉，沒辦法復原。', '如果還想留著，請先下載備份。'], okText: '刪除', danger: true });
    if (!ok || stale) return;
    var prev = snapshot();
    store.sheets = store.sheets.filter(function (x) { return x.id !== id; }); dirty = true;
    if (!flush()) { rollback(prev); renderAll(); toast(stale ? '資料已過期，沒有刪除。請重新整理。' : '刪除失敗：存不進瀏覽器，這張通告還在。'); return; }
    renderAll(); toast('已刪除');
  }
  function download(name, text) {
    var url = URL.createObjectURL(new Blob([text], { type: 'application/json' })), a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }
  function backupNow() {
    var sheets = savedSheets();
    if (stale || corrupt || !sheets.length) return;
    var now = new Date();
    var payload = { kind: 'toolbox.callsheet', v: 1, exportedAt: now.toISOString(), data: { sheets: sheets } };
    download('callsheet-backup-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '.json', JSON.stringify(payload, null, 2));
    markToolbox({ lastBackupAt: now.toISOString() });
    renderBackupStatus();
    setMsg($('backupMsg'), '已下載備份檔（' + sheets.length + ' 張通告）。檔案裡有聯絡人電話，請自己收好。', 'ok');
  }
  function parseBackup(text) {
    var o; try { o = JSON.parse(text); } catch (e) { return { error: '這不是有效的 JSON 檔，沒有還原。' }; }
    if (!o || typeof o !== 'object' || o.kind !== 'toolbox.callsheet') return { error: '這個檔案不是「拍攝日通告」的備份檔，沒有還原。' };
    if (o.v !== 1) return { error: '備份檔的版本（' + String(o.v).slice(0, 10) + '）這個工具不認得，沒有還原。' };
    if (!o.data || typeof o.data !== 'object' || !Array.isArray(o.data.sheets)) return { error: '備份檔裡找不到通告資料，沒有還原。' };
    if (o.data.sheets.length > D.limits.sheets) return { error: '備份檔裡的通告超過 ' + D.limits.sheets + ' 張，看起來不對，沒有還原。' };
    if (!o.data.sheets.every(function (x) { return x && typeof x === 'object' && !Array.isArray(x); })) return { error: '備份檔裡的通告格式不對，沒有還原。' };
    var sheets = cleanSheets(o.data.sheets);
    var contacts = sheets.reduce(function (n, s) { return n + s.contacts.filter(function (c) { return c.name || c.role || c.phone; }).length; }, 0);
    var dates = sheets.map(function (s) { return s.date; }).filter(Boolean).sort();
    return { sheets: sheets, contacts: contacts, from: dates[0] || '', to: dates[dates.length - 1] || '', exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : '' };
  }
  async function restoreFrom(file) {
    var bm = $('backupMsg');
    if (!file) return;
    if (file.size > D.limits.backupBytes) { setMsg(bm, '檔案超過 5 MB，不像是通告備份檔，沒有還原。', 'err'); return; }
    var text; try { text = await file.text(); } catch (e) { setMsg(bm, '讀不到這個檔案，沒有還原。', 'err'); return; }
    var r = parseBackup(text);
    if (r.error) { setMsg(bm, r.error, 'err'); return; }
    var lines = ['備份檔裡有 ' + r.sheets.length + ' 張通告、' + r.contacts + ' 位聯絡人' + (r.from ? '，日期從 ' + r.from + ' 到 ' + r.to : '') + '。',
      '目前這個瀏覽器裡的 ' + savedSheets().length + ' 張通告會被整批取代，沒辦法復原。'];
    if (corrupt) lines.push('現在已存的資料是壞掉的，還原後會被蓋掉。');
    var ok = await confirmDlg({ title: '用備份取代現有的通告？', lines: lines, okText: '取代並還原', danger: true });
    if (!ok) { setMsg(bm, '已取消，沒有改動。', ''); return; }
    if (stale) return;
    var prev = snapshot();
    store.sheets = r.sheets; curId = null; draftId = null;
    var saved = commit(true);
    if (!saved) {   // 退回原本的通告，畫面也重畫，免得清單和實際存的不一樣
      rollback(prev); renderAll();
      setMsg(bm, stale ? '資料已過期，沒有還原。請重新整理後再試。' : '還原失敗：存不進瀏覽器（空間可能不夠）。原本的通告沒有動。', 'err');
      return;
    }
    markNow({ hasData: savedSheets().length > 0 });   // 紀錄馬上更新，資料保險箱和首頁提醒不用等重新整理
    showView('list'); renderAll();
    setMsg(bm, '已還原 ' + r.sheets.length + ' 張通告。', 'ok');
  }
  async function clearAll() {
    if (stale) return;
    var ok = await confirmDlg({ title: '清除全部通告？', lines: ['這個瀏覽器裡的 ' + savedSheets().length + ' 張通告（含聯絡人）會全部刪掉，沒辦法復原。', '如果還想留著，請先下載備份。'], okText: '全部清除', danger: true });
    if (!ok || stale) return;
    var prev = snapshot();
    store.sheets = []; curId = null; draftId = null;
    var saved = commit(true);
    if (!saved) rollback(prev);   // 沒清成功就把記憶體退回原樣，清單繼續顯示實際存著的通告
    else markNow({ hasData: false, lastBackupAt: null });   // 重設：舊備份檔不涵蓋之後才輸入的資料，所以「上次備份」一併清空
    showView('list'); renderAll();
    setMsg($('backupMsg'), saved ? '已清除全部通告。' : stale ? '資料已過期，沒有清除。請重新整理後再試。' : '清除失敗：存不進瀏覽器（空間可能不夠）。原本的通告沒有動。', saved ? 'ok' : 'err');
  }
  async function copyText() {
    var s = cur(); if (!s) return;
    var text = buildText(s);
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      toast('已複製文字版，可以貼到 LINE 了');
    } catch (e) {
      var ta = $('copyArea'); ta.value = text;
      $('copyDlg').showModal(); ta.focus(); ta.select();
    }
  }
  function printSheet() { flush(); window.print(); }

  // ───────── 事件 ─────────
  function onFormInput(e) {
    var t = e.target, s = cur();
    if (!s || stale || corrupt) return;
    if (t.id === 'f-map') { onMapInput(e); return; }
    var f = t.dataset.f;
    if (f) {
      if (f === 'lat' || f === 'lng') applyCoordText(f, t.value);
      else if (f === 'date') s.date = isDateStr(t.value) ? t.value : '';
      else if (f === 'callTime' || f === 'wrapTime') s[f] = isTime(t.value) ? t.value : '';
      else s[f] = cut(t.value, f === 'title' || f === 'locName' || f === 'gearName' ? D.limits.title : D.limits.long);
      edited(); return;
    }
    if (t.dataset.cf !== undefined) {
      var c = s.contacts[+t.dataset.ci]; if (!c) return;
      c[t.dataset.cf] = cut(t.value, D.limits.short); edited();
    }
  }
  function applyMapText(text, final) {
    var msg = $('coordMsg'), r = parseCoords(text);
    if (r.error === 'empty') { setMsg(msg, ''); return; }
    if (r.error) {
      if (final || r.error === 'short' || r.error === 'range') setMsg(msg, COORD_ERR[r.error], 'err'); else setMsg(msg, '');
      return;
    }
    setCoords(r.lat, r.lng);
    $('f-map').value = '';
    setMsg(msg, '已讀到座標：' + fmtNum(r.lat) + ', ' + fmtNum(r.lng) + '。請對一下地點是不是對的。', 'ok');
  }
  function onMapInput(e) {
    var v = $('f-map').value;
    // 貼上（或像網址的長字串）馬上讀；手打的座標等離開欄位再讀，免得打到一半就被取代
    if (e.inputType === 'insertFromPaste' || /^\s*https?:/i.test(v) || /goo\.gl|share\.google/i.test(v)) applyMapText(v, false);
    else setMsg($('coordMsg'), '');   // 開始改字了，上一則說明已經過期
  }

  function init() {
    var presetBox = $('presetBtns');
    D.presets.forEach(function (p, i) { presetBox.appendChild(h('button', { class: 'chipbtn', type: 'button', 'data-preset': String(i), text: p.name })); });

    $('btnNew').addEventListener('click', newSheet);
    $('sheetList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'open') openSheet(b.dataset.id, false);
      else if (b.dataset.act === 'dup') dupSheet(b.dataset.id);
      else if (b.dataset.act === 'del') delSheet(b.dataset.id);
    });
    $('btnBack').addEventListener('click', function () { goList(); });
    $('btnBackup').addEventListener('click', backupNow);
    $('btnRestore').addEventListener('click', function () { setMsg($('backupMsg'), ''); $('restoreFile').click(); });
    $('restoreFile').addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; e.target.value = ''; restoreFrom(f); });
    $('btnClear').addEventListener('click', clearAll);
    $('btnCopy').addEventListener('click', copyText);
    $('btnPrint').addEventListener('click', printSheet);
    $('staleReload').addEventListener('click', function () { location.reload(); });
    $('paneForm').addEventListener('click', function () { setPane('form'); });
    $('panePreview').addEventListener('click', function () { setPane('preview'); window.scrollTo(0, 0); });
    $('dlgOk').addEventListener('click', function () { $('dlg').close('ok'); });
    $('dlgCancel').addEventListener('click', function () { $('dlg').close('cancel'); });
    $('copyClose').addEventListener('click', function () { $('copyDlg').close(); });

    var form = $('formWrap');
    form.addEventListener('input', onFormInput);
    $('f-map').addEventListener('change', function () { applyMapText($('f-map').value, true); });
    form.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || stale || corrupt) return;
      var s = cur(); if (!s) return;
      if (b.dataset.preset !== undefined) {
        var p = D.presets[+b.dataset.preset]; setCoords(p.lat, p.lng);
        setMsg($('coordMsg'), '已填入「' + p.name + '」附近的座標。這只是大約的位置，實際地點請貼地圖網址。', 'ok');
      } else if (b.id === 'btnAddContact') {
        if (s.contacts.length >= D.limits.contacts) return;
        s.contacts.push({ name: '', role: '', phone: '' }); renderContacts(); edited();
        var inputs = $('contactList').querySelectorAll('[data-cf="name"]'); inputs[inputs.length - 1].focus();
      } else if (b.dataset.act === 'rm-contact') {
        s.contacts.splice(+b.dataset.ci, 1); renderContacts(); edited();
        var next = $('contactList').querySelector('[data-cf="name"]'); (next || $('btnAddContact')).focus();
      }
    });

    // 其他分頁改了資料：沒有未存的內容就直接更新畫面；有的話這個分頁已經過期
    window.addEventListener('storage', function (e) {
      if (e.storageArea && e.storageArea !== window.localStorage) return;
      if (e.key === BKEY) { renderBackupStatus(); return; }
      if (e.key !== null && e.key !== KEY) return;
      if (stale) return;
      if (dirty) { setStale(); return; }
      var kept = isDraft(cur()) ? cur() : null;   // 正在填的空白新通告還沒存，別因為重讀資料就不見了
      loadStore();
      if (kept && !store.sheets.some(function (x) { return x.id === kept.id; })) store.sheets.push(kept);
      if (curId && !cur()) { curId = null; draftId = null; showView('list'); toast('這張通告在另一個分頁被刪掉了'); }
      renderAll();
    });
    document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); });
    window.addEventListener('pagehide', flush);

    loadStore();
    syncRecordOnLoad();
    showView('list');
    renderAll();
  }

  window.__callsheet = {   // 測試用的出入口；不影響使用
    solar: Solar, parseCoords: parseCoords, buildText: buildText, sunRows: sunRows, cfg: cfg, cleanSheets: cleanSheets,
    state: function () { return { rev: store.rev, sheets: store.sheets, curId: curId, stale: stale, corrupt: corrupt, storageOK: storageOK, dirty: dirty }; }
  };
  init();
})();
