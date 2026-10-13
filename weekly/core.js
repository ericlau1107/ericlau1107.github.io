/* 每週回顧：純運算（日期、週範圍、各工具資料的唯讀整理、回顧筆記檢查）。
 * 不碰 DOM、不碰任何儲存。所有「其他工具的資料」只在這裡被讀成簡化模型；
 * 看不懂的格式一律回報 ok:false，由畫面顯示「先不顯示」，不猜、不補數字。
 * 日期一律是 YYYY-MM-DD 字串，運算走 UTC；「今天」以台北時間（UTC+8，台灣沒有夏令時間）為準。
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ 日期 */
  var WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
  var DAY_MS = 86400000, TAIPEI_MS = 8 * 3600000;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isLeap(y) { return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0); }
  function dim(y, m) { return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }
  function toYmd(y, m, d) { return String(y).padStart(4, '0') + '-' + pad(m) + '-' + pad(d); }
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > dim(y, mo)) return null;
    return { y: y, m: mo, d: d };
  }
  // 其他工具存的日期，年份只收 1900–2200（和它們自己的檢查同一個範圍）
  function validDate(s) { return !!parseYmd(s) && s >= '1900-01-01' && s <= '2200-12-31'; }
  function validMonth(s) { return typeof s === 'string' && /^\d{4}-\d{2}$/.test(s) && validDate(s + '-01'); }
  function dayNum(s) { var p = parseYmd(s); return Math.round(Date.UTC(p.y, p.m - 1, p.d) / DAY_MS); }
  function fromDayNum(n) { var t = new Date(n * DAY_MS); return toYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
  function addDays(s, n) { return fromDayNum(dayNum(s) + n); }
  function daysBetween(a, b) { return dayNum(b) - dayNum(a); }
  function weekdayIdx(s) { return new Date(dayNum(s) * DAY_MS).getUTCDay(); }          // 0 = 週日
  function weekdayText(s) { return WEEKDAY[weekdayIdx(s)]; }
  function mondayOf(s) { return addDays(s, -((weekdayIdx(s) + 6) % 7)); }
  function weekOf(start) { return { start: start, end: addDays(start, 6) }; }
  function weekDiff(a, b) { return Math.round(daysBetween(a, b) / 7); }
  // 台北日期：把時間加 8 小時再看 UTC 欄位。now 預設是現在；測試可以傳指定時間。
  function taipeiToday(now) {
    var t = now && typeof now.getTime === 'function' ? now.getTime() : Date.now();
    if (!isFinite(t)) return '';
    var d = new Date(t + TAIPEI_MS);
    return toYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  function taipeiDayOf(ms) { return taipeiToday(new Date(ms)); }
  function monthEnd(month) { var p = parseYmd(month + '-01'); return month + '-' + pad(dim(p.y, p.m)); }
  function shortDate(s) { var p = parseYmd(s); return p.m + '/' + p.d + '（週' + weekdayText(s) + '）'; }
  function fullDate(s) { return s + '（週' + weekdayText(s) + '）'; }

  /* ------------------------------------------------------------------ 小工具 */
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function bad(why) { return { ok: false, why: why }; }
  function safeInt(n, lo, hi) { return typeof n === 'number' && Number.isSafeInteger(n) && n >= lo && n <= hi; }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function fmtGroup(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  // 金額單位是「分」（記帳工具存整數分）。整數時不顯示小數。
  function fmtMoney(minor) {
    var neg = minor < 0, a = Math.abs(minor), whole = Math.floor(a / 100), frac = a % 100;
    return (neg ? '−' : '') + 'NT$' + fmtGroup(whole) + (frac ? '.' + pad(frac) : '');
  }
  function fmtNum(n) { return fmtGroup(Math.round(n * 100) / 100); }

  /* ------------------------------------------------------------------ 花費（個人記帳） */
  // 分類名稱與個人記帳 core.js 的 categories.expense 相同；不認得的分類 ＝ 格式看不懂。
  var CATS = [
    ['food', '餐飲'], ['groceries', '日常採買'], ['transport', '交通'], ['shopping', '購物'], ['housing', '居住'],
    ['bills', '帳單與通訊'], ['health', '醫療與健康'], ['entertainment', '休閒娛樂'], ['learning', '學習'], ['travel', '旅行'],
    ['family', '家庭與人情'], ['work', '工作'], ['insurance', '保險與稅費'], ['other', '其他']
  ];
  var CAT_NAME = {}, CAT_ORDER = {};
  CATS.forEach(function (c, i) { CAT_NAME[c[0]] = c[1]; CAT_ORDER[c[0]] = i; });
  var AMOUNT_MAX = 1e12;

  // 只取支出與退款（收入、轉帳、餘額校正都不算支出）。金額是記帳工具存下的「入帳當時固定的台幣分」，外幣不重估。
  function reduceLedger(v) {
    if (!isObj(v) || (v.schema !== 'eric-ledger/1' && v.schema !== 'eric-ledger/2')) return bad('版本');
    if (!Array.isArray(v.transactions)) return bad('交易');
    var rows = [];
    for (var i = 0; i < v.transactions.length; i++) {
      var t = v.transactions[i];
      if (!isObj(t)) return bad('交易');
      if (t.kind !== 'expense' && t.kind !== 'refund') continue;
      if (!validDate(t.date) || !safeInt(t.amount, 0, AMOUNT_MAX) || typeof t.categoryId !== 'string' || !hasOwn(CAT_NAME, t.categoryId)) return bad('支出');
      rows.push({ date: t.date, kind: t.kind, amount: t.amount, categoryId: t.categoryId });
    }
    var budgets = Object.create(null);
    if (v.budgets != null) {
      if (!isObj(v.budgets)) return bad('預算');
      Object.keys(v.budgets).forEach(function (m) {
        var b = v.budgets[m];
        budgets[m] = validMonth(m) && isObj(b) && safeInt(b.total, 0, AMOUNT_MAX) ? b.total : null;   // null ＝ 這個月預算讀不懂，不顯示
      });
    }
    return { ok: true, rows: rows, budgets: budgets };
  }
  function sumAdd(a, b) { var s = a + b; if (!Number.isSafeInteger(s)) throw new Error('overflow'); return s; }
  function tally(rows, start, end) {
    var gross = 0, refunds = 0, count = 0, byCat = {};
    rows.forEach(function (r) {
      if (r.date < start || r.date > end) return;
      count++;
      var c = byCat[r.categoryId] || (byCat[r.categoryId] = { amount: 0, refund: 0 });
      if (r.kind === 'expense') { gross = sumAdd(gross, r.amount); c.amount = sumAdd(c.amount, r.amount); }
      else { refunds = sumAdd(refunds, r.amount); c.refund = sumAdd(c.refund, r.amount); }
    });
    return { gross: gross, refunds: refunds, net: gross - refunds, count: count, byCat: byCat };
  }
  // 一週的支出：淨支出 ＝ 支出 − 退款（退款算在退款那天所在的週，和記帳工具的月分析同一套規則）。
  // 前三大分類依「原始支出」排序，退款不占比例（也和記帳工具的消費分布相同）。
  function moneyWeek(model, start, end) {
    var t = tally(model.rows, start, end);
    var groups = Object.keys(t.byCat).filter(function (id) { return t.byCat[id].amount > 0; }).map(function (id) {
      return { id: id, name: CAT_NAME[id], amount: t.byCat[id].amount, refund: t.byCat[id].refund };
    }).sort(function (a, b) { return b.amount - a.amount || b.refund - a.refund || CAT_ORDER[a.id] - CAT_ORDER[b.id]; });
    return {
      count: t.count, gross: t.gross, refunds: t.refunds, net: t.net,
      top: groups.slice(0, 3).map(function (g) {
        return { id: g.id, name: g.name, amount: g.amount, share: t.gross > 0 ? g.amount / t.gross : 0, pct: t.gross > 0 ? Math.round(g.amount / t.gross * 100) : 0 };
      }),
      groupCount: groups.length
    };
  }
  // 本月預算：今天所在的月份，從 1 日到今天的淨支出，對月預算總額。沒設預算（或預算 0）就回 null。
  function budgetUsage(model, today) {
    var month = today.slice(0, 7);
    if (!validMonth(month) || !hasOwn(model.budgets, month)) return null;
    var total = model.budgets[month];
    if (total === null) return { month: month, unreadable: true };
    if (!(total > 0)) return null;
    var t = tally(model.rows, month + '-01', today < monthEnd(month) ? today : monthEnd(month));
    var ratio = t.net / total;
    return { month: month, total: total, used: t.net, remaining: total - t.net, ratio: ratio, pct: Math.round(ratio * 100), over: t.net > total };
  }

  /* ------------------------------------------------------------------ 運動（健康與健身） */
  // 只取「訓練紀錄的日期與分鐘」和「健康紀錄的日期」。體重、血壓、睡眠等數值完全不讀。
  function reduceHealth(v) {
    if (!isObj(v) || typeof v.schema !== 'string' || !/^eric-health\/[1-4]$/.test(v.schema)) return bad('版本');
    if (!Array.isArray(v.sessions) || !Array.isArray(v.checkins)) return bad('結構');
    var sessions = [], checkins = [];
    for (var i = 0; i < v.sessions.length; i++) {
      var s = v.sessions[i];
      if (!isObj(s) || !validDate(s.date) || typeof s.minutes !== 'number' || !isFinite(s.minutes) || s.minutes < 0 || s.minutes > 1440) return bad('訓練');
      sessions.push({ date: s.date, minutes: s.minutes });
    }
    for (var j = 0; j < v.checkins.length; j++) {
      var c = v.checkins[j];
      if (!isObj(c) || !validDate(c.date)) return bad('紀錄');
      checkins.push(c.date);
    }
    return { ok: true, sessions: sessions, checkins: checkins };
  }
  function healthWeek(model, start, end) {
    var n = 0, minutes = 0, days = {};
    model.sessions.forEach(function (s) { if (s.date >= start && s.date <= end) { n++; minutes += s.minutes; } });
    model.checkins.forEach(function (d) { if (d >= start && d <= end) days[d] = 1; });
    return { sessions: n, minutes: Math.round((minutes + Number.EPSILON) * 100) / 100, checkinDays: Object.keys(days).length };
  }

  /* ------------------------------------------------------------------ 到期事項（證件與到期日管家） */
  var EXPIRY_REPEAT = { none: 0, monthly: 1, yearly: 12 };
  function addMonths(s, n, anchor) {
    var p = parseYmd(s), idx = p.y * 12 + (p.m - 1) + n, y = Math.floor(idx / 12), m = idx % 12 + 1;
    return toYmd(y, m, Math.min(anchor || p.d, dim(y, m)));
  }
  // 和到期日管家同一套：有循環的項目，登記日期已過就推到「基準日（含）之後」的下一次
  function effectiveDue(it, base) {
    var step = EXPIRY_REPEAT[it.repeat];
    if (!step) return it.date;
    var cur = it.date, guard = 0;
    while (dayNum(cur) < dayNum(base) && guard++ < 5000) cur = addMonths(cur, step, it.anchorDay);
    return cur;
  }
  // 讀取範圍和到期日管家「讀已存資料」時相同：年份 1900–2200（它只有輸入與還原時才限 2000–2100），名稱 1–40 字，循環只有三種。
  // 單一項目不合格就只略過那一項、記一筆 skipped；整份結構壞了才整個不顯示。
  // 到期日管家會把它讀不懂的項目原樣放在 skipped 裡，每次讀取再檢查一遍，所以這裡也一起檢查。
  var EXPIRY_MIN_YEAR = 1900, EXPIRY_MAX_YEAR = 2200, EXPIRY_NAME_MAX = 40, EXPIRY_MAX_ITEMS = 500;
  function reduceExpiry(v) {
    if (!isObj(v) || v.v !== 1 || !Number.isInteger(v.rev) || v.rev < 0 || !Array.isArray(v.items) || v.items.length > EXPIRY_MAX_ITEMS) return bad('結構');
    var extra = v.skipped == null ? [] : v.skipped;
    if (!Array.isArray(extra) || extra.length > EXPIRY_MAX_ITEMS) return bad('結構');
    var items = [], skipped = 0;
    v.items.concat(extra).forEach(function (x) {
      var name = isObj(x) && typeof x.name === 'string' ? x.name.trim() : '';
      var p = name && Array.from(name).length <= EXPIRY_NAME_MAX && typeof x.repeat === 'string' && hasOwn(EXPIRY_REPEAT, x.repeat) ? parseYmd(x.date) : null;
      if (!p || p.y < EXPIRY_MIN_YEAR || p.y > EXPIRY_MAX_YEAR || items.length >= EXPIRY_MAX_ITEMS) { skipped++; return; }
      items.push({
        name: name, category: str(x.category), date: x.date, repeat: x.repeat,
        anchorDay: Number.isInteger(x.anchorDay) && x.anchorDay >= 1 && x.anchorDay <= 31 ? x.anchorDay : p.d
      });
    });
    return { ok: true, items: items, skipped: skipped };
  }
  // base 之後 days 天內（含 base 當天、含第 days 天）到期的項目；另數出「基準日以前就過期、也沒有循環」的項目
  function expiryUpcoming(model, base, days) {
    var list = [], expired = 0;
    model.items.forEach(function (it) {
      var due = effectiveDue(it, base), left = daysBetween(base, due);
      if (left < 0) { expired++; return; }
      if (left <= days) list.push({ name: it.name, category: it.category, repeat: it.repeat, due: due, left: left });
    });
    list.sort(function (a, b) { return a.left - b.left || a.name.localeCompare(b.name, 'zh-Hant'); });
    return { list: list, expired: expired };
  }

  /* ------------------------------------------------------------------ 語言（語言每日複習） */
  // 語言複習存的「每天複習幾張」歷史：reviewsByDay = { 台北日期: 張數 }，只留最近 120 天（和語言複習同一個數字）。
  // reviewsSince ＝ 從這一天起沒有紀錄就是真的沒複習；沒有這個欄位就當作整段都可信（只受 120 天限制）。
  var STUDY_HISTORY_DAYS = 120, STUDY_DAY_MAX = 1e6;
  function reduceStudy(v) {
    if (!isObj(v) || v.v !== 1) return bad('結構');
    var history = { state: 'none' };                                   // 舊版／還沒寫過歷史
    if (v.reviewsByDay != null) {
      if (!isObj(v.reviewsByDay)) history = { state: 'bad' };
      else {
        var days = {}, badDays = {};
        Object.keys(v.reviewsByDay).forEach(function (k) {
          if (!validDate(k)) return;                                    // 看不懂的日期不可能落在任何一週裡
          var n = v.reviewsByDay[k];
          if (safeInt(n, 0, STUDY_DAY_MAX)) days[k] = n; else badDays[k] = 1;
        });
        history = { state: 'ok', days: days, bad: badDays, since: validDate(v.reviewsSince) ? v.reviewsSince : null };
      }
    }
    var exams = [];
    if (Array.isArray(v.exams)) v.exams.forEach(function (e) {
      if (isObj(e) && typeof e.name === 'string' && e.name.trim() && validDate(e.date)) exams.push({ name: e.name.trim(), date: e.date });
    });
    return { ok: true, history: history, exams: exams };
  }
  // 這一週（週一到週日）複習了幾張：把 reviewsByDay 在這一週裡的每一天加起來。
  //   state 'ok'     → count（加總；本週還沒過完就只算到今天）、days（有複習的天數）、from（只有一部分日子有紀錄時，紀錄從哪天開始）
  //   state 'none'   → 資料裡完全沒有歷史（舊版語言複習）
  //   state 'before' → 這一週整個在紀錄開始之前（from：可信紀錄的起點；limit：'since' 開始記錄之前／'days' 超過保留的 120 天）
  //   state 'future' → 這週還沒開始
  //   state 'bad'    → 歷史的格式讀不懂，或這一週裡有一天的張數壞掉：不給數字
  function reviewsInWeek(history, start, end, today) {
    if (history.state !== 'ok') return { state: history.state };
    if (start > today) return { state: 'future' };
    var cutoff = addDays(today, -(STUDY_HISTORY_DAYS - 1)), bySince = !!history.since && history.since > cutoff;
    var from = bySince ? history.since : cutoff, last = end < today ? end : today;
    if (last < from) return { state: 'before', from: from, limit: bySince ? 'since' : 'days' };
    var count = 0, days = 0, broken = false;
    Object.keys(history.bad).forEach(function (k) { if (k >= start && k <= last) broken = true; });
    if (broken) return { state: 'bad' };
    Object.keys(history.days).forEach(function (k) {
      if (k < start || k > last) return;
      var n = history.days[k];
      count = sumAdd(count, n);
      if (n > 0) days++;
    });
    return { state: 'ok', count: count, days: days, from: start < from ? from : null, limit: bySince ? 'since' : 'days' };
  }
  function studyWeek(model, start, end, today) {
    var next = null;
    model.exams.forEach(function (e) {
      if (e.date < today) return;
      if (!next || e.date < next.date || (e.date === next.date && e.name < next.name)) next = e;
    });
    var after = next ? model.exams.filter(function (e) { return e.date >= today && e !== next; }).length : 0;
    return { reviewed: reviewsInWeek(model.history, start, end, today), next: next ? { name: next.name, date: next.date, left: daysBetween(today, next.date) } : null, more: after };
  }

  /* ------------------------------------------------------------------ 拍攝日（拍攝日通告） */
  function isTime(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
  function reduceCallsheet(v, today) {
    if (!isObj(v) || v.v !== 1 || !Array.isArray(v.sheets) || v.sheets.length > 500) return bad('結構');
    var sheets = [];
    for (var i = 0; i < v.sheets.length; i++) {
      var s = v.sheets[i];
      if (!isObj(s)) return bad('通告');
      if (!validDate(s.date)) continue;                                   // 沒日期的通告排不進哪一週
      var title = str(s.title).trim(), call = isTime(s.callTime) ? s.callTime : '', wrap = isTime(s.wrapTime) ? s.wrapTime : '', loc = str(s.locName).trim();
      var empty = !title && !call && !wrap && !loc && !(typeof s.lat === 'number') && !(typeof s.lng === 'number') &&
        !(Array.isArray(s.contacts) && s.contacts.length) && !str(s.gearName) && !str(s.transport) && !str(s.weather) && !str(s.food) && !str(s.notes);
      if (empty && s.date === today) continue;                            // 剛按新增、什麼都還沒填的空白通告（拍攝日通告自己也會丟掉）
      sheets.push({ date: s.date, title: title, callTime: call });
    }
    return { ok: true, sheets: sheets };
  }
  function sheetsIn(model, start, end) {
    return model.sheets.filter(function (s) { return s.date >= start && s.date <= end; }).sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.callTime || '99:99') < (b.callTime || '99:99') ? -1 : (a.callTime || '99:99') > (b.callTime || '99:99') ? 1 : a.title.localeCompare(b.title, 'zh-Hant');
    });
  }

  /* ------------------------------------------------------------------ 備份（工具箱共用備份紀錄） */
  var TOOL_NAMES = [
    ['labor-report', '勞報單產生器'], ['gear', '出班器材檢查表'], ['callsheet', '拍攝日通告'], ['money-report', '個人記帳'],
    ['health-fitness', '健康與健身'], ['expiry', '到期日管家'], ['study', '語言每日複習'], ['weekly', '每週回顧']
  ];
  var STALE_DAYS = 14;
  // 規則和資料保險箱一樣：紀錄明確寫著 hasData:true，而且從沒備份過或上次備份超過 14 天。
  function backupStatus(tools, nowMs) {
    var today = taipeiDayOf(nowMs), rows = [], known = 0;
    if (!isObj(tools)) return { known: 0, rows: rows };
    TOOL_NAMES.forEach(function (t) {
      var e = hasOwn(tools, t[0]) ? tools[t[0]] : null;
      if (!isObj(e) || typeof e.hasData !== 'boolean') return;
      known++;
      if (e.hasData !== true) return;
      var ms = typeof e.lastBackupAt === 'string' ? Date.parse(e.lastBackupAt) : NaN;
      if (isNaN(ms)) { rows.push({ id: t[0], name: t[1], never: true, days: null }); return; }
      var days = Math.max(0, daysBetween(taipeiDayOf(ms), today));
      if (days > STALE_DAYS) rows.push({ id: t[0], name: t[1], never: false, days: days });
    });
    return { known: known, rows: rows };
  }

  /* ------------------------------------------------------------------ 回顧筆記 */
  var NOTE_FIELDS = ['good', 'next', 'tweak'];
  var NOTE_MAX = 1000, NOTE_WEEKS_MAX = 600;
  function cleanText(s) { return String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n'); }
  function noteEmpty(w) { return !w || NOTE_FIELDS.every(function (f) { return !w[f] || !String(w[f]).trim(); }); }
  function hasAnyNotes(weeks) { return Object.keys(weeks).some(function (k) { return !noteEmpty(weeks[k]); }); }
  // 整理一份 { 週一日期: {good,next,tweak,t} }；格式不對回 {error}，不偷偷丟資料
  function normalizeNotes(weeks) {
    if (!isObj(weeks)) return { error: '筆記格式不對' };
    var keys = Object.keys(weeks), out = {};
    if (keys.length > NOTE_WEEKS_MAX) return { error: '週數超過 ' + NOTE_WEEKS_MAX };
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], w = weeks[k];
      if (!validDate(k) || weekdayIdx(k) !== 1) return { error: '週的日期要寫該週星期一' };
      if (!isObj(w)) return { error: '有一週的內容不對' };
      var e = { t: typeof w.t === 'string' && !isNaN(Date.parse(w.t)) ? w.t : null };
      for (var j = 0; j < NOTE_FIELDS.length; j++) {
        var f = NOTE_FIELDS[j], val = w[f] == null ? '' : w[f];
        if (typeof val !== 'string') return { error: '有一格筆記不是文字' };
        val = cleanText(val);
        if (Array.from(val).length > NOTE_MAX) return { error: '有一格筆記超過 ' + NOTE_MAX + ' 字' };
        e[f] = val;
      }
      if (!noteEmpty(e)) out[k] = e;
    }
    return { weeks: out };
  }

  var api = {
    WEEKDAY: WEEKDAY, CATS: CATS, TOOL_NAMES: TOOL_NAMES, NOTE_FIELDS: NOTE_FIELDS, NOTE_MAX: NOTE_MAX, NOTE_WEEKS_MAX: NOTE_WEEKS_MAX, STALE_DAYS: STALE_DAYS,
    parseYmd: parseYmd, validDate: validDate, validMonth: validMonth, dayNum: dayNum, addDays: addDays, daysBetween: daysBetween, weekdayIdx: weekdayIdx, weekdayText: weekdayText,
    mondayOf: mondayOf, weekOf: weekOf, weekDiff: weekDiff, taipeiToday: taipeiToday, taipeiDayOf: taipeiDayOf, monthEnd: monthEnd, shortDate: shortDate, fullDate: fullDate,
    fmtMoney: fmtMoney, fmtNum: fmtNum,
    reduceLedger: reduceLedger, moneyWeek: moneyWeek, budgetUsage: budgetUsage,
    reduceHealth: reduceHealth, healthWeek: healthWeek,
    reduceExpiry: reduceExpiry, expiryUpcoming: expiryUpcoming, effectiveDue: effectiveDue,
    reduceStudy: reduceStudy, studyWeek: studyWeek, reviewsInWeek: reviewsInWeek, STUDY_HISTORY_DAYS: STUDY_HISTORY_DAYS,
    reduceCallsheet: reduceCallsheet, sheetsIn: sheetsIn,
    backupStatus: backupStatus,
    normalizeNotes: normalizeNotes, noteEmpty: noteEmpty, hasAnyNotes: hasAnyNotes, cleanText: cleanText
  };
  root.WeeklyCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : this);
