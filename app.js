/**
 * 應用程式進入點：只負責組裝（中介軟體、路由、啟動）。
 * 業務邏輯分布於 routes/（API）、middleware/、services/、lib/。
 */
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const security = require('./lib/security');
const { UPLOAD_DIR } = require('./lib/config');
const { forcePasswordChange, idleTimeout, sessionMiddleware } = require('./middleware/session');
const { viewerReadOnly } = require('./middleware/viewer');
const { ensureDatabaseDirectory, startDatabase } = require('./services/database');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const folderRoutes = require('./routes/folders');
const userRoutes = require('./routes/users');
const groupRoutes = require('./routes/groups');
const permissionRoutes = require('./routes/permissions');
const permissionRequestRoutes = require('./routes/permission-requests');
const databaseRoutes = require('./routes/databases');
const importExportRoutes = require('./routes/import-export');
const pageRoutes = require('./routes/pages');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // 信任前端 nginx 的 X-Forwarded-*，讓 req.protocol / req.ip 正確
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
app.set('port', PORT); // 供 /api/system/health 讀取
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// nginx 在另一台主機：只接受該主機（PROXY_ALLOWLIST，逗號分隔 IP）轉進來的連線，
// 避免有人繞過 nginx 直連應用埠、偽造 X-Forwarded-For 規避登入限速。
const PROXY_ALLOWLIST = security.parseCsvEnv(process.env.PROXY_ALLOWLIST);
if (PROXY_ALLOWLIST.length > 0) {
  app.use(security.proxyAllowlist(PROXY_ALLOWLIST));
  console.log(`✓ 只接受來自反向代理 ${PROXY_ALLOWLIST.join(', ')} 的連線`);
} else {
  console.warn('⚠️  未設定 PROXY_ALLOWLIST：任何能連到本機埠的來源都可直連，並可偽造 X-Forwarded-For。' +
    '正式環境請設定為 nginx 主機 IP，並在防火牆限制只允許該 IP 連入。');
}

app.use(security.securityHeaders());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));
app.use(security.originCheck({ allowedOrigins: security.parseCsvEnv(process.env.ALLOWED_ORIGINS) }));
app.use(sessionMiddleware);
app.use(viewerReadOnly);
app.use(idleTimeout);
app.use(forcePasswordChange);

// 執行權限檢查，並開始載入系統資料庫（非同步）
ensureDatabaseDirectory();
startDatabase();

app.use(authRoutes);
app.use(adminRoutes);
app.use(folderRoutes);
app.use(userRoutes);
app.use(groupRoutes);
app.use(permissionRoutes);
app.use(permissionRequestRoutes);
app.use(databaseRoutes);
app.use(importExportRoutes);
app.use(pageRoutes);

// 自訂 404
app.use((req, res) => {
  console.log('404 for:', req.url);
  res.status(404).json({ error: 'Not Found: ' + req.url });
});

// 未捕獲錯誤寫入 stderr，方便 pm2 logs --err 看到
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('[unhandledRejection]', reason, p);
});

app.listen(PORT, HOST, () => {
  console.log(`Server on ${PORT}`);
});
