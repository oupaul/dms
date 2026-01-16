#!/bin/bash

# ============================================================================
# 資料夾權限管理系統 - 完整移除腳本
# ============================================================================
# 功能：完全移除已部署的應用程式
# 用途：卸載應用、清理環境、重新開始
# 使用：sudo ./uninstall.sh
# ============================================================================

set -e  # 遇到錯誤立即停止

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 配置變數
# 自動偵測應用程式名稱（從目錄名稱或 PM2 進程）
APP_NAME="folder-permission-system"  # 預設值，會根據實際情況自動調整

# 嘗試自動偵測應用目錄
POSSIBLE_DIRS=(
    "/opt/folder-permission-system"
    "/home/$SUDO_USER/folder-permission-system"
    "$HOME/folder-permission-system"
    "$(pwd)"
)

APP_DIR=""
for dir in "${POSSIBLE_DIRS[@]}"; do
    if [ -d "$dir" ] && [ -f "$dir/app.js" ]; then
        APP_DIR="$dir"
        break
    fi
done

# 如果無法自動偵測，使用預設路徑
if [ -z "$APP_DIR" ]; then
    APP_DIR="/opt/folder-permission-system"
fi

BACKUP_BASE_DIR="/opt/backups"
BACKUP_DIR="$BACKUP_BASE_DIR/uninstall_$(date +%Y%m%d_%H%M%S)"

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
# 主程式開始
# ============================================================================

clear

cat << "EOF"
╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║     資料夾權限管理系統 - 完整移除腳本                           ║
║                                                                  ║
║     此腳本將完全移除已部署的應用程式                            ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
EOF

echo ""
echo -e "${RED}⚠️  警告：此操作將移除應用程式及其所有相關檔案${NC}"
echo ""

# ============================================================================
# 步驟 1: 權限檢查
# ============================================================================

print_header "步驟 1/7: 檢查執行權限"

if [ "$EUID" -ne 0 ]; then 
    print_error "請使用 sudo 執行此腳本"
    echo ""
    echo "正確用法："
    echo "  sudo ./uninstall.sh"
    exit 1
fi

print_success "權限檢查通過"

# ============================================================================
# 步驟 2: 顯示當前狀態
# ============================================================================

print_header "步驟 2/7: 檢查當前安裝狀態"

# 檢查應用目錄
if [ -d "$APP_DIR" ] && [ -f "$APP_DIR/app.js" ]; then
    print_success "已偵測到應用目錄：$APP_DIR"
    
    # 計算目錄大小
    DIR_SIZE=$(du -sh "$APP_DIR" 2>/dev/null | cut -f1)
    echo "  目錄大小：$DIR_SIZE"
    
    # 統計資料庫數量
    if [ -d "$APP_DIR/databases" ]; then
        DB_COUNT=$(find "$APP_DIR/databases" -name "*.db" 2>/dev/null | wc -l)
        echo "  資料庫數量：$DB_COUNT 個"
    fi
    
    # 統計備份數量
    if [ -d "$APP_DIR/backups" ]; then
        BACKUP_COUNT=$(find "$APP_DIR/backups" -name "*.tar.gz" 2>/dev/null | wc -l)
        echo "  備份數量：$BACKUP_COUNT 個"
    fi
    
    APP_DIR_EXISTS=true
else
    print_warning "未找到應用目錄：$APP_DIR"
    echo ""
    echo "嘗試搜尋其他可能的位置..."
    
    # 搜尋常見位置（自動偵測第一個找到的）
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
        # 從目錄名稱推斷應用程式名稱
        APP_NAME=$(basename "$APP_DIR")
        print_success "自動偵測到應用目錄：$APP_DIR"
        print_info "應用程式名稱：$APP_NAME"
        APP_DIR_EXISTS=true
        break
    fi
        fi
    done
    
    if [ -z "$FOUND_DIR" ]; then
        print_warning "無法自動偵測應用目錄"
        echo ""
        echo "將使用預設路徑：$APP_DIR"
        echo "如果應用程式安裝在其他位置，請手動修改腳本中的 APP_DIR 變數"
        APP_DIR_EXISTS=false
    fi
