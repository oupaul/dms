/**
 * 匯入／匯出（CSV、XLSX）。
 */

const express = require('express');
const csv = require('csv-parser');
const ExcelJS = require('exceljs');
const fs = require('fs');
const { internalError } = require('../lib/http');
const { nowFileStamp, todayString } = require('../lib/time');
const { upload } = require('../middleware/upload');
const { withUserDatabase } = require('../middleware/user-database');
const { ensureEditorAccess } = require('../middleware/viewer');
const { buildPathWithDb, findFolderByNameAndParent } = require('../services/folders');
const { dbAll, dbGet, dbRun } = require('../lib/db');

const router = express.Router();

// 三段式人員查詢：account_key → email → name
function lookupUserId(userDb, keyword) {
  return new Promise((resolve) => {
    // 1. account_key 完全符合
    userDb.get('SELECT id FROM users WHERE account_key = ?', [keyword], (err, row) => {
      if (row) return resolve(row.id);
      // 2. email 完全符合
      userDb.get('SELECT id FROM users WHERE email = ?', [keyword], (err2, row2) => {
        if (row2) return resolve(row2.id);
        // 3. name 完全符合（最後手段）
        userDb.get('SELECT id FROM users WHERE name = ?', [keyword], (err3, row3) => {
          resolve(row3 ? row3.id : null);
        });
      });
    });
  });
}

// 匯出權限 CSV (UTF-8 with BOM)
router.get('/export_csv', ensureEditorAccess, withUserDatabase, (req, res) => {
  console.log('Hit /export_csv');
  req.userDb.all(`SELECT p.*, f.path, f.name as folder_name, u.name as user_name, g.name as group_name
          FROM permissions p
          LEFT JOIN folders f ON p.folder_id = f.id
          LEFT JOIN users u ON p.user_id = u.id
          LEFT JOIN groups g ON p.group_id = g.id
          ORDER BY p.id`, (err, rows) => {
    if (err) return internalError(res, err);
    
    // 手動建立 CSV 內容，並加入 UTF-8 BOM
    // 使用標準格式，可直接匯入
    const BOM = '\uFEFF';
    const headers = ['type', 'folder_id', 'user_id', 'group_id', 'permission_type', 'folder_path', 'user_name', 'group_name'];
    let csvContent = BOM + headers.join(',') + '\n';
    
    (rows || []).forEach(row => {
      const values = [
        'permission',
        row.folder_id || '',
        row.user_id || '',
        row.group_id || '',
        row.permission_type || '',
        row.path || row.folder_name || '',
        row.user_name || '',
        row.group_name || ''
      ].map(val => {
        // 如果欄位包含逗號、引號或換行符號，需要用引號包起來
        const strVal = String(val);
        if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
          return `"${strVal.replace(/"/g, '""')}"`;
        }
        return strVal;
      });
      csvContent += values.join(',') + '\n';
    });
    
    console.log(`Exported ${rows.length} permissions`);
    
    // 寫入檔案
    const tempFile = 'temp_permissions.csv';
    fs.writeFileSync(tempFile, csvContent, 'utf8');
    
    // 設置正確的 Content-Type 並下載
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.download(tempFile, 'permissions.csv', (err) => {
      if (err) console.error('Download error:', err);
      // 下載完成後刪除暫存檔
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });
  });
});

// 匯出資料夾 CSV (UTF-8 with BOM)
router.get('/export_folders_csv', withUserDatabase, (req, res) => {
  console.log('Hit /export_folders_csv');
  req.userDb.all('SELECT * FROM folders ORDER BY id', (err, rows) => {
    if (err) return internalError(res, err);
    
    // 手動建立 CSV 內容，並加入 UTF-8 BOM
    const BOM = '\uFEFF';
    const headers = ['type', 'name', 'parent_id'];
    let csvContent = BOM + headers.join(',') + '\n';
    
    (rows || []).forEach(row => {
      const values = [
        'folder',
        row.name || '',
        row.parent_id || ''
      ].map(val => {
        const strVal = String(val);
        if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
          return `"${strVal.replace(/"/g, '""')}"`;
        }
        return strVal;
      });
      csvContent += values.join(',') + '\n';
    });
    
    // 寫入檔案
    const tempFile = 'temp_folders.csv';
    fs.writeFileSync(tempFile, csvContent, 'utf8');
    
    // 設置正確的 Content-Type 並下載
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.download(tempFile, 'folders.csv', (err) => {
      if (err) console.error('Download error:', err);
      // 下載完成後刪除暫存檔
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });
  });
});

// 匯出人員 CSV (UTF-8 with BOM)
router.get('/export_users_csv', withUserDatabase, (req, res) => {
  console.log('Hit /export_users_csv');
  req.userDb.all('SELECT * FROM users ORDER BY id', (err, rows) => {
    if (err) return internalError(res, err);
    
    // 手動建立 CSV 內容，並加入 UTF-8 BOM
    const BOM = '\uFEFF';
    const headers = ['type', 'account_key', 'name', 'email', 'department', 'company', 'title', 'phone', 'description'];
    let csvContent = BOM + headers.join(',') + '\n';

    (rows || []).forEach(row => {
      const values = [
        'user',
        row.account_key || '',
        row.name || '',
        row.email || '',
        row.department || '',
        row.company || '',
        row.title || '',
        row.phone || '',
        row.description || ''
      ].map(val => {
        const strVal = String(val);
        if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
          return `"${strVal.replace(/"/g, '""')}"`;
        }
        return strVal;
      });
      csvContent += values.join(',') + '\n';
    });
    
    // 寫入檔案
    const tempFile = 'temp_users.csv';
    fs.writeFileSync(tempFile, csvContent, 'utf8');
    
    // 設置正確的 Content-Type 並下載
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.download(tempFile, 'users.csv', (err) => {
      if (err) console.error('Download error:', err);
      // 下載完成後刪除暫存檔
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });
  });
});

// 下載資料夾 Excel 範本（3 sheet，階層欄位格式）
router.get('/download_folders_template', withUserDatabase, (req, res) => {
  const MAX_LEVELS = 6;
  const wb = new ExcelJS.Workbook();

  // ─── Sheet 1：填寫清單 ────────────────────────────────────────────
  const ws1 = wb.addWorksheet('填寫清單');
  ws1.columns = Array.from({ length: MAX_LEVELS }, (_, i) => ({
    header: `第${['一','二','三','四','五','六'][i]}層`,
    key: `l${i + 1}`,
    width: 20
  }));
  const hdr1 = ws1.getRow(1);
  hdr1.font = { bold: true };
  hdr1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
  // 提示列（灰色斜體）
  const hint = ws1.getRow(2);
  hint.getCell(1).value = '← 請從第 3 列開始填寫。每一欄代表一個階層，同一行代表一條完整路徑。請參考「範例資料」工作表。';
  hint.font = { italic: true, color: { argb: 'FF999999' } };
  ws1.mergeCells(2, 1, 2, MAX_LEVELS);

  // ─── Sheet 2：欄位說明 ────────────────────────────────────────────
  const ws2 = wb.addWorksheet('欄位說明');
  ws2.columns = [
    { header: '項目', key: 'item', width: 20 },
    { header: '說明', key: 'desc', width: 60 },
  ];
  ws2.getRow(1).font = { bold: true };
  ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
  [
    ['格式', `每行代表一條「從根到最末層」的完整路徑。每欄填一個層級名稱。`],
    ['第一層', '根資料夾名稱（必填）'],
    ['第二～六層', '子資料夾名稱（有幾層填幾欄，其餘留空）'],
    ['留空欄', '同一行中，某層留空表示該行到上一層為止'],
    ['重複父路徑', '相同的上層路徑只需填一次（系統自動去重，不會重複建立）'],
    ['最大層數', `${MAX_LEVELS} 層（如需更多層請聯繫管理員）`],
    ['注意事項', '同一層不建議出現相同名稱的資料夾（系統會警告）'],
  ].forEach(r => ws2.addRow({ item: r[0], desc: r[1] }));

  // ─── Sheet 3：範例資料 ────────────────────────────────────────────
  const ws3 = wb.addWorksheet('範例資料');
  // 直接重新定義欄位（不複製 ws1.columns 物件，避免 key 對應失效）
  ws3.columns = Array.from({ length: MAX_LEVELS }, (_, i) => ({
    header: `第${['一','二','三','四','五','六'][i]}層`,
    key: `l${i + 1}`,
    width: 20
  }));
  ws3.getRow(1).font = { bold: true };
  ws3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };

  // 說明列（row 2）
  const exNote = ws3.getRow(2);
  exNote.getCell(1).value = '※ 每行代表一條完整路徑。有幾層就填幾欄，其餘留空。相同的父路徑系統自動去重，不會重複建立。';
  exNote.font = { italic: true, color: { argb: 'FF888888' } };
  ws3.mergeCells(2, 1, 2, MAX_LEVELS);

  // 範例資料（用陣列格式直接對應欄位，不依賴 key 對應）
  const exRows = [
    // 格式：[第一層, 第二層, 第三層, 第四層, 第五層, 第六層]
    ['Share', '管理部', '財務組', '',      '', ''],
    ['Share', '管理部', '人事組', '',      '', ''],
    ['Share', '技術部', '前端組', '專案A', '', ''],
    ['Share', '技術部', '前端組', '專案B', '', ''],
    ['Share', '技術部', '後端組', '',      '', ''],
    ['Share', '業務部', '',       '',      '', ''],
    ['Archive', '2024', 'Q1',    '',      '', ''],
    ['Archive', '2024', 'Q2',    '',      '', ''],
    ['Archive', '2025', '',      '',      '', ''],
  ];
  // 從 row 3 開始寫入（row1=標題、row2=說明文字）
  exRows.forEach((arr, i) => {
    const row = ws3.getRow(3 + i);
    arr.forEach((val, colIdx) => { row.getCell(colIdx + 1).value = val; });
    // 用不同淺色區分兩個根（Share=藍、Archive=黃）
    const bg = arr[0] === 'Archive' ? 'FFFFF2CC' : 'FFDAE8FC';
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    row.commit();
  });

  // 說明文字（底部，空一行後）
  const noteRowNum = 3 + exRows.length + 1;
  const note = ws3.getRow(noteRowNum);
  note.getCell(1).value = '※ 相同的上層（如 Share、Share/管理部）只需列出最末層路徑，系統自動建立父資料夾。根資料夾（第一層）不同顏色僅供閱讀區分。';
  note.font = { italic: true, color: { argb: 'FF666666' } };
  note.commit();
  ws3.mergeCells(noteRowNum, 1, noteRowNum, MAX_LEVELS);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="folders_template.xlsx"');
  wb.xlsx.write(res).then(() => res.end()).catch(err => {
    if (!res.headersSent) internalError(res, err);
  });
});

