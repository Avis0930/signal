#!/usr/bin/env node
// 自檢：資料檔是否合法、prompts 是否載得到、前端引用的檔案是否存在。
// 不需要網路或 API key。 → npm run check
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PATHS, ROOT, readStore, epNum, normalizeAnalysis, MAIN_LIMIT } from './lib/store.mjs';

const require = createRequire(import.meta.url);
let fail = 0;
const ok   = m => console.log('  ✓ ' + m);
const bad  = m => { console.log('  ✗ ' + m); fail++; };
const warn = m => console.log('  ⚠ ' + m);

console.log('\n[1] prompts.js');
try {
  const { PROMPT_PODCAST, PROMPT_INDUSTRY } = require('../prompts.js');
  if (PROMPT_PODCAST?.length > 200) ok(`PROMPT_PODCAST（${PROMPT_PODCAST.length} 字）`); else bad('PROMPT_PODCAST 太短或缺失');
  if (PROMPT_INDUSTRY?.length > 200) ok(`PROMPT_INDUSTRY（${PROMPT_INDUSTRY.length} 字）`); else bad('PROMPT_INDUSTRY 太短或缺失');
} catch (e) { bad('載入失敗：' + e.message); }

console.log('\n[2] 前端檔案');
for (const f of ['index.html', 'prompts.js', '.nojekyll']) {
  fs.existsSync(path.join(ROOT, f)) ? ok(f) : bad(f + ' 不存在');
}
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html.includes('src="prompts.js"') ? ok('index.html 有載入 prompts.js') : bad('index.html 沒有載入 prompts.js');
/\/api\//.test(html) ? bad('index.html 還殘留 /api/ 呼叫') : ok('沒有殘留的 /api/ 呼叫');

console.log('\n[3] 資料檔');
let total = 0;
for (const [name, file] of Object.entries(PATHS)) {
  let recs;
  try { recs = readStore(file); } catch (e) { bad(`${name}：${e.message}`); continue; }
  total += recs.length;

  const ids  = recs.map(r => r.id);
  const dupI = ids.filter((id, i) => ids.indexOf(id) !== i);
  const eps  = recs.map(epNum).filter(Boolean);
  const dupE = eps.filter((e, i) => eps.indexOf(e) !== i);

  let invalid = 0;
  for (const r of recs) {
    if (!r.id || !r.title || !r.created_at || !r.analysis) { invalid++; continue; }
    try { normalizeAnalysis(r.analysis, {}); } catch { invalid++; }
  }

  ok(`${name}：${recs.length} 筆${eps.length ? `，集數 EP${Math.min(...eps)}–EP${Math.max(...eps)}` : ''}`);
  if (dupI.length) bad(`${name}：id 重複 → ${[...new Set(dupI)].join(', ')}`);
  if (dupE.length) warn(`${name}：集數重複 → ${[...new Set(dupE)].map(e => 'EP' + e).join(', ')}`);
  if (invalid)     bad(`${name}：${invalid} 筆結構不完整`);
}

const mainCount = readStore(PATHS.podcast).length;
if (mainCount > MAIN_LIMIT) warn(`主檔 ${mainCount} 筆 > 上限 ${MAIN_LIMIT}，下次寫入時會自動歸檔`);
else ok(`主檔 ${mainCount} 筆（上限 ${MAIN_LIMIT}）`);

console.log(`\n共 ${total} 筆紀錄，${fail ? `${fail} 項錯誤` : '全部通過'}\n`);
process.exitCode = fail ? 1 : 0;
