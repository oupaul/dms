#!/usr/bin/env bash
# ============================================================================
# DMS 部署驗證（外部視角）：從任何一台能連到 nginx 的機器執行，不需要 SSH 到主機
#
# 驗證項目：HTTPS 轉址、安全標頭、自託管前端資源、未登入 API 防護、
#           登入限速、CSRF/Host 轉送、直連應用埠是否被擋、（可選）登入流程與 Cookie 旗標
#
# 用法：
#   scripts/verify-deployment.sh --url https://dms-dev.example.com \
#       [--app http://<應用主機IP>:<PORT>]            # 確認「繞過 nginx 直連」會被擋
#       [--admin-user admin --admin-pass-file ~/.dms-dev-pass]   # 可選：登入流程檢查
#
# 注意：
#   - 會用隨機帳號送出數次錯誤登入以驗證限速；這會累計該來源 IP 的失敗次數（上限 30 次／15 分鐘），
#     請勿在 15 分鐘內重複執行多次。
#   - --admin-pass-file 為只含密碼的檔案（權限請設 600），腳本不會把密碼印出或放在命令列。
#   - 結束碼：0 = 無 FAIL；1 = 有 FAIL。
# ============================================================================
set -u

URL=""; APP_URL=""; ADMIN_USER=""; ADMIN_PASS_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift 2 ;;
    --app) APP_URL="${2%/}"; shift 2 ;;
    --admin-user) ADMIN_USER="$2"; shift 2 ;;
    --admin-pass-file) ADMIN_PASS_FILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知參數：$1"; exit 2 ;;
  esac
done
[ -z "$URL" ] && { echo "請指定 --url（例：--url https://dms-dev.example.com）"; exit 2; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAILN=0; WARN=0
GREEN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; NC=$'\033[0m'
pass() { PASS=$((PASS+1)); echo "  ${GREEN}✔ PASS${NC} $1"; }
fail() { FAILN=$((FAILN+1)); echo "  ${RED}✘ FAIL${NC} $1"; [ -n "${2:-}" ] && echo "         → $2"; }
warn() { WARN=$((WARN+1)); echo "  ${YEL}! WARN${NC} $1"; [ -n "${2:-}" ] && echo "         → $2"; }
section() { echo; echo "■ $1"; }

IS_HTTPS=0; case "$URL" in https://*) IS_HTTPS=1 ;; esac
HOST_PART="${URL#*://}"; HOST_PART="${HOST_PART%%/*}"

# req METHOD PATH [curl 參數...]：結果放在 STATUS / $TMP/headers / $TMP/body
STATUS=""
req() {
  local method="$1" path="$2"; shift 2
  STATUS="$(curl -sS -m 20 -X "$method" -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' "$@" "$URL$path" 2>"$TMP/curl_err" || true)"
  [ -z "$STATUS" ] && STATUS="000"
}
hdr() { grep -i "^$1:" "$TMP/headers" | tail -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }
json_login() { # user pass → JSON body（以 python 轉義，避免特殊字元破壞 JSON）
  python3 -c 'import json,sys; print(json.dumps({"username":sys.argv[1],"password":sys.argv[2]}))' "$1" "$2"
}

echo "DMS 部署驗證 → $URL"

# ---------------------------------------------------------------- 1. 連線與 TLS
section "1. HTTPS 與 TLS"
if [ "$IS_HTTPS" = 1 ]; then
  HTTP_URL="http://$HOST_PART"
  code="$(curl -sS -m 15 -o /dev/null -w '%{http_code} %{redirect_url}' "$HTTP_URL/" 2>/dev/null || echo "000 ")"
  case "$code" in
    30[1278]*https://*) pass "HTTP 自動轉址到 HTTPS（$code）" ;;
    000*) warn "無法連線 $HTTP_URL（80 埠未開？）" "若刻意不開 80 埠可忽略" ;;
    *) fail "HTTP 沒有轉址到 HTTPS（$code）" "nginx 加 server { listen 80; return 301 https://\$host\$request_uri; }" ;;
  esac
  if curl -sS -m 10 --tlsv1.1 --tls-max 1.1 -o /dev/null "$URL/" 2>/dev/null; then
    fail "伺服器仍接受 TLS 1.1 以下" "ssl_protocols TLSv1.2 TLSv1.3;"
  else
    pass "不接受 TLS 1.1 以下"
  fi
  if curl -sS -m 10 -o /dev/null "$URL/" 2>"$TMP/tls_err"; then
    pass "憑證驗證通過"
  else
    warn "憑證驗證失敗：$(head -c 120 "$TMP/tls_err")" "內部自簽憑證可忽略；正式環境需有效憑證"
  fi