// 匯入資料夾 xlsx（階層欄位格式，與範本對應）
router.post('/import_folders_xlsx', withUserDatabase, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(req.file.path);

    // 讀第一個 sheet
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: '找不到工作表' });

    // 確認欄數（最多 MAX_LEVELS 欄）
    const MAX_LEVELS = 6;

    // 收集所有路徑（每行），從第 3 列開始（第 1 列為標題，第 2 列為提示說明）
    const paths = []; // [ ['Share','管理部','財務組'], ... ]
    for (let rowIdx = 3; rowIdx <= ws.rowCount; rowIdx++) {
      const row = ws.getRow(rowIdx);
      const parts = [];
      for (let col = 1; col <= MAX_LEVELS; col++) {
        const v = row.getCell(col).value;
        const s = v ? v.toString().trim() : '';
        if (!s) break;
        parts.push(s);
      }
      if (parts.length > 0) paths.push(parts);
    }

    if (paths.length === 0) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: '工作表中沒有有效資料（請從第 3 列開始填寫）' });
    }

    // 轉換為 CSV 格式字串（複用 import_csv 的邏輯）
    // 先建立去重路徑節點
    const pathMap = {};   // fullPath → tempId
    const nodes   = [];   // { tempId, name, parentTempId }
    let tempId = 1;

    paths.forEach(parts => {
      let parentTempId = '';
      let currentPath  = '';
      parts.forEach(part => {
        currentPath = currentPath ? currentPath + '/' + part : part;
        if (!pathMap.hasOwnProperty(currentPath)) {
          pathMap[currentPath] = tempId;
          nodes.push({ tempId, name: part, parentTempId });
          tempId++;
        }
        parentTempId = pathMap[currentPath];
      });
    });

    // 依賴排序：父節點在前
    const sorted  = [];
    const done    = new Set();
    function visit(n) {
      if (done.has(n.tempId)) return;
      if (n.parentTempId) {
        const parent = nodes.find(x => x.tempId === n.parentTempId);
        if (parent) visit(parent);
      }
      sorted.push(n);
      done.add(n.tempId);
    }
    nodes.forEach(visit);

    // 建立 tempId → CSV 行號的映射（從 1 開始）
    const tempToRow = {};
    sorted.forEach((n, i) => { tempToRow[n.tempId] = i + 1; });

    // 逐筆寫入資料庫
    const tempToDbId = {};  // tempId → 資料庫真實 id
    let inserted = 0, skipped = 0;
    for (const n of sorted) {
      // 找 parent 在資料庫的真實 id
      const parentDbId = n.parentTempId ? (tempToDbId[n.parentTempId] || null) : null;

      // 同一父層底下已有同名資料夾就重用，不重複建立（重複匯入同一份檔案是冪等的）
      const existing = await findFolderByNameAndParent(req.userDb, n.name, parentDbId);
      if (existing) {
        tempToDbId[n.tempId] = existing.id;
        skipped++;
        continue;
      }

      const result = await dbRun(req.userDb, 'INSERT INTO folders (name, parent_id) VALUES (?, ?)', [n.name, parentDbId]);
      tempToDbId[n.tempId] = result.lastID;
      const folderPath = await new Promise((resolve) => {
        buildPathWithDb(req.userDb, result.lastID, (err, pth) => resolve(err ? '/' + n.name : pth));
      });
      await dbRun(req.userDb, 'UPDATE folders SET path = ? WHERE id = ?', [folderPath, result.lastID]);
      inserted++;
    }

    fs.unlink(req.file.path, () => {});
    res.json({ success: true, stats: { total: nodes.length, inserted, skipped } });

  } catch (err) {
    console.error('[import_folders_xlsx]', err);
    fs.unlink(req.file.path, () => {});
    internalError(res, err);
  }
});

// 下載人員 Excel 範本（3 sheet）
router.get('/download_users_template', withUserDatabase, (req, res) => {
  const wb = new ExcelJS.Workbook();

  // ─── Sheet 1：填寫清單 ───────────────────────────────────────────
  const ws1 = wb.addWorksheet('填寫清單');
  ws1.columns = [
    { header: '帳號(account_key)', key: 'account_key', width: 20 },
    { header: '姓名',              key: 'name',        width: 16 },
    { header: 'Email',             key: 'email',       width: 28 },
    { header: '部門',              key: 'department',  width: 16 },
    { header: '公司',              key: 'company',     width: 16 },
    { header: '職稱',              key: 'title',       width: 16 },
    { header: '電話',              key: 'phone',       width: 16 },
    { header: '說明',              key: 'description', width: 24 },
  ];
  // 標頭樣式
  ws1.getRow(1).font = { bold: true };
  ws1.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  // ─── Sheet 2：欄位說明 ──────────────────────────────────────────
  const ws2 = wb.addWorksheet('欄位說明');
  ws2.columns = [
    { header: '欄位名稱', key: 'col', width: 22 },
    { header: '說明',     key: 'desc', width: 50 },
    { header: '必填',     key: 'req',  width: 8  },
  ];
  ws2.getRow(1).font = { bold: true };
  ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
  [
    ['帳號(account_key)', 'NAS / AD 登入帳號（SamAccountName），建議填寫，作為唯一比對鍵', '建議'],
    ['姓名',              '人員真實姓名，系統顯示用',                                       '必填'],
    ['Email',             '電子郵件，用於通知及查詢',                                        '建議'],
    ['部門',              '所屬部門名稱',                                                    '選填'],
    ['公司',              '所屬公司名稱',                                                    '選填'],
    ['職稱',              '職位頭銜',                                                        '選填'],
    ['電話',              '聯絡電話',                                                        '選填'],
    ['說明',              '備注說明',                                                        '選填'],
  ].forEach(r => ws2.addRow({ col: r[0], desc: r[1], req: r[2] }));

  // ─── Sheet 3：範例資料 ──────────────────────────────────────────
  const ws3 = wb.addWorksheet('範例資料');
  ws3.columns = ws1.columns.map(c => ({ ...c }));
  ws3.getRow(1).font = { bold: true };
  ws3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };
  [
    { account_key: 'john.doe',  name: '王大明', email: 'john.doe@example.com',  department: '資訊部', company: '範例公司', title: '工程師', phone: '0912-345678', description: '' },
    { account_key: 'jane.smith',name: '李小美', email: 'jane.smith@example.com', department: '業務部', company: '範例公司', title: '業務專員', phone: '0923-456789', description: '兼任PM' },
  ].forEach(r => ws3.addRow(r));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="users_template.xlsx"');
  wb.xlsx.write(res).then(() => res.end()).catch(err => {
    console.error('Template gen error:', err);
    if (!res.headersSent) internalError(res, err);
  });
});

// 匯入人員 xlsx（從範本格式匯入，以 account_key / email / name 去重）
router.post('/import_users_xlsx', withUserDatabase, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const mode = req.body.mode === 'update' ? 'update' : 'skip'; // 'skip' = INSERT OR IGNORE, 'update' = 更新已存在

  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(req.file.path);

    // 讀第一個 sheet（填寫清單）
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: '找不到工作表' });

    // 讀標頭列（第 1 列）建立 col→key 映射
    const headerRow = ws.getRow(1);
    const colMap = {}; // colNumber → field key
    const headerAliases = {
      '帳號(account_key)': 'account_key', '帳號': 'account_key', 'account_key': 'account_key',
      '姓名': 'name', 'name': 'name',
      'email': 'email', 'Email': 'email',
      '部門': 'department', 'department': 'department',
      '公司': 'company', 'company': 'company',
      '職稱': 'title', 'title': 'title',
      '電話': 'phone', 'phone': 'phone',
      '說明': 'description', 'description': 'description',
    };
    headerRow.eachCell((cell, colNumber) => {
      const h = (cell.value || '').toString().trim();
      if (headerAliases[h]) colMap[colNumber] = headerAliases[h];
    });

    const stats = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
    const rowCount = ws.rowCount;

    for (let rowIdx = 2; rowIdx <= rowCount; rowIdx++) {
      const row = ws.getRow(rowIdx);
      const data = {};
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const key = colMap[colNumber];
        if (key) data[key] = (cell.value || '').toString().trim();
      });

      if (!data.name && !data.account_key) continue; // 空行跳過

      // 查找現有人員：account_key → email → name
      let existingId = null;
      if (data.account_key) {
        const r = await new Promise(resolve => req.userDb.get('SELECT id FROM users WHERE account_key = ?', [data.account_key], (e, row) => resolve(row || null)));
        if (r) existingId = r.id;
      }
      if (!existingId && data.email) {
        const r = await new Promise(resolve => req.userDb.get('SELECT id FROM users WHERE email = ?', [data.email], (e, row) => resolve(row || null)));
        if (r) existingId = r.id;
      }
      if (!existingId && data.name) {
        const r = await new Promise(resolve => req.userDb.get('SELECT id FROM users WHERE name = ?', [data.name], (e, row) => resolve(row || null)));
        if (r) existingId = r.id;
      }

      if (existingId) {
        if (mode === 'update') {
          await dbRun(req.userDb, `UPDATE users SET name=COALESCE(?,name), email=COALESCE(?,email), department=COALESCE(?,department),
               company=COALESCE(?,company), title=COALESCE(?,title), phone=COALESCE(?,phone),
               description=COALESCE(?,description), account_key=COALESCE(?,account_key) WHERE id=?`, [data.name||null, data.email||null, data.department||null, data.company||null,
               data.title||null, data.phone||null, data.description||null, data.account_key||null, existingId]);
          stats.updated++;
        } else {
          stats.skipped++;
        }
      } else {
        try {
          await dbRun(req.userDb, 'INSERT INTO users (name, email, department, company, title, phone, description, account_key) VALUES (?,?,?,?,?,?,?,?)', [data.name||null, data.email||null, data.department||null, data.company||null,
               data.title||null, data.phone||null, data.description||null, data.account_key||null]);
          stats.inserted++;
        } catch (e) {
          console.warn(`[import_users_xlsx] row ${rowIdx} insert error:`, e.message);
          stats.errors++;
        }
      }
    }

    fs.unlink(req.file.path, () => {});
    res.json({ success: true, stats });
  } catch (err) {
    console.error('[import_users_xlsx] error:', err);
    fs.unlink(req.file.path, () => {});
    internalError(res, err);
  }
});

