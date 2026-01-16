#!/bin/bash

# ============================================================================
# 資料夾權限管理系統 - 資料庫自動備份腳本
# ============================================================================
# 功能：自動備份所有資料庫檔案
# 用途：定時備份、災難恢復
# 使用：./backup_databases.sh 或透過 cron 自動執行
# ============================================================================

# 顏色定義（用於手動執行時）
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ============================================================================
# 自動偵測應用程式目錄
# ============================================================================

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

# 配置變數
BACKUP_ROOT="/opt/backups"
BACKUP_DIR="$BACKUP_ROOT/auto_$(date +%Y%m%d_%H%M%S)"
DATABASE_DIR="$APP_DIR/databases"
LOG_FILE="/var/log/folder-permission-system-backup.log"

# 備份保留設定
KEEP_DAILY=7      # 保留 7 天的每日備份
KEEP_WEEKLY=4     # 保留 4 周的每週備份
KEEP_MONTHLY=6    # 保留 6 個月的每月備份

# ============================================================================
# 日誌函數
# ============================================================================

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log_error() {
    echo -e "${RED}[ERROR] $1${NC}" | tee -a "$LOG_FILE"
}

log_success() {
    echo -e "${GREEN}[SUCCESS] $1${NC}" | tee -a "$LOG_FILE"
}

log_info() {
    echo -e "${BLUE}[INFO] $1${NC}" | tee -a "$LOG_FILE"
}

log_warning() {
    echo -e "${YELLOW}[WARNING] $1${NC}" | tee -a "$LOG_FILE"
}

# ============================================================================
# 主要備份函數
# ============================================================================

perform_backup() {
    log "=========================================="
    log "開始資料庫備份作業"
    log "=========================================="
    
    # 檢查資料庫目錄是否存在
    if [ ! -d "$DATABASE_DIR" ]; then
        log_warning "資料庫目錄不存在：$DATABASE_DIR"
        log_info "這可能是首次部署，資料庫尚未創建"
        log_info "跳過備份，等待系統初始化完成"
        return 0  # 返回成功，不中斷部署
    fi
    
    # 統計資料庫數量
    DB_COUNT=$(find "$DATABASE_DIR" -name "*.db" 2>/dev/null | wc -l)
    if [ "$DB_COUNT" -eq 0 ]; then
        log_warning "沒有找到資料庫檔案"
        log_info "這可能是首次部署，資料庫尚未創建"
        log_info "系統啟動後會自動創建資料庫"
        log_info "下次備份時將自動處理"
        return 0  # 返回成功，不中斷部署
    fi
    
    log_info "找到 $DB_COUNT 個資料庫檔案"
    
    # 創建備份目錄
    mkdir -p "$BACKUP_DIR"
    if [ $? -ne 0 ]; then
        log_error "無法創建備份目錄：$BACKUP_DIR"
        return 1
    fi
    
    log_info "備份目錄：$BACKUP_DIR"
    
    # 複製資料庫檔案
    log_info "開始複製資料庫檔案..."
    cp -r "$DATABASE_DIR" "$BACKUP_DIR/"
    
    if [ $? -eq 0 ]; then
        # 計算備份大小
        BACKUP_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
        log_success "資料庫備份完成！大小：$BACKUP_SIZE"
    else
        log_error "資料庫備份失敗"
        return 1
    fi
    
    # 創建備份資訊檔案
    cat > "$BACKUP_DIR/backup_info.txt" << EOF
資料庫自動備份資訊
========================================
備份時間：$(date)
備份類型：自動備份
資料庫數量：$DB_COUNT
備份大小：$BACKUP_SIZE
來源目錄：$DATABASE_DIR
執行用戶：$(whoami)
========================================

資料庫清單：
$(ls -lh "$BACKUP_DIR/databases" 2>/dev/null)
EOF
    
    # 壓縮備份（節省空間）
    log_info "壓縮備份檔案..."
    cd "$BACKUP_ROOT"
    tar -czf "$(basename "$BACKUP_DIR").tar.gz" "$(basename "$BACKUP_DIR")" 2>/dev/null
    
    if [ $? -eq 0 ]; then
        # 刪除未壓縮的目錄
        rm -rf "$BACKUP_DIR"
        COMPRESSED_SIZE=$(du -sh "$(basename "$BACKUP_DIR").tar.gz" | cut -f1)
        log_success "備份已壓縮：$(basename "$BACKUP_DIR").tar.gz（$COMPRESSED_SIZE）"
    else
        log_warning "壓縮失敗，保留未壓縮的備份"
    fi
    
    return 0
}

# ============================================================================
# 清理舊備份
# ============================================================================

