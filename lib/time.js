/**
 * 本地時間工具（Asia/Taipei, CST +08:00）。
 */

// ==================== 本地時間工具（Asia/Taipei, CST +08:00）====================
// toISOString() 固定輸出 UTC；toLocaleString() 依賴 ICU 資料且格式不穩定。
// Taiwan 永遠 UTC+8（無夏令時），用純算術位移最可靠，不依賴任何 locale 支援。
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // +08:00 in ms

function toLocalISO(date) {
  // 將任意 Date 轉成 'YYYY-MM-DDTHH:mm:ss+08:00' 字串
  const p = n => String(n).padStart(2, '0');
  const local = new Date(date.getTime() + TZ_OFFSET_MS);
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth()+1)}-${p(local.getUTCDate())}` +
         `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}+08:00`;
}

function nowISO()       { return toLocalISO(new Date()); }

function todayString()  { return nowISO().slice(0, 10); }          // 'YYYY-MM-DD'

function nowFileStamp() { return nowISO().replace(/[:.]/g, '-').slice(0, 19); } // 'YYYY-MM-DDTHH-mm-ss'

module.exports = {
  nowFileStamp,
  nowISO,
  toLocalISO,
  todayString,
};
