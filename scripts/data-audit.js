#!/usr/bin/env node
'use strict';
/**
 * 資料健檢（唯讀）— 檢查資料庫、資料夾、人員、群組、權限、申請單之間的關聯是否一致。
 *
 * 用法（在應用程式目錄執行，使用與服務相同的帳號，才讀得到資料庫檔）：
 *   node scripts/data-audit.js                    # 檢查 ./databases 下全部資料庫
 *   node scripts/data-audit.js --dir /opt/dms-dev/databases
 *   node scripts/data-audit.js --only admin.db,user_alice.db
 *   node scripts/data-audit.js --samples 10       # 每項顯示的樣本筆數（預設 5）
 *   node scripts/data-audit.js --json > report.json
 *   node scripts/data-audit.js --strict           # 有 error 級問題時結束碼為 1（可用於排程告警）
 *
 * 本腳本以「唯讀」方式開啟資料庫，不會修改、不會建立任何檔案。
 * 說明：error＝資料已不一致；warn＝建議處理；info＝僅供參考。
 */
const path = require('path');
const { auditAll } = require('../lib/data-audit');

function parseArgs(argv) {
  const opts = { dir: path.join(process.cwd(), 'databases'), samples: 5, json: false, strict: false, only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') opts.dir = path.resolve(argv[++i]);
    else if (a === '--samples') opts.samples = Math.max(0, parseInt(argv[++i], 10) || 5);
    else if (a === '--only') opts.only = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--json') opts.json = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '-h' || a === '--help') { opts.help = true; }
    else { console.error(`未知參數：${a}`); process.exit(2); }
  }
  return opts;
}

const ICON = { error: '✘', warn: '!', info: 'ℹ' };
const LABEL = { error: '問題', warn: '警告', info: '提示' };
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const color = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const paint = { error: s => color('31', s), warn: s => color('33', s), info: s => color('36', s) };

function fmtSample(s) {
  return Object.entries(s).map(([k, v]) => `${k}=${v === null ? 'NULL' : v}`).join('  ');
}

function printFinding(f) {
  console.log(`   ${paint[f.severity](`${ICON[f.severity]} [${LABEL[f.severity]}]`)} ${f.title}：${f.count} 筆`);
  for (const s of f.samples) console.log(`        · ${fmtSample(s)}`);
  if (f.count > f.samples.length && f.samples.length) console.log(`        · …其餘 ${f.count - f.samples.length} 筆省略`);
  if (f.hint) console.log(`        → ${f.hint}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(3, 15).join('\n')); return 0; }

  const report = await auditAll(opts.dir, opts);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`DMS 資料健檢（唯讀）— ${opts.dir}`);
    console.log(`檢查時間：${report.startedAt}\n`);

    console.log('■ 系統層級（帳號、資料庫登記）');
    if (!report.system) console.log('   找不到 system.db');
    else if (!report.system.findings.length) console.log('   ✔ 沒有發現問題');
    else report.system.findings.forEach(printFinding);

    for (const d of report.databases) {
      const s = d.stats;
      const counts = ['folders', 'users', 'groups', 'group_users', 'permissions', 'permission_requests']
        .filter(t => s[t] !== null).map(t => `${{ folders: '資料夾', users: '人員', groups: '群組', group_users: '成員', permissions: '權限', permission_requests: '申請單' }[t]} ${s[t]}`).join('、');
      console.log(`\n■ ${d.name}　（${counts || '無資料表'}）${d.snapshot ? '　〔以暫存快照檢查〕' : ''}`);
      if (!d.findings.length) console.log('   ✔ 沒有發現問題');
      else d.findings.forEach(printFinding);
    }

    if (report.errors.length) {
      console.log('\n■ 無法檢查的資料庫');
      report.errors.forEach(e => console.log(`   ✘ ${e.database}：${e.error}`));
    }

    if (report.snapshots.length) {
      console.log(`\n註：${report.snapshots.length} 個資料庫因目前使用者對資料庫目錄沒有寫入權限（WAL 模式的唯讀限制），改以「暫存快照」檢查——`
        + '複製到權限 700 的暫存目錄、檢查完立刻刪除，原檔完全沒被碰。若要避免，請用服務帳號執行（sudo -u <服務帳號> …）。');
    }
    const s = report.summary;
    console.log('\n' + '─'.repeat(60));
    console.log(`共檢查 ${s.databases} 個資料庫：${paint.error(`${s.error} 項問題`)}、${paint.warn(`${s.warn} 項警告`)}、${paint.info(`${s.info} 項提示`)}`);
    if (s.error + s.warn > 0) {
      console.log('本腳本只讀取、不修改；請先備份，確認內容後再決定如何清理（見 docs/data-audit.md）。');
    }
  }

  if (report.errors.length) return 3;
  return opts.strict && report.summary.error > 0 ? 1 : 0;
}

main().then(code => process.exit(code)).catch(err => {
  console.error('健檢失敗：', err.message);
  process.exit(3);
});
