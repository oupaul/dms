#!/bin/bash

# ============================================================================
# 資料夾權限管理系統 - 自動更新腳本
# ============================================================================
#
# 功能：從 GitHub 拉取最新程式碼、視需要安裝相依套件，並重新啟動服務
# 前提：此應用目錄必須是 git clone 下來的工作目錄（deploy.sh 部署時保留 .git）
# 服務管理：自動偵測 systemd（/etc/systemd/system/$APP_NAME.service）或 PM2，
#           兩種部署方式（deploy.sh 的新舊版本）都能用同一支腳本更新
#
# 使用方法：
#   ./update.sh                    # 更新目前所在分支
#   ./update.sh <branch>           # 更新指定分支（例如 main）
#   ./update.sh <branch> --force   # 若有未提交的本機變更，自動 stash 後繼續
#   ./update.sh --skip-backup      # 更新前不執行資料庫備份
#
# 注意：整支腳本包在 main() 函式裡、最後才呼叫，是刻意的寫法——
# 腳本執行中途會對自己所在的 repo 做 git merge，如果邏輯直接寫在
# 檔案最外層，bash 有可能邊執行邊分批讀檔，git merge 把檔案內容換掉後，
# 剩下還沒執行到的部分可能讀到新舊版本混雜的內容而出現難以追查的錯誤。
# 包成函式後，bash 會在呼叫 main 之前就把整個函式主體解析完畢存進記憶體，
# 之後就算檔案在磁碟上被覆寫，也不會影響已經在執行中的這一份。
# ============================================================================

main() {

set -e
trap 'last_command=$current_command; current_command=$BASH_COMMAND' DEBUG
trap 'echo -e "${RED}❌ 更新失敗於命令：$last_command${NC}"' ERR

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ============================================================================
# 解析參數
# ============================================================================

BRANCH=""
FORCE=false
SKIP_BACKUP=false

for arg in "$@"; do
    case "$arg" in
        --force) FORCE=true ;;
        --skip-backup) SKIP_BACKUP=true ;;
        --help|-h)
            echo "使用方法：./update.sh [branch] [--force] [--skip-backup]"
            exit 0
            ;;
        *) BRANCH="$arg" ;;
    esac
done

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║       資料夾權限管理系統 - 自動更新                           ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# ============================================================================
# 步驟 1: 定位應用程式目錄
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR"
cd "$APP_DIR"

echo "應用目錄：$APP_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
    echo -e "${RED}❌ 此目錄不是 git 工作目錄（找不到 .git）${NC}"
    echo "   請確認部署時是使用 'git clone' 取得程式碼，而非直接複製檔案。"
    exit 1
fi

if ! command -v git &> /dev/null; then
    echo -e "${RED}❌ 找不到 git 指令，請先安裝：sudo apt install -y git${NC}"
    exit 1
fi

if [ -z "$BRANCH" ]; then
    BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi

APP_NAME="$(basename "$APP_DIR")"

# 偵測服務管理方式：優先判斷是否已有對應的 systemd service，其次才看 pm2
if systemctl list-unit-files 2>/dev/null | grep -q "^${APP_NAME}\.service"; then
    SERVICE_MODE="systemd"
elif command -v pm2 &> /dev/null; then
    SERVICE_MODE="pm2"
else
    echo -e "${RED}❌ 找不到 ${APP_NAME}.service 的 systemd 服務，也沒有安裝 pm2${NC}"
    echo "   請確認服務名稱（資料夾名稱）與 systemd/pm2 上註冊的服務名稱一致。"
    exit 1
fi

echo "目標分支：$BRANCH"
echo "服務名稱：$APP_NAME"
echo "服務管理方式：$SERVICE_MODE"
echo ""

# ============================================================================
# 步驟 2: 檢查未提交的本機變更
# ============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步驟 1/5: 檢查本機變更"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 執行期資料目錄一律排除在檢查之外：這些目錄理論上都在 .gitignore 內，
# 但萬一被意外加進 git 索引（例如用 git checkout <ref> -- databases/ 這類指令
# 搶救資料時的副作用），也不該讓資料庫的日常寫入卡住每次更新
RUNTIME_DATA_EXCLUDES=(
    ':(exclude)databases/'
    ':(exclude)node_modules/'
    ':(exclude)uploads/'
    ':(exclude)logs/'
    ':(exclude)backups/'
)

if [ -n "$(git status --porcelain -- . "${RUNTIME_DATA_EXCLUDES[@]}")" ]; then
    if [ "$FORCE" = true ]; then
        echo -e "${YELLOW}⚠️  偵測到未提交的本機變更，因 --force 自動暫存 (git stash)${NC}"
        git stash push -u -m "update.sh auto-stash $(date +%Y%m%d_%H%M%S)"
    else
        echo -e "${RED}❌ 偵測到未提交的本機變更，為避免遺失資料已中止更新：${NC}"
        git status --short -- . "${RUNTIME_DATA_EXCLUDES[@]}"
        echo ""
        echo "請先手動處理（git stash / git commit），或加上 --force 讓腳本自動暫存後再更新。"
        exit 1
    fi
