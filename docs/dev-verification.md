# dms-dev 實機驗證清單（security/hardening）

目的：在真實的 **systemd + 另一台 nginx** 環境確認這批安全強化與重構沒有弄壞功能。
本機（macOS）只跑過自動測試與瀏覽器登入，**沒有**在 Ubuntu、nginx、systemd 上驗證過。

> 約定：`<APP_HOST>` = dms-dev 主機；`<NGINX_HOST>` = 前端 nginx 主機；
> `<NGINX_IP>` = nginx 主機對應用主機所見的來源 IP；`<PORT>` = 應用程式埠（預設 5000）。
> 服務名稱 `dms-dev`、目錄 `/opt/dms-dev`（依實際調整）。

驗證順序：**備份 → 更新程式 → systemd 環境變數 → nginx → 防火牆 → 跑兩支腳本 → 手動功能走查 → 觀察日誌 → 判定是否可上 prod**。

---

## 0. 前置決定：用什麼方式把程式放上 dms-dev

目前 `security/hardening` 只在本機，**尚未 push**（repo 是公開的，push 前請自己最後確認一次沒有密鑰）。

| 方式 | 做法 | 備註 |
|---|---|---|
| A. push 分支再拉 | 本機 `git push -u origin security/hardening`；dms-dev 上 `git fetch origin && git checkout security/hardening` | 之後走 PR 合併最順；`update.sh` 預設拉目前分支 |
| B. rsync 直送 | 從本機 `rsync -av --exclude node_modules --exclude .git --exclude databases --exclude sessions --exclude uploads --exclude backups --exclude logs --exclude '.session_secret' --exclude 'email_config.json' --exclude 'msal_config.json' ./dms/ <user>@<APP_HOST>:/opt/dms-dev/` | 不經過 GitHub；dms-dev 的 git 狀態會與遠端不一致，驗證完要再對齊 |

> 記憶中的陷阱：dms-dev 曾與 origin 分歧。更新前先在主機上 `git status --short` 與 `git ls-files databases | wc -l`（應為 0）。
> 若 `databases/` 曾進過 git 索引，**不要直接 `git reset --hard`**（會刪掉資料庫），先做第 1 步備份。

---

## 1. 備份與回退點（必做）

```bash
# 在 dms-dev 主機
sudo systemctl stop dms-dev
sudo tar czf /root/dms-dev-before-hardening-$(date +%Y%m%d-%H%M).tgz -C /opt dms-dev   # 含 databases/、設定檔
sudo sh -c 'cd /opt/dms-dev && git rev-parse HEAD > /root/dms-dev-before-hardening.commit'
sudo systemctl start dms-dev
ls -lh /root/dms-dev-before-hardening-*.tgz
```

---

## 2. 更新程式碼與相依套件

```bash
cd /opt/dms-dev
# 方式 A：
git fetch origin && git checkout security/hardening        # 或用 sudo -u <service user>
# 方式 B 已由 rsync 完成

npm install --omit=dev          # nodemailer 升到 10.x，需重新安裝
```

重點檢查：
- [ ] 服務帳號對 `/opt/dms-dev` **可寫**（應用程式啟動時會建立 `sessions/`、`.session_secret`）：
      `sudo -u <service user> test -w /opt/dms-dev && echo OK`
- [ ] 舊主機（dms-dev 原本沒有 `.session_secret`）：**不需要手動建立**，首次啟動會自動產生（權限 600）。
- [ ] 既有的 `admin` 帳號與資料不會被改動；不會產生新的初始密碼。
- [ ] 後台「手動備份」要用的 `/opt/backups` 必須**事先建立且服務帳號可寫**（服務帳號通常不能在 `/opt` 底下建目錄）：
      `sudo install -d -o <service user> -g <service user> -m 750 /opt/backups`
      新備份檔為 640（`backup_databases.sh` 已加 `umask 027`）；排程（cron）與網頁備份請用同一個帳號，否則對方讀不到。

---

## 3. systemd 環境變數

```bash
sudo systemctl edit dms-dev
```

貼入（`<NGINX_IP>` 換成 nginx 主機 IP，多個以逗號分隔）：

