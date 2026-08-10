# 資料夾權限管理系統 (DMS)

AD 風格的資料夾／人員／群組／權限管理工具。單一 Node.js（Express）後端，每個租戶一個獨立 SQLite 資料庫。

> ⚠️ 本 repo 為**公開倉庫**。請勿提交任何真實密鑰／密碼——`msal_config.json`、`email_config.json` 已改為 `.gitignore` + `.example` 範本模式，只在主機上維護真實內容，不要 `git add -f` 強制加回去。

---

## 快速開始

### 全新部署

```bash
chmod +x deploy.sh
sudo ./deploy.sh
```
互動式精靈會詢問安裝路徑、Port、服務名稱等設定，自動安裝 Node.js、建立 systemd 服務並啟動。細節見 [完整開發說明文件.md](完整開發說明文件.md)、[部署功能檢查清單.md](部署功能檢查清單.md)。

### 現有安裝、但不是 git 倉庫 → 移轉成 git 管理

如果主機當初是用 `scp`/`rsync` 直接複製檔案部署的（`ls -la .git` 找不到 `.git`），沒辦法直接用 `update.sh`。移轉流程（全程對現有正式站零風險，最後才切換）：

```bash
cd /opt

# 1. clone 到全新資料夾，不動現有安裝
git clone --branch main https://github.com/oupaul/dms.git <app-dir>-new

# 2. 把環境專屬、不受 git 管理的東西搬過去
cp -r <app-dir>/databases <app-dir>-new/
cp -r <app-dir>/uploads <app-dir>-new/ 2>/dev/null || true
cp -r <app-dir>/logs <app-dir>-new/ 2>/dev/null || true
cp -r <app-dir>/backups <app-dir>-new/ 2>/dev/null || true
cp <app-dir>/msal_config.json <app-dir>-new/ 2>/dev/null || true
cp <app-dir>/email_config.json <app-dir>-new/ 2>/dev/null || true

# 3. 安裝相依套件
cd <app-dir>-new && npm install --omit=dev && cd /opt

# 4. 安全檢查：確認沒有遺漏檔案
#    特別留意有沒有 public/ 資料夾——app.js 的路由邏輯會優先讀取 public/ 裡的頁面，
#    若存在代表那才是目前實際使用中的版本，需要先比對內容再決定要不要一併搬過去
diff <(ls <app-dir>) <(ls <app-dir>-new)

# 5. 切換（服務名稱以實際 systemd unit 為準）
sudo systemctl stop <service-name>
mv <app-dir> <app-dir>.old_$(date +%Y%m%d_%H%M%S)   # 改名保留，不刪除
mv <app-dir>-new <app-dir>
sudo systemctl start <service-name>
```

完整案例紀錄（含正式環境實際執行結果）見 [2026-07-系統更新技術文件.md](2026-07-系統更新技術文件.md)。

---

## 日常更新

主機已經是 git 倉庫的話，一行指令搞定：

```bash
cd /opt/<app-dir>
./update.sh
```

會依序：檢查本機變更 → 拉取最新程式碼（只允許 fast-forward，分歧時中止不強推）→ `package.json` 有變才跑 `npm install` → 更新前自動備份資料庫 → 自動偵測 systemd 或 PM2 並重啟服務。

```bash
./update.sh <branch>           # 更新到指定分支
./update.sh <branch> --force   # 有未提交變更時自動 stash 後繼續
./update.sh --skip-backup      # 跳過更新前備份
```

---

## 備份與還原

```bash
./backup_databases.sh   # 手動備份，也可排入 cron 自動執行；備份存於 /opt/backups
sudo ./restore.sh        # 互動式還原精靈，從 /opt/backups 選擇備份還原
```

---

## 服務管理

支援 **systemd**（推薦）或 **PM2**，`update.sh`／`restore.sh` 會自動偵測目前用哪一種：

```bash
# systemd
sudo systemctl status <service-name>
sudo journalctl -u <service-name> -f

# PM2
pm2 status
pm2 logs <service-name>
```

---

## 安全性注意事項

- **預設管理員帳號** `admin`／`admin123` 僅在全新安裝時自動建立，**請務必在首次登入後立即更改**——這組帳密寫在公開原始碼裡，任何人都看得到
- **Session 簽章金鑰**：`app.js` 讀取 `SESSION_SECRET` 環境變數；`deploy.sh` 部署時會自動用 `openssl rand -hex 32` 產生一組主機專屬密鑰存到 `.session_secret`（已加入 `.gitignore`）並注入給 PM2 行程。若未設定 `SESSION_SECRET`，會 fallback 成原始碼裡寫死的預設值並印出警告——**正式環境務必確認有設定**，否則任何看過原始碼的人都能偽造 session
- `msal_config.json`（M365 SSO）、`email_config.json`（郵件通知）內含真實密鑰，已加入 `.gitignore`，只存在於各主機本機，不會、也不該被提交進 git
- 定期執行 `npm audit`，尤其是新增/更新相依套件時
- 更多稽核細節見 [2026-07-系統更新技術文件.md](2026-07-系統更新技術文件.md) 的安全性檢查章節

---

## 文件索引

| 文件 | 內容 |
|---|---|
| [完整開發說明文件.md](完整開發說明文件.md) | 系統架構、API 端點、開發環境設定等完整參考（部署章節較舊，以本 README 為準） |
| [2026-07-系統更新技術文件.md](2026-07-系統更新技術文件.md) | 部署工具、systemd 支援、安全性稽核等本次更新的完整技術記錄 |
| [部署功能檢查清單.md](部署功能檢查清單.md) | `deploy.sh`／`uninstall.sh`／`restore.sh` 功能與使用範例 |
| [已修復問題記錄.md](已修復問題記錄.md) | 歷史 bug 修復記錄 |
| [502錯誤排除指南.md](502錯誤排除指南.md) | 502 Bad Gateway 故障排除 |
| [還原後登入問題排除指南.md](還原後登入問題排除指南.md) | 還原資料後登入異常排除 |
| [路徑檢查報告.md](路徑檢查報告.md) | 路徑相關檢查記錄 |
| [AD PowerShell 語法生成功能說明.md](AD%20PowerShell%20語法生成功能說明.md) | AD PowerShell 語法生成工具說明 |
