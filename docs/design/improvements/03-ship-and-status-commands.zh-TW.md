[English](03-ship-and-status-commands.md) | 繁體中文

# 03 — `/agent-loop ship` 與真正的 `/agent-loop status` 儀表板

> **附錄：** ship 現在也會推送任務的 `feature/<id>` 分支，並依
> `codePlatform` 開啟（或重複使用）一個 draft PR——GitHub 或 Azure
> DevOps。以下的稽核完成語意（人工觸發、附註 + commit、原始 `mv` 依然
> 可用）不變；PR 建立是在這些語意之上盡力而為（best-effort）——push/PR
> 失敗絕不會阻擋或回滾這次移動。詳見 `packages/core/src/loop/ship-pr.ts`。

## Context

日常工作流程中有兩個人體工學上的落差：

1. **`in-review → completed` 是一次原始的 `mv`。** driver 的完成提示
   （done-toast）（`driver.ts:372`）只是告訴人類要手動移動檔案。那次移動
   正是最終的把關決策——是唯一代表「有人審查過 diff 並將其發布」的狀態
   轉換——但它卻是這整條工作分支裡**唯一沒有稽核附註、也沒有 commit** 的
   生命週期事件，而這條分支的整個重點正是要留下一份帶時間戳、可歸責的
   紀錄。
2. **`/agent-loop status` 只回報目前 session 的迴圈**（`driver.ts:731-750`）。
   沒有辦法看到整個待辦（backlog）的整體狀態——有多少任務正在哪裡等待、
   哪些卡住了。

## Design

### `/agent-loop ship <id>`——經稽核的完成動作

在 `handleCommand`（`src/loop/driver.ts`）中新增一個分支，與 `recover` 並列：

```
if (lower === "ship" || lower.startsWith("ship ")) {
  const id = arg.slice("ship".length).trim()
  if (!id) → toast "Usage: /agent-loop ship <id>."
  const task = await findByIdIn(client, deps.directory, config.tasksDir, "in-review", id)
  if (!task) → toast `No in-review task "${id}".`
  await appendNote(deps.$, task, auditNote("Shipped — moved to completed", new Date(), await gitActor(...)))
  const newPath = await moveTask(deps.$, task, "completed")
  await commitPaths(deps.$, deps.directory, [config.tasksDir], `loop(${id}): shipped — completed`)
  → toast `"${task.title}" completed.` (success)
}
```

這四個基礎函式（primitive）都已經存在（`findByIdIn`、`appendNote`+
`auditNote`、`moveTask`、`commitPaths`）——這純粹是組合出來的，大約 20 行。

語意：**把關點依然由人類掌控。** `/agent-loop ship` 是由人類觸發的；它把
一次未經稽核的 `mv` 換成一次經過稽核的動作。原始的 `mv` 依然可以使用
（資料夾即狀態仍然是唯一真相來源）——`ship` 是建議的路徑，而不是強制
鎖定。

把完成提示（done-toast，`driver.ts:372`）改成
`…then /agent-loop ship ${state.task.id} when it ships.`，取代原本描述手動
搬移的說法。

### `/agent-loop status`——待辦儀表板

擴充既有的 `status` 分支（`driver.ts:731`）。保留目前這行 session 迴圈的
訊息，然後附加一份待辦摘要：

- 對全部六個資料夾呼叫 `listByStatus`（`store.ts:76`）（每個資料夾一次
  新呼叫；`listInPlanning`/`listInProgress` 本來就只是它的輕量包裝）。
- 每個資料夾：計數，加上來自既有純函式判斷式（predicate）的旗標：
  - `in-planning`：有多少 `hasPlan`（已把關，等待 `/agent-loop go`）相對於
    尚未規劃（等待 `/agent-loop next`）。
  - `in-progress`：有多少 `isClaimable`（已暫存，等待一個 watcher）、
    `wasInterrupted`（已當機——列出 id，建議執行 `/agent-loop recover`），
    以及其他已啟動的（執行中或已停止並帶有附註）。
  - `in-review`：計數 + id 清單（每一項都是人類的待辦事項——建議執行
    `/agent-loop ship <id>`）。
- 輸出：toast 只能是一行字，因此用單一 toast 發出標題摘要
  （`"backlog: 2 draft · 1 planning (1 gated) · 3 in-progress
  (1 interrupted) · 2 in-review"`），再用 `deps.log("info", …)` 輸出逐 id
  的詳細分解。如果 toast 長度成為限制，細節就只留在記錄檔中——不要跟
  TUI 對著幹。

把彙總邏輯抽出成一個純函式輔助工具，以利測試：

```ts
// src/task/store.ts (pure section)
export interface BacklogSummary { /* counts + id lists per flag */ }
export const summarizeBacklog = (byStatus: Record<TaskStatus, readonly Task[]>): BacklogSummary
```

由 driver 取得資料、`summarizeBacklog` 進行計算、driver 負責格式化輸出。

## Edge cases

- 對一個位於其他資料夾的 id 執行 `ship` → 精確的錯誤訊息（「in-progress，
  還不是 in-review——迴圈還沒完成它」相對於「哪裡都找不到」）。實作方式
  是回退到一個類似 `findById` 的跨資料夾探測，只用於產生錯誤訊息。
- 在有存活迴圈正在驅動該任務時執行 `ship`：在結構上就不可能發生（正在
  被驅動的任務會在 `in-progress/` 中，`findByIdIn(..., "in-review")` 找不到
  它）——不需要額外的守衛。
- `commitPaths` 失敗（例如主要工作目錄正在 rebase 中）：`moveTask` 已經
  發生了——發出警告，不要回滾；移動才是唯一真相來源，commit 只是紀錄
  （與 driver 中其他 best-effort commit 的立場一致）。
- 空的待辦 / 缺少資料夾：`listByStatus` 在資料夾不存在時本來就會回傳
  `[]`。

## Test plan（TDD）

- `summarizeBacklog`（純函式）：計數、已把關/未規劃的拆分、中斷的 id、
  可認領的計數——用合成的 `Task[]` fixture 做表格驅動測試（沿用
  `src/task/store.test.ts` 的 fixture 風格）。
- `ship` 指令流程：擴充 driver 的測試工具——`in-review` 中的任務會被
  ship（附註被附加、被移動、被 commit）；缺少 id 會出錯；id 位於錯誤
  資料夾時，錯誤訊息會指名該資料夾。
- 既有的 `status` 測試（若有的話）應維持通過；新增對摘要行的斷言。

## Docs to update

- `README.md` + `.opencode/commands/agent-loop.md` — 把 `ship <id>` 和更
  豐富的 `status` 加進指令清單；把「move the task to completed/」的說法
  換成 `/agent-loop ship <id>`。
- `skills/workflow-orchestration/SKILL.md` — 終止章節：把 `/agent-loop ship`
  列為建議的最終把關動作。
- `skills/task-backlog-management/SKILL.md` — 生命週期表格中
  `in-review → completed` 那一列：「你，透過 `/agent-loop ship <id>`
  （或手動移動）」；Red Flags：一個已完成的任務卻沒有「Shipped」附註。
