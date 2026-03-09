#!/bin/bash

# ============================================================================
# 資料夾權限管理系統 - 資料還原腳本
# ============================================================================
# 功能：從 uninstall.sh 的備份中還原資料
# 用途：快速還原資料庫和設定檔案
# 使用：sudo ./restore.sh
# ============================================================================

set -e  # 遇到錯誤立即停止

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 配置變數（自動偵測）
BACKUP_BASE_DIR="/opt/backups"

# 自動偵測應用程式目錄和名稱
# 嘗試自動偵測應用目錄（優先搜尋 /opt 下的目錄）
POSSIBLE_DIRS=(
    "/opt/folder-permission-system"
    "/opt/folder-dev"
    "/home/$SUDO_USER/folder-permission-system"
    "$HOME/folder-permission-system"
)

APP_DIR=""
CURRENT_DIR="$(pwd)"

# 先搜尋 /opt 下的目錄（最常見的安裝位置）
for dir in /opt/*; do
    if [ -d "$dir" ] && [ -f "$dir/app.js" ]; then
        # 排除當前目錄（如果當前目錄不是應用目錄）
        if [ "$dir" != "$CURRENT_DIR" ] || [ -f "$dir/package.json" ]; then
            APP_DIR="$dir"
            break
        fi
    fi
done

# 如果沒找到，嘗試其他可能的位置
if [ -z "$APP_DIR" ]; then
    for dir in "${POSSIBLE_DIRS[@]}"; do
        if [ -d "$dir" ] && [ -f "$dir/app.js" ]; then
            APP_DIR="$dir"
            break
        fi
    done
fi

# 如果還是找不到，搜尋所有 /opt 下的目錄
if [ -z "$APP_DIR" ]; then
    if [ -d "/opt" ]; then
        FOUND_DIR=$(find /opt -maxdepth 2 -type d -exec test -f {}/app.js \; -print 2>/dev/null | head -1)
        if [ -n "$FOUND_DIR" ]; then
            APP_DIR="$FOUND_DIR"
        fi
    fi
fi

# 如果無法自動偵測，使用預設路徑
if [ -z "$APP_DIR" ]; then
    APP_DIR="/opt/folder-permission-system"
fi

# 從目錄名稱推斷應用程式名稱
APP_NAME=$(basename "$APP_DIR")

# 從目錄名稱推斷 systemd service 名稱
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"

# ============================================================================
# 工具函數
# ============================================================================

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

confirm_action() {
    local prompt="$1"
    local default="${2:-n}"
    
    if [ "$default" = "y" ]; then
        prompt="$prompt [Y/n]: "
    else
        prompt="$prompt [y/N]: "
    fi
    
    while true; do
        read -p "$prompt" response
        response=${response:-$default}
        case "$response" in
            [Yy]|[Yy][Ee][Ss])
                return 0
                ;;
            [Nn]|[Nn][Oo])
                return 1
                ;;
            *)
                echo "請輸入 y 或 n"
                ;;
        esac
    done
}

# ============================================================================
# 清理函數（用於退出時清理臨時檔案）
# ============================================================================

cleanup_temp_files() {
    if [ -n "$TEMP_EXTRACT_DIR" ] && [ -d "$TEMP_EXTRACT_DIR" ]; then
        rm -rf "$TEMP_EXTRACT_DIR" 2>/dev/null || true
    fi
}

# 註冊退出時清理
trap cleanup_temp_files EXIT INT TERM

# ============================================================================
# 主程式開始
# ============================================================================

clear

cat << "EOF"
╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║     資料夾權限管理系統 - 資料還原腳本                           ║
║                                                                  ║
║     從備份中還原資料庫和設定檔案                                ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
EOF

echo ""

# ============================================================================
# 步驟 1: 權限檢查
# ============================================================================

print_header "步驟 1/8: 檢查執行權限"

if [ "$EUID" -ne 0 ]; then 
    print_error "請使用 sudo 執行此腳本"
    echo ""
    echo "正確用法："
    echo "  sudo ./restore.sh"
    exit 1
fi

print_success "權限檢查通過"

# ============================================================================
# 步驟 2: 檢查應用目錄
# ============================================================================

print_header "步驟 2/8: 檢查應用程式安裝狀態"

# 如果預設路徑不存在，嘗試搜尋其他位置
if [ ! -d "$APP_DIR" ] || [ ! -f "$APP_DIR/app.js" ]; then
    print_warning "預設應用目錄不存在或無效：$APP_DIR"
    echo ""
    echo "正在搜尋其他可能的位置..."
    
    # 搜尋常見位置
    SEARCH_DIRS=(
        "/opt"
        "/home/$SUDO_USER"
        "$HOME"
    )
    
    FOUND_DIR=""
    for search_dir in "${SEARCH_DIRS[@]}"; do
        if [ -d "$search_dir" ]; then
            FOUND_DIR=$(find "$search_dir" -maxdepth 2 -type d -name "*folder*permission*" -exec test -f {}/app.js \; -print 2>/dev/null | head -1)
            if [ -n "$FOUND_DIR" ]; then
                APP_DIR="$FOUND_DIR"
                # 更新應用程式名稱
                APP_NAME=$(basename "$APP_DIR")
                # 嘗試從 ecosystem.config.js 獲取
                if [ -f "$APP_DIR/ecosystem.config.js" ]; then
                    DETECTED_NAME=$(grep -E "name\s*:" "$APP_DIR/ecosystem.config.js" | head -1 | sed "s/.*name.*:.*['\"]\(.*\)['\"].*/\1/" | tr -d ' ,')
                    if [ -n "$DETECTED_NAME" ]; then
                        APP_NAME="$DETECTED_NAME"
                    fi
                fi
                break
            fi
        fi
    done
    
    if [ -z "$FOUND_DIR" ] || [ ! -f "$APP_DIR/app.js" ]; then
        print_error "無法找到應用程式目錄"
        echo ""
        print_warning "請先執行部署腳本安裝應用："
        echo "  sudo ./deploy.sh"
        echo ""
        echo "或手動指定應用目錄："
        echo "  修改 restore.sh 中的 APP_DIR 變數"
        exit 1
    fi
