/* 資料保險箱頁面：保存狀態（持久保存／空間用量）＋各工具備份狀態。
 * 只讀「備份紀錄」，不讀任何工具的內容；persist() 只在按下按鈕時才呼叫。 */
(function () {
  'use strict';
  var V = window.ToolboxVault;
  var $ = function (id) { return document.getElementById(id); };
  var st = (typeof navigator !== 'undefined' && navigator.storage) || null;
  var UNSUPPORTED = '這個瀏覽器不支援';

  /* ---------- 保存狀態 ---------- */
  function canPersist() { return !!(st && typeof st.persisted === 'function' && typeof st.persist === 'function'); }

  function fmtMB(bytes, digits) {
    var m = bytes / 1048576;
    if (digits === 1 && bytes > 0 && m < 0.1) return '不到 0.1 MB';
    return m.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + ' MB';
  }

  function showPersisted(p) {
    $('persistState').textContent = p ? '已啟用（瀏覽器不會因為空間不足就自動清掉這個網站的資料）' : '未啟用';
    $('persistBtn').disabled = !!p;
    if (p) $('persistMsg').textContent = '已經啟用，不用再申請。';
  }

  function refreshPersist() {
    var btn = $('persistBtn');
    if (!canPersist()) {
      $('persistState').textContent = UNSUPPORTED;
      btn.disabled = true;
      return;
    }
    st.persisted().then(showPersisted, function () {
      $('persistState').textContent = UNSUPPORTED;
      btn.disabled = true;
    });
  }

  function refreshUsage() {
    var el = $('usage');
    if (!st || typeof st.estimate !== 'function') { el.textContent = UNSUPPORTED; return; }
    st.estimate().then(function (e) {
      if (!e || typeof e.usage !== 'number') { el.textContent = UNSUPPORTED; return; }
      el.textContent = typeof e.quota === 'number' && e.quota > 0
        ? '已用 ' + fmtMB(e.usage, 1) + '，瀏覽器給本網站的上限約 ' + fmtMB(e.quota, 0)
        : '已用 ' + fmtMB(e.usage, 1);
    }, function () { el.textContent = UNSUPPORTED; });
  }

  function onPersistClick() {
    var btn = $('persistBtn'), msg = $('persistMsg');
    if (!canPersist()) return;
    btn.disabled = true;
    msg.textContent = '申請中…';
    st.persist().then(function (ok) {
      if (ok) {
        showPersisted(true);
        msg.textContent = '申請成功，已啟用持久保存。';
      } else {
        btn.disabled = false;
        msg.textContent = '瀏覽器這次沒有答應（它會依你使用這個網站的頻率決定）。不影響使用，請照常下載備份檔。';
      }
    }, function () {
      btn.disabled = false;
      msg.textContent = '申請失敗，請稍後再試。';
    });
  }

  /* ---------- 各工具備份狀態 ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function chipText(r) {
    if (r.source === 'none') return '還沒有紀錄';
    return r.hasData ? '有資料' : '沒有資料';
  }

  function rowEl(r) {
    var li = el('li', 'tool' + (r.needsBackup ? ' attn' : '') + (r.hasData !== true ? ' none' : ''));
    var main = el('div', 'tool-main');
    var h = el('h3', null, r.name);
    h.appendChild(el('span', 'chip', chipText(r)));
    if (r.needsBackup) h.appendChild(el('span', 'flag', r.clockAnomaly ? '時間異常' : '建議現在備份'));
    main.appendChild(h);

    if (r.source === 'none') {
      // 沒有紀錄就不猜、不提醒
      main.appendChild(el('p', null, '還沒有紀錄：打開這個工具存一次資料或做一次備份就會出現'));
    } else if (r.hasData === false) {
      main.appendChild(el('p', null, '還沒有資料，不需要備份。'));
    } else if (r.clockAnomaly) {
      // 備份時間比現在還晚：多半是裝置時鐘被調快。不能當成剛備份過，所以照樣提醒
      main.appendChild(el('p', 'last', '上次備份：' + V.dateText(r.lastBackupAt) + '（比現在還晚，時間異常）'));
      main.appendChild(el('p', 'meta', '這個日期在未來，可能是這台裝置的日期被調快，或紀錄寫錯了。請確認裝置日期，並現在再備份一次。'));
      if (r.updatedAt != null) main.appendChild(el('p', 'meta', '最近一次儲存：' + V.dayLabel(r.updatedDays)));
    } else {
      var last = r.lastBackupAt != null
        ? '上次備份：' + V.dateText(r.lastBackupAt) + '（' + V.dayLabel(r.lastBackupDays) + '）'
        : '上次備份：還沒有備份過';
      main.appendChild(el('p', 'last', last));
      if (r.updatedAt != null) main.appendChild(el('p', 'meta', '最近一次儲存：' + V.dayLabel(r.updatedDays)));
    }
    li.appendChild(main);

    var label = r.hasData === true ? '去備份' : '打開工具';
    var a = el('a', 'go', label);
    a.href = '../#' + r.id;
    a.target = '_top';
    a.setAttribute('aria-label', label + '：' + r.name);
    li.appendChild(a);
    return li;
  }

  function render(rows) {
    var ul = $('toolList');
    ul.textContent = '';
    rows.forEach(function (r) { ul.appendChild(rowEl(r)); });
  }

  function refreshTools() {
    var ul = $('toolList');
    if (!V) {
      ul.textContent = '';
      ul.appendChild(el('li', 'tool none', '讀不到備份紀錄的程式，請重新整理頁面。'));
      return;
    }
    V.load().then(render, function () {
      ul.textContent = '';
      ul.appendChild(el('li', 'tool none', '這個瀏覽器讀不到備份紀錄。'));
    });
  }

  function refreshAll() { refreshPersist(); refreshUsage(); refreshTools(); }

  $('persistBtn').addEventListener('click', onPersistClick);
  $('recheck').addEventListener('click', refreshAll);
  // 別的分頁或工具框裡寫入備份紀錄時，這裡跟著更新
  window.addEventListener('storage', function (e) { if (!e.key || (V && e.key === V.KEY)) refreshTools(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshAll(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted) refreshAll(); });
  refreshAll();
})();