fi

echo ""

# 檢查 PM2 進程（自動偵測應用程式名稱）
if command -v pm2 &> /dev/null; then
    print_info "PM2 已安裝"
    
    # 如果找到應用目錄，從目錄名稱推斷應用程式名稱
    if [ -n "$APP_DIR" ] && [ "$APP_DIR_EXISTS" = true ]; then
        DIR_NAME=$(basename "$APP_DIR")
        APP_NAME="$DIR_NAME"
        
        # 嘗試從 ecosystem.config.js 獲取應用名稱（優先）
        if [ -f "$APP_DIR/ecosystem.config.js" ]; then
            DETECTED_NAME=$(grep -E "name\s*:" "$APP_DIR/ecosystem.config.js" | head -1 | sed "s/.*name.*:.*['\"]\(.*\)['\"].*/\1/" | tr -d ' ,')
            if [ -n "$DETECTED_NAME" ]; then
                APP_NAME="$DETECTED_NAME"
            fi
        fi
    fi
    
    if pm2 list | grep -q "$APP_NAME"; then
        PM2_STATUS=$(pm2 list | grep "$APP_NAME" | awk '{print $10}')
        echo "  應用名稱：$APP_NAME"
        echo "  進程狀態：$PM2_STATUS"
        PM2_RUNNING=true
    else
        echo "  應用名稱：$APP_NAME（未找到運行中的進程）"
        echo "  進程狀態：未運行"
        PM2_RUNNING=false
    fi
else
    print_warning "PM2 未安裝"
    PM2_RUNNING=false
fi

echo ""

# ============================================================================
# 步驟 3: 確認移除選項
# ============================================================================

print_header "步驟 3/7: 選擇移除選項"

echo "請選擇要執行的操作："
echo ""
echo "1. 🗑️  完全移除（刪除所有檔案，包括資料庫）"
echo "2. 💾 保留資料移除（備份資料庫後再刪除應用）"
echo "3. 🛑 僅停止服務（不刪除任何檔案）"
echo "4. ❌ 取消操作"
echo ""

while true; do
    read -p "請選擇 [1-4]: " choice
    case $choice in
        1)
            REMOVE_MODE="full"
            print_warning "將完全移除所有檔案（包括資料庫）"
            break
            ;;
        2)
            REMOVE_MODE="backup"
            print_info "將先備份資料庫，然後移除應用"
            break
            ;;
        3)
            REMOVE_MODE="stop"
            print_info "僅停止服務，不刪除檔案"
            break
            ;;
        4)
            print_info "操作已取消"
            exit 0
            ;;
        *)
            echo "無效選擇，請輸入 1-4"
            ;;
    esac
done

echo ""

# 最後確認
if [ "$REMOVE_MODE" = "full" ]; then
    print_warning "⚠️  注意：選擇完全移除將刪除所有資料，包括："
    echo "  - 應用程式檔案"
    echo "  - 所有資料庫檔案"
    echo "  - 上傳的檔案"
    echo "  - 日誌檔案"
    echo "  - 備份檔案"
    echo ""
    if ! confirm_action "確定要完全移除嗎？此操作無法復原！"; then
        print_info "操作已取消"
        exit 0
    fi
elif [ "$REMOVE_MODE" = "backup" ]; then
    print_info "將創建備份到：$BACKUP_DIR"
    echo ""
    if ! confirm_action "確認執行移除（會先備份資料）？"; then
        print_info "操作已取消"
        exit 0
    fi
else
    if ! confirm_action "確認僅停止服務？"; then
        print_info "操作已取消"
        exit 0
    fi
fi

# ============================================================================
# 步驟 4: 停止 PM2 服務
# ============================================================================

print_header "步驟 4/7: 停止應用程式服務"