// 匯出群組 CSV (UTF-8 with BOM)
router.get('/export_groups_csv', withUserDatabase, async (req, res) => {
  console.log('Hit /export_groups_csv');
  
  try {
    // 1. 先取得所有群組
    const groups = (await dbAll(req.userDb, 'SELECT * FROM groups ORDER BY id')) || [];
    
    // 2. 取得所有群組成員關係
    const groupMembers = (await dbAll(req.userDb, `
        SELECT gu.group_id, gu.user_id, u.name as user_name, u.email
        FROM group_users gu
        LEFT JOIN users u ON gu.user_id = u.id
        ORDER BY gu.group_id, gu.user_id
      `)) || [];
    
    // 3. 手動建立 CSV 內容，並加入 UTF-8 BOM
    const BOM = '\uFEFF';
    const headers = ['type', 'name', 'group_id', 'user_id'];
    let csvContent = BOM + headers.join(',') + '\n';
    
    // 4. 先輸出所有群組
    groups.forEach(group => {
      const values = [
        'group',
        group.name || '',
        '',
        ''
      ].map(val => {
        const strVal = String(val);
        if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
          return `"${strVal.replace(/"/g, '""')}"`;
        }
        return strVal;
      });
      csvContent += values.join(',') + '\n';
    });
    
    // 5. 再輸出所有群組成員關係
    groupMembers.forEach(member => {
      const values = [
        'group_member',
        '', // name 欄位留空
        member.group_id || '',
        member.user_id || ''
      ].map(val => {
        const strVal = String(val);
        if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
          return `"${strVal.replace(/"/g, '""')}"`;
        }
        return strVal;
      });
      csvContent += values.join(',') + '\n';
    });
    
    // 6. 寫入檔案
    const tempFile = 'temp_groups.csv';
    fs.writeFileSync(tempFile, csvContent, 'utf8');
    
    console.log(`Exported ${groups.length} groups and ${groupMembers.length} group members`);
    
    // 7. 設置正確的 Content-Type 並下載
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.download(tempFile, 'groups.csv', (err) => {
      if (err) console.error('Download error:', err);
      // 下載完成後刪除暫存檔
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });
  } catch (error) {
    console.error('Export groups error:', error);
    internalError(res, error);
  }
});

// 匯出完整資料 CSV（一次性匯出所有資料：資料夾、人員、群組、群組成員、權限）
router.get('/export_full_csv', ensureEditorAccess, withUserDatabase, async (req, res) => {
  console.log('Hit /export_full_csv - Exporting all data');
  
  try {
    // 1. 查詢所有資料夾
    const allFolders = (await dbAll(req.userDb, `SELECT id, name, parent_id FROM folders ORDER BY id`)) || [];
    
    // 依賴排序：確保父資料夾在子資料夾之前
    const folders = [];
    const processed = new Set();
    const folderMap = {};
    
    allFolders.forEach(f => {
      folderMap[f.id] = f;
    });
    
    function processFolder(folder) {
      if (processed.has(folder.id)) return;
      
      // 如果有父資料夾，先處理父資料夾
      if (folder.parent_id) {
        const parent = folderMap[folder.parent_id];
        if (parent && !processed.has(parent.id)) {
          processFolder(parent);
        }
      }
      
      folders.push(folder);
      processed.add(folder.id);
    }
    
    allFolders.forEach(folder => {
      processFolder(folder);
    });
    
    // 建立資料夾 ID 到名稱的映射
    const folderIdToName = {};
    folders.forEach(f => {
      folderIdToName[f.id] = f.name;
    });
    
    // 2. 查詢所有人員
    const users = (await dbAll(req.userDb, `SELECT id, name, email, department, company, title, phone, description FROM users ORDER BY id`)) || [];
    
    // 建立人員 ID 到名稱的映射
    const userIdToName = {};
    users.forEach(u => {
      userIdToName[u.id] = u.name;
    });
    
    // 3. 查詢所有群組
    const groups = (await dbAll(req.userDb, `SELECT id, name FROM groups ORDER BY id`)) || [];
    
    // 建立群組 ID 到名稱的映射
    const groupIdToName = {};
    groups.forEach(g => {
      groupIdToName[g.id] = g.name;
    });
    
    // 4. 查詢所有群組成員關係（只包含有效關係）
    const groupMembers = (await dbAll(req.userDb, `
        SELECT gu.group_id, gu.user_id, g.name as group_name, u.name as user_name
        FROM group_users gu
        INNER JOIN groups g ON gu.group_id = g.id
        INNER JOIN users u ON gu.user_id = u.id
        ORDER BY gu.group_id, gu.user_id
      `)) || [];
    
    // 5. 查詢所有權限
    const permissions = (await dbAll(req.userDb, `
        SELECT p.folder_id, p.user_id, p.group_id, p.permission_type,
               f.name as folder_name, u.name as user_name, g.name as group_name
        FROM permissions p
        LEFT JOIN folders f ON p.folder_id = f.id
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN groups g ON p.group_id = g.id
        ORDER BY p.id
      `)) || [];
    
    // 6. 建立 CSV 內容（使用 UTF-8 BOM）
    const BOM = '\uFEFF';
    let csvContent = BOM;
    
    // 輔助函數：轉義 CSV 值
    const escapeCSV = (val) => {
      const strVal = String(val || '');
      if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
        return `"${strVal.replace(/"/g, '""')}"`;
      }
      return strVal;
    };
    
    // 使用統一的標題行（包含所有可能的欄位）
    // type,name,parent_name,email,department,company,title,phone,description,group_name,user_name,folder_name,permission_type
    csvContent += 'type,name,parent_name,email,department,company,title,phone,description,group_name,user_name,folder_name,permission_type\n';
    
    // 6.1 匯出資料夾（使用名稱和父資料夾名稱，已按依賴順序排序）
    folders.forEach(folder => {
      if (!folder.parent_id) {
        // 根資料夾
        csvContent += `folder,${escapeCSV(folder.name)},,,,,,,,,,,\n`;
      } else {
        // 子資料夾
        const parentName = folderIdToName[folder.parent_id] || '';
        csvContent += `folder,${escapeCSV(folder.name)},${escapeCSV(parentName)},,,,,,,,,,,\n`;
      }
    });

    // 6.2 匯出人員
    users.forEach(user => {
      csvContent += `user,${escapeCSV(user.name)},,${escapeCSV(user.email)},${escapeCSV(user.department || '')},${escapeCSV(user.company || '')},${escapeCSV(user.title || '')},${escapeCSV(user.phone || '')},${escapeCSV(user.description || '')},,,,\n`;
    });

    // 6.3 匯出群組
    groups.forEach(group => {
      csvContent += `group,${escapeCSV(group.name)},,,,,,,,,,,\n`;
    });

    // 6.4 匯出群組成員（使用群組名稱和人員名稱）
    // 使用 INNER JOIN 確保只匯出有效關係
    groupMembers.forEach(member => {
      csvContent += `group_member,,,,,,,,,${escapeCSV(member.group_name)},${escapeCSV(member.user_name)},,\n`;
    });

    // 6.5 匯出權限（使用資料夾名稱、群組名稱/人員名稱）
    permissions.forEach(perm => {
      csvContent += `permission,,,,,,,,,${escapeCSV(perm.group_name)},${escapeCSV(perm.user_name)},${escapeCSV(perm.folder_name)},${escapeCSV(perm.permission_type)}\n`;
    });
    
    console.log(`Exported full data: ${folders.length} folders, ${users.length} users, ${groups.length} groups, ${groupMembers.length} group members, ${permissions.length} permissions`);
    
    // 7. 寫入檔案
    const tempFile = 'temp_full_data.csv';
    fs.writeFileSync(tempFile, csvContent, 'utf8');
    
    // 8. 設置正確的 Content-Type 並下載
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.download(tempFile, `full_data_${todayString()}.csv`, (err) => {
      if (err) console.error('Download error:', err);
      // 下載完成後刪除暫存檔
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });
  } catch (error) {
    console.error('Export full data error:', error);
    internalError(res, error);
  }
});

