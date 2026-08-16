[English](28-claim-by-id.md) | 繁體中文

# 28 — `claim` 可以指定任務 id

**狀態：已實作。**

## 問題

當 backlog 裡有多個建置就緒的任務時，沒有任何方法說「建置這一個」。裸
`claim` 依優先序走訪工作池——先取建置就緒的 `in-progress/` 工作，再取一個
未規劃的 `queued/` 任務——順序由走訪決定，不由你決定。更糟的是，動詞之間
互相指來指去繞成一圈：`plan <id>` 對建置就緒的 id 以「claim 會建置它」拒
絕，而 `claim` 根本無法指定 id。兩個 host 上的機制都只蓋了一半：Claude
host 的 `workflow_start({id})` 早就能認領一個特定任務（`in-progress/` 從
BUILD 進入、`queued/` 從 PLAN 進入），卻沒有任何動詞路由到它；OpenCode
driver 的 `start-task` pending 在 `onIdle` 裡有完整的消費端
（`markClaimedOnHumanBranch` + BUILD 進入的 drive），卻沒有任何生產端——
一段正好在等這個功能的死碼。PR sitter 的 `claim <pr>` 早已確立 claim 可以
帶目標；engineering 是唯一一個 claim 無法帶目標的類型。

## 改了什麼

- **OpenCode** —— `plugins/opencode/src/workflow/driver.ts` 的
  `startTaskById`，補上缺席的 `start-task` 生產端：`handleCommand` 的
  claim 分支把 engineering 類型上非空的酬載路由給它（PR 形狀的類型保留
  `<pr>` 解析；其他 sitter 保留「不接受引數」的拒絕）。它持有與
  `plan <id>` 相同的防護——忙碌防護、短雜湊解析、`findSessionDriving`、
  原子性的 `claimTask` 競爭——並比照 `recover` 對不可認領的
  `in-progress/` 任務分流（已啟動 → `recover <id>`，無計畫 →
  `replan <id>`）。`queued/` 的 id 走 `claimForPlan`，行為與 `plan <id>`
  完全一致（消耗 plan-request、設定 `askOnPark`——指名任務的人就坐在這個
  session 前）。其他資料夾一律拒絕，並告知該用哪個動詞。
- **Claude Code / Qwen** —— 伺服器不需改動：`prompts/verbs/engineering.md`
  的 `claim` 動詞區塊現在把 id 路由到既有的 `workflow_start({id})`，裸
  `claim` 仍走 `workflow_claim`；重新生成兩個 host 的
  `verbs/engineering.md`。
- **表面** —— 每個 host 的 `argument-hint`、usage 字串與描述此動詞的文件
  都改為 `claim [id]`；`plan <id>` 對建置就緒任務的拒絕現在指名
  `claim <id>`，而不是那個無法指定目標的優先序走訪。

## 銳利邊緣

- `completed`/`abandoned` 的拒絕訊息說「沒有可執行的」而不是邀請重新認領：
  已完成任務的重跑路徑是開新任務，不是在已出貨的分支上開第二個 drive。
- `startTaskById` 即使 claim 分支已經檢查過，仍自行re-check忙碌防護——
  這個函式必須對任何未來的呼叫者獨立成立。
