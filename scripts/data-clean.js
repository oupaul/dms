#!/usr/bin/env node
'use strict';
/**
 * 資料清理 — 修正「資料健檢」（scripts/data-audit.js）發現、且可以安全自動處理的問題。
 *
 * 預設只預覽，不修改任何資料。要真的套用必須同時加上 --apply --yes。
 *
 * 用法（在應用程式目錄、用服務帳號執行）：
 *   node scripts/data-clean.js                                  # 預覽全部資料庫（不修改）
 *   node scripts/data-clean.js --only user_a.db                 # 只預覽指定資料庫
 *   node scripts/data-clean.js --fix orphans,paths              # 只預覽指定的修正項目
 *   node scripts/data-clean.js --only user_a.db --apply --yes   # 套用（先自動備份）
 *   node scripts/data-clean.js --json                           # 輸出 JSON
 *
 * 參數
 *   --dir <路徑>        資料庫目錄，預設 ./databases
 *   --only a.db,b.db    只處理指定的資料庫（建議一個一個來，先處理測試用的）
 *   --fix <項目>        safe（預設，全部）或逗號分隔：
 *                       orphans, duplicate-permissions, permission-types, paths,
 *                       unused-duplicate-groups, unused-duplicate-folders, allowed-databases
 *   --apply --yes       真的修改。每個資料庫：先 VACUUM INTO 備份 → 單一交易修正 → 失敗整個回復
 *   --backup-dir <路徑> 備份存放處，預設 ./backups/data-clean（權限 700）
 *
 * 套用時請先確認沒有大量使用者正在編輯，並保留備份直到確認結果正確。
 */
const path = require('path');
const { cleanAll, ALL_FIXES } = require('../lib/data-clean');

function parseArgs(argv) {
  const o = { dir: path.join(process.cwd(), 'databases'), only: [], fix: 'safe', apply: false, yes: false, json: false, backupDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') o.dir = path.resolve(argv[++i]);
    else if (a === '--only') o.only = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--fix') o.fix = argv[++i];
    else if (a === '--apply') o.apply = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--json') o.json = true;
    else if (a === '--backup-dir') o.backupDir = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help') o.help = true;
    else { console.error(`未知參數：${a}`); process.exit(2); }
  }
  return o;
}

function table(rows) {
  return rows.map(r => '        · ' + Object.entries(r).map(([k, v]) => `${k}=${v}`).join('  ')).join('\n');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(3, 29).join('\n')); return 0; }
  if (o.apply && !o.yes) {
    console.error('要真的修改資料，請同時加上 --apply --yes（先不加 --apply 預覽即可）。');
    return 2;
  }

  const report = await cleanAll(o.dir, o);
  if (report.unmatched.length) {
    console.error(`找不到這些資料庫（請確認檔名，位於 ${o.dir}）：\n  ${report.unmatched.join('\n  ')}`);
    console.error('未做任何修改。');
    return 2;
  }
  if (o.json) { console.log(JSON.stringify(report, null, 2)); return report.errors.length ? 3 : 0; }

  console.log(`DMS 資料清理 — ${o.dir}`);
  console.log(o.apply ? '★ 套用模式：每個資料庫先備份再修改' : '預覽模式：不會修改任何資料（要套用請加 --apply --yes）');
  console.log(`修正項目：${report.fixes.join('、')}\n`);

  if (!report.databases.length && !report.errors.length) console.log('✔ 沒有需要處理的項目。');

  for (const d of report.databases) {
    console.log(`■ ${d.name}${d.applied ? '　（已套用）' : ''}`);
    if (d.backup) console.log(`   備份：${d.backup}`);
    if (d.error) console.log(`   ✘ 失敗：${d.error}`);
    for (const f of d.fixes) {
      const verb = o.apply ? '已處理' : '將處理';
      if (f.count > 0) console.log(`   ✔ ${f.title}：${verb} ${f.count} 筆`);
      else console.log(`   ! ${f.title}：沒有可自動處理的項目，只有需要人工處理的`);
      if (f.details.length) console.log(table(f.details.slice(0, 8)) + (f.details.length > 8 ? `\n        · …其餘 ${f.details.length - 8} 筆省略` : ''));
      if (f.manual.length) {
        console.log(`   ! 需人工處理（${f.manual.length} 項，這支工具不會動）：`);
        console.log(table(f.manual.slice(0, 15)) + (f.manual.length > 15 ? `\n        · …其餘 ${f.manual.length - 15} 項省略` : ''));
      }
    }
    if (d.after) {
      const left = Object.entries(d.after);
      console.log(left.length ? `   套用後複查，仍有：${left.map(([k, v]) => `${k}=${v}`).join('、')}` : '   套用後複查：問題與警告已清零');
    }
    console.log('');
  }

  if (report.errors.length) {
    console.log('■ 失敗的資料庫（未被修改）');
    report.errors.forEach(e => console.log(`   ✘ ${e.database}：${e.error}`));
  }
  console.log('─'.repeat(60));
  console.log(`${o.apply ? '已套用' : '預覽'}：${report.summary.changed} 個資料庫有變更；${report.summary.manual} 項需要人工處理`);
  if (!o.apply && report.summary.changed) console.log('確認內容後，建議先挑一個測試用資料庫：--only <名稱> --apply --yes');
  return report.errors.length ? 3 : 0;
}

main().then(c => process.exit(c)).catch(e => { console.error('清理失敗：', e.message); process.exit(3); });
