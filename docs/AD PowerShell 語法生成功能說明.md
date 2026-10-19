# AD PowerShell 語法生成功能說明

## 📋 更新日期
2025-01-XX

## ✨ 功能概述

AD PowerShell 語法生成功能是管理員專用功能，可根據系統中的資料自動產生完整的 Active Directory PowerShell 語法，支援三種生成模式：人員、資料夾（群組）、資料夾群組成員。

---

## 🎯 功能特點

### 核心優勢

- ✅ **選擇性生成**：支援單選/複選，可選擇特定項目進行生成
- ✅ **OU 路徑自訂**：可手動輸入 OU 路徑，適應不同 AD 環境
- ✅ **單行指令**：生成的指令為完整單行，無需手動移除分行符號
- ✅ **群組名稱一致性**：資料夾生成的群組名稱與群組成員功能使用的名稱完全一致
- ✅ **即時複製**：生成的語法可直接複製到 PowerShell 執行

### 使用限制

- 僅限管理員使用
- 需要先載入對應的資料清單

---

## 📖 功能詳解

### 1. 人員生成（New-ADUser）

#### 功能說明

根據系統中的人員資料，產生建立 AD 使用者的 PowerShell 語法。

#### 使用步驟

1. **進入功能頁面**
   - 以管理員身份登入系統
   - 點擊導航列中的「AD PowerShell 語法生成」

2. **載入人員清單**
   - 在「人員」卡片中，點擊「載入人員清單」按鈕
   - 系統會載入所有人員資料並顯示複選框列表

3. **選擇人員**
   - 勾選需要生成的使用者
   - 可使用「全選」/「取消全選」按鈕快速操作
   - 即時顯示選擇計數（已選 / 總數）

4. **設定 OU 路徑（選填）**
   - 在「OU 路徑」輸入框中填入目標 OU 路徑
   - 範例：`OU=PN,DC=123456,DC=corp`
   - 留空則使用預設路徑：`OU=Users,DC=yourdomain,DC=com`

5. **生成語法**
   - 點擊「生成選中人員的語法」按鈕
   - 生成的語法會顯示在下方的輸出區域

#### 生成的指令格式

```powershell
# 產生 AD 使用者的 PowerShell 語法
# 共 5 位人員
# OU 路徑: OU=PN,DC=123456,DC=corp
# 注意：如果使用者已存在，會出現錯誤，請先檢查或使用 -ErrorAction SilentlyContinue

# 匯入 ActiveDirectory 模組（如果尚未匯入）
Import-Module ActiveDirectory -ErrorAction SilentlyContinue

# 建立使用者: 張三
New-ADUser -Name '張三' -SamAccountName 'zhang' -UserPrincipalName 'zhang@contoso.com.tw' -DisplayName '張三' -EmailAddress 'zhang@contoso.com.tw' -Department 'IT部' -Company 'contoso' -Path 'OU=PN,DC=123456,DC=corp' -Enabled $true -AccountPassword (ConvertTo-SecureString 'TempPassword123!' -AsPlainText -Force) -ChangePasswordAtLogon $true
```

#### 生成的欄位說明

| 欄位 | 來源 | 說明 |
|------|------|------|
| Name | 人員姓名 | 使用者顯示名稱 |
| SamAccountName | 帳號欄位（優先）／Email 前綴 | 優先用人員的「帳號」欄位（即登入時 `DOMAIN\username` 的 username）；沒填才從 Email 提取（如 `zhang@example.com` → `zhang`） |
| UserPrincipalName | Email | 完整 Email 地址 |
| DisplayName | 人員姓名 | 顯示名稱 |
| EmailAddress | Email | Email 地址 |
| Department | 部門 | 如有填寫 |
| Company | 公司 | 如有填寫 |
| Title | 職稱 | 如有填寫 |
| OfficePhone | 電話 | 如有填寫 |
| Description | 描述 | 如有填寫 |

#### 臨時密碼

