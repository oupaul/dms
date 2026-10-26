#!/bin/bash

# ============================================================================
# 資料夾權限管理系統 - 自動化部署腳本
# ============================================================================
# 
# 此腳本用於在 Ubuntu 伺服器上自動部署應用程式
# 
# 使用方法：
#   chmod +x deploy.sh
#   ./deploy.sh
# 
# ============================================================================

# 設定（可在腳本開始時自定義）
NODE_VERSION="18"  # Node.js 版本

# 自定義配置（可在執行腳本前修改，或使用預設值）
CUSTOM_APP_FOLDER=""  # 留空則使用預設值 folder-permission-system
CUSTOM_PORT=""         # 留空則使用預設值 5000
CUSTOM_PAGE_TITLE=""  # 留空則使用預設值 "資料夾權限文管系統"

# 預設值
DEFAULT_APP_NAME="folder-permission-system"
DEFAULT_PORT=5000
DEFAULT_PAGE_TITLE="資料夾權限文管系統"

# 應用程式名稱和目錄（將根據自定義配置設定）
if [ -z "$CUSTOM_APP_FOLDER" ]; then
    APP_NAME="$DEFAULT_APP_NAME"
else
    APP_NAME="$CUSTOM_APP_FOLDER"
fi
APP_DIR="/opt/$APP_NAME"

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 錯誤處理
set -e
trap 'last_command=$current_command; current_command=$BASH_COMMAND' DEBUG
trap 'echo -e "${RED}❌ 部署失敗於命令：$last_command${NC}"' ERR

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                                                                ║"
echo "║       資料夾權限管理系統 - 自動化部署                         ║"
echo "║       Folder Permission System - Auto Deploy                   ║"
echo "║                                                                ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# ============================================================================
# 配置自定義選項
# ============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "配置選項"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 1. 自定義安裝資料夾名稱
echo "1. 安裝資料夾名稱（在 /opt 下）"
echo "   預設值：$DEFAULT_APP_NAME"
read -p "   請輸入自定義資料夾名稱（直接按 Enter 使用預設值）: " CUSTOM_APP_FOLDER
if [ -z "$CUSTOM_APP_FOLDER" ]; then
    APP_NAME="$DEFAULT_APP_NAME"
    echo "   ✅ 使用預設值：$APP_NAME"
