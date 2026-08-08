[English](17-replan-chains-plan.md) | 繁體中文

# 17 — Replan 串接重新規劃

**狀態：已實作。** `packages/core/src/workflow/gate.ts` 中的
`markPlanNext`/`replanQueued` 與 `data.id` 回傳、`task/plan-request.ts` 中
`requestPlan` 的 `source` 參數、`plugins/opencode/src/workflow/driver.ts` 中的
`claimForPlan` 與串接版 `handleReplan`、`plugins/claude/hooks/gate-parse.mjs`
中 replan 的 `continueTurn` 以及 `prompts/verbs/engineering.md` 重寫後的
verb 區塊；`gate.test.ts`、`plan-request.test.ts`、`driver.test.ts`、
`gate-parse.test.mjs`。

## 背景

`replan [id] [reason]` 過去只是駁回停放的計畫、把任務移回 `queued/` ——
然後就**擱著**。在人類輸入 `plan <id>`、或 claim/watch 輪詢排到它之前，沒
有任何東西會重新規劃它。這個閘門的目的是產出一份「修訂後的計畫」供人類再
次審查，所以每次駁回都要多付一次手動追蹤（或無上限的等待）；而計畫 10 已
經把駁回理由織入下一次 PLAN 提示的機制，也要等到那時才會被讀到。

「讓任務留在 `plan-review/` 原地重新規劃」的做法被否決了：`runPark` 與
`runStop` 寫死了 PLAN 階段的任務位於 `queued/`（`terminal.ts`）、PLAN 的
認領池就是 `queued` 而 `plan-review` 不是池、`canTransition` 只允許從
`queued` 進入 `plan-review`、doctor 的 claim/request 掃描也以池資料夾為
鍵。因此任務仍然會**過境** `queued/`；改變的是這個過境不再是停車場。

## 設計

- **核心蓋上 plan-next 標記。** `replanTask` 在搬移 + commit 之後，透過
  `markPlanNext` 寫入既有的 plan-request 標記
  （`queued/.requests/<id>`、`source: "replan"`）——盡力而為、失敗僅告警，
  並且刻意寫在 commit **之後**，讓這個短暫標記永遠不會被納入追蹤型
  backlog 的 replan commit。所有 worker 本來就尊重這個標記
  （認領流程的 `requestedFirst`），所以連無法串接的宿主也得到「優先重新
  規劃」。回傳新增 `data.id`（且 id 也寫進 `message`），因為宿主要靠它串
  接。
- **OpenCode 行程內串接。** `handleReplan` 在駁回成功後，走 `plan <id>`
  同一套認領 + `setPending({kind:"start-plan"})` 原語（抽出為
  `claimForPlan`，兩條路徑不可能漂移）。session 忙碌、認領被搶、或核心
  dist 過舊（沒有 `data.id`）時，退回為回報核心的 plan-next 結果——串接
  永遠不會反過來擋住駁回本身。
- **Claude/Qwen 走混合 verb 路徑串接。** replan 的分派加上
  `continueTurn: true`（retask 的先例）：hook 仍先確定性地執行駁回，然後
  把回合交還模型，附上結果與 replan verb 區塊——區塊現在只指示執行「一
  次」PLAN（`workflow_start({id})` → `workflow-plan-author` →
  `workflow_advance`），別無其他。模型若沒有跟進，確定性的 plan-next 標
  記仍是後盾。
- **Hub 不串接**——它從不驅動任何 stage（其章程）。hub 的 replan 現在讓卡
  片落在「queued + 已請求規劃」狀態，既有的取消規劃請求按鈕就是退出口。
- **對已在 `queued/` 的任務下 replan**（`replanQueued`）會把新理由記成標
  準駁回註記並重蓋 plan-next——除非該任務在 `queued/` 持有 claim，亦即
  規劃者「此刻」正握著這個檔案：在它底下追加註記是一次遺失更新，而那個
  run 已經在做這個 verb 要求的事，所以這個分支以「正在重新規劃」拒絕。

刻意不動的部分：`planRejectedNote` 的確切措辭（它是
`extractReplanReason` 的解析錨點，而且仍然為真——過境確實發生）、既有的
拒絕分支（live loop、claim 標記），以及 PLAN 的原地取代契約。

## 驗證

`gate.test.ts` 釘住兩種來源的標記蓋章、已在 queued 的重蓋、queued 持有
claim 時的拒絕、以及搬移失敗時不蓋章；`driver.test.ts` 釘住串接認領、
session 忙碌與認領被搶的退回；`gate-parse.test.mjs` 釘住 `continueTurn`；
`packages/hub` 的 `gate.test.ts` 釘住兩種 hub 來源的標記落地。