// 匯入 CSV (改用 Promise 確保操作完成)
router.post('/import_csv', withUserDatabase, upload.single('file'), (req, res) => {
  console.log('Hit /import_csv');
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const results = [];
  
  fs.createReadStream(req.file.path)
    .pipe(csv({
      mapHeaders: ({ header }) => {
        // 清理欄位名稱：移除引號、空格、BOM
        return header.replace(/^['"\uFEFF\s]+|['"\s]+$/g, '').trim();
      }
    }))
    .on('data', (row) => {
      console.log('CSV row read:', row);
      results.push(row);
    })
    .on('end', async () => {
      try {
        console.log(`CSV parsing completed. Total rows: ${results.length}`);
        if (results.length > 0) {
          console.log('First row keys:', Object.keys(results[0]));
          console.log('First row values:', results[0]);
        }
        
        let importCount = 0;
        const stats = {
          folders: 0,
          users: 0,
          groups: 0,
          group_members: 0,
          permissions: 0
        };

        const importMode = req.body.mode === 'full_replace' ? 'full_replace' : 'diff_only';
        const historyDetails = [];
        const permStats = { added: 0, updated: 0, deleted: 0, skipped: 0 };
        const seenPermKeys = new Set();       // 追蹤本次匯入的直接權限 key
        const seenGroupMemberKeys = new Set(); // 追蹤本次匯入的群組成員 key (group_id|user_id)
        const affectedGroupIds = new Set();    // 本次有出現的群組，full_replace 時用來清除舊成員

        // 定義處理順序（確保依賴關係正確）
        // 順序：folder → user → group → group_member → permission
        const typeOrder = {
          'folder': 1,
          'user': 2,
          'group': 3,
          'group_member': 4,
          'permission': 5
        };
        
        // 按照類型排序，確保處理順序正確
        results.sort((a, b) => {
          const typeA = (a.type || a.Type || a.TYPE || '').toLowerCase();
          const typeB = (b.type || b.Type || b.TYPE || '').toLowerCase();
          const orderA = typeOrder[typeA] || 999;
          const orderB = typeOrder[typeB] || 999;
          
          // 如果類型相同，保持原始順序（對於資料夾的依賴排序很重要）
          if (orderA === orderB && typeA === 'folder') {
            // 資料夾需要保持原始順序（父資料夾在前）
            return 0;
          }
          
          return orderA - orderB;
        });
        
        console.log(`Sorted ${results.length} rows by type order: folder -> user -> group -> group_member -> permission`);
        
        // 循序處理每一行（已按正確順序排序）
        for (const row of results) {
          const type = row.type || row.Type || row.TYPE;
          console.log(`Processing row - type: ${type}, name: ${row.name}`);
          
          if (!type) {
            console.log('Skipping row with no type:', row);
            continue;
          }
          
          if (type === 'user') {
            const name = row.name || row.Name;
            const email = row.email || row.Email;
            const department = row.department || row.Department || null;
            const company = row.company || row.Company || null;
            const title = row.title || row.Title || null;
            const phone = row.phone || row.Phone || null;
            const description = row.description || row.Description || null;
            const account_key = row.account_key || row.Account_Key || row['帳號'] || null;

            await new Promise((resolve, reject) => {
              req.userDb.run(
                'INSERT OR IGNORE INTO users (name, email, department, company, title, phone, description, account_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [name, email, department, company, title, phone, description, account_key || null],
                (err) => {
                  if (err) reject(err);
                  else {
                    importCount++;
                    stats.users++;
                    resolve();
                  }
                }
              );
            });
          } else if (type === 'group') {
            const name = row.name || row.Name;
            
            // 插入群組
            const groupId = await new Promise((resolve, reject) => {
              req.userDb.run('INSERT OR IGNORE INTO groups (name) VALUES (?)', 
                [name], 
                function(err) {
                  if (err) {
                    reject(err);
                  } else {
                    console.log(`✓ Inserted group: ${name}, ID: ${this.lastID}`);
                    importCount++;
                    stats.groups++;
                    resolve(this.lastID);
                  }
                }
              );
            });
            
            // 自動指派權限：根據群組名稱自動對應資料夾
            // 格式：完整路徑_RO 或 完整路徑_RW（例如：RD_Test_Lab_RO）
            if (name.endsWith('_RO') || name.endsWith('_RW')) {
              const folderPath = name.endsWith('_RO') 
                ? name.substring(0, name.length - 3) 
                : name.substring(0, name.length - 3);
              
              const permissionType = name.endsWith('_RO') ? 'read' : 'write';
              
              // 獲取所有資料夾，建立完整路徑映射
              const allFolders = (await dbAll(req.userDb, 'SELECT id, name, parent_id FROM folders', [])) || [];
              
              // 建立資料夾映射
              const folderMap = {};
              allFolders.forEach(f => {
                folderMap[f.id] = f;
              });
              
              // 函數：獲取資料夾的完整路徑
              const getFolderPath = (folder) => {
                const path = [];
                let current = folder;
                
                while (current) {
                  path.unshift(current.name);
                  if (current.parent_id && folderMap[current.parent_id]) {
                    current = folderMap[current.parent_id];
                  } else {
                    break;
                  }
                }
                
                return path.join('_');
              };
              
              // 查找完整路徑匹配的資料夾
              let targetFolder = null;
              for (const folder of allFolders) {
                const fullPath = getFolderPath(folder);
                if (fullPath === folderPath) {
                  targetFolder = folder;
                  break;
                }
              }
              
              if (targetFolder) {
                // 指派權限
                await new Promise((resolve, reject) => {
                  req.userDb.run(
                    'INSERT OR IGNORE INTO permissions (folder_id, user_id, group_id, permission_type) VALUES (?, NULL, ?, ?)',
                    [targetFolder.id, groupId, permissionType],
                    (err) => {
                      if (err) {
                        console.error(`❌ Error assigning permission for group ${name}:`, err);
                        reject(err);
                      } else {
                        console.log(`✓ Auto-assigned ${permissionType} permission: group "${name}" (${groupId}) → folder "${folderPath}" (${targetFolder.id})`);
                        resolve();
                      }
                    }
                  );
                });
              } else {
                console.warn(`⚠ Folder with path "${folderPath}" not found for group "${name}", skipping auto-permission`);
              }
            }
          } else if (type === 'folder') {
            const name = row.name || row.Name;
            const parent_id_raw = row.parent_id || row.Parent_id || row.parent_Id || row.Parent_Id;
            const parent_name_raw = row.parent_name || row.Parent_name || row.parent_Name || row.Parent_Name;
            let parent_id = parent_id_raw ? parseInt(parent_id_raw) : null;
            
            // 如果沒有 parent_id 但有 parent_name，根據名稱查找
            if (!parent_id && parent_name_raw) {
              console.log(`Looking up parent folder ID for name: "${parent_name_raw}"`);
              const parentFolder = await new Promise((res) => {
                req.userDb.get('SELECT id FROM folders WHERE name = ?', [parent_name_raw], (err, row) => {
                  if (err) {
                    console.error('Error looking up parent folder:', err);
                    res(null);
                  } else {
                    res(row);
                  }
                });
              });
              
              if (parentFolder) {
                parent_id = parentFolder.id;
                console.log(`✓ Found parent folder ID ${parent_id} for name "${parent_name_raw}"`);
              } else {
                console.warn(`⚠ Parent folder "${parent_name_raw}" not found for "${name}", creating as root folder`);
                parent_id = null;
              }
            }
            
            console.log(`Inserting folder: name="${name}", parent_id=${parent_id}`);
            
            // 驗證 parent_id 是否有效（如果有提供的話）
            if (parent_id) {
              const parentExists = await new Promise((res) => {
                req.userDb.get('SELECT id FROM folders WHERE id = ?', [parent_id], (err, row) => {
                  res(!err && row);
                });
              });
              
              if (!parentExists) {
                console.warn(`⚠ Parent folder ${parent_id} not found for "${name}", creating as root folder`);
                // 將 parent_id 設為 null，作為根資料夾
                parent_id = null;
              }
            }
            
            // 同一父層底下已有同名資料夾就略過，不重複建立
            const existingFolder = await findFolderByNameAndParent(req.userDb, name, parent_id);
            if (existingFolder) {
              console.log(`↷ Folder already exists, skipped: ${name} (ID ${existingFolder.id})`);
              stats.foldersSkipped = (stats.foldersSkipped || 0) + 1;
              continue;
            }

            // 插入資料夾（循序執行，確保順序）
            await new Promise((resolve, reject) => {
              req.userDb.run('INSERT INTO folders (name, parent_id) VALUES (?, ?)', 
                [name, parent_id], 
                function(err) {
                  if (err) {
                    console.error('Error inserting folder:', err);
                    return reject(err);
                  }
                  const folderId = this.lastID;
                  console.log(`✓ Inserted folder: ${name}, ID: ${folderId}, parent_id: ${parent_id || 'null'}`);
                  importCount++;
                  stats.folders++;
                  
                  // 建構路徑
                  buildPathWithDb(req.userDb, folderId, (err, pth) => {
                    if (err) {
                      console.error('Error building path:', err);
                      // 路徑建構失敗，使用簡單路徑
                      const simplePath = '/' + name;
                      req.userDb.run('UPDATE folders SET path = ? WHERE id = ?', [simplePath, folderId], () => {
                        console.log(`✓ Used simple path for folder ${folderId}: ${simplePath}`);
                        resolve();
                      });
                      return;
                    }
                    req.userDb.run('UPDATE folders SET path = ? WHERE id = ?', 
                      [pth, folderId], 
                      (err) => {
                        if (err) console.error('Error updating path:', err);
                        else console.log(`✓ Updated path for folder ${folderId}: ${pth}`);
                        resolve();
                      }
                    );
                  });
                }
              );
            });
          } else if (type === 'group_member') {
            // 支援群組成員匯入（支援 ID 或名稱）
            // 嘗試多種可能的欄位名稱格式
            const group_id_raw = row.group_id || row.Group_id || row.GROUP_ID || row['group_id'] || row['Group_id'];
            const user_id_raw = row.user_id || row.User_id || row.USER_ID || row['user_id'] || row['User_id'];
            const group_name_raw = row.group_name || row.Group_name || row.group_Name || row.Group_Name || 
                                   row['group_name'] || row['Group_name'] || row['group_Name'] || row['Group_Name'] || '';
            const user_name_raw = row.user_name || row.User_name || row.user_Name || row.User_Name || 
                                 row['user_name'] || row['User_name'] || row['user_Name'] || row['User_name'] || '';
            
            console.log(`Processing group_member row:`, {
              group_id: group_id_raw,
              user_id: user_id_raw,
              group_name: group_name_raw,
              user_name: user_name_raw,
              row_keys: Object.keys(row),
              row_values: Object.values(row),
              raw_row: row
            });
            
            let group_id = group_id_raw ? parseInt(group_id_raw) : null;
            let user_id = user_id_raw ? parseInt(user_id_raw) : null;
            
            // 如果沒有 group_id 但有 group_name，根據名稱查找
            if (!group_id && group_name_raw && typeof group_name_raw === 'string' && group_name_raw.trim() !== '') {
              const groupNameClean = group_name_raw.trim();
              console.log(`Looking up group ID for name: "${groupNameClean}"`);
              const groupRow = await new Promise((res) => {
                req.userDb.get('SELECT id FROM groups WHERE name = ?', [groupNameClean], (err, row) => {
                  if (err) {
                    console.error('Error looking up group:', err);
                    res(null);
                  } else {
                    res(row);
                  }
                });
              });
              
              if (groupRow) {
                group_id = groupRow.id;
                console.log(`✓ Found group ID ${group_id} for name "${groupNameClean}"`);
              } else {
                console.warn(`⚠ Group "${groupNameClean}" not found, skipping group member`);
              }
            }
            
            // 如果沒有 user_id 但有 user_name，根據名稱查找
            if (!user_id && user_name_raw && typeof user_name_raw === 'string' && user_name_raw.trim() !== '') {
              const userNameClean = user_name_raw.trim();
              console.log(`Looking up user ID for: "${userNameClean}"`);
              const foundId = await lookupUserId(req.userDb, userNameClean);
              if (foundId) {
                user_id = foundId;
                console.log(`✓ Found user ID ${user_id} for "${userNameClean}"`);
              } else {
                console.warn(`⚠ User "${userNameClean}" not found (tried account_key/email/name), skipping`);
              }
            }
            
            if (group_id && !isNaN(group_id) && user_id && !isNaN(user_id)) {
              seenGroupMemberKeys.add(`${group_id}|${user_id}`);
              affectedGroupIds.add(group_id);
              console.log(`Adding user ${user_id} to group ${group_id}`);
              await new Promise((resolve, reject) => {
                req.userDb.run('INSERT OR IGNORE INTO group_users (group_id, user_id) VALUES (?, ?)',
                  [group_id, user_id],
                  function(err) {
                    if (err) {
                      console.error('Error adding group member:', err);
                      reject(err);
                    } else {
                      if (this.changes > 0) {
                        console.log(`✓ Added user ${user_id} to group ${group_id}`);
                        importCount++;
                        stats.group_members++;
                      } else {
                        console.log(`ℹ User ${user_id} already in group ${group_id} (skipped)`);
                      }
                      resolve();
                    }
                  }
                );
              });
            } else {
              console.warn(`⚠ Skipping group_member: group_id=${group_id}, user_id=${user_id}, group_name="${group_name_raw}", user_name="${user_name_raw}"`);
              console.warn(`   Full row data:`, JSON.stringify(row, null, 2));
            }
          } else if (type === 'permission') {
            // 改進：支援多種欄位名稱格式（支援 ID 或名稱）
            let folder_id_raw = row.folder_id || row.Folder_id || row.FOLDER_ID;
            const folder_name_raw = row.folder_name || row.Folder_name || row.FOLDER_NAME;
            let user_id_raw = row.user_id || row.User_id || row.USER_ID;
            const user_name_raw = row.user_name || row.User_name || row.user_Name || row.User_Name;
            let group_id_raw = row.group_id || row.Group_id || row.GROUP_ID;
            const group_name_raw = row.group_name || row.Group_name || row.group_Name || row.Group_Name;
            const permission_type_raw = row.permission_type || row.Permission_type || row.PERMISSION_TYPE;
            
            // 如果沒有 folder_id 但有 folder_name，嘗試從資料夾名稱查找 ID
            if (!folder_id_raw && folder_name_raw) {
              console.log(`Looking up folder ID for name: "${folder_name_raw}"`);
              const folderRow = await new Promise((res) => {
                req.userDb.get('SELECT id FROM folders WHERE name = ?', [folder_name_raw], (err, row) => {
                  if (err) {
                    console.error('Error looking up folder:', err);
                    res(null);
                  } else {
                    res(row);
                  }
                });
              });
              if (folderRow) {
                folder_id_raw = folderRow.id;
                console.log(`✓ Found folder ID ${folder_id_raw} for name "${folder_name_raw}"`);
              } else {
                console.warn(`⚠ Folder not found for name: "${folder_name_raw}"`);
              }
            }
            
            // 如果沒有 user_id 但有 user_name，嘗試從人員名稱查找 ID
            if (!user_id_raw && user_name_raw) {
              console.log(`Looking up user ID for: "${user_name_raw}"`);
              const foundId = await lookupUserId(req.userDb, user_name_raw);
              if (foundId) {
                user_id_raw = foundId;
                console.log(`✓ Found user ID ${user_id_raw} for "${user_name_raw}"`);
              } else {
                console.warn(`⚠ User "${user_name_raw}" not found (tried account_key/email/name), skipping`);
              }
            }
            
            // 如果沒有 group_id 但有 group_name，嘗試從群組名稱查找 ID
            if (!group_id_raw && group_name_raw) {
              console.log(`Looking up group ID for name: "${group_name_raw}"`);
              const groupRow = await new Promise((res) => {
                req.userDb.get('SELECT id FROM groups WHERE name = ?', [group_name_raw], (err, row) => {
                  if (err) {
                    console.error('Error looking up group:', err);
                    res(null);
                  } else {
                    res(row);
                  }
                });
              });
              if (groupRow) {
                group_id_raw = groupRow.id;
                console.log(`✓ Found group ID ${group_id_raw} for name "${group_name_raw}"`);
              } else {
                console.warn(`⚠ Group not found for name: "${group_name_raw}"`);
              }
            }
            
            const folder_id = folder_id_raw ? parseInt(folder_id_raw) : null;
            const user_id = user_id_raw ? parseInt(user_id_raw) : null;
            const group_id = group_id_raw ? parseInt(group_id_raw) : null;
            const permission_type = permission_type_raw;
            
            console.log(`Processing permission: folder_id=${folder_id}, user_id=${user_id}, group_id=${group_id}, type=${permission_type}`);
            
            // 權限 CSV 匯入：處理不同來源的權限記錄
            // 1. 如果同時有 user_id 和 group_id，表示要將人員加入群組（來自權限CSV生成器）
            // 2. 如果有 folder_id，表示要設定資料夾權限（來自完整資料匯出）
            if (user_id && !isNaN(user_id) && group_id && !isNaN(group_id) && !folder_id) {
              // 來自權限CSV生成器：將人員加入群組
              seenGroupMemberKeys.add(`${group_id}|${user_id}`);
              affectedGroupIds.add(group_id);
              console.log(`Adding user ${user_id} to group ${group_id} (from permission CSV generator)`);

              await new Promise((resolve, reject) => {
                req.userDb.run('INSERT OR IGNORE INTO group_users (group_id, user_id) VALUES (?, ?)',
                  [group_id, user_id],
                  (err) => {
                    if (err) {
                      console.error('Error adding user to group:', err);
                      reject(err);
                    } else {
                      console.log(`✓ Added user ${user_id} to group ${group_id}`);
                      importCount++;
                      stats.group_members++;
                      resolve();
                    }
                  }
                );
              });
            } else if (folder_id && !isNaN(folder_id) && permission_type) {
              // 取得資料夾路徑，供記錄用
              const folderPathRow = await new Promise(res => {
                req.userDb.get('SELECT path, name FROM folders WHERE id = ?', [folder_id], (err, r) => res(r || null));
              });
              const folderLabel = folderPathRow ? (folderPathRow.path || folderPathRow.name) : String(folder_id);

              const applyDiffPermission = async (fid, uid, gid, ptype, targetType, targetName) => {
                const permKey = `${fid}|${uid ?? ''}|${gid ?? ''}`;
                seenPermKeys.add(permKey);

                // 查詢是否已存在
                const existing = await new Promise(res => {
                  req.userDb.get(
                    'SELECT id, permission_type FROM permissions WHERE folder_id=? AND (user_id IS ?) AND (group_id IS ?)',
                    [fid, uid ?? null, gid ?? null],
                    (err, r) => res(r || null)
                  );
                });

                if (!existing) {
                  // 新增
                  await dbRun(req.userDb, 'INSERT INTO permissions (folder_id, user_id, group_id, permission_type) VALUES (?, ?, ?, ?)', [fid, uid ?? null, gid ?? null, ptype]);
                  permStats.added++;
                  importCount++;
                  stats.permissions++;
                  historyDetails.push({ action: 'added', folder_path: folderLabel, target_type: targetType, target_name: targetName, old_permission: null, new_permission: ptype });
                  console.log(`✓ [added] permission: folder ${fid}, ${targetType} ${targetName}, ${ptype}`);
                } else if (existing.permission_type !== ptype) {
                  // 更新
                  await dbRun(req.userDb, 'UPDATE permissions SET permission_type=? WHERE id=?', [ptype, existing.id]);
                  permStats.updated++;
                  importCount++;
                  stats.permissions++;
                  historyDetails.push({ action: 'updated', folder_path: folderLabel, target_type: targetType, target_name: targetName, old_permission: existing.permission_type, new_permission: ptype });
                  console.log(`✓ [updated] permission: folder ${fid}, ${targetType} ${targetName}, ${existing.permission_type} → ${ptype}`);
                } else {
                  // 相同，略過
                  permStats.skipped++;
                  historyDetails.push({ action: 'skipped', folder_path: folderLabel, target_type: targetType, target_name: targetName, old_permission: existing.permission_type, new_permission: ptype });
                  console.log(`ℹ [skipped] permission already exists: folder ${fid}, ${targetType} ${targetName}, ${ptype}`);
                }
              };

              if (group_id && !isNaN(group_id)) {
                const grpName = group_name_raw || String(group_id);
                await applyDiffPermission(folder_id, null, group_id, permission_type, 'group', grpName);
              } else if (user_id && !isNaN(user_id)) {
                const usrName = user_name_raw || String(user_id);
                await applyDiffPermission(folder_id, user_id, null, permission_type, 'user', usrName);
              } else {
                console.log('Skipping permission: no valid user_id or group_id specified');
              }
            } else {
              console.log('Skipping permission with invalid data:', { folder_id, permission_type, row });
            }
          } else {
            console.log('Unknown type:', type);
          }
        }
        
        // full_replace：清除本次有出現的群組中，CSV 裡沒有的舊成員（處理 RO→RW 移動）
        if (importMode === 'full_replace' && affectedGroupIds.size > 0) {
          for (const gid of affectedGroupIds) {
            const existingMembers = await dbAll(req.userDb, `SELECT gu.user_id, u.name AS user_name, g.name AS group_name
                 FROM group_users gu
                 LEFT JOIN users u ON u.id = gu.user_id
                 LEFT JOIN groups g ON g.id = gu.group_id
                 WHERE gu.group_id = ?`, [gid]);
            for (const m of existingMembers) {
              const key = `${gid}|${m.user_id}`;
              if (!seenGroupMemberKeys.has(key)) {
                await dbRun(req.userDb, 'DELETE FROM group_users WHERE group_id = ? AND user_id = ?', [gid, m.user_id]);
                permStats.deleted++;
                historyDetails.push({ action: 'deleted', folder_path: `group:${m.group_name || gid}`, target_type: 'user', target_name: m.user_name || String(m.user_id), old_permission: 'member', new_permission: null });
                console.log(`✓ [deleted] group member: group ${gid}, user ${m.user_id} (${m.user_name})`);
              }
            }
          }
        }

        // full_replace：刪除本次未出現在匯入檔案中的舊直接權限
        if (importMode === 'full_replace') {
          const allPerms = await dbAll(req.userDb, `SELECT p.id, p.folder_id, p.user_id, p.group_id, p.permission_type,
                      f.path AS folder_path, f.name AS folder_name,
                      u.name AS user_name, g.name AS group_name
               FROM permissions p
               LEFT JOIN folders f ON f.id = p.folder_id
               LEFT JOIN users u ON u.id = p.user_id
               LEFT JOIN groups g ON g.id = p.group_id`, []);

          for (const perm of allPerms) {
            const permKey = `${perm.folder_id}|${perm.user_id ?? ''}|${perm.group_id ?? ''}`;
            if (!seenPermKeys.has(permKey)) {
              await dbRun(req.userDb, 'DELETE FROM permissions WHERE id=?', [perm.id]);
              const folderLabel = perm.folder_path || perm.folder_name || String(perm.folder_id);
              const targetType = perm.user_id ? 'user' : 'group';
              const targetName = perm.user_name || perm.group_name || '';
              permStats.deleted++;
              historyDetails.push({ action: 'deleted', folder_path: folderLabel, target_type: targetType, target_name: targetName, old_permission: perm.permission_type, new_permission: null });
              console.log(`✓ [deleted] permission: folder ${perm.folder_id}, ${targetType} ${targetName}`);
            }
          }
        }

        // 儲存匯入歷史
        const historyId = (await dbRun(req.userDb, 'INSERT INTO import_history (imported_by, file_name, mode, added, updated, deleted, skipped) VALUES (?, ?, ?, ?, ?, ?, ?)', [req.session.username || 'unknown', req.file.originalname || req.file.filename, importMode, permStats.added, permStats.updated, permStats.deleted, permStats.skipped])).lastID;

        for (const d of historyDetails) {
          await dbRun(req.userDb, 'INSERT INTO import_history_detail (history_id, action, folder_path, target_type, target_name, old_permission, new_permission) VALUES (?, ?, ?, ?, ?, ?, ?)', [historyId, d.action, d.folder_path, d.target_type, d.target_name, d.old_permission, d.new_permission]);
        }

        // 所有操作已循序完成
        console.log(`Import completed: ${importCount} operations`);
        console.log('Import statistics:', stats);
        console.log('Permission diff stats:', permStats);

        // 刪除上傳的檔案
        fs.unlinkSync(req.file.path);

        res.json({
          success: true,
          imported: importCount,
          count: importCount,
          stats: stats,
          permStats: permStats,
          historyId: historyId,
          mode: importMode
        });
      } catch (error) {
        console.error('Import error:', error);
        // 確保刪除上傳的檔案
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
        internalError(res, error);
      }
    })
    .on('error', (error) => {
      console.error('CSV parse error:', error);
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      res.status(500).json({ error: 'CSV parse error: ' + error.message });
    });
});

// 匯入權限矩陣 xlsx（從匯出的權限清單 xlsx 回匯，操作群組成員）
router.post('/import_permission_matrix_xlsx', withUserDatabase, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  // 修正 multer latin1 編碼問題，還原中文檔名
  const fileName = Buffer.from(req.file.originalname || '', 'latin1').toString('utf8');

  try {
    const importMode = req.body.mode === 'full_replace' ? 'full_replace' : 'diff_only';
    const historyDetails = [];
    const permStats = { added: 0, updated: 0, deleted: 0, skipped: 0 };
    // seenGroupMemberKeys: Set<"groupId|userId"> 本次 xlsx 應在的群組成員
    const seenGroupMemberKeys = new Set();
    // affectedGroupIds: Set<groupId> 本次 xlsx 涵蓋的 RO/RW 群組（full_replace 時清除多餘成員）
    const affectedGroupIds = new Set();

    // 1. 讀取 xlsx
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);
    const ws = workbook.worksheets[0];
    if (!ws) throw new Error('找不到工作表');

    // 2. 偵測是否含描述欄（B1 = '描述'）
    const b1 = ws.getRow(1).getCell(2).value;
    const hasDesc = (b1 && b1.toString().trim() === '描述');
    const dataStartCol = hasDesc ? 3 : 2;

    // 3. 讀取 4 列標頭，建立欄→資料夾 path 映射（路徑以 "/" 連接，群組用 "_"）
    const colFolderPath = {};   // col → "A/B/C" 格式
    const colGroupPath = {};    // col → "A_B_C" 格式（用於對應群組名）
    const lastCol = ws.columnCount || 300;
    for (let col = dataStartCol; col <= lastCol; col++) {
      const parts = [1, 2, 3, 4].map(r => {
        const v = ws.getRow(r).getCell(col).value;
        return v ? v.toString().trim() : '';
      }).filter(v => v !== '');
      if (parts.length > 0) {
        colFolderPath[col] = parts.join('/');
        colGroupPath[col] = parts.join('_');
      }
    }
    if (Object.keys(colFolderPath).length === 0) {
      throw new Error('無法從 xlsx 標頭解析出資料夾欄位，請確認檔案格式正確');
    }

    // 4. 載入所有群組，建立 name→group 映射
    const allGroups = await dbAll(req.userDb, 'SELECT id, name FROM groups', []);
    const groupByName = {};
    allGroups.forEach(g => { groupByName[g.name] = g; });

    // 5. 為每個資料夾欄建立 RO/RW 群組映射，並登記 affectedGroupIds
    const colGroups = {}; // col → { roId, rwId, folderPath, groupPath }
    for (const [col, gpath] of Object.entries(colGroupPath)) {
      const roGroup = groupByName[`${gpath}_RO`];
      const rwGroup = groupByName[`${gpath}_RW`];
      colGroups[col] = {
        roId: roGroup ? roGroup.id : null,
        rwId: rwGroup ? rwGroup.id : null,
        folderPath: colFolderPath[col],
        groupPath: gpath
      };
      if (roGroup) affectedGroupIds.add(roGroup.id);
      if (rwGroup) affectedGroupIds.add(rwGroup.id);
    }

    // 6. 載入所有人員，建立多鍵→id 映射（支援 name / email / account_key）
    const allUsers = await dbAll(req.userDb, 'SELECT id, name, email, account_key FROM users', []);
    const nameToUserId = {};
    // 依精確度低→高順序寫入，後者覆蓋前者（account_key 最精確，最後寫入保證優先）
    allUsers.forEach(u => {
      if (u.name)        nameToUserId[u.name.trim()]        = u.id;
      if (u.email)       nameToUserId[u.email.trim()]       = u.id;
      if (u.account_key) nameToUserId[u.account_key.trim()] = u.id;
    });

    // 7. 處理人員列（第 5 列起）
    const totalRows = ws.rowCount || 0;
    for (let rowIdx = 5; rowIdx <= totalRows; rowIdx++) {
      const rowObj = ws.getRow(rowIdx);
      const nameCell = rowObj.getCell(1).value;
      if (!nameCell) continue;
      const userName = nameCell.toString().trim();
      if (!userName) continue;

      const userId = nameToUserId[userName];
      if (!userId) {
        console.warn(`[xlsx import] 找不到人員: "${userName}"`);
        continue;
      }

      for (const [col, grpInfo] of Object.entries(colGroups)) {
        const cellVal = rowObj.getCell(parseInt(col)).value;
        const raw = cellVal ? cellVal.toString().trim().toUpperCase() : '';
        const isRW = raw === 'RW';
        const isRO = raw === 'RO';

        const targetGroupId = isRW ? grpInfo.rwId : isRO ? grpInfo.roId : null;

        if (targetGroupId) {
          const key = `${targetGroupId}|${userId}`;
          seenGroupMemberKeys.add(key);

          // 檢查是否已是成員
          const existing = await new Promise(resolve => {
            req.userDb.get('SELECT 1 FROM group_users WHERE group_id=? AND user_id=?',
              [targetGroupId, userId], (err, row) => resolve(row || null));
          });

          if (!existing) {
            await dbRun(req.userDb, 'INSERT OR IGNORE INTO group_users (group_id, user_id) VALUES (?, ?)', [targetGroupId, userId]);
            permStats.added++;
            const permLabel = isRW ? 'RW' : 'RO';
            historyDetails.push({ action: 'added', folder_path: grpInfo.folderPath, target_type: 'user', target_name: userName, old_permission: null, new_permission: permLabel });
            console.log(`[xlsx import] added: ${userName} → ${grpInfo.groupPath}_${permLabel}`);
          } else {
            permStats.skipped++;
          }
        }
      }
    }

    // 8. full_replace：清除 affectedGroupIds 中，不在 seenGroupMemberKeys 的舊成員
    if (importMode === 'full_replace' && affectedGroupIds.size > 0) {
      for (const gid of affectedGroupIds) {
        const members = await dbAll(req.userDb, `SELECT gu.user_id, u.name AS user_name, g.name AS group_name
             FROM group_users gu
             LEFT JOIN users u ON u.id = gu.user_id
             LEFT JOIN groups g ON g.id = gu.group_id
             WHERE gu.group_id = ?`, [gid]);
        for (const m of members) {
          const key = `${gid}|${m.user_id}`;
          if (!seenGroupMemberKeys.has(key)) {
            await dbRun(req.userDb, 'DELETE FROM group_users WHERE group_id=? AND user_id=?', [gid, m.user_id]);
            permStats.deleted++;
            historyDetails.push({ action: 'deleted', folder_path: m.group_name || String(gid), target_type: 'user', target_name: m.user_name, old_permission: m.group_name, new_permission: null });
            console.log(`[xlsx import] deleted: ${m.user_name} from ${m.group_name}`);
          }
        }
      }
    }

    // 9. 儲存匯入歷史
    const historyId = (await dbRun(req.userDb, 'INSERT INTO import_history (imported_by, file_name, mode, added, updated, deleted, skipped) VALUES (?, ?, ?, ?, ?, ?, ?)', [req.session.username || 'unknown', fileName, importMode, permStats.added, permStats.updated, permStats.deleted, permStats.skipped])).lastID;
    for (const d of historyDetails) {
      await dbRun(req.userDb, 'INSERT INTO import_history_detail (history_id, action, folder_path, target_type, target_name, old_permission, new_permission) VALUES (?, ?, ?, ?, ?, ?, ?)', [historyId, d.action, d.folder_path, d.target_type, d.target_name, d.old_permission, d.new_permission]);
    }

    fs.unlinkSync(req.file.path);

    console.log(`[xlsx import] 完成: added=${permStats.added} skipped=${permStats.skipped} deleted=${permStats.deleted}`);
    res.json({ success: true, permStats, historyId, mode: importMode });

  } catch (error) {
    console.error('[xlsx import] error:', error);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    internalError(res, error);
  }
});