- 「新使用者臨時密碼」欄位留空時，**每次生成都會自動產生一組隨機密碼**（16 字元，含大小寫、數字、符號），寫在語法標頭的註解裡；也可以自行輸入（請符合網域的密碼原則）
- 同一份語法裡的所有新使用者共用同一組臨時密碼，且一律設定 `-ChangePasswordAtLogon $true`（首次登入必須變更）
- 臨時密碼以明文出現在語法中：請用安全的方式轉交，建立帳號後刪除這份語法

#### 帳號格式提醒

產生器會在有問題的使用者前面加一行 `# ⚠ …` 註解（該行執行時會失敗）：

- SamAccountName 超過 20 字元，或含有 AD 不允許的字元（`" / \ [ ] : ; | = , + * ? < >`），或空白／句點結尾
- 同一份語法裡兩個人的帳號重複（不分大小寫）

#### 注意事項

- ⚠️ **UPN 唯一性**：如果使用者已存在，會出現「UPN value provided for addition/modification is not unique forest-wide」錯誤
- 💡 **解決方案**：
  - 先檢查使用者是否已存在
  - 或使用 `-ErrorAction SilentlyContinue` 參數忽略錯誤
  - 或修改 UserPrincipalName 使其唯一

---

### 2. 資料夾生成（New-ADGroup）

#### 功能說明

根據系統中的資料夾資料，產生建立 AD 群組的 PowerShell 語法。生成的群組名稱與系統群組名稱完全一致。

#### 使用步驟

1. **載入資料夾清單**
   - 點擊「載入資料夾清單」按鈕
   - 系統會載入所有資料夾並顯示複選框列表（依路徑排序）

2. **選擇資料夾**
   - 勾選需要生成群組的資料夾
   - 可使用「全選」/「取消全選」按鈕

3. **設定群組路徑（選填）**
   - 在「群組路徑」輸入框中填入目標路徑
   - 範例：`OU=Groups,DC=123456,DC=corp` 或 `DC=123456,DC=corp`
   - 留空則使用預設路徑：`DC=yourdomain,DC=com`

4. **生成語法**
   - 點擊「生成選中資料夾的語法」按鈕

#### 群組命名規則

系統會自動查找資料夾對應的群組：

1. **有對應群組**：使用系統中群組的實際名稱
   - 例如：資料夾 `/RD/Test` 對應群組 `RD_Test_RO`，則生成 `RD_Test_RO`

2. **無對應群組**：自動生成兩個群組
   - 格式：`資料夾路徑_RO` 和 `資料夾路徑_RW`
   - 例如：資料夾 `/RD/Test` 會生成 `RD_Test_RO` 和 `RD_Test_RW`

#### 生成的指令格式

```powershell
# 產生 AD 群組（Group）的 PowerShell 語法
# 共 3 個資料夾
# 群組路徑: DC=123456,DC=corp

# 匯入 ActiveDirectory 模組（如果尚未匯入）
Import-Module ActiveDirectory -ErrorAction SilentlyContinue

# 建立群組: RD_Test_RO (對應資料夾: Test)
New-ADGroup -Name 'RD_Test_RO' -GroupScope Global -GroupCategory Security -Path 'DC=123456,DC=corp' -Description '資料夾: /RD/Test'

# 建立群組: RD_Test_RW (對應資料夾: Test)
New-ADGroup -Name 'RD_Test_RW' -GroupScope Global -GroupCategory Security -Path 'DC=123456,DC=corp' -Description '資料夾: /RD/Test'
```

#### 群組參數說明

- **GroupScope**: `Global`（全域群組）
- **GroupCategory**: `Security`（安全性群組）
- **Path**: 指定的群組路徑
- **Description**: 資料夾路徑說明

---

### 3. 資料夾群組成員生成（Add-ADGroupMember）

#### 功能說明

根據系統中的權限和群組成員關係，產生將人員加入 AD 群組的 PowerShell 語法。

#### 使用步驟

