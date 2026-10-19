/**
 * M365 SSO（MSAL）設定。
 */

const path = require('path');
const fs = require('fs');
const ROOT_DIR = path.join(__dirname, '..');

let msal = null;

try {
  msal = require('@azure/msal-node');
} catch (e) {
  console.warn('⚠️  @azure/msal-node 未安裝，M365 SSO 功能停用（若需啟用請執行 npm install）');
}

// ==================== M365 SSO ====================

const MSAL_CONFIG_PATH = path.join(ROOT_DIR, 'msal_config.json');

let msalConfig = { enabled: false };

let msalClient = null;

function loadMsalConfig() {
  if (!msal) {
    msalClient = null;
    return; // 套件未安裝，跳過
  }
  try {
    if (fs.existsSync(MSAL_CONFIG_PATH)) {
      msalConfig = JSON.parse(fs.readFileSync(MSAL_CONFIG_PATH, 'utf8'));
    }
    if (msalConfig.enabled && msalConfig.clientId && msalConfig.tenantId && msalConfig.clientSecret) {
      msalClient = new msal.ConfidentialClientApplication({
        auth: {
          clientId: msalConfig.clientId,
          authority: `https://login.microsoftonline.com/${msalConfig.tenantId}`,
          clientSecret: msalConfig.clientSecret,
        },
        system: {
          loggerOptions: { loggerCallback: () => {}, piiLoggingEnabled: false, logLevel: msal.LogLevel.Warning }
        }
      });
      console.log('✓ M365 SSO 已啟用');
    } else {
      msalClient = null;
      console.log('ℹ️  M365 SSO 未啟用');
    }
  } catch (err) {
    console.error('載入 MSAL 設定失敗:', err.message);
  }
}

loadMsalConfig();

const getMsalConfig = () => msalConfig;
const getMsalClient = () => msalClient;

module.exports = {
  MSAL_CONFIG_PATH,
  getMsalClient,
  getMsalConfig,
  loadMsalConfig,
};
