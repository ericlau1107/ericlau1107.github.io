/* 拍攝日通告：預設值與上限。只放資料，不放邏輯。 */
window.CALLSHEET_DATA = {
  // 城市「大約的市中心」。座標差 0.1 度，日出日落只差不到半分鐘，所以拿來當快速預設夠用；實際拍攝地請貼地圖網址。
  presets: [
    { name: '台北車站', lat: 25.0478, lng: 121.5170 },
    { name: '新北板橋', lat: 25.0143, lng: 121.4627 },
    { name: '台中',     lat: 24.1369, lng: 120.6851 },
    { name: '高雄',     lat: 22.6395, lng: 120.3027 }
  ],
  // 「台灣附近」的大略範圍（含澎湖、金門、馬祖）。座標跑到這個框外，就提醒日照是用台北時間算的。
  taiwanBox: { latMin: 21.5, latMax: 26.6, lngMin: 118.0, lngMax: 122.5 },
  limits: { title: 120, loc: 120, short: 40, long: 4000, contacts: 20, sheets: 500, backupBytes: 5 * 1024 * 1024 },
  weatherUrl: 'https://www.cwa.gov.tw/',
  gearUrl: '../gear/',
  staleDays: 14
};