fi

# 更新 service 檔案路徑（可能因搜尋而更新了 APP_NAME）
APP_NAME=$(basename "$APP_DIR")
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"

print_success "應用目錄存在：$APP_DIR"
print_info "應用程式名稱：$APP_NAME"
echo ""

# 確認應用目錄是否正確
if ! confirm_action "確認使用此應用目錄？"; then
    print_info "操作已取消"
    echo ""
    echo "如需使用其他目錄，請修改 restore.sh 中的 APP_DIR 變數"
    exit 0
fi

# 確保必要的目錄存在
echo "檢查並創建必要的目錄..."
mkdir -p "$APP_DIR/databases"
mkdir -p "$APP_DIR/uploads"
mkdir -p "$APP_DIR/logs"
mkdir -p "$APP_DIR/backups"
chmod 775 "$APP_DIR/databases" "$APP_DIR/uploads" "$APP_DIR/logs" "$APP_DIR/backups" 2>/dev/null || true
print_success "目錄準備完成"

# 檢查 systemd service
if [ ! -f "$SERVICE_FILE" ]; then
    print_warning "找不到 systemd service 檔案：$SERVICE_FILE"
    print_warning "請先執行 deploy.sh 完成部署，或手動建立 service 檔案"
fi

# ============================================================================
# 步驟 3: 列出可用備份
# ============================================================================

print_header "步驟 3/8: 選擇要還原的備份"

if [ ! -d "$BACKUP_BASE_DIR" ]; then
    print_error "備份目錄不存在：$BACKUP_BASE_DIR"
    echo ""
    echo "沒有可用的備份"
    exit 1
fi

# 尋找備份（包含 uninstall_ 目錄和 auto_ 壓縮檔）
BACKUP_ITEMS=()
BACKUP_TYPES=()  # 'directory' 或 'compressed'
BACKUP_PATHS=()  # 實際路徑

# 搜尋 uninstall_ 開頭的目錄備份
while IFS= read -r dir; do
    BACKUP_ITEMS+=("$(basename "$dir")")
    BACKUP_TYPES+=("directory")
    BACKUP_PATHS+=("$dir")
done < <(find "$BACKUP_BASE_DIR" -maxdepth 1 -type d -name "uninstall_*" | sort -r)

