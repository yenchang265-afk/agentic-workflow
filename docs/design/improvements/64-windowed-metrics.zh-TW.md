[English](64-windowed-metrics.md) | 繁體中文

# 64 —— 指標可以按時間窗、按週，也可以從終端機看

**狀態：已實作。**

## 問題

管理面板的 Metrics 分頁把整個 `runs/` 摺成每個指標一個數字，所以這個月的退步對著一年的
歷史讀起來像捨入誤差，也完全沒有趨勢。算術住在管理面板套件裡，驅動迴圈的終端機沒有
瀏覽器就無法問「迴圈有沒有變好」。

## 改了什麼

- **core 的 `workflow/metrics-aggregate.ts`** 持有 pass 層級的一半——`iterationBurn`、
  `firstPassYield`、`stageDurations`、`outcomeTally`、`stageLabel`、`isCheckRow` 與其型別——
  從管理面板移入，管理面板改為重新匯出。單位仍是 pass。
- **`MetricsWindow`**（`since`、`kind`）在計數**之前**縮小母體：`windowInputs` 依
  `at`/`kind` 過濾 pass、依 `endedAt`/`kind` 過濾 sidecar 項目，丟掉變空的輸入，
  `runsTotal` 因此說的是時間窗涵蓋了什麼。沒有 kind 的 pass 算作 engineering（歷史紀錄）。
  `parseWindow` 讀 `7d`/`30d`/`all`。
- **`weeklyTrend`**：每個 UTC ISO 週的 pass 數、done 數、cap-trip 與 first-pass 比率，
  最舊在前，最新 12 週。
- **管理面板**：`GET /api/metrics?window=30d&kind=…`（壞值是 400，絕不悄悄變成 `all`）、
  時間窗／kind 晶片、趨勢表，回應中回傳 `window` 讓 UI 無法標錯；`kinds` 來自未過濾的
  母體，過濾後的視圖仍提供其餘選項。
- **兩種 host 的 `metrics [7d|30d|all] [kind]`**（`workflow_metrics`），透過
  `readRunInputs`——管理面板路由現在也用的唯一讀取器——與 `formatMetricsHeadline`，
  終端機與分頁不可能不一致。

## 尖銳邊角

- **先過濾，再計數。** 每個比率必須量同一片切片；過濾算完的回應會讓 `runsTotal`
  描述另一片。
- **週趨勢用 `at`，絕不用檔案順序。** 執行紀錄的 pass 是附加的，但一個檔案跨好幾週。
