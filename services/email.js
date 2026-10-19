/**
 * 電子郵件通知（設定、樣板與彙整發送）。
 */

const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const ROOT_DIR = path.join(__dirname, '..');

// ==================== 審計日誌和使用時間統計 ====================

// 記錄審計日誌
// ==================== 電子郵件通知 ====================

const EMAIL_CONFIG_PATH = path.join(ROOT_DIR, 'email_config.json');

let emailConfig = { enabled: false };

let emailTransporter = null;

function loadEmailConfig() {
  try {
    if (fs.existsSync(EMAIL_CONFIG_PATH)) {
      emailConfig = JSON.parse(fs.readFileSync(EMAIL_CONFIG_PATH, 'utf8'));
      if (emailConfig.enabled && emailConfig.smtp) {
        const enc = emailConfig.smtp.encryption ||
          (emailConfig.smtp.ignoreTLS ? 'none' : (emailConfig.smtp.secure ? 'tls' : 'starttls'));
        const transportOpts = {
          host: emailConfig.smtp.host,
          port: emailConfig.smtp.port || 587,
          secure: enc === 'tls',
          ignoreTLS: enc === 'none',
          connectionTimeout: 70000,
          greetingTimeout: 70000
        };
        // 無加密模式（port 25 IP 白名單）不帶 AUTH，其他模式才帶帳密
        const hasAuth = enc !== 'none' &&
          emailConfig.smtp.auth &&
          emailConfig.smtp.auth.user &&
          emailConfig.smtp.auth.pass;
        if (hasAuth) {
          transportOpts.auth = {
            user: emailConfig.smtp.auth.user,
            pass: emailConfig.smtp.auth.pass
          };
        }
        emailTransporter = nodemailer.createTransport(transportOpts);
        console.log('✓ 郵件通知已啟用，收件人：', emailConfig.to);
      } else {
        console.log('ℹ️  郵件通知未啟用（enabled: false）');
      }
    } else {
      console.log('ℹ️  找不到 email_config.json，郵件通知已停用');
    }
  } catch (err) {
    console.error('讀取郵件設定失敗:', err.message);
  }
}

loadEmailConfig();

const ACTION_LABEL = { create: '新增', update: '修改', delete: '刪除', invite: '發送邀請' };

const RESOURCE_LABEL = { folder: '資料夾', user: '人員', group: '群組', permission: '權限', invite: '邀請連結', permission_request: '權限異動申請' };

const NOTIFY_RESOURCE_TYPES = ['folder', 'user', 'group', 'permission', 'permission_request'];

const NOTIFY_ACTION_TYPES = ['create', 'update', 'delete'];

function formatJsonForEmail(obj) {
  if (!obj) return '—';
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return obj; }
  }
  const rows = Object.entries(obj)
    .map(([k, v]) => `<tr><td style="padding:2px 10px 2px 0;color:#555;white-space:nowrap;">${k}</td><td style="padding:2px 0;">${v == null ? '<em style="color:#aaa;">null</em>' : String(v)}</td></tr>`)
    .join('');
  return `<table style="border-collapse:collapse;font-size:13px;">${rows}</table>`;
}

function buildEmailHtml({ actionType, resourceType, resourceName, dbName, username, fullName, oldValue, newValue, extra }) {
  const actionLabel = ACTION_LABEL[actionType] || actionType;
  const resourceLabel = RESOURCE_LABEL[resourceType] || resourceType;
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

  const rows = [
    ['操作時間', now],
    ['操作人員', fullName ? `${fullName}（${username}）` : username],
    ['操作類型', `<strong>${actionLabel}</strong>`],
    ['資源類型', resourceLabel],
    ['資源名稱', resourceName || '—'],
    ['資料庫', dbName || '—'],
  ];

  if (oldValue) rows.push(['異動前', formatJsonForEmail(oldValue)]);
  if (newValue) rows.push(['異動後', formatJsonForEmail(newValue)]);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      rows.push([k, v || '—']);
    }
  }

  const tableRows = rows.map(([label, value]) =>
    `<tr>
      <td style="padding:8px 16px;background:#f8f9fa;font-weight:600;white-space:nowrap;border:1px solid #dee2e6;color:#495057;">${label}</td>
      <td style="padding:8px 16px;border:1px solid #dee2e6;">${value}</td>
    </tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;font-family:Arial,'Microsoft JhengHei',sans-serif;background:#f4f6f8;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#667eea,#764ba2);padding:20px 24px;">
      <h2 style="margin:0;color:#fff;font-size:18px;">📁 資料夾權限文管系統</h2>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">系統異動通知</p>
    </div>
    <div style="padding:24px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        ${tableRows}
      </table>
    </div>
    <div style="padding:12px 24px;background:#f8f9fa;border-top:1px solid #dee2e6;font-size:12px;color:#6c757d;">
      此信件由系統自動發送，請勿直接回覆。
    </div>
  </div>
</body>
</html>`;
}

// ---- 彙整批次發送 ----
let _pendingChanges = [];

let _batchTimer = null;