if [ "$PM2_RUNNING" = true ]; then
    echo "停止 PM2 進程..."
    
    # 停止應用
    pm2 stop "$APP_NAME" 2>/dev/null || true
    print_success "已停止進程"
    
    # 從 PM2 中刪除
    pm2 delete "$APP_NAME" 2>/dev/null || true
    print_success "已從 PM2 中移除"
    
    # 保存 PM2 配置
    pm2 save --force 2>/dev/null || true
    print_success "已更新 PM2 配置"
else
    print_info "沒有運行中的進程"
fi

# 檢查端口佔用
echo ""
echo "檢查端口佔用..."
PORTS=("3000" "5000" "8080")
for PORT in "${PORTS[@]}"; do
    if lsof -ti:$PORT &> /dev/null; then
        print_warning "端口 $PORT 仍被佔用"
        if confirm_action "是否強制終止佔用端口 $PORT 的進程？"; then
            lsof -ti:$PORT | xargs kill -9 2>/dev/null || true
            print_success "已終止端口 $PORT 的進程"
        fi
    fi
done

print_success "服務停止完成"

# ============================================================================
# 步驟 5: 移除自動備份設定
# ============================================================================

print_header "步驟 5/9: 移除自動備份設定"

# 檢查是否有配置自動備份
CRON_REMOVED=false
BACKUP_SCRIPT_PATH="$APP_DIR/backup_databases.sh"

if crontab -l 2>/dev/null | grep -q "backup_databases.sh"; then
    echo "偵測到自動備份的 cron 任務"
    echo ""
    echo "當前 cron 設定："
    crontab -l 2>/dev/null | grep "backup_databases.sh"
    echo ""
    
    if confirm_action "是否要移除自動備份的 cron 任務？"; then
        # 移除 cron job
        crontab -l 2>/dev/null | grep -v "backup_databases.sh" | grep -v "資料夾權限管理系統.*自動備份" | crontab -
        print_success "已移除 cron 任務"
        CRON_REMOVED=true
    else
        print_info "保留 cron 任務"
    fi
else
    print_info "未偵測到自動備份的 cron 任務"
fi

echo ""

# 詢問是否刪除備份檔案
if [ -d "$BACKUP_BASE_DIR" ]; then
    BACKUP_COUNT=$(find "$BACKUP_BASE_DIR" -name "auto_*.tar.gz" 2>/dev/null | wc -l)
    
    if [ "$BACKUP_COUNT" -gt 0 ]; then
        BACKUP_SIZE=$(du -sh "$BACKUP_BASE_DIR" 2>/dev/null | cut -f1)
        
        echo "偵測到自動備份檔案："
        echo "  位置：$BACKUP_BASE_DIR"
        echo "  數量：$BACKUP_COUNT 個"
        echo "  大小：$BACKUP_SIZE"
        echo ""
        
        if [ "$REMOVE_MODE" = "full" ]; then
            if confirm_action "是否要刪除所有自動備份檔案？"; then
                echo "刪除自動備份檔案..."
                find "$BACKUP_BASE_DIR" -name "auto_*.tar.gz" -type f -delete 2>/dev/null
                print_success "已刪除自動備份檔案"
                
                # 如果 backups 目錄為空，刪除目錄
                if [ -z "$(ls -A "$BACKUP_BASE_DIR" 2>/dev/null)" ]; then
                    rmdir "$BACKUP_BASE_DIR" 2>/dev/null
                    print_info "已刪除空的備份目錄"
                fi
            else
                print_info "保留自動備份檔案"
            fi
        else
            print_info "保留自動備份檔案（建議保留作為災難恢復用途）"
        fi
    fi
fi

echo ""

# 詢問是否刪除備份日誌
BACKUP_LOG="/var/log/folder-permission-system-backup.log"
if [ -f "$BACKUP_LOG" ]; then
    LOG_SIZE=$(du -sh "$BACKUP_LOG" 2>/dev/null | cut -f1)
    
    echo "偵測到備份日誌："
    echo "  位置：$BACKUP_LOG"
    echo "  大小：$LOG_SIZE"
    echo ""
    
    if confirm_action "是否要刪除備份日誌？"; then
        rm -f "$BACKUP_LOG"
        print_success "已刪除備份日誌"
    else
        print_info "保留備份日誌"
    fi