else
    echo "✅ 工作目錄乾淨，無未提交變更"
fi
echo ""

# ============================================================================
# 步驟 3: 拉取最新程式碼
# ============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步驟 2/5: 從 GitHub 拉取最新程式碼"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

OLD_COMMIT="$(git rev-parse HEAD)"

git fetch origin "$BRANCH"

if ! git rev-parse --verify "$BRANCH" &> /dev/null; then
    git checkout -b "$BRANCH" "origin/$BRANCH"
else
    git checkout "$BRANCH"
fi

# 只允許 fast-forward，避免在正式環境自動產生 merge commit 或覆蓋分歧的歷史
if ! git merge --ff-only "origin/$BRANCH"; then
    echo -e "${RED}❌ 無法快轉合併（本機分支與 origin/$BRANCH 已分歧）${NC}"
    echo "   請手動檢查後再處理（例如：git log --oneline HEAD..origin/$BRANCH）"
    exit 1
fi

NEW_COMMIT="$(git rev-parse HEAD)"

if [ "$OLD_COMMIT" = "$NEW_COMMIT" ]; then
    echo "✅ 目前已是最新版本，無需更新"
    echo "   目前版本：$(git log -1 --oneline)"
    exit 0
fi

echo "✅ 已更新："
echo "   舊版本：$(git log -1 --oneline "$OLD_COMMIT")"
echo "   新版本：$(git log -1 --oneline "$NEW_COMMIT")"
echo ""
echo "本次變更："
git log --oneline "$OLD_COMMIT".."$NEW_COMMIT"
echo ""

# ============================================================================
# 步驟 4: 視需要安裝相依套件
# ============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步驟 3/5: 檢查相依套件"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if git diff --name-only "$OLD_COMMIT" "$NEW_COMMIT" | grep -qE '^package(-lock)?\.json$'; then
    echo "偵測到 package.json / package-lock.json 變更，執行 npm install..."
    npm install --omit=dev
else
    echo "✅ 相依套件未變更，略過 npm install"
fi
echo ""

# ============================================================================
# 步驟 5: 更新前備份資料庫（安全網）
# ============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步驟 4/5: 更新前資料庫備份"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$SKIP_BACKUP" = true ]; then
    echo "已指定 --skip-backup，略過備份"
elif [ -x "$APP_DIR/backup_databases.sh" ]; then
    echo "執行 backup_databases.sh..."
    "$APP_DIR/backup_databases.sh" || echo -e "${YELLOW}⚠️  備份腳本執行失敗，但不中斷更新流程${NC}"
else
    echo -e "${YELLOW}⚠️  找不到可執行的 backup_databases.sh，略過備份${NC}"
fi
echo ""

# ============================================================================
# 步驟 6: 重新啟動服務
# ============================================================================

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步驟 5/5: 重新啟動服務"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$SERVICE_MODE" = "systemd" ]; then
    echo "重新啟動 systemd 服務 (systemctl restart $APP_NAME)..."
    sudo systemctl restart "$APP_NAME" || true
    sleep 3

    echo ""
    sudo systemctl status "$APP_NAME" --no-pager -l || true

    if systemctl is-active --quiet "$APP_NAME"; then
        HEALTHY=true
    else
        HEALTHY=false
    fi
else
    if pm2 list | grep -q "$APP_NAME"; then
        echo "以零停機方式重新載入服務 (pm2 reload $APP_NAME)..."
        pm2 reload "$APP_NAME"
    elif [ -f "ecosystem.config.js" ]; then
        echo "服務尚未啟動，使用 ecosystem.config.js 啟動..."
        pm2 start ecosystem.config.js
    else
        echo "服務尚未啟動，直接以 app.js 啟動..."
        pm2 start app.js --name "$APP_NAME"
    fi

    pm2 save
    sleep 3

    echo ""
    pm2 status

    if pm2 list | grep -q "online.*$APP_NAME\|$APP_NAME.*online"; then
        HEALTHY=true
    else
        HEALTHY=false
    fi
fi

if [ "$HEALTHY" = true ]; then
    echo ""
    echo -e "${GREEN}✅ 更新完成，服務運作正常${NC}"
else
    echo ""
    if [ "$SERVICE_MODE" = "systemd" ]; then
        echo -e "${RED}❌ 服務似乎未正常啟動，請檢查日誌：journalctl -u $APP_NAME -n 50 --no-pager${NC}"
        echo "   如需回復到更新前版本：git reset --hard $OLD_COMMIT && sudo systemctl restart $APP_NAME"
    else
        echo -e "${RED}❌ 服務似乎未正常啟動，請檢查日誌：pm2 logs $APP_NAME --err${NC}"
        echo "   如需回復到更新前版本：git reset --hard $OLD_COMMIT && pm2 reload $APP_NAME"
    fi
    exit 1
fi

echo ""
if [ "$SERVICE_MODE" = "systemd" ]; then
    echo "查看日誌：journalctl -u $APP_NAME -f"
    echo "查看狀態：systemctl status $APP_NAME"
else
    echo "查看日誌：pm2 logs $APP_NAME"
    echo "查看狀態：pm2 status"
fi
echo ""

}

main "$@"
