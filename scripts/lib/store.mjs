// Signal 資料存取層：讀寫 data/*.json、歸檔輪轉、JSON 驗證
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');

export const PATHS = {
  podcast:  path.join(ROOT, 'data/podcasts/notes.json'),
  archive:  path.join(ROOT, 'data/podcasts/archive/notes.json'),
  industry: path.join(ROOT, 'data/industry-research/notes.json'),
};

// 主檔保留的 podcast 集數上限，超出的自動搬到 archive（不刪除）
export const MAIN_LIMIT = Number(process.env.MAIN_LIMIT || 50);

export const SENTIMENTS = ['bullish', 'bearish', 'neutral'];

// ── 讀寫 ──────────────────────────────────────────────────────────────────────
export function readStore(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.records) ? data.records : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`${path.relative(ROOT, file)} 解析失敗：${err.message}`);
  }
}

export function writeStore(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ records }, null, 2) + '\n', 'utf8');
}

export const byNewest = (a, b) => new Date(b.created_at) - new Date(a.created_at);

// ── 集數解析 ──────────────────────────────────────────────────────────────────
export function epNum(rec) {
  const a = rec?.analysis || {};
  const src = String(a.episode || rec?.title || '');
  // 只認 EP 標記：標題帶日期的產業筆記（例「石英元件供應鏈_20260419」）必須回傳 null，
  // 否則會被誤判成 EP2026 而讓 latestEpisode() 永遠抓不到新集數。
  const m = src.match(/EP\s*\.?\s*(\d{2,4})\b/i);
  return m ? Number(m[1]) : null;
}

/** 主檔 + 歸檔裡最新的集數（找不到回傳 0） */
export function latestEpisode() {
  const all = [...readStore(PATHS.podcast), ...readStore(PATHS.archive)];
  return all.reduce((max, r) => Math.max(max, epNum(r) || 0), 0);
}

export function knownEpisodes() {
  const all = [...readStore(PATHS.podcast), ...readStore(PATHS.archive)];
  return new Set(all.map(epNum).filter(Boolean));
}

// ── 歸檔輪轉 ──────────────────────────────────────────────────────────────────
/**
 * 主檔只留最新 MAIN_LIMIT 筆，其餘搬到 archive（純搬移，不刪資料）。
 * 產業研究筆記不參與輪轉。
 */
export function rotateArchive() {
  const main    = readStore(PATHS.podcast).sort(byNewest);
  const archive = readStore(PATHS.archive).sort(byNewest);

  if (main.length <= MAIN_LIMIT) {
    writeStore(PATHS.podcast, main);
    writeStore(PATHS.archive, dedupe(archive));
    return { moved: 0, main: main.length, archive: archive.length };
  }

  const keep  = main.slice(0, MAIN_LIMIT);
  const moved = main.slice(MAIN_LIMIT);
  const newArchive = dedupe([...moved, ...archive].sort(byNewest));

  writeStore(PATHS.podcast, keep);
  writeStore(PATHS.archive, newArchive);
  return { moved: moved.length, main: keep.length, archive: newArchive.length };
}

function dedupe(records) {
  const seen = new Set();
  return records.filter(r => {
    const k = String(r.id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── JSON 解析 / 驗證 ──────────────────────────────────────────────────────────
/** 從 Claude 回覆（可能夾帶說明文字或 ```json 圍欄）中取出 JSON 物件 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('內容為空');
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  const first = s.indexOf('{');
  const last  = s.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('找不到 JSON 物件（缺少大括號）');

  const slice = s.slice(first, last + 1);
  try {
    const obj = JSON.parse(slice);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('JSON 不是物件');
    return obj;
  } catch (err) {
    throw new Error(`JSON 解析失敗：${err.message}`);
  }
}

const asStrArray = v =>
  Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];

/**
 * 正規化 + 驗證 analysis 物件。
 * @param {object} raw
 * @param {{ expectType?: string, strict?: boolean }} opts
 *        strict=true 用於自動抓取（要求摘要／標的齊全），手動匯入較寬鬆。
 * @returns {{ analysis: object, warnings: string[] }}
 */
export function normalizeAnalysis(raw, opts = {}) {
  const { expectType, strict = false } = opts;
  const warnings = [];

  const type = raw.type || expectType || 'podcast';
  if (!['podcast', 'industry_research'].includes(type)) {
    throw new Error(`type 不合法：${type}`);
  }

  const a = { ...raw, type };

  a.summary = asStrArray(a.summary);
  a.themes  = asStrArray(a.themes);
  a.quotes  = asStrArray(a.quotes);
  a.risks   = asStrArray(a.risks);

  a.tickers = (Array.isArray(a.tickers) ? a.tickers : [])
    .filter(t => t && typeof t === 'object' && typeof t.name === 'string' && t.name.trim())
    .map(t => ({
      name:     t.name.trim(),
      context:  typeof t.context === 'string' ? t.context : '',
      stance:   SENTIMENTS.includes(t.stance) ? t.stance : 'neutral',
      ...(t.category ? { category: String(t.category) } : {}),
    }));

  if (!SENTIMENTS.includes(a.sentiment)) {
    if (a.sentiment) warnings.push(`sentiment「${a.sentiment}」不合法，改為 neutral`);
    a.sentiment = 'neutral';
  }

  if (a.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(a.date))) {
    warnings.push(`date 格式異常：${a.date}`);
  }

  for (const k of ['market_view', 'sentiment_reason', 'portfolio_advice']) {
    if (a[k] != null && typeof a[k] !== 'string') a[k] = String(a[k]);
  }

  if (strict) {
    if (type === 'podcast' && !a.episode) throw new Error('缺少 episode 欄位');
    if (a.summary.length < 3) throw new Error(`summary 只有 ${a.summary.length} 點，疑似分析不完整`);
    if (!a.market_view)      warnings.push('缺少 market_view');
    if (!a.tickers.length)   warnings.push('沒有抓到任何標的');
  } else if (!a.summary.length && !a.raw) {
    warnings.push('summary 為空');
  }

  return { analysis: a, warnings };
}

// ── GitHub Actions 輸出 ──────────────────────────────────────────────────────
/** 寫入 GitHub Actions step output */
export function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${name}=${String(value).replace(/\r?\n/g, ' ')}\n`);
}

export function addSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  fs.appendFileSync(file, markdown + '\n');
}
