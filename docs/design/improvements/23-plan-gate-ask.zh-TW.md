[English](23-plan-gate-ask.md) | 繁體中文

# 23 — 每一個 host 的計畫閘門都會發問

**狀態：已實作。** `plugins/opencode/src/workflow/driver.ts` 的
`start-plan` `Pending` 上的 `askOnPark`、`planParkNextStep`/`promptPlanGateAsk`
以及 `replanAndChain`/`replanFromAgent`；`plugins/opencode/src/impl.ts` 的
`workflow_replan` 工具；`plugins/claude/hooks/gate-ask.mjs` 的 `planParkAsk` 與
PostToolUse hook `plugins/claude/hooks/plan-gate-ask.mjs`（登記於兩個 host 的
`hooks.json`，Qwen 版由 `scripts/build-hooks.mjs` 產生）；`driver.test.ts`、
`plan-gate-ask.test.mjs`、`gate-ask.test.mjs`。

## 背景

改進 [19](./19-gate-follow-up-questions.zh-TW.md) 讓**任務閘門**有了後續提問：
核准草稿後，harness 自己會問「現在就規劃嗎？」。而**計畫閘門**——那個人類真的
必須先讀點東西才能說 yes 的閘門——從來沒有。計畫停在 `plan-review/`，使用者只被
告知去輸入 `/agentic-workflow:engineering approve <id>`。

兩個 host 的失敗方式不同，所以一種修法蓋不住兩邊。

**OpenCode 沒有可以發問的回合。** `plan <id>` 認領任務、排入工作後就返回；PLAN
階段在之後的 `session.idle` 才執行，所以計畫存在時，當初要求它的那個回合早已結束。
park 處理路徑只能發 toast。這與計畫 19 記錄的閘門 hook 缺口（「被 block 的回合問
不了任何事」）是同一個結構性問題，只是晚了一個階段。

**Claude Code 與 Qwen 只用散文發問。** `workflow_advance` 的 park 分支回傳一段
`next` 字串，寫明 Approve/Replan/Park 的問題，`prompts/verbs/engineering.md` 也這麼
寫。兩者都是被協調模型當成資料讀過去的散文——正是計畫 19 改由 harness 發出後續
提問（而非寫在命令本文裡）所針對的失敗模式，也是 `stampSpawnModel` 存在的理由。

## 設計

**OpenCode：既然外掛無法發起「問題」，就發起那個「回合」。** park 之後，`onIdle`
對剛完成規劃的 session 送出一次純 `session.prompt`（`promptPlanGateAsk`），內含一段
`NEXT STEP`：摘要計畫、用 `question` 工具發問，並依答案呼叫 `workflow_gate`（核准）
或 `workflow_replan`（退回）。三項約束：

- **它在 `finally` 之後才觸發，絕不在 park 分支裡。** session 必須先脫離該次
  drive——終端處的 `clearWorkflow`、`finally` 中釋放的 `driving`——否則
  `refuseIfDriven` 與階段代理的 `question` 拒絕規則會擋掉外掛自己的提問。而且永遠
  不 await：那個回合裡的問題會擋住多久取決於人類，而 `onIdle` 是由 `event` hook
  呼叫的。
- **只有人類要求的規劃才發問。** 旗標掛在工作項目上（`start-plan` `Pending` 的
  `askOnPark`，由 `claimForPlan` 設定），而不是模組層的 map。`claimForPlan` 的呼叫者
  只有 `plan <id>`、`workflow_plan` 與 `replan` 連鎖；watcher 的認領路徑不經過它。
  若改用 map，就得在 drive 可能死掉的每條路徑上清除——ESC、stop、錯誤、被丟棄的
  pending——而漏掉的那一條就會在無人看顧的 `watch` worker 裡跳出對話框。
  `drive()` 自己的回傳值就回答了「有沒有 park？」，因此完全不需要簿記。
- **Replan 需要一個工具。** 這個 host 沒有 MCP server，且守住 `docs/tasks/` 下的
  寫入，所以模型只能「描述」的選項等於讓提問失去意義（計畫 19 自己的規則）。
  `workflow_replan` 包住 verb 使用的同一個 `replanAndChain`——先退回，再連鎖一次
  PLAN pass，其修訂後的計畫再次 park 並再次發問——外層是 `refuseIfDriven`，逾時
  時不邀請重試，因為重複呼叫不是無害的 no-op。

**Claude Code 與 Qwen：把提問以 harness context 再講一次。** 以
`workflow_advance` 為 matcher 的 PostToolUse hook（`plan-gate-ask.mjs`）解析結果，
遇到 `gate: {kind: "plan"}` 描述子就用
`hookSpecificOutput.additionalContext` 送出同一段內容。兩個 host 都支援該事件與
欄位。文字與任務閘門的版本並列在 `gate-ask.mjs`——一個作者、兩個觸發點——而
`ASK_GATES` 刻意不動：那份清單是 `gate-parse.mjs` 的 `continueOnGate`，決定哪些
閘門**動詞**的跨越會把回合交還，而 park 不是動詞。在那裡加上 `"plan"` 只會改變
`approve` 在計畫閘門的行為。

這個 hook **對所有不確定都 fail open**：未知的封包形狀、非 JSON 的結果、沒有描述子
（早於閘門契約的 `mcp-server/dist`）、沒有提問工具的 host。它只加 context，永遠不下
`decision`。錯誤的沉默只損失一次提醒；錯誤的提醒卻會叫模型去為一個根本沒 park 的
任務過閘門。

## 刻意不做

- **不加強制層。** `workflow_plan` 之所以可被拒絕（`askUnanswered`），是因為它是
  人類 session 的不歸點。park 之後沒有危險動作——模型就只是停下——所以沒有可拒絕
  的呼叫，退化行為就是先前的行為：一個 toast，或那段 `next` 字串，以及人類可以輸入
  的動詞。
- **保留 server 的 `next` 字串。** hook 只是把同一件事重新表述，而非取代它；因此在
  hook 沒有執行的 host 或版本上，行為完全不變。
- **park 的 toast 不變。** 那是 watcher 的 park 唯一的訊號，在那裡它仍然是對的。
- **hook 不做 workflow kind 過濾。** 核心的 `runPark` 對無任務狀態回傳 `park-free`，
  而 sitter 的工作項目都不是任務支撐的，所以計畫閘門描述子只會在 engineering 的
  park 出現。加過濾等於守一個不存在的洞。
