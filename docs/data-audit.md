# 資料健檢（唯讀）

檢查資料庫、資料夾、人員、群組、權限、申請單之間的關聯是否一致。**只讀、不修改任何資料。**

## 為什麼需要

資料表雖然宣告了外鍵，但應用程式從未啟用（`PRAGMA foreign_keys` 為 0），也沒有唯一性與合法值限制。
實測確認：刪除群組／人員不會清除成員關聯、可以建立指向不存在資料夾的權限、可以重複新增同一筆權限、
可以建立同名群組。舊資料裡可能已經累積了這些問題。

要加唯一索引、開外鍵、統一有效權限規則之前，必須先知道實際有多少、在哪裡——這就是這支腳本的用途。

## 執行

在應用程式目錄、用跟服務相同的帳號執行（才讀得到資料庫檔）：

```bash
cd /opt/dms-dev
sudo -u <服務帳號> node scripts/data-audit.js
```

| 參數 | 說明 |
|---|---|
| `--dir <路徑>` | 資料庫目錄，預設 `./databases` |
| `--only a.db,b.db` | 只檢查指定的資料庫 |
| `--samples N` | 每項顯示的樣本筆數，預設 5 |
| `--json` | 輸出 JSON（可存檔比對、串接監控） |
| `--strict` | 有「問題」級項目時結束碼為 1（可用於排程告警） |

結束碼：0 正常；1 `--strict` 且有問題；3 有資料庫無法開啟。

**用哪個帳號跑**：建議用服務帳號。若用別的帳號、且對資料庫目錄沒有寫入權限，WAL 模式的資料庫無法以唯讀連線開啟
（`SQLITE_READONLY`）。這時腳本會自動改用「暫存快照」：把資料庫複製到權限 700 的暫存目錄、對副本檢查、檢查完立刻刪除
（Ctrl+C 中斷也會清掉），原檔與原目錄完全不碰；輸出會在該資料庫旁標註〔以暫存快照檢查〕。
快照是檢查當下的複製，若有人同時在寫入，結果可能與下一秒的狀態略有出入，不影響判斷。

**不想更新整個應用程式也能先跑**：只需要把 `lib/data-audit.js`、`lib/db.js`、`scripts/data-audit.js`
三個檔案複製到主機上對應的位置（`lib/`、`scripts/` 目錄），主機原有的 `node_modules/sqlite3` 就夠用。

## 源頭已修正（之後不會再長出來）

正式環境的稽核發現這些問題在持續產生，程式已修正（有自動化測試）：

| 問題 | 原因 | 現在的行為 |
|---|---|---|
| 群組成員孤兒（17 個資料庫、約 1,800 筆） | 單筆與批次刪除群組／人員都沒有清除成員關聯 | 刪除時在同一個交易內一併清除成員關聯，並把以該對象為目標的待審核申請單自動駁回 |
| 重複群組（最多 154 組） | 匯入與自動生成用 `INSERT OR IGNORE`，但群組名稱沒有唯一限制，永遠不會被忽略 | 建立、改名、匯入、自動生成都先以名稱（不分大小寫）檢查，已存在就重用或回 409 |
| 重複權限、read 與 write 並存 | 同上；自動生成的檢查還把「類型」算進鍵值，群組已有相反類型的權限時會再多塞一筆 | 同一資料夾、同一對象只能有一筆（不分類型）；匯入與自動生成遇到已存在就略過，類型不同只記錄警告、不自動改 |
| 非法的權限類型、對象不明確、指向不存在的資料夾／人員 | 新增權限的 API 完全沒有驗證 | 類型只收 `read`／`write`；人員與群組必須剛好指定一個；資料夾與對象必須存在；重複回 409 |
| 刪除資料夾後留下待審核申請單 | 沒有處理 | 刪除資料夾（含強制刪除整棵子樹）前先自動駁回該子樹上待審核的申請單 |

**舊資料不會被自動修正**：上面的問題在既有資料庫裡已經存在的部分，仍需要用健檢找出來、確認後清理。

## 結果怎麼看

三種等級：

