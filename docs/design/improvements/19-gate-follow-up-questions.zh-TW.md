[English](19-gate-follow-up-questions.md) | 繁體中文

# 19 — 閘門會主動問下一步

**狀態：已實作。** `packages/core/src/workflow/gate.ts` 的 approve 家族加上
`data.gate`/`data.id`；兩張 dialect 表（`plugins/claude/mcp-server/src/server.ts`、
`plugins/claude/hooks/src/dialect.mjs`）加上 `askTool`；新增
`plugins/claude/hooks/gate-ask.mjs`，搭配 `gate-parse.mjs` 的 `continueOnGate`
與 `gate-command.mjs` 的條件分支；三個 approve 工具改用 `okGate`；
`prompts/verbs/engineering.md` 改寫 `approve` 區塊並把 plan 區塊改標為
`approve|plan`；`plugins/opencode/src/workflow/driver.ts` 新增
`workflow_gate`/`workflow_plan` 與 `refuseIfDriven`。測試：`gate.test.ts`、
`gate-ask.test.mjs`、`gate-result.test.mjs`、`gate-parse.test.mjs`、
`gate-command.test.mjs`、`dialect.test.mjs`、`verb-slice.test.mjs`、
`driver.test.ts`、`impl.test.ts`。

## 背景

生命週期中有三個天然該發問的時點：草稿剛寫好（要核可嗎？）、任務剛進
`queued/`（現在就規劃嗎？）、計畫剛停放（核可／退回重規劃／先擱著？）。但人
究竟「被問到」還是「得自己去打下一個指令」，取決於他走的是哪條路徑，而且從外
面完全看不出差別：

- 問題 #1 與 #3 寫在動詞散文裡，只在 Claude Code 與 Qwen Code 的互動式 `new`
  流程中會觸發。
- **問題 #2 在獨立的 `approve` 動詞上根本無法觸發。** 閘門 hook 會在模型之前
  完成搬移，然後送出 `decision: "block"`；被封鎖的回合裡沒有模型，也就沒有任何
  地方能發出問題。`approve` 區塊甚至寫著「不要 spawn 任何東西——回報結果就好」。
- OpenCode 三個都沒有：它手寫的指令檔在 `new` 結尾仍寫著「下一步是對每個子任務
  執行 `approve <id>`」。

同一段程式碼裡還藏著一個 Qwen 的實際缺陷。`HostDialect` 沒有發問工具欄位，所以
MCP server 的 plan 與 ship 閘門 `next:` 字串把 `AskUserQuestion` 寫死，並原封不
動送給工具名為 `ask_user_question` 的 Qwen。指到錯的發問工具不會大聲失敗——視窗
只是不會開——而這正是 `gen-prompts.mjs` 當初引入 `{{askTool}}` 要終結的失敗樣態。

## 設計

- **`GateResult.data` 帶出是哪個閘門。** approve 家族現在在每個成功分支（含
  `alreadyDone` 重試分支）都回報 `gate: "task" | "plan" | "ship"` 與 `id`。
  `approveAny` 是純粹的分派器，資料夾驅動的動詞究竟跨過哪個閘門只能從結果得知
  ——而 host 絕不可從 `message` 反推：那是會被重新措辭的散文。這套詞彙與 MCP
  server 在 plan/ship 閘門既有的 `gate: {kind, id}` 描述子一致。
- **`approve` 成為「有條件的」混合動詞。** `retask`/`replan` 早就是混合動詞
  （`continueTurn`），但在這裡用一個無條件旗標是錯的：那會在「被拒絕」以及終端
  的 ship 閘門上也把回合交還，正是封鎖機制要防的重複搬移。因此
  `gate-parse.mjs` 宣告「會發問的閘門」（`continueOnGate`，取自 `gate-ask.mjs`
  的 `ASK_GATES`，兩份清單就不可能漂移），`gate-result.mjs` 把 CLI 的 `data`
  透出，`gate-command.mjs` 只在兩者一致時才續行回合。
- **指令由 harness 發出，不是用散文請求。** `gate-ask.mjs` 組出 `GATE FOLLOW-UP`
  區塊，id 與該 host 的工具名都已代入，並接在動詞內容「之後」，成為模型最後讀到
  的東西。理由與 `stageModels` 由 hook 綁定而非寫在提示裡相同：協調者正是那個不
  會可靠遵守散文的東西。
