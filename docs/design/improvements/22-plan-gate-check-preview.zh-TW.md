[English](22-plan-gate-check-preview.md) | 繁體中文

# 22 — 計畫閘門看得見計畫實際買到什麼

**狀態：已實作。**

## 問題

方案 18 讓 PLAN 把專案的檢查指令探索成 `agentic-checks` 圍欄區塊，在 VERIFY
點火時以消費端 stage 自己的 bash 允許清單審核。審核本身有效；它的**可見性**
沒有。一份圍欄是壞 JSON、info string 打錯、或指令不在允許清單上的計畫，會乾淨
地停泊（park）、被一位無從得知的人類核准，然後 VERIFY 默默地跑了**零個檢查**
——拒絕原因只進了沒人在看的 `log("warn")`，任務檔、run log、metrics 都沒有記
錄「計畫宣告的檢查從未執行」。在磁碟上，「計畫承諾的檢查全數被拒」與「計畫根
本沒宣告檢查」無法區分。

三個較小的缺口加重了它：`approvePlan` 只檢查 `hasPlan`，在 `plan-review/` 手
改過（或被 `workflow_move` 搬進來）的計畫可以完全沒有 `### Verification` 就進
入 BUILD，而且沒有任何提示；plan-author 人設的章節詞彙（**Non-goals**、獨立的
**Acceptance criteria**）與組進 prompt 的契約詞彙（`### Verification`、
`### Out of Scope`）相撞，讓章節命名變成每份計畫擲一次的硬幣。

## 改了什麼

- **停泊時的預報**（`previewDiscoveredChecks`，
  `packages/core/src/workflow/discovered-checks.ts`）：對
  `resolveStageChecks` 在點火時會做出的決定的**純函式**預覽——同一組審核參
  數，文字上緊鄰擺放，兩者不可能漂移——在 `runPark`（`workflow/terminal.ts`）
  計算，同時綴在 `Plan written — parked for plan review` 稽核註記與宿主顯示的
  停泊訊息上。讀閘門的人會看到 `discovered checks: N admitted for VERIFY`、
  `NONE admitted (…原因…)`、或 `no agentic-checks block`。刻意**不做二進位探
  測**：park 在主樹跑，VERIFY 在尚未建立的 worktree 跑，在這裡探測是對消費端
  環境說謊；而且 park 絕不能因 shell 探測而變慢或失敗。`hasChecksFence` 存在
  是因為解析器對「沒有圍欄」和「合法的空區塊」回傳相同的空結果，而這兩者對人
  類意義相反。只預報，永不否決——方案 18 的「停泊時不強制；沒有區塊的計畫是合
  法的」維持不變。
- **點火時的實況**（兩個宿主的 `runStageChecks`）：`resolveStageChecks` 一直
  都算出來、卻被兩個宿主解構丟棄的 `ChecksSource`，現在落在該 stage 的
  metrics 樣本上（`checksSource`、`checksRefused`；`metrics-file.ts` 中
  additive-v1 的 schema 欄位），並且每次 run 一次、**只在結果原本會沉默時**
  （圍欄存在但 `source !== "discovered"`，或有拒絕）追加稽核註記：
  `Discovered checks at VERIFY: N ran; …`。這是預報所預測的正式紀錄——包含預
  覽略過的二進位探測淘汰。
- **`approvePlan` 重新檢查契約，只警告**（`workflow/gate.ts`）：缺
  `### Verification` 與堆疊的 `## Implementation Plan` 標題以 `Note: …` 綴在
  成功訊息與 `data.caveats` 上。警告、永不拒絕：這個閘門與 kind 無關
  （`GateCtx` 不帶 manifest，無從得知停泊的 kind 是否要求契約），而拒絕會讓任
  務擱淺，沒有比人類剛拒絕過的 `replan` 更好的動詞可用。
- **統一章節詞彙**（`prompts/agents/workflow-plan-author/body.md`、
  `skills/planning-and-task-breakdown/SKILL.md`）：人設與 skill 現在逐字使用
  `### Verification` / `### Out of Scope`——契約自己的用詞——不再是
  「Non-goals」/「Acceptance criteria」同義詞。

## 刻意不做的事

- 不在停泊時**強制**圍欄，也不強化寬鬆的 `hasVerificationSection` regex——兩
  者都是有主的取捨（18 與 12）；嚴格化的失敗模式是每個輪詢 tick 燒掉一次
  PLAN 的活鎖。
- 預覽不做 `resolvableChecks` 探測（環境不對、不純）。
- 停泊時不因堆疊標題否決——`runPark` 自己的註解解釋了否決會讓任務擱淺；改由
  核准閘門的 caveat 呈現。

## 落點

`previewDiscoveredChecks`/`hasChecksFence`/`discoveringStage`（自 `engine.ts`
搬來，該處 re-export）在 `packages/core/src/workflow/discovered-checks.ts`；
預報後綴在 `runPark`（`workflow/terminal.ts`）；caveats 在 `approvePlan`
（`workflow/gate.ts`）；`checksSource`/`checksRefused` 在 `StageSample`
（`workflow/metrics.ts`）+ `MetricsSampleSchema`（`workflow/metrics-file.ts`）；
宿主端 provenance 在 `plugins/opencode/src/workflow/driver.ts`
（`stageChecksInfo`）與 `plugins/claude/mcp-server/src/server.ts`
（`checksInfo`）。測試：`discovered-checks.test.ts`、`terminal.test.ts`、
`gate.test.ts`、`metrics-file.test.ts`。
