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
互動式精靈會詢問安裝路徑、Port、服務名稱等設定，自動安裝 Node.js、建立 systemd 服務並啟動。細節見 [完整開發說明文件.md](docs/完整開發說明文件.md)、[部署功能檢查清單.md](docs/部署功能檢查清單.md)。

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

完整案例紀錄（含正式環境實際執行結果）見 [2026-07-系統更新技術文件.md](docs/2026-07-系統更新技術文件.md)。

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

### 管理員初始密碼
- 全新安裝時，`deploy.sh` 會**亂數產生**管理員（`admin`）初始密碼，**只在部署結束時顯示在終端機一次**，同時寫入 `.initial_admin_password`（權限 600）；應用程式建立帳號後立即刪除該檔。
- 該帳號首次登入會被強制修改密碼，改完前其他功能一律被擋（伺服器端強制，不只是前端提示）。
- 管理員建立的帳號、以及管理員重設的密碼都是「臨時密碼」，使用者下次登入同樣必須自行修改。
- 若不是用 `deploy.sh`（手動啟動）且沒有初始密碼檔，程式會產生亂數密碼並**只在啟動日誌印出一次**。忘記密碼：`sudo ./reset_password.sh admin`。
- 密碼政策：至少 10 字元、含大寫/小寫/數字/符號至少三類、不可含使用者名稱、不可為常見密碼。

### 前端 nginx（不同主機）
- 應用程式環境變數 **`PROXY_ALLOWLIST`**（逗號分隔 IP）：只接受來自 nginx 主機的連線，直連一律 403。`deploy.sh` 會詢問；systemd 部署請在 service 的 `Environment=` 加上，例如 `Environment=PROXY_ALLOWLIST=10.0.0.10`。
- 防火牆也要同步限制：`sudo ufw allow from <nginx IP> to any port <APP_PORT> proto tcp`。
- nginx 範本見 [docs/nginx-example.conf](docs/nginx-example.conf)：終止 TLS、登入端點限速、安全標頭，**必須**帶 `Host`、`X-Forwarded-For`、`X-Forwarded-Proto`（Origin 檢查與登入限速依賴它們）。
- `ALLOWED_ORIGINS`（可選，逗號分隔）：額外允許的 Origin（例如有多個對外網域時）。

### 認證與連線防護
- 登入失敗鎖定：同 IP+帳號 5 次、同 IP 30 次、同帳號 30 次，15 分鐘內回 429；不論帳號是否存在回應一致。
- 登入後換發 session ID；session 存於 `sessions/sessions.sqlite`（重啟不會登出所有人）；改密碼、重設密碼、變更角色／權限、刪除帳號時，該帳號其他 session 立即失效。
- CSRF：非 GET 請求檢查 `Origin`/`Sec-Fetch-Site`；搭配 `SameSite=Lax`、`Secure`、`HttpOnly` cookie。
- 安全標頭：CSP、`X-Frame-Options: DENY`、`nosniff`、HSTS（經 HTTPS 代理時）。前端函式庫（Bootstrap、jQuery、Bootstrap Icons）已**自託管**於 `public/vendor/`，不再載入外部 CDN。
- M365 SSO 的 `state` 改為隨機值並綁定 session（一次性）。

### 密鑰與設定檔
- **Session 簽章金鑰**：優先用環境變數 `SESSION_SECRET`，其次主機專屬的 `.session_secret`；兩者皆無時自動產生隨機金鑰並寫入 `.session_secret`（權限 600）。原始碼中不再有任何寫死的後備值。
- `msal_config.json`、`email_config.json` 內含真實密鑰，已加入 `.gitignore`，由程式寫入時權限為 600；後台儲存設定只接受白名單欄位。
- 啟動時會檢查帳號名稱是否互為底線前綴（如 `a` 與 `a_b`）：這類帳號會讓個人資料庫歸屬混淆，新帳號已禁止，既有的會在日誌警告。

### 其他
- 檔案上傳：單檔 10MB、僅 `.xlsx` / `.csv`，處理完一律刪除暫存檔。
- 「清空全部資料」限內部帳號，執行前自動備份到 `backups/pre-clear/`（保留最近 20 份）。
- 資料庫可見範圍：一般內部帳號只看得到、也只能複製／切換自己的資料庫（或管理員明確授權給自己的）；系統資料庫（`system.db`、`admin.db`）與他人／客戶的資料庫對非管理員一律不可見、不可複製。需要參考他人資料庫時，請管理員授權或由管理員代為複製。
- 500 錯誤只回通用訊息，細節只在伺服器日誌。
- 回歸測試：`npm test`（含登入限速、強制改密碼、CSRF、授權、上傳、代理白名單等整合測試）。
- 定期執行 `npm audit`，尤其是新增／更新相依套件時。
- 更多稽核細節見 [2026-07-系統更新技術文件.md](docs/2026-07-系統更新技術文件.md) 的安全性檢查章節

---

## 程式結構

`app.js` 只負責組裝（中介軟體、路由掛載、啟動），邏輯依領域分在以下目錄：

| 目錄 | 內容 |
|---|---|
| `routes/` | API 路由：`auth`、`admin`、`folders`、`users`、`groups`、`permissions`、`permission-requests`、`databases`、`import-export`、`pages` |
| `middleware/` | `auth`（登入／角色檢查）、`session`（Session、閒置逾時、強制改密碼）、`viewer`（唯讀帳號）、`user-database`（`req.userDb`）、`upload` |
| `services/` | `database`（連線、啟動、使用者連線快取）、`schema`、`email`、`sso`、`audit`、`backup`、`folders`、`permissions`、`accounts` |
| `lib/` | `security`、`session-store`、`db`（`dbGet`／`dbAll`／`dbRun` 等 Promise 包裝）、`connection-cache`、`config`、`time`、`http` |

- 使用者資料庫連線快取上限預設 20 條、閒置 30 分鐘自動關閉，可用環境變數 `USER_DB_CACHE_MAX`、`USER_DB_IDLE_MINUTES` 調整。
- 部署時整個目錄一起複製（`deploy.sh` 用 rsync／cp 整個資料夾），不要只複製 `app.js`。

---

## 文件索引

| 文件 | 內容 |
|---|---|
| [nginx-example.conf](docs/nginx-example.conf) | 前端 nginx 反向代理範本（TLS、限速、安全標頭） |
| [完整開發說明文件.md](docs/完整開發說明文件.md) | 系統架構、API 端點、開發環境設定等完整參考（部署章節較舊，以本 README 為準） |
| [2026-07-系統更新技術文件.md](docs/2026-07-系統更新技術文件.md) | 部署工具、systemd 支援、安全性稽核等本次更新的完整技術記錄 |
| [部署功能檢查清單.md](docs/部署功能檢查清單.md) | `deploy.sh`／`uninstall.sh`／`restore.sh` 功能與使用範例 |
| [已修復問題記錄.md](docs/已修復問題記錄.md) | 歷史 bug 修復記錄 |
| [502錯誤排除指南.md](docs/502錯誤排除指南.md) | 502 Bad Gateway 故障排除 |
| [還原後登入問題排除指南.md](docs/還原後登入問題排除指南.md) | 還原資料後登入異常排除 |
| [路徑檢查報告.md](docs/路徑檢查報告.md) | 路徑相關檢查記錄 |
| [AD PowerShell 語法生成功能說明.md](docs/AD%20PowerShell%20語法生成功能說明.md) | AD PowerShell 語法生成工具說明 |