else
  warn "使用 http:// 位址，略過 TLS／轉址檢查" "正式環境必須是 HTTPS（Cookie 設為 Secure）"
fi

# ---------------------------------------------------------------- 2. 頁面與標頭
section "2. 登入頁、安全標頭"
req GET /login.html
if [ "$STATUS" = 200 ]; then pass "/login.html 可存取（200）"; else fail "/login.html 回應 $STATUS" "$(head -c 100 "$TMP/curl_err")"; fi
csp="$(hdr content-security-policy)"
[ -n "$csp" ] && pass "Content-Security-Policy 存在" || fail "缺少 Content-Security-Policy"
echo "$csp" | grep -q "frame-ancestors 'none'" && pass "CSP 禁止被嵌入框架" || fail "CSP 缺少 frame-ancestors 'none'"
echo "$csp" | grep -Eq "https://(cdn|code|unpkg)\." && fail "CSP 仍允許外部 CDN" "$csp" || pass "CSP 未開放外部 CDN"
[ "$(hdr x-frame-options)" = "DENY" ] && pass "X-Frame-Options: DENY" || fail "X-Frame-Options 不是 DENY"
[ "$(hdr x-content-type-options)" = "nosniff" ] && pass "X-Content-Type-Options: nosniff" || fail "缺少 nosniff"
if [ "$IS_HTTPS" = 1 ]; then
  hdr strict-transport-security | grep -q "max-age" && pass "HSTS 存在" || fail "缺少 Strict-Transport-Security" "確認 nginx 有帶 X-Forwarded-Proto \$scheme"
fi
[ -z "$(hdr x-powered-by)" ] && pass "未洩漏 X-Powered-By" || fail "洩漏 X-Powered-By: $(hdr x-powered-by)"
server="$(hdr server)"
echo "$server" | grep -Eq "nginx/[0-9]" && warn "Server 標頭洩漏 nginx 版本（$server）" "nginx 加 server_tokens off;" || pass "Server 標頭未洩漏版本（${server:-無}）"

# ---------------------------------------------------------------- 3. 自託管前端資源
section "3. 自託管前端資源（不依賴外部 CDN）"
for item in \
  "/vendor/jquery/jquery-3.6.0.min.js:javascript" \
  "/vendor/bootstrap/bootstrap.min.css:text/css" \
  "/vendor/bootstrap/bootstrap.bundle.min.js:javascript" \
  "/vendor/bootstrap-icons/bootstrap-icons.css:text/css" \
  "/vendor/bootstrap-icons/fonts/bootstrap-icons.woff2:font" \
  "/megapower-theme.css:text/css"; do
  p="${item%%:*}"; want="${item##*:}"
  req GET "$p"
  ct="$(hdr content-type)"
  if [ "$STATUS" = 200 ] && echo "$ct" | grep -qi "$want"; then pass "$p（$STATUS, $ct）"; else fail "$p → $STATUS, $ct"; fi
done
for page in /login.html /index.html; do
  req GET "$page"
  if grep -Eq "(cdn\.jsdelivr|unpkg\.com|code\.jquery\.com)" "$TMP/body"; then fail "$page 仍引用外部 CDN"; else pass "$page 未引用外部 CDN"; fi
done

