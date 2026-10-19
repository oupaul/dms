/**
 * HTTP 回應輔助函式。
 */

// 500 錯誤只回傳通用訊息，細節（SQL、路徑、堆疊）僅寫入伺服器日誌，避免洩漏內部資訊
function internalError(res, err) {
  console.error('[500]', err && err.stack ? err.stack : err);
  if (!res.headersSent) {
    res.status(500).json({ error: '伺服器內部錯誤，請稍後再試或聯繫管理員' });
  }
}

module.exports = {
  internalError,
};
