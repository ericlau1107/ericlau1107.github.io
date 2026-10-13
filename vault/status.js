/* 資料保險箱：讀取「各工具留下的備份紀錄」並判斷該不該提醒備份。
 * 工具箱首頁的提醒條與 vault/index.html 共用這一份，判斷規則只有一處。
 *
 * 只讀一樣東西：localStorage 'toolbox.backup.v1'（各工具自己寫的狀態：有沒有資料、最後儲存、最後備份時間）。
 * 提醒規則只有一條：紀錄明確寫著 hasData:true，而且「從沒備份過」「上次備份超過 14 天」或「上次備份的時間比現在還晚」（時間異常）。
 * 時間異常＝lastBackupAt 比現在晚超過 5 分鐘（裝置時鐘被調快、或寫進了錯的時間）。這種紀錄不能當成「剛備份過」，否則一個未來日期會讓提醒靜音到那一天。
 * 沒有紀錄的工具不猜：不看資料庫名稱、不看其他鍵，只顯示「還沒有紀錄」，也不提醒。
 * 絕不開任何資料庫（沒有 indexedDB 呼叫），也不讀任何工具的實際內容（帳目、健康數值、個資）。
 */
(function () {
  'use strict';
  var KEY = 'toolbox.backup.v1';
  var STALE_DAYS = 14;
  var DAY = 86400000;
  var FUTURE_SLACK = 5 * 60000;   // 容許的時鐘誤差；比現在晚超過這麼久的備份時間算「時間異常」

  // 會寫備份紀錄的工具（順序＝首頁選單的順序）
  var TOOLS = [
    { id: 'labor-report', name: '勞報單產生器' },
    { id: 'gear', name: '出班器材檢查表' },
    { id: 'callsheet', name: '拍攝日通告' },
    { id: 'money-report', name: '個人記帳' },
    { id: 'health-fitness', name: '健康與健身' },
    { id: 'expiry', name: '到期日管家' },
    { id: 'study', name: '語言每日複習' },
    { id: 'weekly', name: '每週回顧' }
  ];

  function readRecords() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || '');
      if (o && o.v === 1 && o.tools && typeof o.tools === 'object') return o.tools;
    } catch (e) { /* 沒有紀錄、壞掉或讀不到：當作沒有 */ }
    return {};
  }

  function parseTime(s) {
    if (typeof s !== 'string') return null;
    var t = Date.parse(s);
    return isNaN(t) ? null : t;
  }

  // 以當地日曆日計算「幾天前」：昨天晚上備份、今天早上看，算 1 天前；時間在未來算 0（是否異常另由 clockAnomaly 判斷，不靠這個數字）
  function daysSince(t, now) {
    if (t == null) return null;
    var a = new Date(now), b = new Date(t);
    var d = Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(b.getFullYear(), b.getMonth(), b.getDate())) / DAY);
    return d < 0 ? 0 : d;
  }

  function dayLabel(d) {
    if (d == null) return '';
    return d === 0 ? '今天' : d + ' 天前';
  }

  function dateText(t) {
    var d = new Date(t), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // 回傳 Promise<陣列>，每個工具一筆：
  //  source:  'record'（工具自己寫過紀錄）／'none'（沒有紀錄或紀錄格式不對；不猜）
  //  hasData: true / false（紀錄怎麼說就怎麼算）／null（source 是 none）
  //  lastBackupAt / updatedAt: 時間戳（毫秒）或 null；lastBackupDays / updatedDays: 幾天前
  //  clockAnomaly: hasData 是 true，而且 lastBackupAt 比現在晚超過 5 分鐘（時間異常）
  //  needsBackup: 只有 hasData 是 true，而且從沒備份過、超過 14 天，或時間異常
  function load(nowMs) {
    var now = nowMs == null ? Date.now() : nowMs;
    var rec = readRecords();
    return Promise.resolve(TOOLS.map(function (tool) {
      var e = Object.prototype.hasOwnProperty.call(rec, tool.id) ? rec[tool.id] : null;
      var row = { id: tool.id, name: tool.name, hasData: null, source: 'none', updatedAt: null, lastBackupAt: null, updatedDays: null, lastBackupDays: null, clockAnomaly: false, needsBackup: false };
      if (e && typeof e === 'object' && typeof e.hasData === 'boolean') {
        row.source = 'record';
        row.hasData = e.hasData;
        row.updatedAt = parseTime(e.updatedAt);
        row.lastBackupAt = parseTime(e.lastBackupAt);
      }
      row.updatedDays = daysSince(row.updatedAt, now);
      row.lastBackupDays = daysSince(row.lastBackupAt, now);
      row.clockAnomaly = row.hasData === true && row.lastBackupAt != null && row.lastBackupAt > now + FUTURE_SLACK;
      row.needsBackup = row.hasData === true && (row.lastBackupAt == null || row.clockAnomaly || row.lastBackupDays > STALE_DAYS);
      return row;
    }));
  }

  window.ToolboxVault = {
    KEY: KEY,
    STALE_DAYS: STALE_DAYS,
    TOOLS: TOOLS,
    load: load,
    dayLabel: dayLabel,
    dateText: dateText
  };
})();
