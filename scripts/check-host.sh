#!/usr/bin/env bash
# ============================================================================
# DMS 主機端檢查：在 dms-dev / dms-prod 主機上執行（建議用 sudo，才能讀 systemd 環境、防火牆與日誌）
#
# 用法：
#   sudo scripts/check-host.sh --service dms-dev --dir /opt/dms-dev --nginx-ip 10.0.0.10 --port 5000
#
# 參數（皆可省略，會盡量自動偵測）：
#   --service   systemd 服務名稱（預設為 --dir 的資料夾名稱）
#   --dir       應用程式目錄（預設為本腳本所在專案根目錄）
#   --nginx-ip  前端 nginx 主機 IP；給了才會比對 PROXY_ALLOWLIST 與防火牆規則
#   --port      應用程式埠（預設從服務環境變數 PORT 讀取，找不到用 5000）
#   --log-min   檢查最近幾分鐘的日誌（預設 60）
#
# 本腳本只讀取資訊，不會修改任何設定；也不會印出任何密鑰內容。
# 結束碼：0 = 無 FAIL；1 = 有 FAIL。
# ============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$(dirname "$SCRIPT_DIR")"; SERVICE=""; NGINX_IP=""; PORT=""; LOG_MIN=60
while [ $# -gt 0 ]; do
  case "$1" in
    --service) SERVICE="$2"; shift 2 ;;
    --dir) DIR="${2%/}"; shift 2 ;;
    --nginx-ip) NGINX_IP="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --log-min) LOG_MIN="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知參數：$1"; exit 2 ;;
  esac
done
[ -z "$SERVICE" ] && SERVICE="$(basename "$DIR")"

PASS=0; FAILN=0; WARN=0
GREEN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; NC=$'\033[0m'
pass() { PASS=$((PASS+1)); echo "  ${GREEN}✔ PASS${NC} $1"; }
fail() { FAILN=$((FAILN+1)); echo "  ${RED}✘ FAIL${NC} $1"; [ -n "${2:-}" ] && echo "         → $2"; }
warn() { WARN=$((WARN+1)); echo "  ${YEL}! WARN${NC} $1"; [ -n "${2:-}" ] && echo "         → $2"; }
section() { echo; echo "■ $1"; }
have() { command -v "$1" >/dev/null 2>&1; }
perm() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
owner() { stat -c '%U' "$1" 2>/dev/null || stat -f '%Su' "$1" 2>/dev/null; }

echo "DMS 主機檢查 → 服務 $SERVICE，目錄 $DIR"
[ "$(id -u)" -ne 0 ] && warn "未以 root 執行，部分檢查會略過" "建議 sudo 執行"
[ -d "$DIR" ] || { fail "找不到目錄 $DIR"; exit 1; }

# ---------------------------------------------------------------- 1. 版本與 git 狀態
section "1. 程式版本與 git 狀態"
if [ -d "$DIR/.git" ] && have git; then
  G() { git -C "$DIR" "$@"; }
  echo "  分支：$(G branch --show-current 2>/dev/null)　commit：$(G log --oneline -1 2>/dev/null)"
  dirty="$(G status --short 2>/dev/null | grep -v '^??' | wc -l | tr -d ' ')"
  [ "$dirty" = 0 ] && pass "沒有未提交的已追蹤檔案變更" || warn "有 $dirty 個已追蹤檔案被本機修改" "update.sh 會因此中止；先確認這些變更是否需要保留"
  tracked_db="$(G ls-files databases 2>/dev/null | wc -l | tr -d ' ')"
  [ "$tracked_db" = 0 ] && pass "databases/ 沒有被 git 追蹤" || fail "databases/ 有 $tracked_db 個檔案被 git 追蹤" "git rm -r --cached databases（見記憶中的 reset --hard 陷阱：先備份！）"
  bad="$(G ls-files 2>/dev/null | grep -E '(^|/)(msal_config|email_config)\.json$|\.session_secret|\.initial_admin_password|sessions/' | wc -l | tr -d ' ')"
  [ "$bad" = 0 ] && pass "密鑰／設定檔／session 未被 git 追蹤" || fail "有密鑰或 session 檔案被 git 追蹤（$bad 個）"