```ini
[Service]
Environment=PROXY_ALLOWLIST=<NGINX_IP>
# 有多個對外網域、或網域與 nginx 轉送的 Host 不同時才需要：
# Environment=ALLOWED_ORIGINS=https://dms-dev.example.com
```

**選用：systemd 沙箱強化**（先不加也可以；加了要把驗證再跑一遍）：

```ini
[Service]
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/opt/dms-dev /opt/backups
```

> `ReadWritePaths` 要包含：應用程式目錄（databases、sessions、uploads、logs、backups、`.session_secret`、設定檔）與 `/opt/backups`（後台「手動備份」腳本寫入處）。

```bash
sudo systemctl daemon-reload
sudo systemctl restart dms-dev
sudo systemctl show dms-dev -p Environment      # 應看到 PROXY_ALLOWLIST=...
sudo journalctl -u dms-dev -n 40 --no-pager
```

啟動日誌應看到：
- [ ] `✓ 只接受來自反向代理 <NGINX_IP> 的連線`
- [ ] **沒有** `未設定 PROXY_ALLOWLIST` 警告
- [ ] 第一次啟動：`已產生主機專屬密鑰並寫入 .../.session_secret`
- [ ] 若有 `帳號名稱衝突` 警告 → 記下來，之後把其中一個帳號改名

---

## 4. nginx 主機

1. 套用 [nginx-example.conf](nginx-example.conf)：把 `<APP_HOST_IP>`、`<PORT>`、網域與憑證路徑換成實際值，
   其中 `dms-proxy.conf` 片段另存為 `/etc/nginx/snippets/dms-proxy.conf`。
2. 三個標頭**缺一不可**：

   | 標頭 | 缺了會怎樣 |
   |---|---|
   | `Host $host` | 所有寫入請求被 Origin 檢查擋成 403（日誌：`[CSRF] 拒絕來源`） |
   | `X-Forwarded-For $remote_addr` | 登入限速把所有人算成同一個 IP，一人被鎖全員被鎖 |
   | `X-Forwarded-Proto $scheme` | Cookie 是 Secure，應用程式以為是 http → **無法登入** |
3. `client_max_body_size` 要 ≥ 12m（應用程式上傳上限 10MB）。
4. Ubuntu 22.04／24.04 的 nginx（1.18／1.24）不認得獨立的 `http2 on;`（會 `unknown directive`），範例檔已改為 `listen 443 ssl http2;`。

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## 5. 防火牆（在應用主機）

```bash
sudo ufw allow from <NGINX_IP> to any port <PORT> proto tcp
sudo ufw status numbered          # 不應有對 Anywhere 開放 <PORT> 的規則
# 若有舊規則「ufw allow <PORT>/tcp」，請刪除：sudo ufw delete <編號>
```

> 啟用 ufw 前先確認 SSH 已放行，避免把自己鎖在外面。雲端環境請改查安全群組。

---

## 6. 自動化檢查（兩支腳本）

### 6.1 主機端（在應用主機上執行）

```bash
cd /opt/dms-dev
sudo scripts/check-host.sh --service dms-dev --dir /opt/dms-dev --nginx-ip <NGINX_IP> --port <PORT>
```

檢查：git 狀態（databases 未被追蹤、密鑰未被追蹤）、新版檔案、Node ≥ 20、`npm audit`、systemd 環境變數
（PROXY_ALLOWLIST）、服務帳號寫入權限、`.session_secret`／設定檔／`sessions/` 權限、殘留的
`.initial_admin_password`、埠監聽、ufw 規則、最近日誌（CSRF 拒絕、帳號衝突、錯誤）。

### 6.2 外部視角（在**非 nginx**、非應用主機的機器上執行，例如你的 Mac）

```bash
# 把 dms-dev 管理員密碼放進權限 600 的檔案（不要放在命令列）
( umask 077; read -rs -p "dms-dev admin 密碼: " p; echo; printf '%s' "$p" > ~/.dms-dev-pass )

scripts/verify-deployment.sh \
  --url https://dms-dev.example.com \
  --app http://<APP_HOST_IP>:<PORT> \
  --admin-user admin --admin-pass-file ~/.dms-dev-pass
```

