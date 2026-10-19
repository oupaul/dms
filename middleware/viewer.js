/**
 * 唯讀（viewer）帳號的存取限制。
 */

function isViewer(req) {
  return req.session && req.session.permissionLevel === 'viewer';
}

const VIEWER_WRITE_WHITELIST = [
  '/api/auth/logout',
  '/api/databases/switch',
  '/api/permission-requests'
];

function ensureEditorAccess(req, res, next) {
  if (isViewer(req)) {
    const message = '此帳號為唯讀，無法使用此功能。';
    const acceptHeader = (req.headers && req.headers.accept) ? req.headers.accept : '';
    const prefersHtml = acceptHeader.includes('text/html') && !acceptHeader.includes('application/json');

    if (prefersHtml) {
      return res
        .status(403)
        .send(`<!DOCTYPE html>
<html lang="zh-TW">
<head><meta charset="UTF-8"><title>403 Forbidden</title></head>
<body style="font-family: Arial, sans-serif; background:#f8f9fa; color:#333; text-align:center; padding:40px;">
  <h1>403 - 僅限可編輯帳號</h1>
  <p>${message}</p>
  <p><a href="/index.html">返回主系統</a></p>
</body>
</html>`);
    }

    return res.status(403).json({ error: 'viewer_feature_forbidden', message });
  }
  next();
}

const viewerReadOnly = (req, res, next) => {
  if (isViewer(req)) {
    const method = req.method.toUpperCase();
    if (method !== 'GET') {
      const allowed = VIEWER_WRITE_WHITELIST.some(path => req.path.startsWith(path));
      if (!allowed) {
        return res.status(403).json({ error: '此帳號僅能瀏覽指定資料庫', code: 'viewer_read_only' });
      }
    }
  }
  next();
};

module.exports = {
  ensureEditorAccess,
  isViewer,
  viewerReadOnly,
};
