// Signal 共用 prompt 定義
// 前端用 <script src="prompts.js"> 載入；GitHub Actions 的 scripts/*.mjs 用 createRequire 讀取。
// 修改這裡即同時生效於兩邊。

// ── Prompts ───────────────────────────────────────────────────────────────────
const PROMPT_PODCAST = `以下是投資相關筆記，請幫我深度分析：

【筆記標題】（填入集數名稱，例：股癌 EP.646）
【來源】（填入：股癌 / izaax / 其他）
【日期】（填入發布日期，格式：YYYY-MM-DD）

【筆記內容】
（在這裡貼上筆記全文）

【我的資產配置】
- 核心：0050（台股），約 105 萬，長期持有
- 可投資資金：約 50 萬
- 每月可新增：約 1 萬
- 目標：美股 VOO/VTI 被動為主，少部分主動投資台股

注意事項：
1. tickers 的 name 欄位統一標的名稱格式
2. TQQQ、正2 等槓桿工具型 ETF 不列入 tickers
3. 如果 portfolio_advice 建議「觀察」或「買進」
   某標的，該標的 stance 改為 bullish
4. sentiment 只填 bullish/bearish/neutral
5. portfolio_advice 只寫具體行動

請以下列 JSON 格式回覆，不要加任何多餘文字：
{
  "type": "podcast",
  "episode": "EP646",
  "date": "YYYY-MM-DD",
  "source": "股癌",
  "summary": ["重點1", "重點2", "重點3"],
  "tickers": [
    {
      "name": "MU 美光",
      "context": "提到的原因或看法",
      "stance": "bullish/bearish/neutral"
    }
  ],
  "themes": ["主題1", "主題2"],
  "market_view": "整體市場觀點（2-4句）",
  "sentiment": "bullish",
  "sentiment_reason": "情緒判斷原因",
  "quotes": ["金句1", "金句2"],
  "portfolio_advice": "具體投資行動建議"
}`;

const PROMPT_INDUSTRY = `你是產業研究筆記整理助手。請將以下產業分析內容整理成標準JSON格式，回傳純JSON不要加說明文字或markdown標記。

【規則】
1. type 固定填 "industry_research"
2. industry 填產業大類或主題（例：玻璃基板、被動元件、AI伺服器、美股觀察、總經分析）
3. 每個 ticker 的 category 欄位「依筆記內容判斷」：
   - 若筆記有供應鏈分析 → 填上游設備/中游/下游/材料/檢測等
   - 若筆記按題材分類 → 填題材分類（例：CPU、ASIC、散熱、電源）
   - 若筆記沒明確分類 → 填空字串 ""
   重點是「忠於原筆記的分類方式」，不要自己硬套
4. risks 陣列填產業特有風險，沒提到就填空陣列
5. stance 只填 bullish / bearish / neutral
6. date 格式 YYYY-MM-DD
7. quotes 摘錄原文金句，最多5句，沒有就空陣列
8. summary 列點摘要主要論點，3-8點

═══ JSON格式（更新版）═══

【類型1：podcast筆記】
{
  "episode": "EP???",
  "date": "YYYY-MM-DD",
  "source": "股癌",
  "type": "podcast",
  "summary": [],
  "tickers": [...],
  ...
}

【類型2：產業研究筆記】
{
  "title": "玻璃基板系列",
  "date": "YYYY-MM-DD",
  "source": "手寫產業筆記-娜娜",
  "type": "industry_research",
  "industry": "先進封裝/玻璃基板",
  "summary": [],
  "tickers": [
    {
      "name": "標的",
      "context": "說明",
      "stance": "bullish/bearish/neutral",
      "category": "上游設備/中游/下游/材料/檢測"
    }
  ],
  "themes": [],
  "market_view": "",
  "sentiment": "",
  "sentiment_reason": "",
  "quotes": [],
  "portfolio_advice": "",
  "risks": []
}

═══ 類型判斷規則 ═══
- 有 episode 編號 → type: podcast
- 系列產業分析 → type: industry_research
- 個人單篇心得 → 不收錄

【內容】
（這裡貼上產業筆記內容）`;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PROMPT_PODCAST, PROMPT_INDUSTRY };
}
