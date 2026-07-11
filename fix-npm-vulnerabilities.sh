#!/bin/bash

# ============================================================================
# NPM 安全漏洞自動修復腳本
# ============================================================================
# 用途：自動檢查並修復 npm 套件的安全漏洞
# 使用：./fix-npm-vulnerabilities.sh
# ============================================================================

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 日誌函數
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_header() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$1"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
}

# ============================================================================
# 主程式
# ============================================================================

print_header "NPM 安全漏洞修復工具"

echo "此腳本將幫助您修復 npm 套件的安全漏洞"
echo ""

# 檢查是否在專案目錄
if [ ! -f "package.json" ]; then
    log_error "找不到 package.json，請在專案根目錄執行此腳本"
    exit 1
fi

log_success "找到 package.json"
echo ""

# ============================================================================
# 步驟 1: 檢查當前漏洞
# ============================================================================

print_header "步驟 1/6: 檢查當前漏洞"

log_info "執行安全審計..."
npm audit

echo ""
read -p "是否繼續修復？(y/N) " -r
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_info "已取消"
    exit 0
fi

# ============================================================================
# 步驟 2: 備份
# ============================================================================

print_header "步驟 2/6: 備份當前狀態"

BACKUP_DIR="../npm-fix-backup-$(date +%Y%m%d_%H%M%S)"

log_info "創建備份目錄：$BACKUP_DIR"
mkdir -p "$BACKUP_DIR"

if [ -f "package.json" ]; then
    cp package.json "$BACKUP_DIR/"
    log_success "已備份 package.json"
fi

if [ -f "package-lock.json" ]; then
    cp package-lock.json "$BACKUP_DIR/"
    log_success "已備份 package-lock.json"
fi

if [ -d "node_modules" ]; then
    log_info "備份 node_modules（這可能需要一些時間）..."
    cp -r node_modules "$BACKUP_DIR/"
    log_success "已備份 node_modules"
fi

echo ""
log_info "備份已保存到：$BACKUP_DIR"
echo ""

# ============================================================================
# 步驟 3: 選擇修復方式
# ============================================================================

print_header "步驟 3/6: 選擇修復方式"

echo "請選擇修復方式："
echo ""
echo "1) 自動修復（安全，僅修復補丁版本）"
echo "2) 強制修復（可能包含破壞性更新）"
echo "3) 完全重新安裝（清理後重新安裝）"
echo "4) 手動更新所有套件到最新版本"
echo ""

while true; do
    read -p "請選擇 [1-4]: " choice
    case $choice in
        1)
            FIX_MODE="auto"
            log_info "將執行：npm audit fix"
            break
            ;;
        2)
            FIX_MODE="force"
            log_warning "強制修復可能導致破壞性更新！"
            read -p "確定要繼續嗎？(y/N) " -r
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                log_info "將執行：npm audit fix --force"
                break
            else
                continue
            fi
            ;;
        3)
            FIX_MODE="clean"
            log_warning "將刪除 node_modules 和 package-lock.json"
            read -p "確定要繼續嗎？(y/N) " -r
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                log_info "將執行：清理並重新安裝"
                break
            else
                continue
            fi
            ;;
        4)
            FIX_MODE="update"
            log_warning "將更新所有套件到最新版本"
            read -p "確定要繼續嗎？(y/N) " -r
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                log_info "將執行：npm update --save"
                break
            else
                continue
            fi
            ;;
        *)
            log_error "無效的選擇，請重新輸入"
            ;;
    esac
done

echo ""

# ============================================================================
# 步驟 4: 執行修復
# ============================================================================

print_header "步驟 4/6: 執行修復"

case $FIX_MODE in
    auto)
        log_info "執行自動修復..."
        npm audit fix
        
        if [ $? -eq 0 ]; then
            log_success "自動修復完成"
        else
            log_error "自動修復失敗"
            exit 1
        fi
        ;;
        
    force)
        log_info "執行強制修復..."
        npm audit fix --force
        
        if [ $? -eq 0 ]; then
            log_success "強制修復完成"
        else
            log_error "強制修復失敗"
            exit 1
        fi
        ;;
        
    clean)
        log_info "刪除 node_modules..."
        rm -rf node_modules
        
        log_info "刪除 package-lock.json..."
        rm -f package-lock.json
        
        log_info "清理 npm 緩存..."
        npm cache clean --force
        
        log_info "重新安裝套件..."
        npm install
        
        if [ $? -eq 0 ]; then
            log_success "重新安裝完成"
            
            log_info "執行自動修復..."
            npm audit fix
        else
            log_error "重新安裝失敗"
            exit 1
        fi
        ;;
        
    update)
        log_info "更新所有套件..."
        npm update --save
        
        if [ $? -eq 0 ]; then
            log_success "套件更新完成"
            
            log_info "執行自動修復..."
            npm audit fix
        else
            log_error "套件更新失敗"
            exit 1
        fi
        ;;
esac

echo ""

# ============================================================================
# 步驟 5: 驗證修復結果
# ============================================================================

print_header "步驟 5/6: 驗證修復結果"

log_info "執行安全審計..."
AUDIT_OUTPUT=$(npm audit 2>&1)

echo "$AUDIT_OUTPUT"
echo ""

if echo "$AUDIT_OUTPUT" | grep -q "found 0 vulnerabilities"; then
    log_success "🎉 所有漏洞已修復！"
    VULNERABILITIES_FIXED=true
else
    log_warning "仍有部分漏洞未修復"
    VULNERABILITIES_FIXED=false
fi

echo ""

# ============================================================================
# 步驟 6: 測試應用
# ============================================================================

print_header "步驟 6/6: 測試應用"

log_info "建議在部署前進行以下測試："
echo ""
echo "1. 啟動應用："
echo "   npm start"
echo ""
echo "2. 測試主要功能："
echo "   - 登入/登出"
echo "   - 人員管理"
echo "   - 資料夾管理"
echo "   - 群組管理"
echo "   - 權限管理"
echo "   - CSV 匯入/匯出"
echo ""

read -p "是否要立即啟動應用進行測試？(y/N) " -r
if [[ $REPLY =~ ^[Yy]$ ]]; then
    log_info "啟動應用..."
    npm start
fi

# ============================================================================
# 完成總結
# ============================================================================

echo ""
print_header "修復完成"

echo "📋 修復摘要："
echo ""
echo "  修復方式：$FIX_MODE"
echo "  備份位置：$BACKUP_DIR"

if [ "$VULNERABILITIES_FIXED" = true ]; then
    echo "  漏洞狀態：✅ 已全部修復"
else
    echo "  漏洞狀態：⚠️  仍有部分漏洞"
fi

echo ""
echo "📝 後續步驟："
echo ""

if [ "$VULNERABILITIES_FIXED" = false ]; then
    echo "1. 查看剩餘漏洞詳情："
    echo "   npm audit"
    echo ""
    echo "2. 手動檢查無法自動修復的漏洞"
    echo ""
fi

echo "3. 如果測試正常，可刪除備份："
echo "   rm -rf $BACKUP_DIR"
echo ""
echo "4. 如果出現問題，還原備份："
echo "   cp $BACKUP_DIR/package.json ."
echo "   cp $BACKUP_DIR/package-lock.json ."
echo "   rm -rf node_modules"
echo "   cp -r $BACKUP_DIR/node_modules ."
echo ""

log_success "腳本執行完成！"

exit 0