# 搜尋 auto_ 開頭的壓縮備份
while IFS= read -r file; do
    BACKUP_ITEMS+=("$(basename "$file")")
    BACKUP_TYPES+=("compressed")
    BACKUP_PATHS+=("$file")
done < <(find "$BACKUP_BASE_DIR" -maxdepth 1 -type f -name "auto_*.tar.gz" | sort -r)

if [ ${#BACKUP_ITEMS[@]} -eq 0 ]; then
    print_error "找不到任何備份"
    echo ""
    echo "備份目錄：$BACKUP_BASE_DIR"
    echo ""
    echo "提示："
    echo "  - uninstall_* 開頭的目錄備份（來自 uninstall.sh）"
    echo "  - auto_*.tar.gz 壓縮備份（來自 backup_databases.sh）"
    exit 1
fi

echo "找到 ${#BACKUP_ITEMS[@]} 個備份："
echo ""

for i in "${!BACKUP_ITEMS[@]}"; do
    backup_name="${BACKUP_ITEMS[$i]}"
    backup_type="${BACKUP_TYPES[$i]}"
    backup_path="${BACKUP_PATHS[$i]}"
    
    if [ "$backup_type" = "directory" ]; then
        backup_size=$(du -sh "$backup_path" 2>/dev/null | cut -f1)
        backup_time=$(echo "$backup_name" | sed 's/uninstall_//' | sed 's/_/ /')
        backup_type_label="目錄備份（uninstall）"
        
        echo "  $((i+1)). $backup_name"
        echo "     類型：$backup_type_label"
        echo "     時間：$backup_time"
        echo "     大小：$backup_size"
        
        # 顯示備份內容
        if [ -f "$backup_path/backup_info.txt" ]; then
            db_count=$(find "$backup_path/databases" -name "*.db" 2>/dev/null | wc -l)
            echo "     資料庫：$db_count 個"
        fi
    else
        # 壓縮備份
        backup_size=$(du -sh "$backup_path" 2>/dev/null | cut -f1)
        backup_time=$(echo "$backup_name" | sed 's/auto_//' | sed 's/.tar.gz$//' | sed 's/_/ /')
        backup_type_label="壓縮備份（auto）"
        
        echo "  $((i+1)). $backup_name"
        echo "     類型：$backup_type_label"
        echo "     時間：$backup_time"
        echo "     大小：$backup_size"
        
        # 嘗試查看壓縮檔內容（不解壓）
        if tar -tzf "$backup_path" 2>/dev/null | grep -q "databases/.*\.db$"; then
            db_count=$(tar -tzf "$backup_path" 2>/dev/null | grep -c "databases/.*\.db$" || echo "0")
            echo "     資料庫：$db_count 個（壓縮檔內）"
        fi
    fi
    echo ""
done

while true; do
    read -p "請選擇要還原的備份 [1-${#BACKUP_ITEMS[@]}]: " choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le ${#BACKUP_ITEMS[@]} ]; then
        SELECTED_BACKUP_PATH="${BACKUP_PATHS[$((choice-1))]}"
        SELECTED_BACKUP_TYPE="${BACKUP_TYPES[$((choice-1))]}"
        break
    else
        echo "無效選擇，請重試"
    fi
done

SELECTED_BACKUP_NAME="${BACKUP_ITEMS[$((choice-1))]}"
BACKUP_NAME="$SELECTED_BACKUP_NAME"  # 用於後續顯示
print_success "已選擇備份：$SELECTED_BACKUP_NAME"

# 如果是壓縮備份，需要先解壓縮到臨時目錄
TEMP_EXTRACT_DIR=""
if [ "$SELECTED_BACKUP_TYPE" = "compressed" ]; then
    print_info "檢測到壓縮備份，準備解壓縮..."
    TEMP_EXTRACT_DIR="/tmp/restore_extract_$$"
    mkdir -p "$TEMP_EXTRACT_DIR"
    
    echo "解壓縮備份檔案..."
    if tar -xzf "$SELECTED_BACKUP_PATH" -C "$TEMP_EXTRACT_DIR" 2>/dev/null; then
        # 找到解壓後的目錄
        EXTRACTED_DIR=$(find "$TEMP_EXTRACT_DIR" -maxdepth 1 -type d -name "auto_*" | head -1)
        if [ -n "$EXTRACTED_DIR" ]; then
            SELECTED_BACKUP="$EXTRACTED_DIR"
            print_success "備份已解壓縮到臨時目錄"
        else
            print_error "無法找到解壓後的備份目錄"
            rm -rf "$TEMP_EXTRACT_DIR"
            exit 1
        fi
    else
        print_error "解壓縮失敗"
        rm -rf "$TEMP_EXTRACT_DIR"
        exit 1
    fi
else
    # 目錄備份直接使用
    SELECTED_BACKUP="$SELECTED_BACKUP_PATH"
fi

# 顯示備份詳細資訊
if [ -f "$SELECTED_BACKUP/backup_info.txt" ]; then
    echo ""
    echo "備份資訊："
    echo "─────────────────────────────────────"
    cat "$SELECTED_BACKUP/backup_info.txt" | head -n 10
    echo "─────────────────────────────────────"
fi

# ============================================================================
# 步驟 4: 確認還原選項
# ============================================================================

print_header "步驟 4/8: 選擇還原選項"

echo "請選擇要還原的內容："
echo ""
echo "1. 📦 完整還原（資料庫 + 上傳檔案 + 配置）"
echo "2. 💾 僅還原資料庫"
echo "3. 📁 僅還原上傳檔案"
echo "4. ⚙️  僅還原配置檔案"
echo "5. ❌ 取消操作"
echo ""

while true; do
    read -p "請選擇 [1-5]: " restore_choice
    case $restore_choice in
        1)
            RESTORE_MODE="full"
            print_info "將還原所有內容"
            break
            ;;
        2)
            RESTORE_MODE="database"
            print_info "僅還原資料庫"
            break
            ;;
        3)
            RESTORE_MODE="uploads"
            print_info "僅還原上傳檔案"
            break
            ;;
        4)
            RESTORE_MODE="config"
            print_info "僅還原配置檔案"
            break
            ;;
        5)
            print_info "操作已取消"
            exit 0
            ;;
        *)
            echo "無效選擇，請輸入 1-5"
            ;;
    esac