else
  warn "不是 git 目錄或沒有 git，略過版本檢查"
fi
for f in lib/security.js lib/session-store.js app.js public/vendor/jquery/jquery-3.6.0.min.js public/vendor/bootstrap/bootstrap.min.css; do
  [ -f "$DIR/$f" ] && pass "存在 $f" || fail "缺少 $f" "程式碼可能不是新版（或 HTML/vendor 位置不對）"
done

# ---------------------------------------------------------------- 2. Node / 相依套件
section "2. Node 與相依套件"
if have node; then
  v="$(node -v | sed 's/^v//')"; major="${v%%.*}"
  [ "$major" -ge 20 ] 2>/dev/null && pass "Node $v（需 >= 20）" || fail "Node $v 低於 20"
else
  fail "找不到 node"
fi
if [ -d "$DIR/node_modules" ]; then
  pass "node_modules 存在"
  if have npm && [ -f "$DIR/package-lock.json" ]; then
    T=""; have timeout && T="timeout 60"
    out="$(cd "$DIR" && $T npm audit --omit=dev 2>&1 | tail -4 | tr '\n' ' ')"
    case "$out" in
      *"found 0 vulnerabilities"*) pass "npm audit：0 個弱點" ;;
      *vulnerabilit*) warn "npm audit：$out" "目前已知僅剩 exceljs/uuid 的 2 項中度（需破壞性升級）" ;;
      *) warn "npm audit 無法執行（可能無外網）" ;;
    esac
  fi
else
  fail "沒有 node_modules" "cd $DIR && npm install --omit=dev"
fi

# ---------------------------------------------------------------- 3. systemd
section "3. systemd 服務與環境變數"
SVC_USER=""
if have systemctl && systemctl cat "$SERVICE" >/dev/null 2>&1; then
  state="$(systemctl is-active "$SERVICE" 2>/dev/null)"
  [ "$state" = active ] && pass "服務 $SERVICE 運作中" || fail "服務狀態：$state" "journalctl -u $SERVICE -n 80 --no-pager"
  SVC_USER="$(systemctl show "$SERVICE" -p User --value 2>/dev/null)"
  echo "  執行身分：${SVC_USER:-root（未指定 User=）}"
  [ -z "$SVC_USER" ] || [ "$SVC_USER" = root ] && warn "服務以 root 執行" "建議在 service 設定 User=<專用帳號>"
  envline="$(systemctl show "$SERVICE" -p Environment --value 2>/dev/null)"
  envfile="$(systemctl show "$SERVICE" -p EnvironmentFiles --value 2>/dev/null)"
  allenv="$envline"
  # EnvironmentFile 內容（只取非密鑰變數名稱以外的值）
  efile="$(echo "$envfile" | awk '{print $1}')"
  [ -n "$efile" ] && [ -r "${efile#-}" ] && allenv="$allenv $(grep -E '^(PROXY_ALLOWLIST|ALLOWED_ORIGINS|PORT|HOST|NODE_ENV)=' "${efile#-}" 2>/dev/null | tr '\n' ' ')"
  pal="$(echo "$allenv" | tr ' ' '\n' | grep '^PROXY_ALLOWLIST=' | head -1 | cut -d= -f2-)"
  if [ -z "$pal" ]; then
    fail "服務環境沒有 PROXY_ALLOWLIST" "sudo systemctl edit $SERVICE → [Service] Environment=PROXY_ALLOWLIST=<nginx IP>；systemctl restart $SERVICE"
  elif [ -n "$NGINX_IP" ]; then
    echo ",$pal," | grep -q ",$NGINX_IP," && pass "PROXY_ALLOWLIST=$pal（含 nginx $NGINX_IP）" || fail "PROXY_ALLOWLIST=$pal 不含 $NGINX_IP"
  else
    pass "PROXY_ALLOWLIST=$pal"
  fi
  [ -z "$PORT" ] && PORT="$(echo "$allenv" | tr ' ' '\n' | grep '^PORT=' | head -1 | cut -d= -f2-)"
  echo "$allenv" | grep -q "SESSION_SECRET=" && warn "SESSION_SECRET 直接寫在 service 環境（會出現在 systemctl show）" "建議移除，改用 $DIR/.session_secret（600）"
  hardening="$(systemctl show "$SERVICE" -p NoNewPrivileges -p ProtectSystem --value 2>/dev/null | tr '\n' ' ')"
  case "$hardening" in *yes*) pass "service 有啟用 systemd 沙箱（$hardening）" ;; *) warn "service 未啟用 NoNewPrivileges/ProtectSystem" "選用強化：見 docs/dev-verification.md 的 systemd drop-in 範例" ;; esac