fi

print_success "自動備份設定清理完成"

# ============================================================================
# 步驟 6: 備份資料（如果選擇）
# ============================================================================

if [ "$REMOVE_MODE" = "backup" ]; then
    print_header "步驟 6/9: 備份重要資料"
    
    if [ "$APP_DIR_EXISTS" = true ] && [ -d "$APP_DIR" ]; then
        echo "創建備份目錄..."
        mkdir -p "$BACKUP_DIR"
        
        # 備份資料庫
        if [ -d "$APP_DIR/databases" ]; then
            echo "備份資料庫..."
            cp -r "$APP_DIR/databases" "$BACKUP_DIR/" 2>/dev/null || true
            DB_BACKUP_SIZE=$(du -sh "$BACKUP_DIR/databases" 2>/dev/null | cut -f1)
            print_success "資料庫已備份（$DB_BACKUP_SIZE）"
        fi
        
        # 備份上傳檔案
        if [ -d "$APP_DIR/uploads" ]; then
            echo "備份上傳檔案..."
            cp -r "$APP_DIR/uploads" "$BACKUP_DIR/" 2>/dev/null || true
            UPLOAD_BACKUP_SIZE=$(du -sh "$BACKUP_DIR/uploads" 2>/dev/null | cut -f1)
            print_success "上傳檔案已備份（$UPLOAD_BACKUP_SIZE）"
        fi
        
        # 備份配置檔案
        echo "備份配置檔案..."
        cp "$APP_DIR/package.json" "$BACKUP_DIR/" 2>/dev/null || true
        cp "$APP_DIR/ecosystem.config.js" "$BACKUP_DIR/" 2>/dev/null || true
        cp "$APP_DIR/.env" "$BACKUP_DIR/" 2>/dev/null || true
        print_success "配置檔案已備份"
        
        # 創建備份資訊檔案
        cat > "$BACKUP_DIR/backup_info.txt" << EOF
備份資訊
========================================
備份時間：$(date)
原始路徑：$APP_DIR
備份原因：應用程式移除前自動備份
系統資訊：$(uname -a)
========================================

目錄結構：
$(tree -L 2 "$BACKUP_DIR" 2>/dev/null || find "$BACKUP_DIR" -maxdepth 2 -type d)

備份大小：
$(du -sh "$BACKUP_DIR")
EOF
        
        echo ""
        print_success "備份完成：$BACKUP_DIR"
        echo ""
        echo "備份內容："
        ls -lh "$BACKUP_DIR"
        echo ""
    else
        print_warning "應用目錄不存在，跳過備份"
    fi
else
    print_header "步驟 6/9: 備份資料"
    print_info "已跳過備份（根據選擇）"
fi

# ============================================================================
# 步驟 7: 移除應用檔案
# ============================================================================

if [ "$REMOVE_MODE" = "stop" ]; then
    print_header "步驟 7/9: 移除應用檔案"
    print_info "已跳過移除檔案（僅停止服務）"
else
    print_header "步驟 7/9: 移除應用檔案"
    
    if [ "$APP_DIR_EXISTS" = true ] && [ -d "$APP_DIR" ]; then
        echo "準備刪除：$APP_DIR"
        echo ""
        
        # 最後一次確認
        if [ "$REMOVE_MODE" = "full" ]; then
            print_warning "這是最後一次確認！"
            if ! confirm_action "真的要刪除 $APP_DIR 及其所有內容嗎？"; then
                print_info "操作已取消"
                exit 0
            fi
        fi
        
        echo ""
        echo "刪除中..."
        
        # 顯示刪除進度
        rm -rf "$APP_DIR" &
        PID=$!
        
        while kill -0 $PID 2>/dev/null; do
            echo -n "."
            sleep 0.5
        done
        
        wait $PID
        
        echo ""
        print_success "應用目錄已刪除"
    else
        print_warning "應用目錄不存在或無法訪問"
        echo ""
        echo "可能的原因："
        echo "  1. 應用未安裝或已被刪除"
        echo "  2. 安裝在不同的目錄位置"
        echo "  3. 沒有訪問權限"
        echo ""
        print_info "即使目錄不存在，仍會繼續清理 PM2 進程和端口"
    fi