1. **載入群組成員清單**
   - 點擊「載入群組成員清單」按鈕
   - 系統會載入所有資料夾-群組組合

2. **選擇組合**
   - 勾選需要的資料夾-群組組合
   - 顯示格式：`資料夾路徑 → 群組名稱`
   - 例如：`/RD/Test → RD_Test_RO`

3. **生成語法**
   - 點擊「生成選中群組成員的語法」按鈕

#### 生成的指令格式

```powershell
# 產生將人員加入 AD 群組的 PowerShell 語法
# 共 5 個資料夾-群組組合
# 請根據實際環境調整 Domain 和群組名稱格式

# 匯入 ActiveDirectory 模組（如果尚未匯入）
Import-Module ActiveDirectory -ErrorAction SilentlyContinue

# ========== 資料夾: /RD/Test ==========

# 群組: RD_Test_RO
Add-ADGroupMember -Identity 'RD_Test_RO' -Members 'zhang'
Add-ADGroupMember -Identity 'RD_Test_RO' -Members 'li'

# ========== 資料夾: /RA/DCC ==========

# 群組: RA_DCC_RW
Add-ADGroupMember -Identity 'RA_DCC_RW' -Members 'wang'
```

#### 輸出特點

- **按資料夾組織**：每個資料夾的群組成員會分組顯示
- **避免重複**：同一人員加入同一群組只會出現一次
- **使用實際群組名稱**：與系統中群組的實際名稱完全一致

#### 成員識別

- 與「人員生成」一致：優先使用人員的「帳號」欄位作為 SamAccountName，沒填才用 Email 前綴
- 例如：帳號欄位 `zhang.s`、Email `zhang@example.com` → `zhang.s`；帳號欄位空白 → `zhang`

---

## 🔧 技術細節

### 資料來源

| 功能 | 資料來源 API |
|------|-------------|
| 人員生成 | `/api/users` |
| 資料夾生成 | `/api/folders`, `/api/groups`, `/api/permissions` |
| 群組成員生成 | `/api/groups`, `/api/users`, `/api/permissions`, `/api/folders`, `/api/groups/:id/users` |

### 群組名稱對應邏輯

資料夾生成功能會自動查找對應的群組：

1. 查詢權限表（permissions），找出資料夾對應的群組 ID
2. 如果找到群組，使用群組的實際名稱（`group.name`）
3. 如果沒有找到，使用資料夾路徑生成群組名稱（與自動生成群組規則一致）

### 指令格式

所有生成的指令都是**單行格式**，不使用分行符號（`\`），可直接複製到 PowerShell 執行。

所有值（姓名、帳號、群組名稱、OU 路徑、描述…）一律以 **PowerShell 單引號字串**輸出。單引號字串不會展開 `$()`、`$變數` 與反引號，
所以名稱即使含有這些符號，也只是資料，不會被執行；值本身若含單引號，會重複兩次（`it's` → `'it''s'`）。
註解與值中的換行會被壓成空白，確保每個指令維持單行。這些規則有自動化測試，並用 PowerShell 的剖析器驗證。

---

## 📝 使用範例

### 範例 1：生成單一人員

**步驟：**
1. 載入人員清單
2. 選擇「張三」
3. 輸入 OU 路徑：`OU=PN,DC=123456,DC=corp`
4. 生成語法

**結果：**
```powershell
New-ADUser -Name '張三' -SamAccountName 'zhang' -UserPrincipalName 'zhang@contoso.com.tw' -DisplayName '張三' -EmailAddress 'zhang@contoso.com.tw' -Path 'OU=PN,DC=123456,DC=corp' -Enabled $true -AccountPassword (ConvertTo-SecureString 'TempPassword123!' -AsPlainText -Force) -ChangePasswordAtLogon $true
```

### 範例 2：生成多個資料夾的群組

**步驟：**
1. 載入資料夾清單
2. 選擇 `/RD/Test` 和 `/RA/DCC`
3. 輸入群組路徑：`DC=123456,DC=corp`
4. 生成語法