else
  warn "找不到 systemd 服務 $SERVICE（PM2 部署請改檢查 pm2 env）" "PM2：pm2 env <id> | grep PROXY_ALLOWLIST"
fi
[ -z "$PORT" ] && PORT=5000

# ---------------------------------------------------------------- 4. 檔案權限
section "4. 密鑰與資料目錄權限"
check_perm() { # 路徑 允許的權限(空白分隔) 說明
  local f="$1" allowed="$2" label="$3"
  [ -e "$f" ] || { echo "  - $label 不存在（略過）"; return; }
  local p; p="$(perm "$f")"
  echo " $allowed " | grep -q " $p " && pass "$label 權限 $p（擁有者 $(owner "$f")）" || fail "$label 權限為 $p（應為 $allowed）" "chmod $(echo "$allowed" | awk '{print $1}') $f"
}
check_perm "$DIR/.session_secret" "600 400" ".session_secret"
check_perm "$DIR/email_config.json" "600 400" "email_config.json"
check_perm "$DIR/msal_config.json" "600 400" "msal_config.json"
check_perm "$DIR/sessions" "700" "sessions/ 目錄"
check_perm "$DIR/sessions/sessions.sqlite" "600" "sessions.sqlite"
check_perm "$DIR/backups" "700 750 755 775" "backups/ 目錄"
if [ -d /opt/backups ]; then
  bp="$(perm /opt/backups)"
  other="${bp: -1}"
  [ "$other" = 0 ] && pass "/opt/backups 權限 $bp（其他使用者不可讀）" || warn "/opt/backups 權限 $bp，其他使用者可讀取備份（含帳號與密碼雜湊）" "chmod 750 /opt/backups；舊備份檔 chmod 640 /opt/backups/*.tar.gz"
  loose="$(find /opt/backups -maxdepth 1 -name '*.tar.gz' -perm -004 2>/dev/null | wc -l | tr -d ' ')"
  [ "$loose" = 0 ] && pass "/opt/backups 內沒有其他人可讀的備份檔" || warn "有 $loose 個備份檔其他使用者可讀" "chmod 640 /opt/backups/*.tar.gz"
fi
[ -e "$DIR/.initial_admin_password" ] && fail "殘留 .initial_admin_password" "管理員帳號建立後應已刪除；確認已登入並改密碼後 rm 此檔" || pass "沒有殘留 .initial_admin_password"
[ -f "$DIR/.session_secret" ] && [ "$(wc -c < "$DIR/.session_secret" | tr -d ' ')" -ge 32 ] && pass ".session_secret 長度足夠" || warn ".session_secret 不存在或過短" "沒設環境變數時，服務啟動會自動產生"
if [ -n "$SVC_USER" ] && [ "$(id -u)" -eq 0 ] && have sudo; then
  sudo -u "$SVC_USER" test -w "$DIR" && pass "服務帳號 $SVC_USER 可寫入 $DIR（建立 sessions/.session_secret 所需）" || fail "服務帳號 $SVC_USER 無法寫入 $DIR" "chown -R $SVC_USER $DIR 或至少讓 sessions/、databases/、uploads/、backups/ 與 .session_secret 可寫"
fi
wp="$(find "$DIR" -maxdepth 1 -perm -0002 ! -type l 2>/dev/null | head -3 | tr '\n' ' ')"
[ -z "$wp" ] && pass "應用程式目錄頂層沒有 world-writable 項目" || fail "world-writable：$wp" "chmod o-w"

# ---------------------------------------------------------------- 5. 網路與防火牆
section "5. 監聽與防火牆（埠 $PORT）"
if have ss; then
  ss -ltn 2>/dev/null | grep -q ":$PORT " && pass "埠 $PORT 有在監聽" || fail "埠 $PORT 沒有在監聽"