fi

# ============================================================================
# 步驟 8: 清理和驗證
# ============================================================================

print_header "步驟 8/9: 清理和驗證"

echo "執行最終清理..."

# 清理 PM2 殘留
if command -v pm2 &> /dev/null; then
    echo "清理 PM2 配置..."
    pm2 save --force 2>/dev/null || true
    print_success "PM2 配置已更新"
fi

# 驗證刪除結果
echo ""
echo "驗證移除結果..."

if [ "$REMOVE_MODE" != "stop" ]; then
    if [ -d "$APP_DIR" ]; then
        print_warning "警告：應用目錄仍然存在"
    else
        print_success "應用目錄已完全移除"
    fi
fi

if command -v pm2 &> /dev/null; then
    if pm2 list | grep -q "$APP_NAME"; then
        print_warning "警告：PM2 中仍有應用進程"
    else
        print_success "PM2 中無殘留進程"
    fi
fi

# 檢查端口
echo ""
echo "檢查端口狀態..."
PORTS_CLEAR=true
for PORT in "${PORTS[@]}"; do
    if lsof -ti:$PORT &> /dev/null; then
        print_warning "端口 $PORT 仍被佔用"
        PORTS_CLEAR=false
    fi
done

if [ "$PORTS_CLEAR" = true ]; then
    print_success "所有端口已釋放"
fi

print_success "清理完成"

# ============================================================================
# 步驟 9: 最終確認
# ============================================================================

print_header "步驟 9/9: 最終確認"

echo "驗證自動備份設定清理狀態..."

# 檢查 cron 任務
if crontab -l 2>/dev/null | grep -q "backup_databases.sh"; then
    print_warning "警告：cron 任務仍然存在"
    echo "  可手動移除：crontab -e"
else
    if [ "$CRON_REMOVED" = true ]; then
        print_success "Cron 任務已移除"
    else
        print_info "無 cron 任務"
    fi
fi

# 檢查備份檔案
REMAINING_BACKUPS=$(find "$BACKUP_BASE_DIR" -name "auto_*.tar.gz" 2>/dev/null | wc -l)
if [ "$REMAINING_BACKUPS" -gt 0 ]; then
    print_info "保留 $REMAINING_BACKUPS 個自動備份檔案在 $BACKUP_BASE_DIR"
else
    print_success "無自動備份檔案殘留"
fi

# 檢查日誌檔案
if [ -f "$BACKUP_LOG" ]; then
    print_info "保留備份日誌：$BACKUP_LOG"
else
    print_success "備份日誌已清理"
fi

print_success "最終確認完成"

# ============================================================================
# 完成總結
# ============================================================================

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
print_success "移除完成！"
echo ""