// 查詢匯入歷史清單
router.get('/api/import-history', withUserDatabase, (req, res) => {
  req.userDb.all(
    'SELECT * FROM import_history ORDER BY imported_at DESC LIMIT 100',
    [],
    (err, rows) => {
      if (err) return internalError(res, err);
      res.json(rows);
    }
  );
});

// 查詢單次匯入的明細
router.get('/api/import-history/:id/details', withUserDatabase, (req, res) => {
  const id = parseInt(req.params.id);
  req.userDb.all(
    'SELECT * FROM import_history_detail WHERE history_id = ? ORDER BY id ASC',
    [id],
    (err, rows) => {
      if (err) return internalError(res, err);
      res.json(rows);
    }
  );
});

// 匯出完整 Excel 報表（中文欄位，多個 Sheet）
router.get('/export_excel', withUserDatabase, async (req, res) => {
  console.log('Hit /export_excel - Exporting all data to Excel');
  
  try {
    // 1. 查詢所有資料夾
    const folders = (await dbAll(req.userDb, `SELECT id, name, parent_id, path FROM folders ORDER BY id`)) || [];
    
    // 2. 查詢所有人員
    const users = (await dbAll(req.userDb, `SELECT id, name, email, department, company, title, phone, description FROM users ORDER BY id`)) || [];
    
    // 3. 查詢所有群組及成員
    const groups = (await dbAll(req.userDb, `SELECT id, name FROM groups ORDER BY id`)) || [];
    
    // 4. 查詢群組成員詳細資訊
    const groupMembers = (await dbAll(req.userDb, `
        SELECT g.id as group_id, g.name as group_name, 
               u.id as user_id, u.name as user_name, u.email,
               u.department, u.company, u.title, u.phone, u.description
        FROM groups g
        LEFT JOIN group_users gu ON g.id = gu.group_id
        LEFT JOIN users u ON gu.user_id = u.id
        ORDER BY g.id, u.id
      `)) || [];
    
    // 5. 查詢所有權限
    const permissions = (await dbAll(req.userDb, `
        SELECT p.id, 
               f.name as folder_name, f.path as folder_path,
               u.name as user_name, u.email as user_email,
               g.name as group_name,
               p.permission_type
        FROM permissions p
        LEFT JOIN folders f ON p.folder_id = f.id
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN groups g ON p.group_id = g.id
        ORDER BY p.id
      `)) || [];
    
    // 6. 建立 Excel 工作簿 (使用 ExcelJS)
    const workbook = new ExcelJS.Workbook();
    workbook.creator = '資料夾權限文管系統';
    workbook.created = new Date();
    workbook.modified = new Date();
    
    // 輔助函數：添加工作表並格式化
    const addWorksheet = (name, data) => {
      const worksheet = workbook.addWorksheet(name);
      
      if (data.length > 0) {
        // 獲取標題
        const headers = Object.keys(data[0]);
        
        // 添加標題行
        const headerRow = worksheet.addRow(headers);
        
        // 設定標題樣式
        headerRow.font = { bold: true, size: 11 };
        headerRow.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFD9D9D9' }
        };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
        headerRow.height = 20;
        
        // 添加資料行
        data.forEach(row => {
          const values = headers.map(header => row[header] || '');
          worksheet.addRow(values);
        });
        
        // 自動調整欄寬
        worksheet.columns.forEach((column, index) => {
          let maxLength = headers[index].length;
          column.eachCell({ includeEmpty: false }, cell => {
            const cellLength = cell.value ? cell.value.toString().length : 0;
            if (cellLength > maxLength) maxLength = cellLength;
          });
          column.width = Math.min(Math.max(maxLength + 2, 10), 50);
        });
        
        // 添加篩選
        if (data.length > 0) {
          worksheet.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: headers.length }
          };
        }
        
        // 凍結標題行
        worksheet.views = [
          { state: 'frozen', xSplit: 0, ySplit: 1 }
        ];
      }
      
      return worksheet;
    };
    
    // 7. 建立「資料夾」工作表
    const foldersData = folders.map(f => ({
      '編號': f.id,
      '資料夾名稱': f.name,
      '父資料夾編號': f.parent_id || '',
      '完整路徑': f.path || ''
    }));
    addWorksheet('資料夾', foldersData);
    
    // 8. 建立「人員」工作表
    const usersData = users.map(u => ({
      '編號': u.id,
      '姓名': u.name,
      'Email': u.email,
      '部門': u.department || '',
      '公司': u.company || '',
      '職稱': u.title || '',
      '電話': u.phone || '',
      '描述': u.description || ''
    }));
    addWorksheet('人員', usersData);
    
    // 9. 建立「群組」工作表
    const groupsData = groups.map(g => {
      const members = groupMembers
        .filter(m => m.group_id === g.id && m.user_id)
        .map(m => m.user_name)
        .join(', ');
      return {
        '編號': g.id,
        '群組名稱': g.name,
        '成員人數': groupMembers.filter(m => m.group_id === g.id && m.user_id).length,
        '成員清單': members || '無'
      };
    });
    addWorksheet('群組', groupsData);
    
    // 10. 建立「群組成員明細」工作表
    const groupMembersData = groupMembers
      .filter(m => m.user_id) // 只顯示有成員的記錄
      .map(m => ({
        '群組編號': m.group_id,
        '群組名稱': m.group_name,
        '人員編號': m.user_id,
        '人員姓名': m.user_name,
        '人員Email': m.email,
        '部門': m.department || '',
        '公司': m.company || '',
        '職稱': m.title || '',
        '電話': m.phone || '',
        '描述': m.description || ''
      }));
    addWorksheet('群組成員明細', groupMembersData);
    
    // 11. 建立「權限」工作表
    const permissionsData = permissions.map(p => {
      const permType = p.permission_type === 'read' ? '讀取' :
                       p.permission_type === 'write' ? '寫入' : p.permission_type;
      const target = p.user_name ? `人員: ${p.user_name}` : 
                     p.group_name ? `群組: ${p.group_name}` : '未知';
      return {
        '編號': p.id,
        '資料夾': p.folder_path || p.folder_name,
        '授權對象': target,
        '對象名稱': p.user_name || p.group_name || '',
        'Email/說明': p.user_email || '',
        '權限類型': permType
      };
    });
    addWorksheet('權限', permissionsData);
    
    // 12. 建立統計摘要工作表
    const summaryData = [
      { '項目': '資料夾總數', '數量': folders.length },
      { '項目': '人員總數', '數量': users.length },
      { '項目': '群組總數', '數量': groups.length },
      { '項目': '群組成員總數', '數量': groupMembers.filter(m => m.user_id).length },
      { '項目': '權限總數', '數量': permissions.length }
    ];
    addWorksheet('統計摘要', summaryData);
    
    // 13. 寫入檔案 (使用 ExcelJS)
    const tempFile = 'temp_export_' + Date.now() + '.xlsx';
    await workbook.xlsx.writeFile(tempFile);
    
    console.log(`Exported Excel: ${folders.length} folders, ${users.length} users, ${groups.length} groups, ${permissions.length} permissions`);
    
    // 14. 下載檔案
    const timestamp = nowFileStamp();
    const filename = `權限管理系統_完整報表_${timestamp}.xlsx`;
    
    res.download(tempFile, filename, (err) => {
      if (err) console.error('Download error:', err);
      // 刪除臨時檔案
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });
    
  } catch (error) {
    console.error('Export Excel error:', error);
    internalError(res, error);
  }
});