# ---------------------------------------------------------------- 4. 未登入防護
section "4. 未登入 API 防護"
for p in /api/folders /api/users /api/databases /api/admin/accounts /api/admin/backup/list /api/system/health; do
  req GET "$p"
  case "$STATUS" in 401|403) pass "GET $p → $STATUS" ;; *) fail "GET $p 未登入卻回 $STATUS" ;; esac
done
req GET /api/auth/status
grep -q '"loggedIn":false' "$TMP/body" && pass "/api/auth/status 顯示未登入" || fail "/api/auth/status 未登入回應異常：$(head -c 100 "$TMP/body")"

# ---------------------------------------------------------------- 5. CSRF / Host 轉送
section "5. CSRF（Origin 檢查）與 nginx Host 轉送"
rnd="verify$RANDOM$RANDOM"
BADBODY="$(json_login "$rnd" 'Wrong-Pass-1!')"
req POST /api/auth/login -H 'Content-Type: application/json' -H 'Origin: https://evil.example' -d "$BADBODY"
[ "$STATUS" = 403 ] && pass "跨站 Origin 的 POST 被拒（403）" || fail "跨站 Origin 的 POST 回應 $STATUS（預期 403）"
req POST /api/auth/login -H 'Content-Type: application/json' -H "Origin: $URL" -d "$BADBODY"
case "$STATUS" in
  401) pass "同站 Origin 正常通過 Origin 檢查（帳密錯誤回 401）——代表 nginx 有正確轉送 Host" ;;
  403) fail "同站 Origin 被當成跨站拒絕" "nginx 必須 proxy_set_header Host \$host;（或設定 ALLOWED_ORIGINS）；日誌會有 [CSRF] 拒絕來源" ;;
  429) warn "被限速（429），無法判斷 Host 轉送" "稍後再執行" ;;
  *) fail "同站 Origin 回應 $STATUS（預期 401）" ;;
esac

# ---------------------------------------------------------------- 6. 登入限速
section "6. 登入失敗限速"
rnd="verify$RANDOM$RANDOM"; BADBODY="$(json_login "$rnd" 'Wrong-Pass-1!')"
first=""; got429=0; n=0
while [ $n -lt 12 ]; do
  n=$((n+1))
  req POST /api/auth/login -H 'Content-Type: application/json' -H "Origin: $URL" -d "$BADBODY"
  [ -z "$first" ] && first="$STATUS"
  if [ "$STATUS" = 429 ]; then got429=$n; break; fi
done
[ "$first" = 401 ] && pass "第 1 次錯誤登入回 401" || fail "第 1 次錯誤登入回 $first（預期 401）"
if [ "$got429" -ge 4 ] && [ "$got429" -le 8 ]; then
  pass "第 $got429 次失敗後被鎖定（429）"
  ra="$(hdr retry-after)"; [ -n "$ra" ] && pass "回應帶 Retry-After: $ra" || warn "429 沒有 Retry-After"
elif [ "$got429" -gt 0 ]; then
  warn "第 $got429 次才 429（預期約第 6 次）" "可能被 nginx 限速或計數受其他請求影響"
else
  fail "連續 12 次錯誤登入都沒被限速"
fi

# ---------------------------------------------------------------- 7. 直連應用埠
section "7. 繞過 nginx 直連應用埠"
if [ -n "$APP_URL" ]; then
  code="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "$APP_URL/login.html" 2>/dev/null || true)"
  case "$code" in
    403) pass "直連應用埠被拒（403，PROXY_ALLOWLIST 生效）" ;;
    000|"") pass "直連應用埠連不上（防火牆已擋）" ;;
    *) fail "直連應用埠回應 $code" "設定 PROXY_ALLOWLIST=<nginx IP>，並以 ufw 只允許 nginx 主機連入" ;;
  esac
else
  warn "未指定 --app，略過直連檢查" "建議加上 --app http://<應用主機IP>:<PORT>，並在「非 nginx」的機器上執行"