檢查：HTTP→HTTPS、TLS 版本、安全標頭、自託管前端資源、未登入 API 防護、跨站 Origin 被拒、
**同站 Origin 通過（驗證 nginx 有轉送 Host）**、登入限速（429 + Retry-After）、
**繞過 nginx 直連被擋**、Cookie 旗標、登入／登出與登出後 session 失效。

> 自簽憑證的測試環境加上 `--insecure`（略過憑證驗證，正式環境請勿使用）。
> 限速測試會累計你來源 IP 的失敗次數（上限 30 次／15 分鐘），15 分鐘內請勿重複執行。
> 管理員若還在「必須改密碼」狀態，第 8 段會提示先手動改密碼。
> 兩支腳本的 Linux 專屬部分（systemctl、ufw、journalctl）尚未在實機跑過，第一次執行請對照輸出人工確認。

**兩支腳本都沒有 FAIL 才進入下一步。** WARN 逐項判讀（腳本會說明處理方式）。

---

## 7. 手動功能走查（瀏覽器，約 30–45 分鐘）

先用管理員在後台建立測試帳號（之後可刪）：`t_editor`（一般內部）、`t_viewer`（唯讀，指定一個資料庫）、
並以邀請連結建立 `t_client`（客戶使用者）。

### 7.1 認證與密碼

| # | 步驟 | 預期 |
|---|---|---|
| 1 | 用管理員後台新建 `t_editor`，臨時密碼 `abc12345` | 被拒，提示密碼政策 |
| 2 | 改用符合政策的臨時密碼建立 | 成功 |
| 3 | 以 `t_editor` 登入 | 跳出**無法關閉**的「修改密碼」對話框，沒有取消／關閉鈕；背景不載入資料 |
| 4 | 新密碼填 `password123` | 被拒（常見密碼） |
| 5 | 填符合政策的新密碼 | 成功並導回登入頁，用新密碼可登入、不再強制改密碼 |
| 6 | 同一帳號開兩個瀏覽器（A、B）登入，在 A 改密碼 | B 下一個動作被登出（其他 session 失效） |
| 7 | 管理員重設 `t_editor` 密碼 | 該帳號既有登入立即失效；下次登入又被強制改密碼 |
| 8 | 對 `t_editor` 連續輸入錯誤密碼 6 次 | 第 6 次起顯示「登入失敗次數過多」，約 15 分鐘後解除；另一個帳號仍能登入 |
| 9 | 重啟服務 `sudo systemctl restart dms-dev` 後重新整理頁面 | **仍保持登入**（session 存在 `sessions/sessions.sqlite`） |
| 10 | 閒置超過 1 小時後操作 | 顯示逾時並導回登入頁 |

### 7.2 邀請與角色

| # | 步驟 | 預期 |
|---|---|---|
| 1 | 管理員建立客戶邀請連結，開啟後用弱密碼註冊 | 被拒 |
| 2 | 用符合政策的密碼註冊 `t_client` | 成功；註冊 `t_client_x`（與既有帳號互為底線前綴）被拒並說明原因 |
| 3 | 同一邀請連結再用一次 | 顯示已使用 |
| 4 | `t_client` 登入 → 資料庫管理 | 看不到建立／刪除／重新命名／複製；呼叫相關 API 回 403 |
| 5 | `t_viewer` 登入 | 唯讀：所有新增／修改／刪除都被擋 |

### 7.3 資料庫與資料夾

| # | 步驟 | 預期 |
|---|---|---|
| 1 | `t_editor` 開「資料庫管理」 | 只看到自己的資料庫（`user_t_editor...`），看不到其他人、客戶、`system.db`、`admin.db` |
| 2 | 建立 `user_t_editor_proj.db`、切換、複製成 `user_t_editor_proj2.db`、重新命名、刪除 | 皆成功 |
| 3 | 建立名稱不以 `user_t_editor_` 開頭的資料庫 | 被拒 |
| 4 | 管理員開資料庫管理 | 看得到全部，可管理 |
| 5 | 新增資料夾 A、A/B、A/B/C；把 A 移到 C 底下 | **400**：「不能將資料夾移到自己或子資料夾底下」，資料不變 |
| 6 | 把 C 移到 A 底下（合法） | 成功，C 與子孫路徑全部更新 |

### 7.4 匯入匯出