**結果：**
```powershell
# 建立群組: RD_Test_RO (對應資料夾: Test)
New-ADGroup -Name 'RD_Test_RO' -GroupScope Global -GroupCategory Security -Path 'DC=123456,DC=corp' -Description '資料夾: /RD/Test'

# 建立群組: RD_Test_RW (對應資料夾: Test)
New-ADGroup -Name 'RD_Test_RW' -GroupScope Global -GroupCategory Security -Path 'DC=123456,DC=corp' -Description '資料夾: /RD/Test'

# 建立群組: RA_DCC_RO (對應資料夾: DCC)
New-ADGroup -Name 'RA_DCC_RO' -GroupScope Global -GroupCategory Security -Path 'DC=123456,DC=corp' -Description '資料夾: /RA/DCC'
```

### 範例 3：生成群組成員

**步驟：**
1. 載入群組成員清單
2. 選擇 `/RD/Test → RD_Test_RO`
3. 生成語法

**結果：**
```powershell
# ========== 資料夾: /RD/Test ==========

# 群組: RD_Test_RO
Add-ADGroupMember -Identity 'RD_Test_RO' -Members 'zhang'
Add-ADGroupMember -Identity 'RD_Test_RO' -Members 'li'
```

---

## ⚠️ 注意事項

### 通用注意事項

1. **權限要求**
   - 僅限管理員使用
   - 執行 PowerShell 指令需要 AD 管理權限

2. **環境差異**
   - 生成的指令使用預設值，可能需要根據實際環境調整
   - OU 路徑、Domain 名稱等需要手動填入

3. **錯誤處理**
   - 如果使用者或群組已存在，會出現錯誤
   - 建議先檢查或使用 `-ErrorAction SilentlyContinue`

### 人員生成注意事項

- ⚠️ UPN 必須唯一：如果 UserPrincipalName 已存在，會出現錯誤
- 💡 建議：先查詢現有使用者，或修改 UPN

### 資料夾生成注意事項

- ✅ 群組名稱與系統群組名稱一致：確保後續群組成員生成功能正常運作
- 💡 如果資料夾沒有對應群組，會自動生成 RO 和 RW 兩個群組

### 群組成員生成注意事項

- ✅ 自動避免重複：同一人員加入同一群組只會出現一次
- 💡 按資料夾組織輸出，方便檢視和管理

---

## 🔍 故障排除

### 問題 1：人員列表無法顯示

**症狀：** 點擊「載入人員清單」後看不到複選框

**解決方案：**
1. 檢查瀏覽器 Console 是否有錯誤
2. 確認是否有人員資料
3. 重新整理頁面後再試

### 問題 2：生成的指令執行失敗

**症狀：** 複製指令到 PowerShell 執行時出現錯誤

**可能原因：**
- OU 路徑不正確
- 使用者或群組已存在
- 權限不足

**解決方案：**
1. 檢查 OU 路徑是否正確
2. 先查詢現有物件：`Get-ADUser -Filter *` 或 `Get-ADGroup -Filter *`
3. 確認執行 PowerShell 的帳號有足夠權限

### 問題 3：群組名稱不一致

**症狀：** 資料夾生成的群組名稱與群組成員生成使用的名稱不同

**解決方案：**
- 確保資料夾在權限表中有對應的群組
- 如果沒有，系統會自動生成，名稱格式為 `路徑_RO` 和 `路徑_RW`

---

## 📚 相關文檔

- **完整開發說明文件.md** - 系統完整說明
- **人員管理AD匯入功能說明.md** - AD 匯入功能詳解
- **多租戶架構修改說明.md** - 多租戶架構說明

---

## 📅 更新歷史

- **2025-01-XX**：初始版本
  - 新增人員生成功能
  - 新增資料夾（群組）生成功能
  - 新增資料夾群組成員生成功能
  - 支援單選/複選
  - 支援 OU 路徑自訂
  - 單行指令格式

