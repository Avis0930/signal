#!/usr/bin/env node
// 每天抓取 socialworkerdaily 上的股癌筆記新集數，交給 Claude 整理成 Signal 的 JSON 格式。
//
// 環境變數：
//   ANTHROPIC_API_KEY  必填（DRY_RUN=true 時不需要）
//   CLAUDE_MODEL       預設 claude-sonnet-5
//   MAX_TOKENS         預設 4000
//   MAX_EPISODES       單次最多處理幾集，預設 3
//   DRY_RUN            true 時只抓網頁、不呼叫 API（驗證選擇器用）
import { createRequire } from 'node:module';
import * as cheerio from 'cheerio';
import Anthropic from '@anthropic-ai/sdk';
import {
  PATHS, readStore, writeStore, byNewest, rotateArchive, latestEpisode, knownEpisodes,
  parseJsonLoose, normalizeAnalysis, setOutput, addSummary,
} from './lib/store.mjs';

const require = createRequire(import.meta.url);
const { PROMPT_PODCAST } = require('../prompts.js');

const INDEX_URL   = 'https://socialworkerdaily.com/index/invest/notes-of-gooaye/';
const EP_URL      = n => `https://socialworkerdaily.com/notes-of-gooaye-ep-${n}/`;
const UA          = 'Mozilla/5.0 (compatible; SignalBot/1.0; +https://github.com)';
const MODEL       = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const MAX_TOKENS  = Number(process.env.MAX_TOKENS || 4000);
const MAX_EPISODES = Math.max(1, Number(process.env.MAX_EPISODES || 3));
const DRY_RUN     = String(process.env.DRY_RUN || '').toLowerCase() === 'true'
                 || process.argv.includes('--dry-run');
// 設了就連「比現有最新集數舊、但從沒收錄過」的缺號一起補（例 EP667、EP676）
const BACKFILL_FROM = Number(process.env.BACKFILL_FROM || 0);
const MIN_CONTENT = 300;   // 低於這個字數視為抓取失敗（付費牆／版面改版）

const log = (...a) => console.log(...a);

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function httpGet(url, { tries = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9' },
        redirect: 'follow',
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < tries) await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
  throw new Error(`抓取 ${url} 失敗：${lastErr?.message || lastErr}`);
}

// ── 找出有哪些新集數 ─────────────────────────────────────────────────────────
// 來源站是三層結構：索引頁 →（ep-700-to-800 之類的）區間頁 → 單集頁
async function discoverEpisodes(latest) {
  const found = new Set();
  // 一般情況只找比最新集數更新的；BACKFILL_FROM 有值時從該集起全部重掃（補缺號）
  const floor = BACKFILL_FROM ? BACKFILL_FROM - 1 : latest;

  try {
    const indexHtml = await httpGet(INDEX_URL);
    const ranges = [...(indexHtml || '').matchAll(/notes-of-gooaye\/ep-(\d+)-to-(\d+)\//g)]
      .map(m => ({ from: Number(m[1]), to: Number(m[2]), url: `https://socialworkerdaily.com/index/invest/notes-of-gooaye/ep-${m[1]}-to-${m[2]}/` }));

    const uniqueRanges = [...new Map(ranges.map(r => [r.url, r])).values()]
      .filter(r => r.to > floor)
      .sort((a, b) => a.from - b.from);

    log(`索引頁找到 ${uniqueRanges.length} 個可能含新集數的區間頁`);

    for (const r of uniqueRanges) {
      const html = await httpGet(r.url);
      if (!html) continue;
      for (const m of html.matchAll(/notes-of-gooaye-ep-(\d+)/g)) {
        const n = Number(m[1]);
        if (n > floor) found.add(n);
      }
    }
  } catch (err) {
    log(`⚠ 索引頁解析失敗（${err.message}），改用直接探測`);
  }

  // 後備：直接探測 latest+1 起算的網址，連續 3 次 404 就停
  if (!found.size) {
    let misses = 0;
    for (let n = floor + 1; n <= floor + 20 && misses < 3; n++) {
      const html = await httpGet(EP_URL(n), { tries: 2 }).catch(() => null);
      if (html) { found.add(n); misses = 0; } else { misses++; }
    }
    if (found.size) log(`探測模式找到 ${found.size} 集`);
  }

  const known = knownEpisodes();
  return [...found].filter(n => !known.has(n)).sort((a, b) => a - b);
}

// ── 擷取單集內容 ─────────────────────────────────────────────────────────────
function extractArticle(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript,nav,footer,aside,form,iframe,.sidebar,.comments,#comments,.related,.share,.nav-links,.breadcrumb').remove();

  const selectors = [
    'article .entry-content', '.entry-content', '.post-content', '.article-content',
    '.td-post-content', 'article', 'main', '#content',
  ];
  let best = '';
  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const t = $(el).text().trim();
      if (t.length > best.length) best = t;
    });
  }
  if (!best) best = $('body').text().trim();

  const text = best
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  let date = '';
  const meta = $('meta[property="article:published_time"]').attr('content')
            || $('time[datetime]').first().attr('datetime') || '';
  const dm = String(meta).match(/(\d{4}-\d{2}-\d{2})/);
  if (dm) date = dm[1];

  return { text, date };
}