| # | 步驟 | 預期 |
|---|---|---|
| 1 | 下載資料夾／人員範本、填入資料後匯入 | 成功，匯入歷史有紀錄 |
| 2 | 匯入 CSV、權限矩陣 xlsx | 成功 |
| 3 | 上傳 `.txt`／`.php` 等副檔名 | 400：僅支援 .xlsx 或 .csv |
| 4 | 上傳 > 10MB 檔案 | 413（nginx 或應用程式回） |
| 5 | 匯出 CSV、Excel、權限矩陣、完整報表 | 檔案可開啟、內容正確、中文不亂碼 |
| 6 | 檢查應用主機 `ls /opt/dms-dev/uploads` | 空的（暫存檔都被刪除） |
| 7 | 把剛匯出的完整 CSV（或同一份 xlsx）再匯入一次 | 資料夾數量不變（重用同一父層下的同名資料夾，不重複建立）；手動新增同一層同名資料夾會提示「同一層已有名稱相同的資料夾」 |

### 7.5 權限異動申請單

| # | 步驟 | 預期 |
|---|---|---|
| 1 | `t_client` 送出多筆權限異動申請 | 成功，工程師登入時有待審提醒 |
| 2 | 工程師審核：看到前後比對、核准／退回 | 套用結果正確；匯出申請單可開啟 |

### 7.6 管理功能

| # | 步驟 | 預期 |
|---|---|---|
| 1 | 後台「手動備份」→ 列表 → 下載 | 備份成功、可下載（若啟用 systemd 沙箱，確認 `/opt/backups` 可寫） |
| 2 | 資料庫內容「清空全部」（用 `t_editor` 或管理員） | 成功；`/opt/dms-dev/backups/pre-clear/` 出現一份 `.bak`（權限 600） |
| 3 | 以 `t_client`／`t_viewer` 嘗試清空 | 403 |
| 4 | Email 設定頁 → 測試寄信 | 成功（nodemailer 10 的實測；密碼欄位顯示為遮蔽字元，不改密碼時儲存不會清掉） |
| 5 | SSO 設定頁（若有啟用 M365） | 用 M365 登入成功；**SSO state 已改為隨機值綁定 session，務必實測一次** |
| 6 | 稽核日誌、線上使用者、系統健康頁 | 正常顯示；登入／改密碼／設定變更有紀錄 |
| 7 | 登出 | 回登入頁；按上一頁不再看到資料 |

### 7.7 瀏覽器端

- [ ] 開發者工具 Console：**沒有** CSP 違規（`Refused to ...`）、沒有外部網域請求（Network 篩選只有本站與 `www.megapower.asia`）。
- [ ] 版面、圖示、字型都正常（Bootstrap Icons 為自託管）。
- [ ] 登入頁與主頁在手機寬度下正常。

---

## 8. 觀察期（建議至少 1 個工作天）

每天跑一次 `sudo scripts/check-host.sh ...` 並看日誌：

```bash
sudo journalctl -u dms-dev --since "1 day ago" --no-pager | grep -E "\[CSRF\]|\[500\]|EACCES|SQLITE|uncaught|帳號名稱衝突"
```

- [ ] 沒有 `[CSRF] 拒絕來源`（有的話 = 真實使用者被擋，先查 nginx 的 Host／ALLOWED_ORIGINS）
- [ ] 沒有非預期的 `[500]`
- [ ] 沒有 `EACCES`／`SQLITE_CANTOPEN`（權限或沙箱問題）
- [ ] 記憶體穩定（`systemctl status dms-dev` 的 Memory；連線快取有上限與閒置關閉）
- [ ] 實際使用者回報「被登出」「登入被鎖」的頻率合理

---

## 9. 回退

```bash
sudo systemctl stop dms-dev
cd /opt/dms-dev && git checkout <before 的 commit，見 /root/dms-dev-before-hardening.commit>   # 方式 A
# 或整包還原：sudo tar xzf /root/dms-dev-before-hardening-*.tgz -C /opt
npm install --omit=dev
sudo systemctl start dms-dev
```