function queueChangeNotification(change) {
  if (!emailConfig.enabled || !emailTransporter) return;
  const events = emailConfig.notifyEvents || {};
  if (events[change.resourceType] === false) return;

  _pendingChanges.push({ ...change, queuedAt: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) });

  if (!_batchTimer) {
    const minutes = emailConfig.batchMinutes || 15;
    _batchTimer = setTimeout(() => flushBatch().catch(err => console.error('批次發送失敗:', err.message)), minutes * 60 * 1000);
    console.log(`📧 彙整計時器啟動（${minutes} 分鐘後發送，目前 ${_pendingChanges.length} 筆）`);
  }
}

async function flushBatch() {
  _batchTimer = null;
  if (_pendingChanges.length === 0) return;

  const changes = _pendingChanges.splice(0);
  const prefix = emailConfig.subjectPrefix || '[DMS]';
  const subject = `${prefix} 系統異動彙整 - 共 ${changes.length} 筆`;

  const actionColors = { create: '#198754', update: '#0d6efd', delete: '#dc3545', invite: '#6f42c1' };

  const rows = changes.map((c, i) => {
    const actionLabel = ACTION_LABEL[c.actionType] || c.actionType;
    const resourceLabel = RESOURCE_LABEL[c.resourceType] || c.resourceType;
    const color = actionColors[c.actionType] || '#6c757d';
    const operator = c.fullName ? `${c.fullName}（${c.username}）` : c.username;
    return `<tr style="background:${i % 2 === 0 ? '#fff' : '#f8f9fa'}">
      <td style="padding:8px 12px;border:1px solid #dee2e6;white-space:nowrap;color:#6c757d;font-size:12px;">${c.queuedAt}</td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;white-space:nowrap;">${operator}</td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;white-space:nowrap;">
        <span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;">${actionLabel}</span>
      </td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;">${resourceLabel}</td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;">${c.resourceName || '—'}</td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;font-size:12px;color:#6c757d;">${c.dbName || '—'}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;font-family:Arial,'Microsoft JhengHei',sans-serif;background:#f4f6f8;">
  <div style="max-width:900px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#667eea,#764ba2);padding:20px 24px;">
      <h2 style="margin:0;color:#fff;font-size:18px;">📁 資料夾權限文管系統</h2>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">系統異動彙整通知 — 共 ${changes.length} 筆</p>
    </div>
    <div style="padding:24px;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="background:#495057;color:#fff;">
            <th style="padding:10px 12px;text-align:left;border:1px solid #dee2e6;white-space:nowrap;">操作時間</th>
            <th style="padding:10px 12px;text-align:left;border:1px solid #dee2e6;white-space:nowrap;">操作人員</th>
            <th style="padding:10px 12px;text-align:left;border:1px solid #dee2e6;white-space:nowrap;">操作類型</th>
            <th style="padding:10px 12px;text-align:left;border:1px solid #dee2e6;">資源類型</th>
            <th style="padding:10px 12px;text-align:left;border:1px solid #dee2e6;">名稱</th>
            <th style="padding:10px 12px;text-align:left;border:1px solid #dee2e6;">資料庫</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="padding:12px 24px;background:#f8f9fa;border-top:1px solid #dee2e6;font-size:12px;color:#6c757d;">
      此信件由系統自動發送，請勿直接回覆。
    </div>
  </div>
</body></html>`;

  if (!emailTransporter) {
    console.error('flushBatch: emailTransporter 未初始化，無法發送');
    throw new Error('郵件傳輸器未初始化，請確認 SMTP 設定');
  }

  const toAddr = Array.isArray(emailConfig.to) ? emailConfig.to.join(', ') : emailConfig.to;
  console.log(`📧 準備發送彙整信 → to:${toAddr}  subject:${subject}`);
  const info = await emailTransporter.sendMail({
    from: emailConfig.from,
    to: toAddr,
    subject,
    html
  });
  console.log(`✓ 彙整通知已發送：${subject}  messageId:${info.messageId}  response:${info.response}`);
  return { to: toAddr, subject, messageId: info.messageId, response: info.response, count: changes.length };
}

// 保留單筆發送供測試信件使用
async function sendChangeNotification(change) {
  queueChangeNotification(change);
}

// 供管理介面查詢／操作彙整發送佇列
function getPendingChangeCount() {
  return _pendingChanges.length;
}

function hasBatchTimer() {
  return !!_batchTimer;
}

function cancelBatchTimer() {
  if (_batchTimer) { clearTimeout(_batchTimer); _batchTimer = null; }
}

const getEmailConfig = () => emailConfig;
const getEmailTransporter = () => emailTransporter;

module.exports = {
  EMAIL_CONFIG_PATH,
  NOTIFY_ACTION_TYPES,
  NOTIFY_RESOURCE_TYPES,
  buildEmailHtml,
  cancelBatchTimer,
  flushBatch,
  getEmailConfig,
  getEmailTransporter,
  getPendingChangeCount,
  hasBatchTimer,
  loadEmailConfig,
  sendChangeNotification,
};