async function fetchEpisode(n) {
  const html = await httpGet(EP_URL(n));
  if (!html) throw new Error(`單集頁不存在（${EP_URL(n)}）`);
  const { text, date } = extractArticle(html);
  if (text.length < MIN_CONTENT) {
    throw new Error(`內容只有 ${text.length} 字，疑似付費牆或版面改版（${EP_URL(n)}）`);
  }
  return { text, date, url: EP_URL(n) };
}

// ── Claude 分析 ──────────────────────────────────────────────────────────────
const client = DRY_RUN ? null : new Anthropic();

function buildPrompt(n, { text, date, url }) {
  // PROMPT_PODCAST 是範本（含「請填入」說明），實際輸入附在後面覆蓋，
  // 這樣 prompts.js 保持單一來源，改前端 prompt 不會讓這支腳本失效。
  return `${PROMPT_PODCAST}

---
以下是這次要分析的實際輸入，請以此為準（覆蓋上方範本中的填入說明）：

【筆記標題】股癌 EP${n}
【來源】股癌
【日期】${date || '未標示，請從內容推斷，無法判斷則填發布年月的第一天'}
【原文網址】${url}

【筆記內容】
${text}`;
}

const todayTW = () =>
  new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

async function analyze(n, page) {
  const prompt = buildPrompt(n, page);
  let maxTokens = MAX_TOKENS;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const msg = await callClaude(prompt, maxTokens);

    if (msg.stop_reason === 'refusal') {
      throw new Error(`Claude 拒絕處理（${msg.stop_details?.category || 'unknown'}）`);
    }
    if (msg.stop_reason === 'max_tokens') {
      if (attempt === 1) {
        maxTokens = MAX_TOKENS * 2;
        console.log(`  ⚠ 回覆被 max_tokens 截斷，改用 ${maxTokens} 重試`);
        continue;
      }
      throw new Error(`回覆仍被截斷（max_tokens=${maxTokens}）`);
    }

    const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const { analysis, warnings } = normalizeAnalysis(parseJsonLoose(text), {
      expectType: 'podcast',
      strict: true,
    });

    analysis.type    = 'podcast';
    analysis.episode = `EP${n}`;
    analysis.source  = analysis.source || '股癌';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(analysis.date || ''))) {
      analysis.date = page.date || todayTW();
    }
    analysis.source_url = page.url;

    return { analysis, warnings, usage: msg.usage };
  }
  throw new Error('分析失敗');
}

