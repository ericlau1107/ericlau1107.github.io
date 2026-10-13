/* 證件與到期日管家：預設值。只放「選項」，不放任何人的資料。 */
window.EXPIRY_DEFAULTS = {
  categories: ['證件', '保險', '訂閱', '保固', '其他'],
  repeats: [['none', '不循環'], ['monthly', '每月'], ['yearly', '每年']],
  reminders: [60, 30, 7],
  // 提前提醒天數的快捷鈕：手機上不用切鍵盤，點一下加入或移除
  remPresets: [1, 3, 7, 14, 30, 60, 90, 180],
  // 常用名稱：點一下只會帶入名稱、類別、循環，日期要自己選
  quick: [
    { name: '護照', category: '證件', repeat: 'none' },
    { name: '居留證', category: '證件', repeat: 'none' },
    { name: '駕照', category: '證件', repeat: 'none' },
    { name: '健保卡', category: '證件', repeat: 'none' },
    { name: '機車行照', category: '證件', repeat: 'none' },
    { name: '汽車保險', category: '保險', repeat: 'yearly' },
    { name: '器材保險', category: '保險', repeat: 'yearly' },
    { name: '手機門號', category: '訂閱', repeat: 'monthly' },
    { name: '雲端訂閱', category: '訂閱', repeat: 'monthly' }
  ]
};