- 資料庫結構僅新增 `accounts.must_change_password` 欄位（舊版程式會忽略它，向下相容）。
- 新增的 `sessions/` 目錄與 `.session_secret` 可保留，不影響舊版。
- 回退後 nginx 設定仍可沿用；`PROXY_ALLOWLIST` 對舊版無作用。

---

## 10. 通過標準（才可 push、PR、更新 prod）

- [ ] `check-host.sh` 與 `verify-deployment.sh` 皆無 FAIL，WARN 都已判讀
- [ ] 第 7 節走查全部符合預期（特別是：強制改密碼、重啟後仍登入、資料庫可見範圍、匯入匯出、備份、Email、SSO）
- [ ] 觀察期內沒有 `[CSRF]` 誤擋與非預期 `[500]`
- [ ] 回退流程已確認可行（至少讀過一遍、備份檔存在）

通過後：push 分支 → 開 PR 到 `main` → 合併 → dms-prod 先備份、確認 `git status` 乾淨與 `databases/` 未被追蹤，
再依第 2–6 節對 dms-prod 重複一次（**prod 的 PROXY_ALLOWLIST 要填 prod 的 nginx IP**）。


---

## 附錄：Ubuntu VM（VirtualBuddy）實測記錄 — 2026-10-18

環境：兩台 Ubuntu 24.04.5 arm64（dev01 = 應用程式、nginx01 = nginx 1.24），Node 22.23.3（nodejs.org 官方 tarball，已驗證 SHA256）。

**已在實機驗證通過：**
- systemd 服務（`User=dms`）啟動；`PROXY_ALLOWLIST` 生效；`.session_secret`（600）、`sessions/`（700）、`sessions.sqlite`（600）自動建立
- 初始密碼檔機制：首次啟動建立 admin 並刪除 `.initial_admin_password`；首次登入強制改密碼
- nginx（自簽 TLS、HTTP→HTTPS、安全標頭、HSTS、Secure Cookie）→ 應用程式全程正常；`Host` 轉送正確（同站 Origin 通過、跨站被拒）
- 應用程式自身的登入鎖定（429 + `Retry-After: 900`）
- 重啟服務後 session 仍有效（SQLite session store）
- 上傳：13MB → nginx 413；11MB → 應用程式 413；`.txt` → 400；`uploads/` 無殘留
- 手動備份在 systemd 沙箱（`NoNewPrivileges`、`ProtectSystem=full`、`ProtectHome`、`PrivateTmp`）下可正常運作
- 直連應用埠：白名單層（403）與 ufw 層（連線被丟棄）各自都會擋下
- `npm test` 在 Ubuntu arm64 / Node 22 上全數通過
- `check-host.sh`、`verify-deployment.sh` 的 Linux 專屬檢查實際跑過，行為符合預期

**實測中發現並已修正：**
1. 範例 nginx 設定的 `http2 on;` 在 nginx 1.24 無法載入 → 改用 `listen 443 ssl http2;`
2. 範例 nginx 登入限速 10r/m 太緊（腳本自己的測試就會把額度用完）→ 改為 30r/m、burst 10
3. `/opt/backups` 需事先建立；備份檔原本是 644（任何本機使用者可讀帳號與密碼雜湊）→ `umask 027`，並在 `check-host.sh` 加檢查
4. `verify-deployment.sh` 加 `--insecure`，並把「登入流程」排在「限速」之前，避免被限速影響

**環境限制（不是程式問題）：**
- VirtualBuddy 預設 NAT 下，**兩台 VM 之間無法互連**（彼此 ARP 解析失敗，只有 Mac 能連到兩台），因此本次以 Mac 的 SSH 通道（`ssh -R`）當中繼，
  應用程式看到的來源 IP 是 Mac（192.168.64.1）而不是 nginx VM。要測「真正跨主機」請把兩台 VM 的網路改為 Bridge。
- VM 內 Node 的 HTTPS 連線到 npm registry 常被重置（curl 正常），所以 `npm ci` 失敗；本次改在 Mac 安裝純 JS 相依後送入，再於 VM 內編譯 sqlite3
  （`npm_config_nodedir=/usr/local npm rebuild sqlite3`）。`npm audit` 在 VM 內因此無法執行。
- 尚未實測：M365 SSO、Email 寄送、瀏覽器端完整功能走查（第 7 節）。