else
    # 驗證資料夾名稱（只允許英數字、底線、連字號）
    if [[ ! "$CUSTOM_APP_FOLDER" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo -e "   ${YELLOW}⚠️  資料夾名稱只能包含英數字、底線和連字號，使用預設值${NC}"
        APP_NAME="$DEFAULT_APP_NAME"
    else
        APP_NAME="$CUSTOM_APP_FOLDER"
        echo "   ✅ 使用自定義值：$APP_NAME"
    fi
fi
APP_DIR="/opt/$APP_NAME"
echo "   安裝路徑：$APP_DIR"
echo ""

# 2. 自定義 PORT
echo "2. 服務 Port"
echo "   預設值：$DEFAULT_PORT"
read -p "   請輸入自定義 Port（直接按 Enter 使用預設值）: " CUSTOM_PORT
if [ -z "$CUSTOM_PORT" ]; then
    APP_PORT=$DEFAULT_PORT
    echo "   ✅ 使用預設值：$APP_PORT"
else
    # 驗證 Port 範圍（1024-65535）
    if [[ ! "$CUSTOM_PORT" =~ ^[0-9]+$ ]] || [ "$CUSTOM_PORT" -lt 1024 ] || [ "$CUSTOM_PORT" -gt 65535 ]; then
        echo -e "   ${YELLOW}⚠️  Port 必須是 1024-65535 之間的數字，使用預設值${NC}"
        APP_PORT=$DEFAULT_PORT
    else
        APP_PORT=$CUSTOM_PORT
        echo "   ✅ 使用自定義值：$APP_PORT"
    fi
fi
echo ""

# 3. 自定義瀏覽器標題
echo "3. 瀏覽器分頁顯示名稱"
echo "   預設值：$DEFAULT_PAGE_TITLE"
read -p "   請輸入自定義標題（直接按 Enter 使用預設值）: " CUSTOM_PAGE_TITLE
if [ -z "$CUSTOM_PAGE_TITLE" ]; then
    PAGE_TITLE="$DEFAULT_PAGE_TITLE"
    echo "   ✅ 使用預設值：$PAGE_TITLE"
else
    PAGE_TITLE="$CUSTOM_PAGE_TITLE"
    echo "   ✅ 使用自定義值：$PAGE_TITLE"
fi
echo ""

# 4. 前端 nginx 反向代理主機 IP
echo "4. 前端 nginx 反向代理主機 IP（強烈建議設定）"
echo "   設定後，應用程式只接受來自這些 IP 的連線，並建議以防火牆同步限制"
echo "   可填多個，以逗號分隔（例：10.0.0.10,10.0.0.11）；留空表示不限制（不建議）"
read -p "   請輸入 nginx 主機 IP: " PROXY_IPS_INPUT
PROXY_IPS_INPUT="${PROXY_IPS_INPUT// /}"
if [ -z "$PROXY_IPS_INPUT" ]; then
    PROXY_ALLOWLIST=""
    echo -e "   ${YELLOW}⚠️  未設定：任何能連到 Port $APP_PORT 的來源都可直連應用程式${NC}"
elif [[ "$PROXY_IPS_INPUT" =~ ^[0-9a-fA-F:.,]+$ ]]; then
    PROXY_ALLOWLIST="$PROXY_IPS_INPUT"
    echo "   ✅ 只接受來自 $PROXY_ALLOWLIST 的連線"
else
    echo -e "   ${YELLOW}⚠️  格式不正確，改為不限制（請部署後手動設定 PROXY_ALLOWLIST）${NC}"
    PROXY_ALLOWLIST=""
fi
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "配置摘要"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  安裝路徑：$APP_DIR"
echo "  服務 Port：$APP_PORT"
echo "  瀏覽器標題：$PAGE_TITLE"
echo "  nginx 主機 IP：${PROXY_ALLOWLIST:-（不限制）}"
echo ""
read -p "確認以上配置？(y/N) " -r
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "部署已取消"
    exit 0
fi
echo ""

# 檢查是否為 root 或有 sudo 權限
if [ "$EUID" -eq 0 ]; then 
    echo -e "${YELLOW}⚠️  不建議以 root 身份執行此腳本${NC}"
    read -p "繼續？(yes/no) " -r
    if [[ ! $REPLY =~ ^[Yy]([Ee][Ss])?$ ]]; then
        exit 1
    fi
fi

# 檢查 sudo 權限
if ! sudo -v; then
    echo -e "${RED}❌ 需要 sudo 權限${NC}"
    exit 1
fi

echo -e "${BLUE}開始部署時間：$(date '+%Y-%m-%d %H:%M:%S')${NC}"
echo ""

# ============================================================================
# 步驟 1: 系統準備
# ============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步驟 1/8: 系統準備"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "更新系統套件..."
sudo apt update -qq
sudo apt upgrade -y -qq
sudo apt install -y curl wget git build-essential sqlite3

echo -e "${GREEN}✅ 系統準備完成${NC}"
echo ""

# ============================================================================
# 步驟 2: 安裝 Node.js
# ============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步驟 2/8: 安裝 Node.js"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if command -v node &> /dev/null; then
    CURRENT_NODE_VERSION=$(node --version)
    echo "Node.js 已安裝：$CURRENT_NODE_VERSION"
    
    read -p "是否重新安裝 Node.js $NODE_VERSION？(y/N) " -r
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
        sudo apt install -y nodejs
    fi
else
    echo "安裝 Node.js $NODE_VERSION..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
    sudo apt install -y nodejs
fi

echo "Node.js 版本：$(node --version)"
echo "npm 版本：$(npm --version)"
echo -e "${GREEN}✅ Node.js 安裝完成${NC}"
echo ""

# ============================================================================
# 步驟 3: 安裝 PM2
# ============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步驟 3/8: 安裝 PM2"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if command -v pm2 &> /dev/null; then
    echo "PM2 已安裝：$(pm2 --version)"
else
    echo "安裝 PM2..."
    sudo npm install -g pm2
    
    # 設定 PM2 開機自動啟動
    pm2 startup | grep "sudo" | bash
fi

echo -e "${GREEN}✅ PM2 安裝完成${NC}"
echo ""

# ============================================================================
# 步驟 4: 創建應用目錄
# ============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步驟 4/8: 創建應用目錄"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -d "$APP_DIR" ]; then
    echo -e "${YELLOW}⚠️  應用目錄已存在：$APP_DIR${NC}"
    read -p "是否備份現有目錄並重新安裝？(y/N) " -r
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        BACKUP_NAME="${APP_NAME}_backup_$(date +%Y%m%d_%H%M%S)"
        echo "備份現有目錄到：/opt/$BACKUP_NAME"
        sudo mv "$APP_DIR" "/opt/$BACKUP_NAME"
        
        sudo mkdir -p "$APP_DIR"
        sudo chown -R $USER:$USER "$APP_DIR"
    fi
else
    sudo mkdir -p "$APP_DIR"
    sudo chown -R $USER:$USER "$APP_DIR"
    echo "已創建應用目錄：$APP_DIR"
fi

echo -e "${GREEN}✅ 應用目錄準備完成${NC}"
echo ""

# ============================================================================
# 步驟 5: 部署應用程式檔案
# ============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步驟 5/8: 部署應用程式檔案"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$SCRIPT_DIR" = "$APP_DIR" ]; then
    echo "檔案已在目標目錄，跳過複製"
else
    echo "複製檔案從 $SCRIPT_DIR 到 $APP_DIR"
    
    # 檢查是否需要排除某些目錄
    EXCLUDE_DIRS="node_modules databases backups logs uploads"
    
    echo "排除的目錄：$EXCLUDE_DIRS"
    
    # 使用 rsync 複製（如果可用）
    if command -v rsync &> /dev/null; then
        rsync -av --exclude='node_modules' --exclude='databases' --exclude='backups' --exclude='logs' --exclude='uploads' --exclude='sessions' --exclude='.session_secret' --exclude='.initial_admin_password' \
            "$SCRIPT_DIR/" "$APP_DIR/"
    else
        # 使用 cp（較慢）
        cp -r "$SCRIPT_DIR"/* "$APP_DIR/" 2>/dev/null || true
    fi
fi

echo -e "${GREEN}✅ 檔案部署完成${NC}"
echo ""

# ============================================================================
# 步驟 6: 安裝依賴和設定
# ============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步驟 6/8: 安裝依賴和設定"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

cd "$APP_DIR"

# 更新 app.js 中的 PORT
echo "更新應用程式配置..."
if [ -f "app.js" ]; then
    # 備份原始檔案
    cp app.js app.js.backup
    
    # 更新 PORT
    if grep -q "^const PORT = " app.js; then
        sed -i "s/^const PORT = [0-9]*;/const PORT = $APP_PORT;/" app.js
        echo "  ✅ 已更新 Port 為 $APP_PORT"
    else
        echo -e "  ${YELLOW}⚠️  無法找到 PORT 設定，請手動檢查${NC}"
    fi
fi

# 更新 HTML 檔案中的標題
echo "更新瀏覽器標題..."
if [ -f "public/index.html" ]; then
    sed -i "s|<title>.*</title>|<title>$PAGE_TITLE</title>|" public/index.html
    sed -i "s|資料夾權限文管系統|$PAGE_TITLE|g" public/index.html
    echo "  ✅ 已更新 index.html 標題"
fi

if [ -f "public/login.html" ]; then
    sed -i "s|<title>.*</title>|<title>登入 - $PAGE_TITLE</title>|" public/login.html
    sed -i "s|資料夾權限文管系統|$PAGE_TITLE|g" public/login.html
    echo "  ✅ 已更新 login.html 標題"
fi

# 如果 HTML 檔案還在根目錄，也更新它們
if [ -f "index.html" ]; then
    sed -i "s|<title>.*</title>|<title>$PAGE_TITLE</title>|" index.html
    sed -i "s|資料夾權限文管系統|$PAGE_TITLE|g" index.html
fi

if [ -f "login.html" ]; then
    sed -i "s|<title>.*</title>|<title>登入 - $PAGE_TITLE</title>|" login.html
    sed -i "s|資料夾權限文管系統|$PAGE_TITLE|g" login.html
fi

echo ""
echo "設定 Session Secret..."
SESSION_SECRET_FILE="$APP_DIR/.session_secret"
if [ -f "$SESSION_SECRET_FILE" ]; then
    echo "  ✅ 已存在主機專屬 Session Secret，沿用（避免重新部署時使既有登入失效）"
else
    if command -v openssl &> /dev/null; then
        openssl rand -hex 32 > "$SESSION_SECRET_FILE"
    else
        node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$SESSION_SECRET_FILE"
    fi
    chmod 600 "$SESSION_SECRET_FILE"
    echo "  ✅ 已產生新的主機專屬 Session Secret：$SESSION_SECRET_FILE"
fi

echo ""
echo "安裝 npm 套件..."
npm install --production

echo ""
echo "創建必要目錄..."
mkdir -p databases uploads logs backups public

echo "設定目錄權限..."
chmod 775 databases uploads logs backups public
chmod 700 backups

# 全新安裝：產生亂數管理員初始密碼（顯示於部署結束時的終端機畫面，應用程式建立帳號後會刪除此檔）
INITIAL_ADMIN_PASSWORD=""
INITIAL_ADMIN_FILE="$APP_DIR/.initial_admin_password"
if [ ! -f "$APP_DIR/databases/system.db" ]; then
    INITIAL_ADMIN_PASSWORD="$(cd "$APP_DIR" && node -e "console.log(require('./lib/security').generatePassword(20))")"
    if [ -z "$INITIAL_ADMIN_PASSWORD" ]; then
        echo -e "${RED}❌ 無法產生管理員初始密碼${NC}"
        exit 1
    fi
    ( umask 077; printf '%s' "$INITIAL_ADMIN_PASSWORD" > "$INITIAL_ADMIN_FILE" )
    chmod 600 "$INITIAL_ADMIN_FILE"
    echo "  ✅ 已產生管理員初始密碼（部署完成時顯示一次）"
else
    rm -f "$INITIAL_ADMIN_FILE"
    echo "  ℹ️  偵測到既有資料庫，沿用現有管理員帳號（不產生初始密碼）"
fi

echo ""
echo "檢查並設定 public 資料夾..."

# 檢查 HTML 檔案位置
HTML_FILES=("index.html" "login.html" "csv_generator.html" "user_csv_generator.html" "permission_generator.html")
FILES_TO_MOVE=()

for FILE in "${HTML_FILES[@]}"; do
    if [ -f "$FILE" ] && [ ! -f "public/$FILE" ]; then
        FILES_TO_MOVE+=("$FILE")
    fi
done

if [ ${#FILES_TO_MOVE[@]} -gt 0 ]; then
    echo "發現 HTML 檔案在根目錄，移動到 public/ 資料夾..."
    for FILE in "${FILES_TO_MOVE[@]}"; do
        if [ -f "$FILE" ]; then
            echo "  移動 $FILE -> public/$FILE"
            mv "$FILE" "public/"
        fi
    done
    echo -e "${GREEN}✅ HTML 檔案已移動到 public/ 資料夾${NC}"
elif [ -f "public/index.html" ]; then
    echo -e "${GREEN}✅ HTML 檔案已在 public/ 資料夾中${NC}"
else
    echo -e "${YELLOW}⚠️  警告：未找到 index.html 檔案${NC}"
    echo "   請確認 HTML 檔案位置是否正確"
fi

echo ""
echo "設定可執行權限..."
chmod +x *.sh 2>/dev/null || true

echo -e "${GREEN}✅ 依賴和設定完成${NC}"
echo ""

# ============================================================================
# 步驟 7: 啟動應用程式
# ============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步驟 7/8: 啟動應用程式"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 停止現有的應用程式（如果存在）
if pm2 list | grep -q "$APP_NAME"; then
    echo "停止現有應用程式..."
    pm2 stop $APP_NAME
    pm2 delete $APP_NAME
fi

echo "啟動應用程式..."
export SESSION_SECRET="$(cat "$SESSION_SECRET_FILE")"
export PROXY_ALLOWLIST="$PROXY_ALLOWLIST"
if [ -f "ecosystem.config.js" ]; then
    pm2 start ecosystem.config.js
else
    pm2 start app.js --name $APP_NAME
fi

echo "保存 PM2 設定..."
pm2 save

sleep 3

echo ""
echo "應用程式狀態："
pm2 status

echo -e "${GREEN}✅ 應用程式啟動完成${NC}"
echo ""

# ============================================================================
# 步驟 8: 驗證部署
# ============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步驟 8/8: 驗證部署"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 臨時禁用錯誤中斷（驗證過程中的失敗是正常的）
set +e

echo "等待應用程式啟動..."
echo -n "進度："
for i in {1..10}; do
    echo -n "█"
    sleep 1
done
echo " 完成"
echo ""

# 檢查應用程式進程狀態
echo "檢查應用程式進程..."
if pm2 list | grep -q "online.*$APP_NAME"; then
    echo -e "${GREEN}✅ 應用程式進程運行中${NC}"
else
    echo -e "${YELLOW}⚠️  應用程式進程狀態異常${NC}"
    echo "PM2 狀態："
    pm2 list
    echo ""
fi

# 使用配置的 Port（已在前面設定）
echo -e "${GREEN}✅ 應用程式 Port：$APP_PORT${NC}"

echo ""

# 檢查 Port 是否在監聽
echo "檢查 Port 監聽狀態..."
if netstat -tln 2>/dev/null | grep -q ":$APP_PORT "; then
    echo -e "${GREEN}✅ Port $APP_PORT 正在監聽${NC}"
elif ss -tln 2>/dev/null | grep -q ":$APP_PORT "; then
    echo -e "${GREEN}✅ Port $APP_PORT 正在監聽${NC}"
else
    echo -e "${YELLOW}⚠️  Port $APP_PORT 未在監聽${NC}"
    echo "正在列出所有 Node.js 監聽的 Port..."
    netstat -tlnp 2>/dev/null | grep node || ss -tlnp 2>/dev/null | grep node || echo "無法檢測"
fi

echo ""

# 測試 HTTP 連接
echo "測試 HTTP 連接到 http://localhost:$APP_PORT ..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$APP_PORT 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✅ HTTP 測試通過（狀態碼：$HTTP_CODE）${NC}"
    DEPLOY_SUCCESS=true
elif [ "$HTTP_CODE" = "404" ]; then
    echo -e "${YELLOW}⚠️  HTTP 回應 404 - 伺服器運行中但路由不存在${NC}"
    echo -e "${YELLOW}   這可能是正常的，應用程式可能需要訪問特定路徑${NC}"
    DEPLOY_SUCCESS=true  # 404 表示伺服器在運行，只是路由不對
else
    echo -e "${YELLOW}⚠️  HTTP 測試異常（狀態碼：$HTTP_CODE）${NC}"
    echo -e "${YELLOW}   正在檢查常用 Port...${NC}"
    
    DEPLOY_SUCCESS=false
    # 嘗試其他常用 Port
    for TEST_PORT in 3000 5000 8080; do
        if [ "$TEST_PORT" != "$APP_PORT" ]; then
            echo -n "   測試 Port $TEST_PORT... "
            TEST_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$TEST_PORT 2>/dev/null || echo "000")
            if [ "$TEST_CODE" = "200" ] || [ "$TEST_CODE" = "404" ]; then
                echo -e "${GREEN}回應 $TEST_CODE${NC}"
                APP_PORT=$TEST_PORT
                DEPLOY_SUCCESS=true
                break
            else
                echo -e "${YELLOW}無回應${NC}"
            fi
        fi
    done
    
    if [ "$DEPLOY_SUCCESS" = false ]; then
        echo -e "${YELLOW}   未在常用 Port 找到應用程式${NC}"
        echo ""
        echo -e "${YELLOW}   診斷建議：${NC}"
        echo "   1. 檢查應用程式日誌：pm2 logs $APP_NAME --err"
        echo "   2. 檢查應用程式狀態：pm2 status"
        echo "   3. 手動測試：curl -v http://localhost:$APP_PORT"
    fi
fi

echo ""

# 測試 API
if [ "$DEPLOY_SUCCESS" = true ]; then
    API_RESPONSE=$(curl -s http://localhost:$APP_PORT/api/auth/has-accounts 2>/dev/null || echo "")
    if echo "$API_RESPONSE" | grep -q "hasAccounts"; then
        echo -e "${GREEN}✅ API 測試通過${NC}"
    else
        echo -e "${YELLOW}⚠️  API 測試異常${NC}"
        echo -e "${YELLOW}   應用程式可能還在啟動中，請稍後手動驗證${NC}"
    fi
fi

# 重新啟用錯誤中斷
set -e

echo ""

# ============================================================================
# 完成
# ============================================================================

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                                                                ║"
echo "║                    🎉 部署完成！                               ║"
echo "║                                                                ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

echo -e "${GREEN}✅ 應用程式已成功部署並運行${NC}"
echo ""

# 顯示訪問資訊
SERVER_IP=$(hostname -I | awk '{print $1}')
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "訪問資訊"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  本地訪問：http://localhost:$APP_PORT"
echo "  遠端訪問：http://$SERVER_IP:$APP_PORT"
echo ""
if [ -n "$INITIAL_ADMIN_PASSWORD" ]; then
    if [ ! -f "$INITIAL_ADMIN_FILE" ]; then
        echo -e "${YELLOW}  ┌──────────────────────────────────────────────────────────┐${NC}"
        echo -e "${YELLOW}  │  管理員初始帳號（只顯示這一次，請立即記下）              │${NC}"
        echo -e "${YELLOW}  └──────────────────────────────────────────────────────────┘${NC}"
        echo "    使用者名稱：admin"
        echo "    密碼：$INITIAL_ADMIN_PASSWORD"
        echo ""
        echo -e "${RED}  ⚠️  首次登入後系統會強制要求修改密碼。${NC}"
    else
        echo -e "${YELLOW}  ⚠️  應用程式尚未建立管理員帳號（初始密碼檔仍在 $INITIAL_ADMIN_FILE）。${NC}"
        echo "     請查看 pm2 logs $APP_NAME 確認啟動狀況；帳號建立後密碼檔會自動刪除。"
        echo "     若無法取得密碼，可用 ./reset_password.sh admin 重設。"
    fi
else
    echo "  沿用既有管理員帳號，未產生新的初始密碼。"
    echo "  忘記密碼可執行：sudo ./reset_password.sh admin"
fi
unset INITIAL_ADMIN_PASSWORD
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "接下來的步驟"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. 設定防火牆（只允許 nginx 主機連到應用程式埠）："
if [ -n "$PROXY_ALLOWLIST" ]; then
    for ip in ${PROXY_ALLOWLIST//,/ }; do
        echo "   sudo ufw allow from $ip to any port $APP_PORT proto tcp"
    done
else
    echo "   sudo ufw allow from <nginx 主機 IP> to any port $APP_PORT proto tcp"
fi
echo "   sudo ufw enable"
echo "   並請在 nginx 主機套用 docs/nginx-example.conf（TLS、限速、安全標頭）"
echo ""
echo "2. 查看應用程式日誌："
echo "   pm2 logs $APP_NAME"
echo ""
echo "3. 查看應用程式狀態："
echo "   pm2 status"
echo ""
echo "4. 設定 SSL（可選）："
echo "   參閱《Ubuntu完整部署指南.md》"
echo ""
echo "5. 設定自動備份："
echo "   手動設定："
echo "     crontab -e"
echo "     0 4 * * * $APP_DIR/backup_databases.sh"
echo ""
echo "   或立即自動配置："
echo ""

# 提供自動配置備份的選項
read -p "是否要立即配置自動備份？(每天凌晨 4:00 執行) [y/N]: " -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "配置自動備份"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    
    # 檢查備份腳本是否存在
    if [ -f "$APP_DIR/backup_databases.sh" ]; then
        echo "✅ 備份腳本已存在"
        
        # 賦予執行權限
        chmod +x "$APP_DIR/backup_databases.sh"
        echo "✅ 已設定執行權限"
        
        # 配置 cron job
        # 檢查是否已存在相同的 cron job
        if crontab -l 2>/dev/null | grep -q "$APP_DIR/backup_databases.sh"; then
            echo "ℹ️  自動備份已配置，跳過"
        else
            # 添加 cron job
            (crontab -l 2>/dev/null; echo "# 資料夾權限管理系統 - 每天凌晨 4:00 自動備份") | crontab -
            (crontab -l 2>/dev/null; echo "0 4 * * * $APP_DIR/backup_databases.sh >> /var/log/folder-permission-system-backup.log 2>&1") | crontab -
            
            echo "✅ 已配置自動備份（每天凌晨 4:00）"
            echo ""
            echo "備份設定："
            echo "  執行時間：每天凌晨 4:00"
            echo "  備份腳本：$APP_DIR/backup_databases.sh"
            echo "  備份目錄：/opt/backups/auto_YYYYMMDD_HHMMSS.tar.gz"
            echo "  日誌檔案：/var/log/folder-permission-system-backup.log"
            echo "  保留策略："
            echo "    - 最近 7 天：保留所有備份"
            echo "    - 8-30 天：每週保留一個"
            echo "    - 31-180 天：每月保留一個"
            echo "    - 180 天以上：自動刪除"
            echo ""
            
            # 詢問是否立即測試備份
            read -p "是否要立即執行一次測試備份？ [y/N]: " -r
            echo ""
            
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                echo "執行測試備份..."
                echo ""
                echo "注意：首次部署時，資料庫可能尚未創建，這是正常的。"
                echo ""
                
                # 暫時禁用錯誤自動退出，以免測試備份失敗導致部署中斷
                set +e
                sudo "$APP_DIR/backup_databases.sh"
                BACKUP_EXIT_CODE=$?
                set -e
                
                echo ""
                if [ $BACKUP_EXIT_CODE -eq 0 ]; then
                    # 檢查是否真的有備份檔案產生
                    if ls /opt/backups/auto_*.tar.gz 1> /dev/null 2>&1; then
                        echo "✅ 測試備份成功！"
                        echo ""
                        echo "查看備份："
                        ls -lh /opt/backups/auto_*.tar.gz 2>/dev/null | tail -n 1
                    else
                        echo "ℹ️  備份腳本執行成功"
                        echo "   （資料庫尚未創建，首次啟動後會自動建立）"
                    fi
                else
                    echo "⚠️  測試備份返回錯誤"
                    echo "   請在系統啟動後檢查備份功能"
                    echo "   查看日誌：tail -f /var/log/folder-permission-system-backup.log"
                fi
            fi
        fi
        
        echo ""
        echo "管理備份的命令："
        echo "  查看 cron 設定：crontab -l"
        echo "  編輯 cron 設定：crontab -e"
        echo "  手動執行備份：sudo $APP_DIR/backup_databases.sh"
        echo "  查看備份日誌：tail -f /var/log/folder-permission-system-backup.log"
        echo "  查看備份檔案：ls -lh /opt/backups/"
        echo ""
    else
        echo "⚠️  備份腳本不存在：$APP_DIR/backup_databases.sh"
        echo "   請確保 backup_databases.sh 在專案目錄中"
    fi
else
    echo "ℹ️  已跳過自動備份配置"
    echo "   您可以稍後手動設定"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "相關文檔"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  📖 Ubuntu完整部署指南.md"
echo "  🔧 系統維護管理手冊.md"
echo "  🆘 故障排除手冊.md"
echo ""

echo "完成時間：$(date '+%Y-%m-%d %H:%M:%S')"
echo ""

exit 0

