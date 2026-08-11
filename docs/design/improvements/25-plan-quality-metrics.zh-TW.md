[English](25-plan-quality-metrics.md) | 繁體中文

# 25 — 計畫品質有了自己的數字

**狀態：已實作。**

## 問題

Metrics 分頁量測了 run 的一切，唯獨漏了人類閘門花最多判斷力的東西：計畫。
`capTripRate` 是「計畫很糟」的唯一代理指標，而它把爛計畫、難任務、與不穩測試
混為一談。與此同時證據早就在磁碟上——sidecar 裡的 plan-stage passes、停泊閘門
的契約拒絕明細、以及（自方案 22 起）每個樣本的檢查來源——沒有一項被彙整。

## 改了什麼

- **`plans`** 上到 `MetricsResponse`（`packages/hub/src/shared/api.ts`，
  `planStats` 在 `server/metrics/aggregate.ts`）：`runsWithPlanPass`、
  `replannedRuns`（sidecar 內含 ≥2 個 plan-stage pass 的 run 檔——一個檔案累
  積一個任務的 passes，所以「被拒後重規劃」就以此形狀可見）、`replanRate`
  （無法量測時為 null，與其他比率一致）、以及 `contractRefusals`——detail 與
  停泊閘門自己的拒絕字串相符的 sidecar `error` 條目。那些字串現在是匯出的常
  數（`PARK_NO_PLAN_WHY`/`PARK_NO_VERIFICATION_WHY`，
  `packages/core/src/workflow/terminal.ts`），彙整端直接匯入——手抄字串正是寫
  入端與比對端漂移、計數永遠靜默為零的成因。
- **`discovery`**（`discoveryStats`）：check-stage 點火依 `checksSource`
  （config / manifest / discovered / none）計數，加上 `refusedTotal`。一次點
  火是一組（entry × stage × iteration）：OpenCode 宿主替 fan-out 每個 pass 的
  樣本蓋上相同來源，因此每組取第一個樣本，lens fan-out 不會被數 N 次。
- **UI**（`web/metrics/MetricsTab.tsx`）：一列計畫品質 chips——replan 率（高
  於 50% 轉紅）、契約拒絕、檢查來源分佈、被拒檢查——放在它所補充脈絡的既有
  cap-trip chip 旁。

## 刻意不做的事

- 不做跨檔的 per-task join：pass 仍是分析單位，一如彙整模組自己的註解；對
  backlog 來源而言 run 檔本就 per-task，`replannedRuns` 倚賴的正是這點。
- 不從 run log 推導計畫統計：log 的 footer 分不出 plan pass；sidecar 母體才
  是誠實的分母，並如實具名。

## 落點

`PlanQualityStats`/`DiscoveryStats` 在 `packages/hub/src/shared/api.ts`；
`planStats`/`discoveryStats` 在
`packages/hub/src/server/metrics/aggregate.ts`；chip 列在
`packages/hub/src/web/metrics/MetricsTab.tsx`；匯出的拒絕常數在
`packages/core/src/workflow/terminal.ts`。測試：`aggregate.test.ts`
（replanned-run 計數、以匯入常數比對拒絕、fan-out 下的每點火去重）。
