# Signal

投資筆記分析工具。靜態站跑在 GitHub Pages（手機可直接用，不需要 `npm start`），
每天台灣時間早上 8 點由 GitHub Actions 自動抓股癌筆記新集數、呼叫 Claude 整理成 JSON 後 commit 回 repo。

```
index.html                     單頁 App（輸入筆記 / 統計儀表板）
prompts.js                     PROMPT_PODCAST / PROMPT_INDUSTRY（前端與 Actions 共用同一份）
data/podcasts/notes.json       Podcast 筆記（主檔，最新 50 集）
data/podcasts/archive/notes.json   歸檔（超過 50 集自動搬過來，不刪資料）
data/industry-research/notes.json  產業研究筆記（不歸檔）
data/archive/legacy-notes-2026-05.json  舊版 data/notes.json 原樣保留（內容已含在主檔內）
scripts/fetch-gooaye.mjs       每日抓取 + Claude 分析
scripts/import-note.mjs        手動匯入／刪除（由網頁表單觸發）
scripts/check.mjs              本機自檢（不需網路）
scripts/serve.mjs              本機預覽（零依賴）
```

## 運作方式

**讀取**：頁面直接 `fetch` 上面那幾個 JSON（帶 `?t=` 時間戳避開 CDN 快取）。
首次只載主檔；點「統計儀表板」或「查看歷史」時才載歸檔，所以統計一律是全量資料。

**寫入**：GitHub Pages 是靜態的，所以儲存／刪除會用你的 PAT 觸發
`import-note.yml`，由 Actions 驗證 JSON 後 commit。網頁會等 run 跑完（約 40 秒）再自動重新載入。

**自動抓取**：`fetch-gooaye.yml` → 讀主檔＋歸檔算出最新集數 → 走
索引頁 → 區間頁（`ep-700-to-800`）→ 單集頁三層找新集數 → cheerio 擷取正文 →
Claude（`claude-sonnet-5`, max_tokens 4000, thinking 關閉）→ 驗證 → 寫檔 → commit。
執行結果看 Actions 的 log 與 run 頁面上方的 Summary，不另外發通知。
索引頁解析失敗時會自動改用「直接探測網址」的後備方式。

## 首次設定

1. 建一個 **public** repo（私有 repo 開 Pages 需要 GitHub Pro），把這個資料夾推上 `main`
2. **Settings → Pages** → Source 選 `Deploy from a branch`，分支 `main`、資料夾 `/ (root)`
3. **Settings → Actions → General → Workflow permissions** 改成 **Read and write permissions**
   （否則 Actions 無法 commit）
4. **Settings → Secrets and variables → Actions → New repository secret**，建 1 個：

   | Secret | 內容 |
   |---|---|
   | `ANTHROPIC_API_KEY` | Claude API key |

5. 手機存檔用的 token：**Settings（個人）→ Developer settings → Personal access tokens →
   Fine-grained tokens** → Repository access 只勾這個 repo → Permissions 只給
   **Actions: Read and write** → 產生後貼進網頁右上角 ⚙

6. 補檔：**Actions → 每日抓取股癌筆記 → Run workflow**，`max_episodes` 填 `20`，
   一次把落後的集數補完（之後 cron 每天上限 3 集）。
   不確定來源站版面有沒有變的話，先用 `dry_run = true` 跑一次，只抓網頁不花 API 費用。

## 本機

```bash
npm install
npm run check      # 資料檔 / prompts / 前端引用自檢
npm run dev        # http://localhost:3333 預覽
npm run fetch:dry  # 只抓網頁不呼叫 API
```

## 注意

- 這個 repo 是 public，`data/` 裡的筆記內容任何人都看得到。
- PAT 只存在填入它的那台裝置的瀏覽器 localStorage，不會進入 repo；換手機要重新填。
- 單次 `workflow_dispatch` 的 `raw` 輸入上限約 60KB，一般筆記遠低於此。
- `prompts.js` 是前端和 Actions 的單一來源，改 prompt 兩邊同時生效。
- 沒有 commit `package-lock.json`；workflow 用 `npm install`。要鎖版本的話在本機
  `npm install` 後把產生的 lock 檔 commit 上去即可。