cleanup_old_backups() {
    log "=========================================="
    log "清理舊備份"
    log "=========================================="
    
    if [ ! -d "$BACKUP_ROOT" ]; then
        log_info "備份目錄不存在，跳過清理"
        return 0
    fi
    
    cd "$BACKUP_ROOT"
    
    # 保留策略：
    # - 最近 7 天：保留所有備份
    # - 8-30 天：每週保留一個
    # - 31-180 天：每月保留一個
    # - 180 天以上：刪除
    
    local deleted_count=0
    local kept_count=0
    
    # 刪除 180 天以上的備份
    log_info "刪除 180 天以上的備份..."
    find "$BACKUP_ROOT" -name "auto_*.tar.gz" -mtime +180 -type f | while read -r file; do
        log_info "刪除舊備份：$(basename "$file")"
        rm -f "$file"
        ((deleted_count++))
    done
    
    # 處理 8-30 天的備份（每週保留一個）
    log_info "處理 8-30 天的備份（每週保留一個）..."
    for week in {1..3}; do
        week_start=$((7 + (week - 1) * 7))
        week_end=$((week_start + 6))
        
        # 獲取該週的備份
        backups=($(find "$BACKUP_ROOT" -name "auto_*.tar.gz" -mtime +$week_start -mtime -$week_end -type f | sort -r))
        
        if [ ${#backups[@]} -gt 1 ]; then
            # 保留第一個（最新的），刪除其他
            for ((i=1; i<${#backups[@]}; i++)); do
                log_info "刪除每週多餘備份：$(basename "${backups[$i]}")"
                rm -f "${backups[$i]}"
                ((deleted_count++))
            done
        fi
    done
    
    # 處理 31-180 天的備份（每月保留一個）
    log_info "處理 31-180 天的備份（每月保留一個）..."
    for month in {1..5}; do
        month_start=$((30 + (month - 1) * 30))
        month_end=$((month_start + 29))
        
        backups=($(find "$BACKUP_ROOT" -name "auto_*.tar.gz" -mtime +$month_start -mtime -$month_end -type f | sort -r))
        
        if [ ${#backups[@]} -gt 1 ]; then
            for ((i=1; i<${#backups[@]}; i++)); do
                log_info "刪除每月多餘備份：$(basename "${backups[$i]}")"
                rm -f "${backups[$i]}"
                ((deleted_count++))
            done
        fi
    done
    
    # 統計當前備份
    kept_count=$(find "$BACKUP_ROOT" -name "auto_*.tar.gz" -type f | wc -l)
    
    log_success "清理完成！已刪除：$deleted_count 個，保留：$kept_count 個"
    
    # 顯示磁碟使用量
    BACKUP_TOTAL_SIZE=$(du -sh "$BACKUP_ROOT" 2>/dev/null | cut -f1)
    log_info "備份總大小：$BACKUP_TOTAL_SIZE"
}

# ============================================================================
# 檢查磁碟空間
# ============================================================================

check_disk_space() {
    # 獲取備份目錄所在分區的可用空間（單位：MB）
    AVAILABLE_SPACE=$(df -m "$BACKUP_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')
    
    if [ -z "$AVAILABLE_SPACE" ]; then
        log_warning "無法檢查磁碟空間"
        return 0
    fi
    
    # 如果可用空間小於 1GB，發出警告
    if [ "$AVAILABLE_SPACE" -lt 1024 ]; then
        log_warning "磁碟空間不足！可用空間：${AVAILABLE_SPACE}MB"
        
        # 如果小於 500MB，不執行備份
        if [ "$AVAILABLE_SPACE" -lt 500 ]; then
            log_error "磁碟空間嚴重不足（< 500MB），取消備份"
            return 1
        fi
    fi
    
    return 0
}

# ============================================================================
# 驗證備份完整性
# ============================================================================

verify_backup() {
    local backup_file="$1"
    
    if [ ! -f "$backup_file" ]; then
        log_error "備份檔案不存在：$backup_file"
        return 1
    fi
    
    # 測試壓縮檔案完整性
    tar -tzf "$backup_file" > /dev/null 2>&1
    
    if [ $? -eq 0 ]; then
        log_success "備份檔案驗證通過：$(basename "$backup_file")"
        return 0
    else
        log_error "備份檔案損壞：$(basename "$backup_file")"
        return 1
    fi
}

# ============================================================================
# 主程式
# ============================================================================

main() {
    # 檢查是否以 root 執行（建議但非必須）
    if [ "$EUID" -ne 0 ]; then
        log_warning "建議使用 sudo 執行以確保權限正確"
    fi
    
    # 創建日誌檔案（如果不存在）
    touch "$LOG_FILE" 2>/dev/null || LOG_FILE="/tmp/folder-permission-system-backup.log"
    
    # 檢查磁碟空間
    if ! check_disk_space; then
        exit 1
    fi
    
    # 執行備份
    if perform_backup; then
        # 驗證最新的備份
        LATEST_BACKUP=$(find "$BACKUP_ROOT" -name "auto_*.tar.gz" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2)
        
        if [ -n "$LATEST_BACKUP" ]; then
            verify_backup "$LATEST_BACKUP"
        fi
        
        # 清理舊備份
        cleanup_old_backups
        
        log "=========================================="
        log "備份作業完成"
        log "=========================================="
        
        exit 0
    else
        log_error "備份作業失敗"
        exit 1
    fi
}

# 執行主程式
main