- **問題（error）**：資料已經不一致，會造成錯誤的權限判斷或匯出結果
- **警告（warn）**：有疑慮，建議處理
- **提示（info）**：僅供參考，不一定要改

| 項目 id | 等級 | 意思 | 怎麼處理 |
|---|---|---|---|
| `group_users.orphan_group` / `orphan_user` | 問題 | 成員紀錄指向已刪除的群組／人員 | 可安全刪除（SQL 見下） |
| `permissions.orphan_folder` / `orphan_user` / `orphan_group` | 問題 | 權限指向不存在的對象 | 確認後刪除 |
| `permissions.bad_type` | 問題 | 權限類型不是 read／write | 人工判斷改成哪一種或刪除 |
| `permissions.bad_target` | 問題 | 人員與群組同時指定，或都沒指定 | 人工判斷拆成兩筆或刪除 |
| `permissions.duplicate` | 問題 | 同資料夾、同對象有多筆 | 保留一筆；`types` 有 read,write 並存時要先決定保留哪個 |
| `folders.orphan_parent` / `cycle` | 問題 | 父層不存在／父子成環 | 改掛到正確父層，或把循環中其中一個改為根層 |
| `folders.path_mismatch` | 警告 | 儲存的路徑與實際階層不一致 | 由階層重新計算（SQL 見下） |
| `folders.duplicate_sibling` | 警告 | 同層同名資料夾 | 多半是重複匯入；合併前先搬移權限 |
| `folders.bad_name` | 警告 | 名稱含 `\ / : * ? " < > \|` 或首尾空白／結尾句點 | 改名；否則產生腳本會出錯 |
| `groups.duplicate_name` | 警告 | 同名（不分大小寫）群組 | 合併前先確認各自的成員與權限 |
| `users.duplicate_email` / `duplicate_account_key` | 警告 | 只有大小寫不同的重複 | 很可能是同一個人建立兩次 |
| `permissions.direct_vs_group` | 警告 | 同人同資料夾，個人權限與群組權限不一致 | 見下方「有效權限規則」 |
| `requests.orphan_*` | 警告 | 申請單的資料夾／對象已不存在 | 待審核的請駁回，否則核准時會寫出孤兒權限 |
| `requests.stale_pending` | 警告 | 待審核超過 30 天 | 審核或駁回 |
| `requests.applied_missing` | 警告 | 已核准的申請單所套用的權限已不存在 | 僅供稽核參考 |
| `requests.bad_status` | 問題 | 狀態不是 pending／approved／rejected | 人工判斷 |
| `accounts.missing_user_database` | 問題 | 帳號的預設資料庫檔案不存在 | 該帳號登入會失敗；恢復檔案或改指派 |
| `accounts.allowed_database_missing` | 警告 | 可存取清單含不存在的資料庫 | 整理清單 |
| `accounts.allowed_databases_invalid` | 問題 | 可存取欄位不是合法 JSON 陣列 | 該帳號會被視為沒有任何資料庫 |
| `accounts.prefix_clash` | 問題 | 帳號名稱互為底線前綴（如 `a` 與 `a_b`） | 其中一個改名，否則個人資料庫歸屬會混淆 |
| `databases.registry_missing_file` | 警告 | 登記表有登記但檔案不存在 | 從登記表移除 |
| `databases.unregistered_file` | 提示 | 檔案存在但沒登記 | 服務啟動時會自動補登記 |
| `groups.unused` / `users.unused` | 提示 | 沒有成員與權限的群組／沒有群組與權限的人員 | 視需要清理 |
| `schema.missing_indexes` | 提示 | 缺少常用查詢的索引（僅針對有資料的表） | 建立索引不改變資料 |
| `schema.empty_accounts` | 提示 | 租戶資料庫內有永遠是空的 `accounts` 表 | 歷史遺留，可日後移除 |

### 有效權限規則（`permissions.direct_vs_group`）

目前系統「個人直接權限優先」：同一個人在同一資料夾若同時有個人權限與群組權限，只採用個人權限。
這和 AD／NTFS 的直覺（取最高值）不同。