done

echo ""
print_warning "⚠️  注意：還原將覆蓋現有資料"
echo ""
if ! confirm_action "確認要執行還原嗎？"; then
    print_info "操作已取消"
    exit 0
fi

# ============================================================================
# 步驟 5: 停止應用服務
# ============================================================================

print_header "步驟 5/8: 停止應用程式服務"

if [ -f "$SERVICE_FILE" ]; then
    if systemctl is-active --quiet "$APP_NAME" 2>/dev/null; then
        echo "停止 systemd 服務..."
        systemctl stop "$APP_NAME" 2>/dev/null || true
        print_success "服務已停止"
    else
        print_info "服務未運行"
    fi
else
    print_warning "找不到 systemd service，跳過停止服務"
fi

# ============================================================================
# 步驟 6: 備份當前資料（安全措施）
# ============================================================================

print_header "步驟 6/8: 備份當前資料（安全措施）"

SAFETY_BACKUP_DIR="$APP_DIR/safety_backup_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$SAFETY_BACKUP_DIR"

if [ "$RESTORE_MODE" = "full" ] || [ "$RESTORE_MODE" = "database" ]; then
    if [ -d "$APP_DIR/databases" ]; then
        echo "備份當前資料庫..."
        cp -r "$APP_DIR/databases" "$SAFETY_BACKUP_DIR/"
        print_success "當前資料庫已備份到：$SAFETY_BACKUP_DIR"
    fi
fi

# ============================================================================
# 步驟 7: 執行還原
# ============================================================================

print_header "步驟 7/8: 執行資料還原"

