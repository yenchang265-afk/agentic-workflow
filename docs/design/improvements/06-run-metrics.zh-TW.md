[English](06-run-metrics.md) | 繁體中文

# 06 — 執行紀錄檔中的單次執行指標

## 背景

執行紀錄檔（`<tasksDir>/runs/<id>.md`，即 `src/task/store.ts:192` 中的
`appendRunLog`）會記錄每個階段的*輸出*，但沒有記錄這次執行的*樣貌*：一個
任務用掉了幾次疊代、每個階段花了多久、裁定歷史是什麼樣子。使用幾週之後，
我們沒有辦法回答「迴圈是在第一次疊代就收斂，還是經常把上限用光？」、
「哪個階段最耗費實際時間？」，或是「VERIFY 失敗的次數是否多於 REVIEW
失敗？」——而這些正是能用來調校 `maxIterations`、`stageTimeoutMinutes`
和階段提示詞的數字。

## 設計

### 驅動程式本地的累加器（保持 `state.ts` 純粹）

`LoopState` 保持不動——指標是驅動程式層級的非純粹（impure）關注點，就像
`recordedVerdicts` 一樣：

```ts
// src/loop/driver.ts (or a small src/loop/metrics.ts if it grows)
interface StageSample {
  readonly stage: Stage
  readonly iteration: number
  readonly ms: number
  readonly verdict?: Verdict | "none"   // check stages only
}
const runMetrics = new Map<string, StageSample[]>()  // keyed by sessionID
```

- 在 `drive()` 的 fire 迴圈中：在 `runStage`（第 292 行）之前執行
  `const t0 = Date.now()`，並在其執行後推入一筆樣本（且要在檢查類階段
  取得裁定之後才推入，這樣樣本才會帶有裁定）。搭配計畫 04 的多視角
  （multi-lens）審查，每次視角（lens）傳遞會有一筆樣本，並帶有 `lens?`
  欄位。
- 在 `done`/`stop`/error 時隨著 `clearLoop` 一併清除——在渲染完成之後。

### 在終端事件上渲染

在 `done` 和 `stop`（以及 `onIdle` 的 catch）時，在清除之前，透過既有的
`appendRunLog` 附加一個摘要區塊：

```
## Run summary · <done|stopped: reason> · 2026-07-04T10:12:03Z

| # | stage  | iter | verdict | wall-clock |
|---|--------|------|---------|------------|
| 1 | plan   | 1    | —       | 2m 41s     |
| 2 | build  | 1    | —       | 11m 05s    |
| 3 | verify | 1    | FAIL    | 3m 12s     |
| 4 | plan   | 2    | —       | 1m 58s     |
| 5 | build  | 2    | —       | 6m 44s     |
| 6 | verify | 2    | PASS    | 3m 01s     |
| 7 | review | 2    | PASS    | 4m 19s     |

iterations used: 2/3 · total: 33m 00s · outcome: done (review passed)
```

渲染是一個純函式——`renderRunSummary(samples, outcome, config)`——很容易
用表格驅動的方式測試。

### 範圍紀律

刻意**不**納入本計畫範圍：跨執行的彙總、儀表板、其他格式的指標檔案。
執行紀錄檔本身已經是持久的逐任務紀錄；每次執行加上一個摘要區塊，就能讓它
可用 grep 搜尋（`grep -A20 "## Run summary" docs/tasks/runs/*.md`），這樣
就足以回答一開始提出的問題。如果 grep 這種做法漸漸不敷使用，之後可以再做
彙總工具——不要投機性地預先建置它。

## 邊界案例

- 階段丟出例外（逾時）→ 中止的階段不會有樣本，但摘要仍會在錯誤路徑上，以
  已收集到的資料渲染；outcome 會標明錯誤名稱。
- 在階段執行中途下達 `/agent-loop stop` → 相同處理：部分樣本 +
  `stopped` outcome。
- 在執行中途重新啟動會遺失累加器（僅存於記憶體中）——這是可接受的；如果
  計畫 02 已經導入，復原後執行的摘要就只涵蓋復原後的樣本，並會這樣註明
  （`outcome: done (recovered run — pre-crash stages not timed)`）。不要
  把指標持久化進狀態快照——不值得為此增加耦合。
- 沒有任務的自由文字迴圈：`loopId()` 產生的 slug 已經會將執行紀錄檔路由到
  正確位置——不需改動即可運作。

## 測試計畫（TDD）

- `renderRunSummary`（純函式）：針對乾淨的單次疊代通過、重新規劃的執行、
  ERROR 中止、空樣本清單（在任何階段之前就當機）分別驗證表格形狀；以及
  時長格式化（不滿一分鐘、超過一小時）。
- 驅動程式測試框架：在驅動完成之後，執行紀錄檔收到了一個
  `## Run summary` 附加內容；樣本會帶有檢查類階段的裁定；渲染之後累加器
  會被清除（同一個 session 內不會跨執行洩漏）。

## 待更新文件

- `README.md` —— 在稽核／可觀測性段落中提及執行摘要區塊。
- `skills/loop-orchestration/SKILL.md` —— 執行紀錄檔段落：摘要包含什麼
  內容，以及它讓哪種調校迴圈成為可能（根據觀察到的數字調整
  `maxIterations` / `stageTimeoutMinutes`）。
