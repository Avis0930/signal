#!/usr/bin/env node
// 把執行報告寄到信箱。缺 MAIL_* secrets 時只記錄 log、不讓 workflow 失敗。
//
// 環境變數：
//   MAIL_USERNAME  Gmail 帳號
//   MAIL_PASSWORD  Gmail 應用程式密碼（16 碼，不是登入密碼）
//   MAIL_TO        收件人（預設同 MAIL_USERNAME）
//   MAIL_ONLY_ON_ERROR  true 時只有失敗才寄信
import nodemailer from 'nodemailer';
import { readReport } from './lib/store.mjs';

const USER = process.env.MAIL_USERNAME;
const PASS = process.env.MAIL_PASSWORD;
const TO   = process.env.MAIL_TO || USER;
const ONLY_ON_ERROR = String(process.env.MAIL_ONLY_ON_ERROR || '').toLowerCase() === 'true';

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const report = readReport() || {
  job: 'unknown',
  status: 'error',
  fatal: '找不到執行報告，腳本可能在產生報告前就中斷了（請看 Actions log）',
  runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '',
};

const SUBJECTS = {
  ok:      r => `[Signal] ✅ 新增 ${(r.added || []).map(a => 'EP' + a.episode).join(', ') || '筆記'}`,
  partial: r => `[Signal] ⚠️ 部分成功（新增 ${(r.added || []).length} 集，失敗 ${(r.failed || []).length} 集）`,
  none:    () => '[Signal] ⏸ 今日無新集數',
  error:   () => '[Signal] ❌ 執行失敗',
};

function buildHtml(r) {
  const rows = [];
  const add = (k, v) => v && rows.push(`<tr><td style="padding:4px 12px 4px 0;color:#888;white-space:nowrap">${k}</td><td style="padding:4px 0">${v}</td></tr>`);

  add('工作', r.job === 'fetch' ? '每日抓取股癌筆記' : r.job === 'import' ? '手動匯入筆記' : r.job);
  add('狀態', esc(r.status));
  if (r.model) add('模型', esc(r.model));
  if (r.latestBefore) add('原本最新', 'EP' + r.latestBefore);

  if (r.added?.length) {
    add('新增', r.added.map(a => a.dryRun
      ? `EP${a.episode}（dry-run，${a.chars} 字）`
      : `EP${a.episode}（摘要 ${a.summary} 點／標的 ${a.tickers} 檔／${a.sentiment}${a.tokens ? `／tokens ${a.tokens}` : ''}）`
    ).join('<br>'));
  }
  if (r.failed?.length) {
    add('失敗', r.failed.map(f => `EP${f.episode}：${esc(f.error)}`).join('<br>'));
  }
  if (r.skipped?.length) add('本次未處理', r.skipped.map(n => 'EP' + n).join(', ') + '（超過單次上限，明天會續抓）');
  if (r.warnings?.length) add('提醒', r.warnings.map(esc).join('<br>'));
  if (r.rotated?.moved)  add('歸檔', `搬了 ${r.rotated.moved} 集到 archive`);
  if (r.fatal) add('錯誤', `<code>${esc(r.fatal)}</code>`);
  if (r.error) add('錯誤', `<code>${esc(r.error)}</code>`);
  if (r.title) add('標題', esc(r.title));
  if (r.finishedAt) add('完成時間', new Date(r.finishedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) + ' (台北)');

  return `<div style="font-family:system-ui,'Noto Sans TC',sans-serif;font-size:14px;line-height:1.7;color:#222">
  <h2 style="font-size:16px;margin:0 0 12px">Signal 自動化執行報告</h2>
  <table style="border-collapse:collapse">${rows.join('')}</table>
  ${r.runUrl ? `<p style="margin-top:16px"><a href="${esc(r.runUrl)}">查看 Actions 執行紀錄 →</a></p>` : ''}
</div>`;
}

async function main() {
  if (!USER || !PASS) {
    console.log('⚠ 未設定 MAIL_USERNAME / MAIL_PASSWORD，跳過寄信');
    return;
  }
  if (ONLY_ON_ERROR && !['error', 'partial'].includes(report.status)) {
    console.log(`狀態 ${report.status}，依 MAIL_ONLY_ON_ERROR 設定不寄信`);
    return;
  }

  const subject = (SUBJECTS[report.status] || SUBJECTS.error)(report);
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: USER, pass: PASS },
  });

  await transporter.sendMail({
    from: `Signal <${USER}>`,
    to: TO,
    subject,
    html: buildHtml(report),
    text: JSON.stringify(report, null, 2),
  });
  console.log(`✓ 已寄出：${subject} → ${TO}`);
}

main().catch(err => {
  // 寄信失敗不該讓整個 workflow 變紅（資料已經寫進去了），只警告
  console.error('⚠ 寄信失敗：', err?.message || err);
  if (/Invalid login|Username and Password not accepted/i.test(String(err?.message))) {
    console.error('  → 請確認 MAIL_PASSWORD 用的是 Google「應用程式密碼」而非登入密碼');
  }
});