腳本會告訴你有幾筆是「個人 read、群組 write」——若之後把規則改成「取最高值」，這些人的實際權限會**變高**，
需要先和使用者確認。若這項是 0，改規則就沒有任何人受影響。

## 清理工具（`scripts/data-clean.js`）

把健檢發現、且**有明確規則**的問題自動修正。**預設只預覽，不修改任何資料。**

```bash
cd /opt/dms-dev
sudo -u <服務帳號> node scripts/data-clean.js                      # 預覽全部資料庫（不修改）
sudo -u <服務帳號> node scripts/data-clean.js --only paul_test.db  # 只預覽一個
sudo -u <服務帳號> node scripts/data-clean.js --only paul_test.db --apply --yes   # 套用
```

套用時每個資料庫：先用 `VACUUM INTO` 備份（預設 `./backups/data-clean/`，目錄 700、檔案 600，並驗證備份可開啟）
→ 在**單一交易**內修正 → 任何一步失敗整個回復 → 套用後立刻重新健檢並顯示剩下的項目。
沒有變更的資料庫不備份、不寫入；再跑一次是冪等的。備份失敗（例如空間不足）時，該資料庫完全不會被修改。
需要用服務帳號執行（要有寫入權限）；服務正在執行時也可以做，但請避開大量編輯的時段。

| `--fix` 項目 | 做什麼 | 規則 |
|---|---|---|
| `orphans` | 刪除孤兒成員、指向不存在對象的權限 | 沒有對應對象，無法生效 |
| `duplicate-permissions` | 合併同資料夾同對象的重複權限 | 類型相同 → 保留最早一筆；read 與 write 並存 → **依群組名稱後綴**：`_RW` 留 write、`_RO` 留 read（一律往名稱的語意走，因此一定不會比名稱承諾的更高）；沒有後綴或對象是人員 → 不動，列入人工處理 |
| `permission-types` | `RO`／`RW`（含大小寫）→ `read`／`write` | 其他不認得的值不動 |
| `paths` | 由階層重新計算資料夾路徑 | 循環中的資料夾不動 |
| `unused-duplicate-groups` | 刪除同名群組中**沒有成員、沒有權限、沒有申請單**的多餘複本 | 每個名稱至少保留一組；兩組以上都有資料 → 人工處理 |
| `unused-duplicate-folders` | 刪除同層同名資料夾中**沒有子資料夾、沒有權限、沒有申請單**的多餘複本 | 每組至少保留一個；兩個以上都有資料 → 人工處理 |
| `allowed-databases` | 只對 `system.db`：移除帳號可存取清單中檔案已不存在的資料庫名稱 | 不是合法 JSON 的不動；`--fix` 不指定時預設包含 |

`--fix safe`（預設）等於以上全部；也可只指定其中幾項，例如 `--fix orphans,paths`。

**這支工具預設不會處理（只列出完整清單供你判斷）：** 兩組以上都有資料的同名群組或同名資料夾（要合併請用下面的 `--fix merge`）、
類型不同且無法判斷的重複權限、不認得的權限類型、資料夾名稱含 `/` 等非法字元、循環、帳號名稱互為底線前綴、
`permissions.direct_vs_group`（要先決定有效權限規則）。

### 合併重複的群組與資料夾（選用：`--fix merge`）

同名群組、同層同名資料夾「兩份以上都在使用」（通常是同一份資料匯入兩次，之後各自又被加了成員或權限）時，
預設的 `safe` 只會列入人工處理。確認要合併時改用 `--fix merge`（不在 `safe` 內，不會誤跑）：

```bash
sudo "$(which node)" scripts/data-clean.js --only user_sean_心心.db --fix merge                # 先預覽
sudo "$(which node)" scripts/data-clean.js --only user_sean_心心.db --fix merge --apply --yes  # 再套用（同樣先備份、單一交易）
```

| `--fix` 項目 | 做什麼 | 規則 |
|---|---|---|
| `merge-groups` | 同名（不分大小寫）群組合併成一組 | 保留**編號最小**的一組；成員取聯集；其餘的權限搬進來，已有相同的就刪掉重複；指向被併入群組的申請單改指向保留的那組 |
| `merge-folders` | 同層同名資料夾合併成一個 | 保留**編號最小**的一個；子資料夾搬進來（搬進來後若與既有子資料夾同名，會繼續往下合併）、權限同上去重；申請單改指向保留的那個 |