- **結構上安全失效。** 續行路徑同時需要 `ok`、可辨識的 `data.gate`、以及字串型
  的 `data.id`。較舊的 `mcp-server/dist` 三者皆無，因此任何不確定都會退回舊行為
  ——封鎖。誤封鎖的代價是人多打一個指令；誤續行則重新打開重複搬移的洞。
- **兩條路徑一致。** 沒有任何東西會攔截「工具呼叫」，所以 `okGate` 把同一段提問
  折進 `workflow_task_approve`／`workflow_plan_approve`／`workflow_approve` 的
  `next`。否則同一個搬移在一條路徑上會問、另一條卻沉默，而走哪條路徑並不是人選
  的。提問散文刻意不放進 core：`gate.ts` 的 `next` 字串設計上是 host 中立的，而
  且也會流到 OpenCode 的 toast 與 hub。
- **切片。** `approve` 切片的「是」分支需要 PLAN 程序，而切片只會包含自己的區塊
  ——所以 plan 區塊改為共用的 `approve|plan`，並把 `approve` 加進另外兩個共用區塊
  （`workflow-orchestration` 指標，以及「就地提供閘門選項」規則）。另外兩處原本
  在切片下就已失效的交叉引用（「下面的 `plan <id>` 程序」，在 `new` 切片裡從來
  不存在）改為直接寫明。

### OpenCode

只搬散文會比不做更糟：這個 host 沒有 MCP server，且對 `docs/tasks/` 下的所有寫入
都有防護，因此問了「要核可這份草稿嗎？」也無法兌現「要」。所以互動式撰寫回合需要
的兩個搬移，被做成與 `workflow_verdict` 並列的模型可呼叫工具——`workflow_gate`
（core 的 `approveAny`）與 `workflow_plan`（`plan <id>` 的處理函式，本來就握有忙碌／
存活／claim 競態的守衛）。task 閘門的結果會帶一行 `NEXT STEP`，而原本寫著「回報結果
然後停止」的指令提示覆寫，現在為它開了例外——因為壓掉那行，正是「然後停止」做的事。

**兩個工具都會拒絕來自運行中迴圈的呼叫。** 插件工具表裡的工具會提供給每一個
session，包含階段子代理，所以沒有守衛就等於讓 BUILD 或 REVIEW 代理核可自己正在
驅動的任務——正是 `workflow_verdict` 階段檢查要堵住的自評漏洞。檢查走
`findDrivingWorkflow`，因此以子任務形式執行的階段會被其驅動祖先攔下；而且它是
**安全失效為拒絕**：誤拒的代價是人多打一個指令，誤放行則是把未經審查的成果送出去。
這與 Claude spawn 守衛的不對稱方向相反，且是刻意的。

## 刻意不做的事

- **OpenCode 上的問題 #3。** PLAN 回合是在背景 `session.idle` driver 裡、於回合
  結束之後才完成的，因此沒有任何模型回合可以承載提問——而
  `@opencode-ai/plugin` 對 Question 只提供 list/reply/reject 加上唯讀的
  `tui.question`，也就是說插件能回答待答問題，卻無法主動發起一個。
  `client.session.prompt` 雖可從 `onIdle` 觸發新回合，但那會重新進入 watch/claim
  迴圈所依賴的同一個事件——在 driver 的觸發器裡埋下遞迴風險。該處的計畫閘門維持
  toast，指令檔現在也寫明原因。
- **plan 閘門後的「現在就開始建置嗎？」** `ASK_GATES` 只列 `task`。用一個字就開始
  建置，遠比用一個字開始規劃承諾更大，而且 `workflow-orchestration` 要求建置前必須
  有獨立的明確答覆，所以那一支留給能履行它的互動流程。要加的話只是 `ASK_GATES` 一
  筆加上 `gateAsk` 的一個分支。
- **問題 #1 在所有 host 上仍由散文驅動。** 草稿是由 `workflow-task-author` 子代理
  在模型自己的回合裡寫出的，沒有任何 hook 會因為那次寫入而觸發——沒有可以掛上注入
  式指令的確定性事件。