# 還原資料庫
if [ "$RESTORE_MODE" = "full" ] || [ "$RESTORE_MODE" = "database" ]; then
    if [ -d "$SELECTED_BACKUP/databases" ]; then
        echo "還原資料庫..."
        
        # 確保目標目錄存在
        mkdir -p "$APP_DIR/databases"
        
        # 清空現有資料庫（如果存在）
        if [ "$(ls -A "$APP_DIR/databases" 2>/dev/null)" ]; then
            rm -rf "$APP_DIR/databases"/*
        fi
        
        # 複製備份
        if [ "$(ls -A "$SELECTED_BACKUP/databases" 2>/dev/null)" ]; then
            cp -r "$SELECTED_BACKUP/databases"/* "$APP_DIR/databases/" 2>/dev/null || {
                print_error "複製資料庫檔案失敗"
                echo "  來源：$SELECTED_BACKUP/databases/"
                echo "  目標：$APP_DIR/databases/"
                exit 1
            }
        else
            print_warning "備份中的資料庫目錄為空"
        fi
        
        # 修復權限
        chown -R $SUDO_USER:$SUDO_USER "$APP_DIR/databases" 2>/dev/null || true
        chmod -R 775 "$APP_DIR/databases" 2>/dev/null || true
        
        DB_COUNT=$(find "$APP_DIR/databases" -name "*.db" 2>/dev/null | wc -l)
        if [ "$DB_COUNT" -gt 0 ]; then
            print_success "已還原 $DB_COUNT 個資料庫"
        else
            print_warning "還原完成，但未找到資料庫檔案"
        fi
    else
        print_warning "備份中無資料庫目錄"
    fi
fi

# 還原上傳檔案
if [ "$RESTORE_MODE" = "full" ] || [ "$RESTORE_MODE" = "uploads" ]; then
    if [ -d "$SELECTED_BACKUP/uploads" ]; then
        # 檢查目錄是否有檔案
        if [ "$(ls -A "$SELECTED_BACKUP/uploads" 2>/dev/null)" ]; then
            echo "還原上傳檔案..."
            
            mkdir -p "$APP_DIR/uploads"
            cp -r "$SELECTED_BACKUP/uploads"/* "$APP_DIR/uploads/" 2>/dev/null || true
            
            # 修復權限
            chown -R $SUDO_USER:$SUDO_USER "$APP_DIR/uploads"
            chmod -R 775 "$APP_DIR/uploads"
            
            UPLOAD_COUNT=$(find "$APP_DIR/uploads" -type f 2>/dev/null | wc -l)
            print_success "已還原 $UPLOAD_COUNT 個上傳檔案"
        else
            print_info "備份中的上傳檔案目錄為空"
        fi
    else
        print_info "備份中無上傳檔案目錄"
    fi
fi

# 還原配置檔案
if [ "$RESTORE_MODE" = "full" ] || [ "$RESTORE_MODE" = "config" ]; then
    echo "還原配置檔案..."
    
    CONFIG_RESTORED=0
    
    if [ -f "$SELECTED_BACKUP/.env" ]; then
        cp "$SELECTED_BACKUP/.env" "$APP_DIR/"
        chown $SUDO_USER:$SUDO_USER "$APP_DIR/.env"
        ((CONFIG_RESTORED++))
    fi
    
    if [ -f "$SELECTED_BACKUP/ecosystem.config.js" ]; then
        cp "$SELECTED_BACKUP/ecosystem.config.js" "$APP_DIR/"
        chown $SUDO_USER:$SUDO_USER "$APP_DIR/ecosystem.config.js"
        ((CONFIG_RESTORED++))
    fi
    
    if [ -f "$SELECTED_BACKUP/package.json" ]; then
        # 僅作為參考，不覆蓋（可能版本不同）
        cp "$SELECTED_BACKUP/package.json" "$SAFETY_BACKUP_DIR/"
        print_info "package.json 已保存到安全備份目錄供參考"
    fi
    
    if [ $CONFIG_RESTORED -gt 0 ]; then
        print_success "已還原 $CONFIG_RESTORED 個配置檔案"
    else
        print_info "備份中無配置檔案"
    fi
fi

# ============================================================================
# 步驟 8: 重啟服務並驗證
# ============================================================================

print_header "步驟 8/8: 重啟服務並驗證"

if [ -f "$SERVICE_FILE" ]; then
    echo "重啟應用服務..."
    systemctl restart "$APP_NAME" 2>/dev/null || {
        echo "嘗試啟動服務..."
        systemctl start "$APP_NAME"
    }

    # 等待啟動
    echo "等待服務啟動..."
    sleep 3

    # 檢查狀態
    if systemctl is-active --quiet "$APP_NAME" 2>/dev/null; then
        print_success "服務已成功啟動"
        echo ""
        systemctl status "$APP_NAME" --no-pager -l
    else
        print_warning "服務可能未正常啟動，請檢查日誌"
        echo ""
        echo "查看日誌："
        echo "  journalctl -u $APP_NAME -n 50"
    fi
else
    print_warning "找不到 systemd service 檔案，請手動啟動應用"
    echo "  若需建立服務，請重新執行 deploy.sh"
fi

# 驗證資料庫
echo ""
echo "驗證資料庫..."
# 自動檢測系統資料庫（優先使用 system.db）
DB_PATH=""
if [ -f "$APP_DIR/databases/system.db" ]; then
    DB_PATH="$APP_DIR/databases/system.db"
elif [ -f "$APP_DIR/databases/main.db" ]; then
    DB_PATH="$APP_DIR/databases/main.db"
else
    # 嘗試找到第一個資料庫檔案
    FIRST_DB=$(find "$APP_DIR/databases" -maxdepth 1 -name "*.db" -type f ! -name "user_*.db" | head -1)
    if [ -n "$FIRST_DB" ]; then
        DB_PATH="$FIRST_DB"
    fi
fi

if [ -n "$DB_PATH" ] && [ -f "$DB_PATH" ]; then
    if command -v sqlite3 &> /dev/null; then
        INTEGRITY=$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;" 2>/dev/null || echo "error")
        if [ "$INTEGRITY" = "ok" ]; then
            print_success "系統資料庫完整性檢查通過：$(basename "$DB_PATH")"
        else
            print_warning "資料庫可能有問題，請檢查：$(basename "$DB_PATH")"
        fi
    else
        print_info "sqlite3 未安裝，跳過完整性檢查"
    fi
else
    print_info "未找到系統資料庫檔案，跳過完整性檢查"
fi

# ============================================================================
# 完成總結
# ============================================================================

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
print_success "還原完成！"
echo ""

echo "還原摘要："
echo "─────────────────────────────────────"
echo "  備份來源：$BACKUP_NAME"
echo "  還原模式：$RESTORE_MODE"
echo "  應用目錄：$APP_DIR"
echo "  安全備份：$SAFETY_BACKUP_DIR"
echo "─────────────────────────────────────"
echo ""

echo "📋 後續步驟："
echo ""
echo "1. 驗證應用運作："
# 嘗試從 app.js 獲取 Port
DETECTED_PORT=$(grep -E "^const PORT = [0-9]+;" "$APP_DIR/app.js" 2>/dev/null | sed 's/const PORT = //; s/;//' | tr -d ' ' || echo "5000")
echo "   curl http://localhost:$DETECTED_PORT/login.html"
echo "   或使用瀏覽器訪問 http://your-server-ip:$DETECTED_PORT"
echo ""
echo "2. 查看應用日誌："
echo "   journalctl -u $APP_NAME -f"
echo ""
echo "3. 檢查服務狀態："
echo "   systemctl status $APP_NAME"
echo ""
echo "4. 如果還原有問題，可以從安全備份復原："
echo "   cp -r $SAFETY_BACKUP_DIR/databases/* $APP_DIR/databases/"
echo ""

if [ "$RESTORE_MODE" = "database" ] || [ "$RESTORE_MODE" = "full" ]; then
    echo "💡 資料庫還原提示："
    echo "   - 請使用相同版本的應用程式"
    echo "   - 如有任何登入問題，請檢查 users 表"
    echo "   - 建議在測試環境先驗證"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 記錄日誌（使用應用程式名稱）
LOG_FILE="/var/log/${APP_NAME}-restore.log"
cat > "$LOG_FILE" << EOF
資料還原日誌
================================
還原時間：$(date)
還原模式：$RESTORE_MODE
執行用戶：$(whoami)
備份來源：$SELECTED_BACKUP
應用目錄：$APP_DIR
安全備份：$SAFETY_BACKUP_DIR
================================
EOF

print_info "還原日誌已保存：$LOG_FILE"
echo ""

# 清理臨時解壓縮目錄（如果存在）
if [ -n "$TEMP_EXTRACT_DIR" ] && [ -d "$TEMP_EXTRACT_DIR" ]; then
    print_info "清理臨時檔案..."
    rm -rf "$TEMP_EXTRACT_DIR"
fi

exit 0

