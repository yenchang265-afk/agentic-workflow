[English](72-metrics-run-cache.md) | 繁體中文

# 72 —— 執行紀錄讀取器快取解析結果並平行讀取

**狀態：已實作。**

## 問題

`readRunInputs` 每次呼叫都逐一讀取並解析每個 `runs/*.md` 與 `*.metrics.json`，管理面板的
Metrics 分頁又在每次 `versions.run`/`versions.tokens` SSE 事件時重抓——一次執行紀錄的附加就
讓整棵樹被重讀好幾次，而在 WSL 的 DrvFS 樹上逐檔延遲是主要成本。core 的 `Client` 沒有 stat，
沒有東西可以當快取鍵。

## 改了什麼

- **`ReadRunInputsOptions`**：選填的 `stat(absPath)` 鉤子與呼叫端持有的 `cache` map。兩者都
  給時，一次執行的解析在**兩個**檔案的大小與 mtime 都不變時重用（`tokens/transcripts.ts`
  記下的教訓：只看大小會把同長度的改寫當成沒變）；檔案變了就重新解析；消失的 id 會被逐出。
  `concurrency`（預設 16）以有界的 worker pool 取代序列迴圈，順序保留。
- **管理面板**傳入 `fs.statSync` 與每個 repo 一份、行程生命週期的 map（`metrics/runcache.ts`）；
  core 預設仍不需要 stat，所以兩種 CLI host 的 `metrics` 動詞不變，之後可選擇加入。

## 尖銳邊角

- **兩個檔案都當鍵。** `upsertRunMetrics` 經常把 sidecar 改寫成相同長度；mtime 才抓得到。
- **快取是呼叫端的。** 它的生命週期與上限是管理面板的決定，不是 core 的。