// 匯出權限清單（橫向格式，四層標題 + 人員權限）
// 查詢參數：include_description=1 時一併輸出人員描述欄位
router.get('/export_permission_matrix', withUserDatabase, async (req, res) => {
  const includeDescription = (req.query.include_description === '1' || req.query.include_description === 'true');
  console.log('Hit /export_permission_matrix - Exporting permission matrix, include_description:', includeDescription);
  
  try {
    // 1. 查詢所有資料夾
    const allFolders = await new Promise((resolve, reject) => {
      req.userDb.all(`SELECT id, name, parent_id, path FROM folders ORDER BY id`, (err, rows) => {
        if (err) {
          console.error('Error querying folders:', err);
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    });
    
    if (!allFolders || allFolders.length === 0) {
      return res.status(400).json({ error: '沒有資料夾資料，無法匯出權限清單' });
    }
    
    // 2. 查詢所有人員（需要描述時一併查詢 description；若 DB 無 description 欄位則自動改為不輸出描述）
    let actualIncludeDescription = includeDescription;
    let users;
    if (actualIncludeDescription) {
      try {
        users = (await dbAll(req.userDb, `SELECT id, name, description FROM users ORDER BY name`)) || [];
      } catch (userErr) {
        const msg = (userErr && userErr.message) ? String(userErr.message) : '';
        if (/no such column.*description/i.test(msg)) {
          actualIncludeDescription = false;
          users = (await dbAll(req.userDb, `SELECT id, name FROM users ORDER BY name`)) || [];
        } else {
          throw userErr;
        }
      }
    } else {
      users = (await dbAll(req.userDb, `SELECT id, name FROM users ORDER BY name`)) || [];
    }
    
    if (!users || users.length === 0) {
      return res.status(400).json({ error: '沒有人員資料，無法匯出權限清單' });
    }
    
    // 3. 查詢所有權限
    const permissions = (await dbAll(req.userDb, `
        SELECT p.folder_id, p.user_id, p.group_id, p.permission_type,
               f.path as folder_path, f.name as folder_name,
               u.name as user_name, g.name as group_name
        FROM permissions p
        LEFT JOIN folders f ON p.folder_id = f.id
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN groups g ON p.group_id = g.id
      `)) || [];
    
    // 4. 建立資料夾階層結構（最多4層）
    const folderMap = {};
    allFolders.forEach(f => {
      folderMap[f.id] = f;
    });
    
    // 計算每個資料夾的層級
    function getFolderLevel(folderId, visited = new Set()) {
      if (visited.has(folderId)) return 0; // 防止循環
      visited.add(folderId);
      
      const folder = folderMap[folderId];
      if (!folder || !folder.parent_id) return 1;
      
      return 1 + getFolderLevel(folder.parent_id, visited);
    }
    
    // 建立資料夾列表，包含層級資訊
    const foldersWithLevel = allFolders.map(f => {
      const level = getFolderLevel(f.id);
      return {
        ...f,
        level: Math.min(level, 4) // 最多4層
      };
    });
    
    // 按層級和名稱排序
    foldersWithLevel.sort((a, b) => {
      if (a.level !== b.level) return a.level - b.level;
      return (a.path || a.name).localeCompare(b.path || b.name, 'zh-TW');
    });
    
    // 5. 建立權限映射（人員 -> 資料夾 -> 權限類型）
    const permissionMap = {};
    
    // 先處理人員權限
    permissions.forEach(p => {
      if (p.user_id && p.user_name) {
        if (!permissionMap[p.user_id]) {
          permissionMap[p.user_id] = {};
        }
        permissionMap[p.user_id][p.folder_id] = p.permission_type;
      }
    });
    
    // 處理群組權限（需要展開群組成員）
    const groupPermissions = permissions.filter(p => p.group_id);
    if (groupPermissions.length > 0) {
      const groupIds = [...new Set(groupPermissions.map(p => p.group_id))];
      
      // 查詢所有群組成員
      const allGroupMembers = await new Promise((resolve, reject) => {
        const placeholders = groupIds.map(() => '?').join(',');
        req.userDb.all(`
          SELECT group_id, user_id FROM group_users WHERE group_id IN (${placeholders})
        `, groupIds, (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });
      
      // 建立群組到成員的映射
      const groupToMembers = {};
      allGroupMembers.forEach(m => {
        if (!groupToMembers[m.group_id]) {
          groupToMembers[m.group_id] = [];
        }
        groupToMembers[m.group_id].push(m.user_id);
      });
      
      // 將群組權限展開到成員
      groupPermissions.forEach(p => {
        const members = groupToMembers[p.group_id] || [];
        members.forEach(userId => {
          if (!permissionMap[userId]) {
            permissionMap[userId] = {};
          }
          // 如果該人員已有權限，保留較高權限（write > read）
          if (!permissionMap[userId][p.folder_id] || 
              (permissionMap[userId][p.folder_id] === 'read' && p.permission_type === 'write')) {
            permissionMap[userId][p.folder_id] = p.permission_type;
          }
        });
      });
    }
    
    // 6. 建立 Excel 工作簿
    const workbook = new ExcelJS.Workbook();
    workbook.creator = '資料夾權限文管系統';
    workbook.created = new Date();
    workbook.modified = new Date();
    
    const worksheet = workbook.addWorksheet('權限清單');
    
    // 7. 建立標題行（4層）
    // 輔助函數：取得資料夾的根目錄（第一層資料夾）
    function getRootFolder(folderId) {
      let currentId = folderId;
      let rootFolder = folderMap[currentId];
      while (currentId && folderMap[currentId] && folderMap[currentId].parent_id) {
        currentId = folderMap[currentId].parent_id;
        rootFolder = folderMap[currentId];
      }
      return rootFolder;
    }
    
    // 輔助函數：取得資料夾的所有祖先（從根到父，不包括資料夾本身）
    function getFolderAncestors(folderId) {
      const ancestors = [];
      let currentId = folderId;
      while (currentId && folderMap[currentId] && folderMap[currentId].parent_id) {
        currentId = folderMap[currentId].parent_id;
        if (folderMap[currentId]) {
          ancestors.unshift(folderMap[currentId]);
        }
      }
      return ancestors;
    }
    
    // 建立標題行資料
    const row1 = []; // 第一層：根目錄資料夾名稱（需要合併相同根目錄）
    const row2 = []; // 第二層：依父資料夾 ID 顯示
    const row3 = []; // 第三層：依父資料夾 ID 顯示
    const row4 = []; // 第四層：依父資料夾 ID 顯示
    
    let currentCol = actualIncludeDescription ? 3 : 2; // 含描述時從第3欄開始（A=層級/人員名，B=描述），否則從第2欄
    
    // 記錄每個根目錄的起始和結束列，用於合併
    const rootFolderRanges = {};
    let lastRootFolderId = null;
    let rootStartCol = 2; // 從B欄開始（第2列）
    
    foldersWithLevel.forEach((folder, index) => {
      const rootFolder = getRootFolder(folder.id);
      const rootFolderId = rootFolder ? rootFolder.id : folder.id;
      const ancestors = getFolderAncestors(folder.id);
      
      // 如果是第一個資料夾，初始化根目錄範圍
      if (index === 0) {
        rootStartCol = currentCol;
        lastRootFolderId = rootFolderId;
      }
      // 如果根目錄改變，記錄上一個根目錄的範圍
      else if (lastRootFolderId !== null && lastRootFolderId !== rootFolderId) {
        // 記錄上一個根目錄的結束位置
        if (rootFolderRanges[lastRootFolderId]) {
          rootFolderRanges[lastRootFolderId].end = currentCol - 1;
        } else {
          rootFolderRanges[lastRootFolderId] = { start: rootStartCol, end: currentCol - 1 };
        }
        // 開始新的根目錄範圍
        rootStartCol = currentCol;
        lastRootFolderId = rootFolderId;
      }
      
      // 取得完整路徑鏈（根 → ... → 資料夾本身）
      const pathChain = [...ancestors.map(a => a.name), folder.name];
      const levelValues = [
        pathChain[0] || '', // 第一層：根目錄
        pathChain[1] || '', // 第二層
        pathChain[2] || '', // 第三層
        pathChain[3] || ''  // 第四層
      ];
      
      // 第一層：根目錄名稱（需要合併相同根目錄）
      const rootName = levelValues[0] || folder.name;
      row1.push(rootName);
      
      // 第二層、第三層、第四層：依據父資料夾階層顯示（不足的層級填空字串）
      row2.push(levelValues[1]);
      row3.push(levelValues[2]);
      row4.push(levelValues[3]);
      
      currentCol += 1;
    });
    
    // 記錄最後一個根目錄的範圍
    if (lastRootFolderId !== null) {
      if (rootFolderRanges[lastRootFolderId]) {
        // 如果已經有記錄，更新結束位置
        rootFolderRanges[lastRootFolderId].end = currentCol - 1;
      } else {
        // 如果沒有記錄，創建新記錄
        rootFolderRanges[lastRootFolderId] = { start: rootStartCol, end: currentCol - 1 };
      }
    }
    
    // 添加標題行（A欄顯示層級標籤，B欄為描述欄標題（可選），其後為資料夾標題）
    if (actualIncludeDescription) {
      worksheet.addRow(['第一層', '描述', ...row1]);
      worksheet.addRow(['第二層', '', ...row2]);
      worksheet.addRow(['第三層', '', ...row3]);
      worksheet.addRow(['第四層', '', ...row4]);
    } else {
      worksheet.addRow(['第一層', ...row1]);
      worksheet.addRow(['第二層', ...row2]);
      worksheet.addRow(['第三層', ...row3]);
      worksheet.addRow(['第四層', ...row4]);
    }
    
        // 8.（不進行欄位合併，確保每一層的文字都能對應至各自的欄位）
// 9. 設定標題樣式
    for (let row = 1; row <= 4; row++) {
      const rowObj = worksheet.getRow(row);
      rowObj.font = { bold: true, size: 11 };
      rowObj.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD9D9D9' }
      };
      rowObj.alignment = { vertical: 'middle', horizontal: 'center' };
      rowObj.height = 20;
    }
    
    // 10. 添加人員權限資料
    users.forEach(user => {
      const desc = actualIncludeDescription && user && 'description' in user
        ? String(user.description != null ? user.description : '').trim()
        : '';
      const row = actualIncludeDescription ? [user.name, desc] : [user.name];
      
      foldersWithLevel.forEach(folder => {
        const perm = permissionMap[user.id] && permissionMap[user.id][folder.id];
        if (perm === 'write') {
          row.push('RW');
        } else if (perm === 'read') {
          row.push('RO');
        } else {
          row.push('');
        }
      });
      
      worksheet.addRow(row);
    });
    
    // 11. 設定資料行樣式
    for (let row = 5; row <= 4 + users.length; row++) {
      const rowObj = worksheet.getRow(row);
      rowObj.alignment = { vertical: 'middle', horizontal: 'center' };
      rowObj.height = 18;
    }
    
    // 12. 設定欄寬
    worksheet.getColumn(1).width = 20; // A欄：人員名稱列和層級標籤
    if (actualIncludeDescription) {
      worksheet.getColumn(2).width = 25; // B欄：描述
      for (let col = 3; col <= currentCol - 1; col++) {
        worksheet.getColumn(col).width = 8;
      }
    } else {
      for (let col = 2; col <= currentCol - 1; col++) {
        worksheet.getColumn(col).width = 8;
      }
    }
    
    // 13. 凍結標題行和人員名稱列（含描述時凍結 A、B 欄，前4行）
    worksheet.views = [
      { state: 'frozen', xSplit: actualIncludeDescription ? 2 : 1, ySplit: 4 }
    ];
    
    // 14. 寫入檔案
    const tempFile = 'temp_permission_matrix_' + Date.now() + '.xlsx';
    await workbook.xlsx.writeFile(tempFile);
    
    console.log(`Exported permission matrix: ${foldersWithLevel.length} folders, ${users.length} users`);
    
    // 15. 下載檔案
    const timestamp = nowFileStamp();
    const filename = `權限清單_${timestamp}.xlsx`;
    
    res.download(tempFile, filename, (err) => {
      if (err) console.error('Download error:', err);
      // 刪除臨時檔案
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });
    
  } catch (error) {
    console.error('Export permission matrix error:', error);
    console.error('Error stack:', error.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: '匯出失敗：' + error.message });
    }
  }
});

module.exports = router;
