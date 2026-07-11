#!/bin/bash

# ============================================================================
# 資料夾權限管理系統 - 帳號診斷腳本
# ============================================================================
# 功能：檢查帳號狀態、密碼格式、登入問題
# 使用：sudo ./check_accounts.sh
# ============================================================================

set -e

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 配置變數
APP_DIR="/opt/folder-permission-system"
DB_DIR="$APP_DIR/databases"

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
    DB_FILES=$(find "$DB_DIR" -maxdepth 1 -name "*.db" -type f 2>/dev/null | sort)
    
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
        # 檢查是否包含 accounts 表
        if sqlite3 "$db_file" "SELECT name FROM sqlite_master WHERE type='table' AND name='accounts';" 2>/dev/null | grep -q "accounts"; then
            echo "  ✓ $db_name ($db_size) - 包含 accounts 表"
        else
            echo "    $db_name ($db_size)"
        fi
    done
    
    echo ""
    echo "提示：請確認系統資料庫檔案名稱（通常是 system.db 或 main.db）"
    exit 1
fi

# 顯示使用的資料庫
print_info "使用資料庫：$DB_PATH"

print_header "帳號診斷報告"

# 檢查 SQLite3 是否安裝
if ! command -v sqlite3 &> /dev/null; then
    print_error "sqlite3 未安裝"
    echo ""
    echo "請安裝 sqlite3："
    echo "  Ubuntu/Debian: sudo apt-get install sqlite3"
    echo "  CentOS/RHEL: sudo yum install sqlite3"
    exit 1
fi

# 1. 列出所有帳號
print_info "1. 帳號清單"
echo "─────────────────────────────────────"
sqlite3 "$DB_PATH" << EOF
.mode column
.headers on
SELECT
    id,
    username,
    full_name,
    role,
    COALESCE(role_level, CASE WHEN role='admin' THEN 'admin' ELSE 'user' END) as role_level,
    COALESCE(can_invite, 0) as can_invite,
    status,
    CASE
        WHEN password_hash LIKE '$argon2%' THEN 'argon2'
        WHEN password_hash LIKE '$2a$%' OR password_hash LIKE '$2b$%' OR password_hash LIKE '$2y$%' THEN 'bcrypt'
        ELSE 'unknown'
    END as hash_type,
    permission_level,
    created_at
FROM accounts
ORDER BY id;
EOF

echo ""

# 2. 檢查帳號狀態
print_info "2. 帳號狀態統計"
echo "─────────────────────────────────────"
sqlite3 "$DB_PATH" << EOF
SELECT 
    status,
    COUNT(*) as count
FROM accounts
GROUP BY status;
EOF

echo ""

# 3. 檢查密碼雜湊格式
print_info "3. 密碼雜湊格式分析"
echo "─────────────────────────────────────"
sqlite3 "$DB_PATH" << EOF
SELECT 
    CASE 
        WHEN password_hash LIKE '$argon2%' THEN 'argon2 (正確)'
        WHEN password_hash LIKE '$2a$%' OR password_hash LIKE '$2b$%' OR password_hash LIKE '$2y$%' THEN 'bcrypt (舊格式，需更新)'
        ELSE '未知格式 (可能有問題)'
    END as hash_format,
    COUNT(*) as count
FROM accounts
GROUP BY hash_format;
EOF

echo ""

# 4. 列出可能有問題的帳號
print_info "4. 可能有問題的帳號"
echo "─────────────────────────────────────"
PROBLEM_COUNT=$(sqlite3 "$DB_PATH" << EOF
SELECT COUNT(*) 
FROM accounts 
WHERE status != 'active' 
   OR password_hash NOT LIKE '$argon2%';
EOF
)

if [ "$PROBLEM_COUNT" -eq 0 ]; then
    print_success "所有帳號狀態正常"
else
    sqlite3 "$DB_PATH" << EOF
.mode column
.headers on
SELECT 
    id,
    username,
    full_name,
    status,
    CASE 
        WHEN password_hash LIKE '$argon2%' THEN 'argon2'
        WHEN password_hash LIKE '$2a$%' OR password_hash LIKE '$2b$%' OR password_hash LIKE '$2y$%' THEN 'bcrypt (需更新)'
        ELSE 'unknown (需檢查)'
    END as hash_type
FROM accounts 
WHERE status != 'active' 
   OR password_hash NOT LIKE '$argon2%';
EOF
fi

echo ""

# 5. 檢查管理員帳號
print_info "5. 管理員帳號檢查"
echo "─────────────────────────────────────"
ADMIN_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM accounts WHERE role = 'admin' AND status = 'active';")

if [ "$ADMIN_COUNT" -eq 0 ]; then
    print_warning "沒有可用的管理員帳號"
    echo ""
    echo "建議："
    echo "  1. 使用 reset_password.sh 重置管理員密碼"
    echo "  2. 或手動更新帳號狀態為 'active'"
else
    print_success "找到 $ADMIN_COUNT 個活躍的管理員帳號"
    sqlite3 "$DB_PATH" << EOF
.mode column
.headers on
SELECT 
    id,
    username,
    full_name,
    status,
    CASE 
        WHEN password_hash LIKE '$argon2%' THEN 'argon2'
        ELSE '需更新'
    END as hash_type
FROM accounts 
WHERE role = 'admin';
EOF
fi

echo ""

# 6. 資料庫完整性檢查
print_info "6. 資料庫完整性檢查"
echo "─────────────────────────────────────"
INTEGRITY=$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;" 2>/dev/null)

if [ "$INTEGRITY" = "ok" ]; then
    print_success "資料庫完整性檢查通過"
else
    print_error "資料庫可能有問題：$INTEGRITY"
fi

echo ""

# 總結和建議
print_header "診斷總結與建議"

echo "📋 常見問題解決方案："
echo ""
echo "1. 如果帳號狀態不是 'active'："
echo "   sqlite3 $DB_PATH \"UPDATE accounts SET status = 'active' WHERE username = 'your_username';\""
echo ""
echo "2. 如果密碼雜湊是 bcrypt 格式（舊格式）："
echo "   使用 reset_password.sh 重置密碼"
echo ""
echo "3. 如果忘記管理員密碼："
echo "   sudo ./reset_password.sh admin"
echo ""
echo "4. 手動重置密碼（需要生成 argon2 雜湊）："
echo "   使用 reset_password.sh 腳本，或參考手動修改密碼說明"
echo ""

exit 0