else
  warn "沒有 ss 指令，略過監聽檢查"
fi
if have ufw && [ "$(id -u)" -eq 0 ]; then
  ustat="$(ufw status 2>/dev/null)"
  if echo "$ustat" | grep -q "inactive"; then
    fail "ufw 未啟用" "sudo ufw allow from <nginx IP> to any port $PORT proto tcp && sudo ufw enable（記得先放行 SSH）"
  else
    lines="$(echo "$ustat" | grep -E "(^|[^0-9])$PORT(/tcp)?[[:space:]]" | grep -i allow || true)"
    if [ -z "$lines" ]; then
      warn "ufw 沒有針對埠 $PORT 的允許規則" "nginx 將無法連入；加上 ufw allow from <nginx IP> to any port $PORT proto tcp"
    elif echo "$lines" | grep -qi "anywhere" && ! echo "$lines" | grep -q "[0-9]\+\.[0-9]\+\.[0-9]\+\.[0-9]\+"; then
      fail "埠 $PORT 對任何來源開放" "$(echo "$lines" | head -2 | tr '\n' ';')"
    elif echo "$lines" | awk '{print $NF}' | grep -qi "anywhere"; then
      fail "埠 $PORT 有對 Anywhere 開放的規則" "$(echo "$lines" | head -3 | tr '\n' ';')"
    else
      [ -z "$NGINX_IP" ] && pass "埠 $PORT 僅對特定來源開放" || { echo "$lines" | grep -q "$NGINX_IP" && pass "埠 $PORT 僅允許 $NGINX_IP" || fail "規則中沒有 $NGINX_IP" "$(echo "$lines" | head -2 | tr '\n' ';')"; }
    fi
  fi
else
  warn "略過防火牆檢查（需 root 且有 ufw）" "若用 firewalld/iptables/雲端安全群組，請手動確認只允許 nginx 主機連到埠 $PORT"
fi

# ---------------------------------------------------------------- 6. 日誌
section "6. 最近 $LOG_MIN 分鐘的服務日誌"
if have journalctl && [ "$(id -u)" -eq 0 ]; then
  J="$(journalctl -u "$SERVICE" --since "$LOG_MIN min ago" --no-pager 2>/dev/null)"
  if [ -z "$J" ]; then
    warn "最近沒有日誌（服務剛重啟？調大 --log-min）"
  else
    echo "$J" | grep -q "未設定 PROXY_ALLOWLIST" && fail "日誌顯示未設定 PROXY_ALLOWLIST" || pass "日誌沒有 PROXY_ALLOWLIST 警告"
    echo "$J" | grep -q "只接受來自反向代理" && pass "日誌確認白名單已啟用" || warn "日誌中沒看到白名單啟用訊息（可能在更早之前啟動）"
    n="$(echo "$J" | grep -c '\[CSRF\] 拒絕來源' || true)"
    [ "$n" = 0 ] && pass "沒有 CSRF 來源被拒紀錄" || warn "有 $n 筆 [CSRF] 拒絕來源" "若是正常使用被擋：nginx 沒帶 Host，或需設定 ALLOWED_ORIGINS"
    echo "$J" | grep -q "帳號名稱衝突" && warn "有帳號名稱互為底線前綴" "$(echo "$J" | grep '帳號名稱衝突' | head -2 | cut -c1-160)" || pass "沒有帳號名稱衝突警告"
    echo "$J" | grep -Eq "SQLITE_CANTOPEN|EACCES|Cannot find module|uncaughtException|\[500\]" && warn "日誌有錯誤" "$(echo "$J" | grep -E 'SQLITE_CANTOPEN|EACCES|Cannot find module|uncaughtException|\[500\]' | head -3 | cut -c1-160)" || pass "日誌沒有明顯錯誤"
  fi
else
  warn "略過日誌檢查（需 root 且有 journalctl；PM2 請看 pm2 logs）"
fi

echo
echo "────────────────────────────────────────"
echo "結果：${GREEN}$PASS 通過${NC}／${RED}$FAILN 失敗${NC}／${YEL}$WARN 警告${NC}"
[ "$FAILN" -eq 0 ]
