#!/usr/bin/env node
// 手動匯入／刪除筆記。由網頁表單透過 workflow_dispatch 觸發，JSON 在這裡驗證後才寫檔。
//
// 環境變數（對應 workflow inputs）：
//   ACTION     save | delete
//   NOTE_TYPE  podcast | industry_research（save 用，analysis.type 優先）
//   TITLE      筆記標題（save 用）
//   RAW        Claude 回覆原文（save 用）
//   RECORD_ID  要刪除的 record id（delete 用）
import {
  PATHS, readStore, writeStore, byNewest, rotateArchive, epNum,
  parseJsonLoose, normalizeAnalysis, setOutput, addSummary,
} from './lib/store.mjs';

const ACTION    = (process.env.ACTION || '').trim();
const NOTE_TYPE = (process.env.NOTE_TYPE || 'podcast').trim();
const TITLE     = (process.env.TITLE || '').trim();
const RAW       = process.env.RAW || '';
const RECORD_ID = (process.env.RECORD_ID || '').trim();

const log = (...a) => console.log(...a);
const fileFor = type => (type === 'industry_research' ? PATHS.industry : PATHS.podcast);

function save() {
  if (!RAW.trim()) throw new Error('RAW 是空的，沒有內容可存');
  if (RAW.length > 80000) throw new Error(`內容 ${RAW.length} 字元，超過上限 80000`);

  const { analysis, warnings } = normalizeAnalysis(parseJsonLoose(RAW), { expectType: NOTE_TYPE });
  const title = TITLE || analysis.episode || analysis.title || '未命名筆記';
  const file  = fileFor(analysis.type);
  const records = readStore(file);

  // 同一集／同標題再存一次視為更新，不製造重複紀錄
  const ep = epNum({ analysis, title });
  const dupIdx = records.findIndex(r =>
    (analysis.type === 'podcast' && ep && epNum(r) === ep) || r.title === title);

  const record = {
    id: dupIdx >= 0 ? records[dupIdx].id : Date.now(),
    title,
    created_at: dupIdx >= 0 ? records[dupIdx].created_at : new Date().toISOString(),
    updated_at: dupIdx >= 0 ? new Date().toISOString() : undefined,
    analysis,
  };
  if (!record.updated_at) delete record.updated_at;

  let mode;
  if (dupIdx >= 0) { records[dupIdx] = record; mode = 'updated'; }
  else             { records.unshift(record); mode = 'created'; }

  writeStore(file, records.sort(byNewest));
  const rotated = analysis.type === 'podcast' ? rotateArchive() : { moved: 0 };

  log(`✓ ${mode}：${title}（${analysis.type}，摘要 ${analysis.summary.length} 點、標的 ${analysis.tickers.length} 檔）`);
  warnings.forEach(w => log(`  ⚠ ${w}`));
  if (rotated.moved) log(`  歸檔：搬了 ${rotated.moved} 集`);

  return { mode, title, type: analysis.type, warnings, rotated };
}

function remove() {
  if (!/^\d+$/.test(RECORD_ID)) throw new Error(`RECORD_ID 不合法：${RECORD_ID}`);
  const id = Number(RECORD_ID);

  for (const [name, file] of Object.entries(PATHS)) {
    const records = readStore(file);
    const hit = records.find(r => Number(r.id) === id);
    if (!hit) continue;
    writeStore(file, records.filter(r => Number(r.id) !== id));
    log(`✓ 已從 ${name} 刪除：${hit.title}`);
    return { mode: 'deleted', title: hit.title, type: name };
  }
  throw new Error(`找不到 id=${id} 的紀錄（可能已被刪除）`);
}

try {
  if (!['save', 'delete'].includes(ACTION)) throw new Error(`ACTION 只能是 save 或 delete，收到：${ACTION || '(空)'}`);

  const result = ACTION === 'save' ? save() : remove();

  setOutput('status', 'ok');
  addSummary(`### 筆記${result.mode === 'deleted' ? '刪除' : '匯入'}成功\n\n- ${result.title}\n- 類型：${result.type}`);
} catch (err) {
  const msg = err?.message || String(err);
  console.error(`✗ ${msg}`);
  setOutput('status', 'error');
  addSummary(`### 筆記處理失敗\n\n\`\`\`\n${msg}\n\`\`\``);
  process.exitCode = 1;
}