- **預覽就是實際會做的事**（同一份計畫）。群組合併會列出「**新增成員**」姓名：原本只在被併入群組裡的人，合併後會取得保留群組的全部權限，
  請確認這是你要的。
- **類型衝突**（同一個對象在同一資料夾，一份是 read、一份是 write）：只有群組名稱以 `_RW`／`_RO` 結尾才會自動決定（理由同上，往名稱的語意走）；
  否則**整組原封不動**，列入人工處理，不會替你決定誰該有寫入權限。
- 合併不改路徑（同層同名的路徑本來就相同）；要順便重算路徑可用 `--fix merge,paths`。
- 只在資料庫內合併，**不會動檔案伺服器**。

### 建議的上線流程

1. **預覽並閱讀**：`node scripts/data-clean.js > clean-preview.txt`，特別看「重複權限」的每一筆決定（保留哪筆、刪哪筆、依據）。
2. **用複本演練**（不碰正式資料）。複本要屬於你執行工具的帳號，否則會因沒有寫入權限而被拒絕（什麼都不會被改）：
   ```bash
   sudo cp -a databases /tmp/dbcopy
   sudo chown -R "$(id -un)": /tmp/dbcopy && chmod 700 /tmp/dbcopy   # 複本屬於你、且不讓其他人讀
   sudo rm -f /tmp/dbcopy/*-shm                                       # 清掉複製來的共用記憶體檔，開啟時會重建
   node scripts/data-clean.js --dir /tmp/dbcopy --backup-dir /tmp/dbcopy-bak --apply --yes
   node scripts/data-audit.js --dir /tmp/dbcopy
   ```
   演練完請刪除：`rm -rf /tmp/dbcopy /tmp/dbcopy-bak`（裡面是完整的客戶資料）。
3. **正式套用**：先挑測試用的資料庫（例如 `paul_test.db`、`test.db`），確認沒問題再一個個做；最後才做 `system.db`。
4. **保留備份**：確認使用者回報正常後再刪除 `backups/data-clean/`。
5. 全部清零（只剩人工處理的項目）後，才進一步加上唯一索引與外鍵。

### 手動清理語句（沒有這支工具時的備案）

請先備份該資料庫檔案（服務執行中可用 `sqlite3 <db> ".backup '<備份檔>'"`）。以下語句已在測試資料上驗證過：

```sql
-- 1) 孤兒成員
DELETE FROM group_users
 WHERE group_id NOT IN (SELECT id FROM groups) OR user_id NOT IN (SELECT id FROM users);

-- 2) 指向不存在對象的權限
DELETE FROM permissions
 WHERE folder_id NOT IN (SELECT id FROM folders)
    OR (user_id  IS NOT NULL AND user_id  NOT IN (SELECT id FROM users))
    OR (group_id IS NOT NULL AND group_id NOT IN (SELECT id FROM groups));

-- 3) 完全相同（同資料夾、同對象、同類型）的重複權限：保留最早一筆
DELETE FROM permissions
 WHERE id NOT IN (SELECT MIN(id) FROM permissions GROUP BY folder_id, user_id, group_id, permission_type);

-- 4) 由階層重新計算所有資料夾路徑（循環中的資料夾不會被更新）
WITH RECURSIVE t(id, p) AS (
  SELECT id, '/' || name FROM folders WHERE parent_id IS NULL
  UNION ALL SELECT f.id, t.p || '/' || f.name FROM folders f JOIN t ON f.parent_id = t.id)
UPDATE folders SET path = (SELECT p FROM t WHERE t.id = folders.id) WHERE id IN (SELECT id FROM t);
```

其餘項目（非法權限類型、對象不明確、不同類型的重複權限、循環、同名群組／資料夾）需要人工判斷，
腳本只列出樣本與建議，不提供自動清理。

清理完再跑一次健檢確認；全部清零後，才適合進一步加上唯一索引與外鍵。