case "$REMOVE_MODE" in
    full)
        echo -e "${GREEN}✅ 應用程式已完全移除${NC}"
        echo ""
        echo "已刪除："
        echo "  - 應用程式目錄：$APP_DIR"
        echo "  - PM2 進程：$APP_NAME"
        echo "  - 所有資料庫"
        echo "  - 所有備份"
        if [ "$CRON_REMOVED" = true ]; then
            echo "  - 自動備份 Cron 任務"
        fi
        echo ""
        ;;
    backup)
        echo -e "${GREEN}✅ 應用程式已移除（資料已備份）${NC}"
        echo ""
        echo "已刪除："
        echo "  - 應用程式目錄：$APP_DIR"
        echo "  - PM2 進程：$APP_NAME"
        if [ "$CRON_REMOVED" = true ]; then
            echo "  - 自動備份 Cron 任務"
        fi
        echo ""
        echo "備份位置："
        echo "  📁 $BACKUP_DIR"
        echo ""
        echo "備份內容："
        echo "  - databases/  （資料庫檔案）"
        echo "  - uploads/    （上傳檔案）"
        echo "  - *.json      （配置檔案）"
        echo ""
        if [ "$REMAINING_BACKUPS" -gt 0 ]; then
            echo "保留："
            echo "  - $REMAINING_BACKUPS 個自動備份檔案在 $BACKUP_BASE_DIR"
            echo ""
        fi
        print_info "如需恢復資料，請從備份目錄複製"
        echo ""
        ;;
    stop)
        echo -e "${GREEN}✅ 服務已停止${NC}"
        echo ""
        echo "已執行："
        echo "  - 停止 PM2 進程：$APP_NAME"
        echo "  - 釋放佔用端口"
        if [ "$CRON_REMOVED" = true ]; then
            echo "  - 移除自動備份 Cron 任務"
        fi
        echo ""
        echo "保留："
        echo "  - 應用程式目錄：$APP_DIR"
        echo "  - 所有資料檔案"
        if [ "$REMAINING_BACKUPS" -gt 0 ]; then
            echo "  - $REMAINING_BACKUPS 個自動備份檔案"
        fi
        echo ""
        print_info "如需重新啟動，請執行："
        echo "  cd $APP_DIR && pm2 start ecosystem.config.js"
        echo ""
        ;;
esac

# 顯示後續建議
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 後續建議："
echo ""

if [ "$REMOVE_MODE" = "full" ] || [ "$REMOVE_MODE" = "backup" ]; then
    echo "1. 檢查磁碟空間："
    echo "   df -h"
    echo ""
    
    if [ "$REMOVE_MODE" = "backup" ]; then
        echo "2. 查看備份："
        echo "   ls -lh $BACKUP_DIR"
        echo ""
        echo "3. 如需恢復資料："
        echo "   # 重新部署應用"
        echo "   ./deploy.sh"
        echo "   # 恢復資料庫"
        echo "   cp -r $BACKUP_DIR/databases/* $APP_DIR/databases/"
        echo "   # 修復權限"
        echo "   sudo chown -R \$USER:\$USER $APP_DIR/databases"
        echo "   sudo chmod -R 775 $APP_DIR/databases"
        echo "   # 重啟服務"
        echo "   pm2 restart $APP_NAME"
        echo ""
    fi
    
    echo "4. 如需重新安裝："
    echo "   ./deploy.sh"
    echo ""
fi

if [ "$REMOVE_MODE" = "stop" ]; then
    echo "1. 重新啟動服務："
    echo "   cd $APP_DIR"
    echo "   pm2 start ecosystem.config.js"
    echo ""
    echo "2. 查看服務狀態："
    echo "   pm2 status"
    echo "   pm2 logs $APP_NAME"
    echo ""
fi

echo "5. 檢查自動備份狀態："
echo "   crontab -l | grep backup"
if [ "$REMAINING_BACKUPS" -gt 0 ]; then
    echo "   ls -lh $BACKUP_BASE_DIR/"
fi
echo ""

echo "6. 查看系統資源："
echo "   pm2 list"
echo "   free -h"
echo "   df -h"
echo ""

# 顯示 PM2 相關提示
if command -v pm2 &> /dev/null; then
    REMAINING_APPS=$(pm2 list | grep -c "online\|stopped" || echo "0")
    if [ "$REMAINING_APPS" -eq 0 ]; then
        echo "💡 提示："
        echo "   PM2 中已無應用程式，如不再需要可以卸載："
        echo "   npm uninstall -g pm2"
        echo ""
    fi
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 記錄日誌
LOG_FILE="/var/log/folder-permission-system-uninstall.log"
cat > "$LOG_FILE" << EOF
應用程式移除日誌
================================
移除時間：$(date)
移除模式：$REMOVE_MODE
執行用戶：$(whoami)
應用目錄：$APP_DIR
備份目錄：${BACKUP_DIR:-無}
Cron 任務移除：${CRON_REMOVED:-false}
保留自動備份數量：${REMAINING_BACKUPS:-0}
自動備份目錄：$BACKUP_BASE_DIR
================================
EOF

print_info "移除日誌已保存：$LOG_FILE"
echo ""

exit 0

