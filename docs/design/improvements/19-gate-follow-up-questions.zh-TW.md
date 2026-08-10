[English](19-gate-follow-up-questions.md) | 繁體中文

# 19 — 閘門會主動問下一步

**狀態：已實作。** `packages/core/src/workflow/gate.ts` 的 approve 家族加上
`data.gate`/`data.id`；兩張 dialect 表（`plugins/claude/mcp-server/src/server.ts`、
`plugins/claude/hooks/src/dialect.mjs`）加上 `askTool`；新增
`plugins/claude/hooks/gate-ask.mjs`，搭配 `gate-parse.mjs` 的 `continueOnGate`
與 `gate-command.mjs` 的條件分支；三個 approve 工具改用 `okGate`；
`prompts/verbs/engineering.md` 改寫 `approve` 區塊並把 plan 區塊改標為
`approve|plan`；`plugins/opencode/src/workflow/driver.ts` 新增
`workflow_gate`/`workflow_plan` 與 `refuseIfDriven`；在散文本身被證實可被略過之後，
同檔再加上 `armTaskGateAsk`／`askUnanswered`／`noteQuestionEvent` 與 `onIdle` 的提問
守衛，問題事件與非等待式驅動則接在 `plugins/opencode/src/impl.ts`；再之後，因為該機制
本身也會無聲失去作用，改以 `question` 工具呼叫為主要訊號
（`noteQuestionToolCall`／`noteQuestionToolSettled`／`noteOtherToolCall`，接在
`tool.execute.before`／`.after`），加上每個視窗一個 token、`question.v2.*` 正規化、
ESC／`stop` 時的 `clearQuestionState`，以及兩個靜默安全失效出口各自的警告。
測試：`gate.test.ts`、
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

### 這個提問需要機制，而不是只用散文請求

只送出 `NEXT STEP` 那一行並不夠，實際使用時破綻就出現了：問題視窗從未打開，TUI 卻
在跑使用者沒有要求的東西。編排模型讀完那行後直接呼叫 `workflow_plan`，就會**永久**
失去這個提問——該呼叫會 claim 任務，而它排入的驅動會以 `session.command` 在驅動
session 上跑各階段，之後 `refuseIfDriven` 與「沒有空閒模型回合」兩者，讓整條鏈跑完
之前沒有任何管道能詢問人類。這與 `stageModels` 同一類：編排模型正是那個不會可靠遵循
散文的東西，所以散文背後要有機制。

- **`askArmed` / `askUnanswered`（`driver.ts`）。** task 閘門會就它搬移的 id 佈下
  一次性的提問；`planFromAgent` 在問題真的被打開之前拒絕該 id，並重述解鎖所需的確切
  呼叫。佈下提問與 `NEXT STEP` 文字是同一個函式（`armTaskGateAsk`），兩者不可能對
  「哪些閘門會提問」產生分歧。
- **訊號來自 `question.asked` / `question.replied` / `question.rejected` 事件**
  （`noteQuestionEvent`，接在插件的 `event` hook 上）。插件依然無法主動發起提問——
  它只能看著提問被打開。
- **`onIdle` 在有問題開著時直接返回**，且在 `pending.delete` 之前，因此排隊中的驅動
  會等到答覆之後的那次 idle。沒有這一條，`watch`／`claim` session 會在視窗已經開著時
  把自己接管掉。
- **兩者都是安全失效為放行**，以 `questionsObservable` 把關：從未看過任何提問的
  session 永遠不會被拒絕，所以面對不發這些事件的 host，規則會失去作用，而不是讓一個
  已核可的任務卡在沒有任何動詞能規劃的狀態。這與 `refuseIfDriven` 的不對稱方向相反，
  理由也相反——那裡誤拒只是人多打一個指令，這裡誤拒會卡住待辦。
- **`event` hook 不再等待驅動完成。** `onIdle` 是整條 build → verify → review 鏈的
  入口，等待它會讓那個 handler（以及共用同一個 hook 的 ESC 路徑）被綁住整條鏈的時間。

