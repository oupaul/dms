#!/bin/bash

# ============================================================================
# 資料夾權限管理系統 - 密碼重置腳本
# ============================================================================
# 功能：重置指定帳號的密碼（使用 argon2 加密）
# 使用：sudo ./reset_password.sh [username] [new_password]
# 範例：sudo ./reset_password.sh admin newpassword123
# ============================================================================

set -e

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 配置變數 - 自動偵測應用程式目錄
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 嘗試多種方式找到應用程式目錄
if [ -d "$SCRIPT_DIR/databases" ]; then
    # 腳本所在目錄有 databases 子目錄
    APP_DIR="$SCRIPT_DIR"
elif [ -d "$(dirname "$SCRIPT_DIR")/databases" ]; then
    # 腳本所在目錄的父目錄有 databases 子目錄
    APP_DIR="$(dirname "$SCRIPT_DIR")"
elif [ -d "/opt/folder-permission-system/databases" ]; then
    # 使用預設路徑（向下相容）
    APP_DIR="/opt/folder-permission-system"
else
    # 嘗試在常見位置尋找
    for possible_dir in /opt/*/databases /root/*/databases ~/*/databases; do
        if [ -d "$possible_dir" ]; then
            APP_DIR="$(dirname "$possible_dir")"
            break
        fi
    done
    # 如果還是找不到，使用腳本所在目錄
    if [ -z "$APP_DIR" ]; then
        APP_DIR="$SCRIPT_DIR"
    fi
fi

DB_DIR="$APP_DIR/databases"
NODE_SCRIPT="/tmp/generate_hash_$$.js"

# 自動檢測系統資料庫（優先使用 system.db，否則使用第一個找到的 .db 檔案）
DB_PATH=""
if [ ! -d "$DB_DIR" ]; then
    # 目錄不存在，使用預設值
    DB_PATH="$DB_DIR/system.db"
else
    # 優先使用 system.db
    if [ -f "$DB_DIR/system.db" ]; then
        DB_PATH="$DB_DIR/system.db"
    # 其次使用 main.db
    elif [ -f "$DB_DIR/main.db" ]; then
        DB_PATH="$DB_DIR/main.db"
    else
        # 嘗試找到第一個資料庫檔案（排除 user_ 開頭的用戶資料庫）
        FIRST_DB=$(find "$DB_DIR" -maxdepth 1 -name "*.db" -type f ! -name "user_*.db" | head -1)
        if [ -n "$FIRST_DB" ]; then
            DB_PATH="$FIRST_DB"
        else
            # 如果還是找不到，使用 system.db 作為預設值
            DB_PATH="$DB_DIR/system.db"
        fi
    fi
fi

print_header() {
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}$1${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# 清理函數
cleanup() {
    if [ -f "$NODE_SCRIPT" ]; then
        rm -f "$NODE_SCRIPT"
    fi
}
trap cleanup EXIT INT TERM

# 檢查權限
if [ "$EUID" -ne 0 ]; then 
    print_error "請使用 sudo 執行此腳本"
    echo ""
    echo "正確用法："
    echo "  sudo ./reset_password.sh [username] [new_password]"
    exit 1
fi

# 檢查資料庫目錄
if [ ! -d "$DB_DIR" ]; then
    print_error "資料庫目錄不存在：$DB_DIR"
    echo ""
    echo "請確認："
    echo "  1. 應用程式已正確安裝"
    echo "  2. 資料庫目錄路徑正確"
    exit 1
fi

# 檢查資料庫檔案
if [ ! -f "$DB_PATH" ]; then
    print_error "系統資料庫不存在：$DB_PATH"
    echo ""
    echo "正在搜尋可用的資料庫檔案..."
    
    # 列出所有資料庫檔案
    DB_FILES=$(find "$DB_DIR" -maxdepth 1 -name "*.db" -type f 2>/dev/null)
    
    if [ -z "$DB_FILES" ]; then
        print_error "資料庫目錄中沒有任何 .db 檔案"
        echo ""
        echo "目錄內容："
        ls -la "$DB_DIR" 2>/dev/null || echo "  無法讀取目錄"
        exit 1
    fi
    
    echo "找到以下資料庫檔案："
    echo "$DB_FILES" | while read -r db_file; do
        db_name=$(basename "$db_file")
        db_size=$(du -sh "$db_file" 2>/dev/null | cut -f1)
        echo "  - $db_name ($db_size)"
    done
    
    echo ""
    echo "請選擇要使用的資料庫檔案（輸入完整路徑）："
    read -r SELECTED_DB
    
    if [ -f "$SELECTED_DB" ]; then
        DB_PATH="$SELECTED_DB"
        print_info "已選擇資料庫：$DB_PATH"
    else
        print_error "指定的檔案不存在：$SELECTED_DB"
        exit 1
    fi
else
    # 顯示使用的資料庫
    print_info "使用資料庫：$DB_PATH"
fi

# 檢查 Node.js
if ! command -v node &> /dev/null; then
    print_error "Node.js 未安裝"
    exit 1
fi

# 檢查 SQLite3
if ! command -v sqlite3 &> /dev/null; then
    print_error "sqlite3 未安裝"
    exit 1
fi

print_header "密碼重置工具"

# 獲取參數（過濾掉路徑參數）
USERNAME=""
NEW_PASSWORD_PARAM=""

# 處理參數：如果第一個參數看起來像路徑，則跳過它
for arg in "$@"; do
    # 如果參數是路徑（包含 / 或以 .db 結尾），跳過
    if [[ "$arg" == *"/"* ]] || [[ "$arg" == *.db ]] || [[ "$arg" == *"databases"* ]]; then
        continue
    fi
    
    # 第一個非路徑參數是用戶名
    if [ -z "$USERNAME" ]; then
        USERNAME="$arg"
    # 第二個非路徑參數是密碼
    elif [ -z "$NEW_PASSWORD_PARAM" ]; then
        NEW_PASSWORD_PARAM="$arg"
    fi
done

# 如果沒有提供用戶名，提示輸入
if [ -z "$USERNAME" ]; then
    echo "請輸入要重置密碼的使用者名稱："
    read -r USERNAME
fi

if [ -z "$USERNAME" ]; then
    print_error "使用者名稱不能為空"
    exit 1
fi

# 檢查帳號是否存在
ACCOUNT_EXISTS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM accounts WHERE username = '$USERNAME';")

if [ "$ACCOUNT_EXISTS" -eq 0 ]; then
    print_error "帳號不存在：$USERNAME"
    echo ""
    echo "可用帳號列表："
    sqlite3 "$DB_PATH" "SELECT username, full_name, role, status FROM accounts;"
    exit 1
fi

# 獲取新密碼
if [ -z "$NEW_PASSWORD_PARAM" ]; then
    echo "請輸入新密碼（至少 6 個字元）："
    read -rs NEW_PASSWORD
    echo ""
    echo "請再次確認新密碼："
    read -rs CONFIRM_PASSWORD
    echo ""
    
    if [ "$NEW_PASSWORD" != "$CONFIRM_PASSWORD" ]; then
        print_error "兩次輸入的密碼不一致"
        exit 1
    fi
    
    if [ ${#NEW_PASSWORD} -lt 6 ]; then
        print_error "密碼長度至少需要 6 個字元"
        exit 1
    fi
else
    NEW_PASSWORD="$NEW_PASSWORD_PARAM"
    if [ ${#NEW_PASSWORD} -lt 6 ]; then
        print_error "密碼長度至少需要 6 個字元"
        exit 1
    fi
fi

# 顯示帳號資訊
print_info "帳號資訊："
sqlite3 "$DB_PATH" << EOF
.mode column
.headers on
SELECT 
    id,
    username,
    full_name,
    role,
    status
FROM accounts 
WHERE username = '$USERNAME';
EOF

echo ""

# 確認操作
echo -e "${YELLOW}⚠️  即將重置帳號 '$USERNAME' 的密碼${NC}"
read -p "確認繼續？[y/N]: " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    print_info "操作已取消"
    exit 0
fi

# 生成 Node.js 腳本來產生 argon2 雜湊
cat > "$NODE_SCRIPT" << 'NODE_EOF'
const argon2 = require('argon2');

async function generateHash() {
    const password = process.argv[2];
    try {
        const hash = await argon2.hash(password);
        console.log(hash);
        process.exit(0);
    } catch (error) {
        console.error('Error generating hash:', error.message);
        process.exit(1);
    }
}

generateHash();
NODE_EOF

# 檢查應用目錄是否有 node_modules
if [ ! -d "$APP_DIR/node_modules" ]; then
    print_warning "應用目錄中沒有 node_modules，嘗試安裝..."
    cd "$APP_DIR" || exit 1
    if [ -f "$APP_DIR/package.json" ]; then
        print_info "正在安裝依賴套件..."
        npm install --production 2>/dev/null || {
            print_error "無法安裝依賴套件"
            exit 1
        }
    else
        print_error "找不到 package.json"
        exit 1
    fi
fi

# 檢查 argon2 模組是否存在
if [ ! -d "$APP_DIR/node_modules/argon2" ]; then
    print_error "找不到 argon2 模組"
    echo ""
    echo "請在應用程式目錄執行："
    echo "  cd $APP_DIR"
    echo "  npm install argon2"
    exit 1
fi

# 生成密碼雜湊（在應用程式目錄執行，確保能找到模組）
print_info "生成密碼雜湊..."
cd "$APP_DIR" || exit 1

# 將 Node.js 腳本移動到應用程式目錄執行
APP_NODE_SCRIPT="$APP_DIR/generate_hash_$$.js"
cp "$NODE_SCRIPT" "$APP_NODE_SCRIPT"

# 執行腳本生成雜湊
PASSWORD_HASH=$(node "$APP_NODE_SCRIPT" "$NEW_PASSWORD" 2>&1)
EXIT_CODE=$?

# 清理臨時腳本
rm -f "$APP_NODE_SCRIPT"

# 檢查是否成功
if [ $EXIT_CODE -ne 0 ] || [ -z "$PASSWORD_HASH" ] || [[ ! "$PASSWORD_HASH" =~ ^\$argon2 ]]; then
    print_error "密碼雜湊生成失敗"
    echo "錯誤訊息：$PASSWORD_HASH"
    exit 1
fi

if [ -z "$PASSWORD_HASH" ] || [ ! "$PASSWORD_HASH" =~ ^\$argon2 ]; then
    print_error "密碼雜湊生成失敗"
    exit 1
fi

# 更新資料庫
print_info "更新資料庫..."
sqlite3 "$DB_PATH" << EOF
UPDATE accounts 
SET password_hash = '$PASSWORD_HASH' 
WHERE username = '$USERNAME';
EOF

# 驗證更新
UPDATED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM accounts WHERE username = '$USERNAME' AND password_hash = '$PASSWORD_HASH';")

if [ "$UPDATED" -eq 1 ]; then
    print_success "密碼重置成功！"
    echo ""
    echo "帳號：$USERNAME"
    echo "新密碼：${NEW_PASSWORD:0:3}***（已隱藏）"
    echo ""
    echo "📋 後續步驟："
    echo "  1. 使用新密碼登入系統"
    echo "  2. 建議登入後立即修改密碼"
    echo ""
else
    print_error "密碼更新失敗"
    exit 1
fi

# 清理
cleanup

exit 0