async function callClaude(prompt, maxTokens) {
  for (let i = 1; i <= 3; i++) {
    try {
      return await client.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        // 這是固定格式的擷取任務，關掉 thinking 讓 max_tokens 全部留給 JSON 輸出
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      });
    } catch (err) {
      const retryable = err instanceof Anthropic.RateLimitError
        || err instanceof Anthropic.APIConnectionError
        || (err instanceof Anthropic.APIError && err.status >= 500);
      if (!retryable || i === 3) throw describeApiError(err);
      const wait = 5000 * i;
      console.log(`  ⚠ API 錯誤（${err.status || err.name}），${wait / 1000}s 後重試`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

function describeApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new Error('ANTHROPIC_API_KEY 無效或已失效');
  if (err instanceof Anthropic.BadRequestError)     return new Error(`API 參數錯誤：${err.message}`);
  if (err instanceof Anthropic.RateLimitError)      return new Error('API 連續被 rate limit，稍後重試');
  if (err instanceof Anthropic.APIError)            return new Error(`API 錯誤 ${err.status}：${err.message}`);
  return err;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = new Date().toISOString();
  const latest = latestEpisode();
  log(`目前最新集數：EP${latest || '（無資料）'}`);
  log(`模式：${DRY_RUN ? 'DRY RUN（不呼叫 API）' : MODEL}，單次上限 ${MAX_EPISODES} 集\n`);

  const pending = await discoverEpisodes(latest);
  log(`發現未收錄集數：${pending.length ? pending.map(n => 'EP' + n).join(', ') : '（無）'}`);

  const targets = pending.slice(0, MAX_EPISODES);
  const skipped = pending.slice(MAX_EPISODES);

  const added = [], failed = [], warnings = [];

  for (const n of targets) {
    log(`\n── EP${n} ──`);
    try {
      const page = await fetchEpisode(n);
      log(`  擷取 ${page.text.length} 字${page.date ? `（發布 ${page.date}）` : ''}`);

      if (DRY_RUN) {
        log(`  預覽：${page.text.slice(0, 200).replace(/\n/g, ' ')}…`);
        added.push({ episode: n, dryRun: true, chars: page.text.length });
        continue;
      }

      const { analysis, warnings: w, usage } = await analyze(n, page);
      const records = readStore(PATHS.podcast);
      records.unshift({
        id: Date.now(),
        title: `股癌 EP${n}`,
        created_at: new Date().toISOString(),
        analysis,
      });
      writeStore(PATHS.podcast, records.sort(byNewest));

      w.forEach(x => warnings.push(`EP${n}：${x}`));
      log(`  ✓ 已寫入（摘要 ${analysis.summary.length} 點、標的 ${analysis.tickers.length} 檔、情緒 ${analysis.sentiment}）`);
      added.push({
        episode: n,
        summary: analysis.summary.length,
        tickers: analysis.tickers.length,
        sentiment: analysis.sentiment,
        tokens: usage ? `${usage.input_tokens}→${usage.output_tokens}` : '',
      });
      await new Promise(r => setTimeout(r, 1200)); // 對來源站客氣一點
    } catch (err) {
      log(`  ✗ ${err.message}`);
      failed.push({ episode: n, error: err.message });
    }
  }

  const rotated = DRY_RUN || !added.length ? { moved: 0 } : rotateArchive();
  if (rotated.moved) log(`\n歸檔：搬了 ${rotated.moved} 集到 data/podcasts/archive/`);

  const status = failed.length && !added.length ? 'error'
               : failed.length                  ? 'partial'
               : added.length                   ? 'ok'
               : 'none';

  const changed = !DRY_RUN && added.length > 0;
  setOutput('status', status);
  setOutput('changed', changed);
  setOutput('added', added.map(a => 'EP' + a.episode).join(','));

  // 執行結果只留在 Actions log 與 run 頁面的 Summary（不另外通知）
  addSummary([
    `### Signal 抓取結果：${status}`,
    '',
    `- 開始時間：${startedAt}`,
    `- 模式：${DRY_RUN ? 'dry-run（未呼叫 API）' : MODEL}`,
    `- 原本最新：EP${latest}`,
    `- 新增：${added.length ? added.map(a => 'EP' + a.episode).join(', ') : '無'}`,
    failed.length ? `- 失敗：${failed.map(f => `EP${f.episode}（${f.error}）`).join('；')}` : '',
    skipped.length ? `- 本次未處理（超過上限）：${skipped.map(n => 'EP' + n).join(', ')}` : '',
    warnings.length ? `- 提醒：${warnings.join('；')}` : '',
    rotated.moved ? `- 歸檔：搬了 ${rotated.moved} 集到 archive` : '',
  ].filter(Boolean).join('\n'));

  log(`\n完成：status=${status}，新增 ${added.length} 集，失敗 ${failed.length} 集`);
}

main().catch(err => {
  console.error('✗ 執行中斷：', err?.stack || err);
  addSummary(['### Signal 抓取失敗', '', '```', String(err?.message || err), '```'].join('\n'));
  setOutput('status', 'error');
  // 不覆寫 changed：若崩潰前已寫入部分集數，workflow 會用 git diff 自行判斷要不要 commit
  process.exitCode = 1;
});