### 會無聲失去作用的機制，本質上仍是散文

讓這件事重開的回報：核可草稿後沒有「現在規劃嗎？」的視窗，session 接著就一直忙著、
卻什麼都沒有跑。上面每一項都已經就位，卻仍可能整組蒸發——原因是三個接縫，而且每一個
都是無聲的，這正是為什麼一個缺陷能疊在另一個之上出貨。

- **事件名稱是 host 的，不是我們的。** SDK 的事件聯集用兩套家族承載同一個視窗
  （`question.asked` 與 `question.v2.asked`，兩者都帶 `sessionID`）。猜錯一次，
  `questionsObservable` 就永遠是空的，於是 `askUnanswered` 會放行每一次規劃、
  `onIdle` 的守衛也永不生效——安全失效為放行的設計完全照設計運作，只是輸入是錯的。
  因此**主要**訊號改成模型自己的 `question` 工具呼叫，透過
  `tool.execute.before`／`.after` 觀察，那是本插件自己的接縫；`noteQuestionEvent`
  留作附加的第二來源，並先把 `question.v2.*` 正規化回舊名。可觀測性不可能再在「提問
  有可能發生」時為假，因為同一個動作同時證明了兩件事。
- **兩個來源必須是同一筆紀錄。** asked 事件帶著 `tool.callID`——與工具 hook 拿到的
  是同一個 id——所以視窗以該 **token** 為鍵。舊的 per-session 旗標既會重複計數，也
  漏掉一個真實情況：同一則訊息可以開兩個視窗，第一個結束就清掉旗標，而第二個還開著，
  session 就在視窗底下被交給驅動。
- **沒人移除的 token 比沒有 token 更糟。** `onIdle` 會在整個行程生命週期內因它返回，
  讓該 session 排隊的驅動**以及它已經放下的磁碟 claim** 一起擱淺，之後每個閘門動詞
  都會以「現在有 loop 正在驅動這個任務」拒絕它。這裡刻意**不設逾時**——人類還沒去看
  的視窗，開上幾小時是合理的——所以界限來自：每一種無聲死亡都會清掉它。ESC
  （`onInterrupt`，同時清被中斷的 id 與解析出的驅動 id）、`stop` 動詞，以及該 session
  裡任何其他工具的啟動。最後這一條是對「`tool.execute.after` 從未觸發」的安全閥，
  而它成立的理由是：提問會擋住整個回合，能走到下一個工具就證明人類已經答覆了。
- **拒絕在紀錄之前執行。** 階段被拒絕的提問從未送達人類，若記錄下來就會滿足一個沒人
  看過的閘門提問。
- **`armTaskGateAsk` 回傳 `""` 是最該吵的失敗，過去卻完全靜默。** `data.gate`／
  `data.id` 來自 core，而 core 解析到 `packages/core/dist`——它被 gitignore、只由
  `npm install` 重建，但安裝好的插件指向工作樹。新插件搭配舊的 core dist 就會落在
  這裡，`r.ok` 為真卻沒有 gate，於是兩半缺陷同時發生：模型收不到 `NEXT STEP`，也沒有
  任何東西被佈下供 `askUnanswered` 強制。現在它會警告，並指名修法。另一個安全失效為
  放行的出口（`askUnanswered` 的 bootstrap）同樣會警告——「人類說好」與「我們無從得知」
  過去產生相同結果與同樣空白的紀錄。

## 刻意不做的事

- **OpenCode 上的問題 #3。** PLAN 回合是在背景 `session.idle` driver 裡、於回合
  結束之後才完成的，因此沒有任何模型回合可以承載提問——而插件無法主動發起提問：
  SDK 的 Question API 不在 `PluginInput["client"]` 上，唯讀的 `tui.question` 檢視
  屬於一般插件拿不到的 TUI 插件介面。插件只能透過 `question.*` 事件*觀察*提問。
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