fi

# ---------------------------------------------------------------- 8. 登入流程（可選）
if [ -n "$ADMIN_USER" ] && [ -n "$ADMIN_PASS_FILE" ]; then
  section "8. 登入流程與 Cookie（使用 $ADMIN_USER）"
  if [ ! -r "$ADMIN_PASS_FILE" ]; then
    fail "讀不到密碼檔 $ADMIN_PASS_FILE"
  else
    perm="$(stat -c '%a' "$ADMIN_PASS_FILE" 2>/dev/null || stat -f '%Lp' "$ADMIN_PASS_FILE" 2>/dev/null)"
    case "$perm" in 600|400) ;; *) warn "密碼檔權限為 $perm" "chmod 600 $ADMIN_PASS_FILE" ;; esac
    PASS_VALUE="$(tr -d '\r\n' < "$ADMIN_PASS_FILE")"
    JAR="$TMP/jar"
    BODY="$(json_login "$ADMIN_USER" "$PASS_VALUE")"
    req POST /api/auth/login -c "$JAR" -H 'Content-Type: application/json' -H "Origin: $URL" -d "$BODY"
    unset PASS_VALUE BODY
    if [ "$STATUS" = 200 ]; then
      pass "登入成功"
      sc="$(grep -i '^set-cookie:' "$TMP/headers" | tr -d '\r')"
      echo "$sc" | grep -qi "httponly" && pass "Cookie 有 HttpOnly" || fail "Cookie 缺少 HttpOnly"
      echo "$sc" | grep -qi "samesite=lax" && pass "Cookie 有 SameSite=Lax" || fail "Cookie 缺少 SameSite=Lax"
      if [ "$IS_HTTPS" = 1 ]; then echo "$sc" | grep -qi "secure" && pass "Cookie 有 Secure" || fail "Cookie 缺少 Secure" "確認 nginx 帶 X-Forwarded-Proto"; fi
      MUST="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("mustChangePassword"))' "$TMP/body" 2>/dev/null || echo "?")"
      if [ "$MUST" = "True" ]; then
        warn "此帳號需要先修改密碼（mustChangePassword=true）" "請先手動登入改密碼，再重跑本段"
      else
        pass "帳號不需強制改密碼"
        req GET /api/auth/status -b "$JAR"
        grep -q '"loggedIn":true' "$TMP/body" && pass "Session 有效（/api/auth/status）" || fail "登入後 session 無效"
        req GET /api/folders -b "$JAR"
        [ "$STATUS" = 200 ] && pass "已登入可讀取 /api/folders" || fail "已登入讀 /api/folders 回 $STATUS"
        req GET /api/admin/accounts -b "$JAR"
        [ "$STATUS" = 200 ] && pass "管理員可讀取帳號清單" || warn "/api/admin/accounts 回 $STATUS（非管理員帳號可忽略）"
        req POST /api/databases/switch -b "$JAR" -H 'Content-Type: application/json' -H 'Origin: https://evil.example' -d '{"name":"admin.db"}'
        [ "$STATUS" = 403 ] && pass "已登入狀態下跨站 Origin 的寫入仍被拒" || fail "已登入跨站寫入回 $STATUS（預期 403）"
        req POST /api/auth/logout -b "$JAR" -c "$JAR" -H "Origin: $URL"
        [ "$STATUS" = 200 ] && pass "登出成功" || fail "登出回 $STATUS"
        req GET /api/auth/status -b "$JAR"
        grep -q '"loggedIn":false' "$TMP/body" && pass "登出後 session 失效" || fail "登出後仍是登入狀態"
      fi
    else
      fail "登入失敗（$STATUS）：$(head -c 120 "$TMP/body")"
    fi
  fi
fi

echo
echo "────────────────────────────────────────"
echo "結果：${GREEN}$PASS 通過${NC}／${RED}$FAILN 失敗${NC}／${YEL}$WARN 警告${NC}"
[ "$FAILN" -eq 0 ]
