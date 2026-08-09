[English](README.md) | 繁體中文

# Agentic loop —— 工程（engineering）工作流程改進計畫

**本頁每一份計畫（01–17）都已實作並測試完成**，存放於共用的
`@agentic-workflow/core` 套件（`packages/core/`）中，供 OpenCode 外掛和 Claude
MCP 伺服器共同使用。這些文件保留作為這些功能的設計紀錄，而非待辦的
backlog。計畫 10–13 已於 2026-08-02 落地；計畫 14 於 2026-08-03；計畫 15 於
2026-08-07；計畫 16 與 17 於 2026-08-08。

來源：目前的程式碼（所有引用的路徑與函式名稱均已對照撰寫當下的原始碼驗證
過）、[`../threat-model.md`](../threat-model.md) 中列出的殘餘風險，以及
`README.md` / `skills/workflow-orchestration/SKILL.md` 中記載的已知限制。

## 這些計畫（全部已發布）

| # | 計畫 | 帶來了什麼 | 現在位於何處 |
|---|------|----------------|--------------------|
| 01 | [Worktree isolation（工作樹隔離）](./01-worktree-isolation.md) | 人類的 checkout 永遠不會被動到；同一個實體中可安全地並行執行多個 watch 工作階段 | `packages/core/src/workflow/git.ts`、`packages/core/src/workflow/isolate.ts` 中的 `ensureIsolation`、`plugins/opencode/src/index.ts` 中的編輯守衛；`git.test.ts` |
| 02 | [State persistence（狀態持久化）](./02-state-persistence.md) | 崩潰／重啟後能在確切的階段連同產出物一起恢復，而不必重新規劃 | `packages/core/src/workflow/persist.ts`；`persist.test.ts` |
| 03 | [Ship + status commands（發布與狀態指令）](./03-ship-and-status-commands.md) | 有稽核記錄的 `in-review → completed` 移動；待辦儀表板 | `plugins/opencode/src/workflow/driver.ts` 中的 `/agent-loop ship` + status、`packages/core/src/task/store.ts` 中的 `summarizeBacklog`；`store.test.ts` |
| 04 | [Verdict quality（裁定品質）](./04-verdict-quality.md) | 結構化的失敗原因回饋給重新建置；可選的多視角審查 | `packages/core/src/workflow/verdict.ts`；`verdict.test.ts` |
| 05 | [Secret redaction（機密資訊遮罩）](./05-secret-redaction.md) | 在寫入持久化產出物之前先清除機密資訊 | `packages/core/src/task/redact.ts`，接線於 `packages/core/src/task/store.ts`；`redact.test.ts` |
| 06 | [Run metrics（執行指標）](./06-run-metrics.md) | 每次執行的階段耗時 + 裁定歷史記錄寫入執行日誌 | `packages/core/src/workflow/metrics.ts`；`metrics.test.ts` |
| 07 | [在共用排程器上執行多種工作流程類型](./07-multi-workflow-scheduler.md) | 一個排程器驅動多種工作流程類型（engineering + PR sitter）；抽取出 `@agentic-workflow/core`，讓兩個外掛共用同一份實作 | `packages/core/src/manifest/`（結構描述、註冊表、範本）、`packages/core/src/scheduler/`（排程器、租約）、`packages/core/src/source/`（backlog、github-pr、ado-pr、帳本）；`workflows/engineering/`、`workflows/pr-sitter/` |
| 08 | [決定性檢查指令](./08-deterministic-gate-commands.zh-TW.md) | 已宣告的測試／型別檢查／lint 指令改由驅動程式端執行；其結束碼成為檢查類階段的既定事實並約束其裁定，取代原本由代理人自行回報的「測試是綠的」 | `packages/core/src/workflow/checks.ts`、`manifest/schema.ts` 中 `StageDefSchema` 的 `checks`、`config.ts` 中的 `stageChecks`／`checksFor`／`unknownStageCheckKeys`（以及 `SHELL_BEARING_WORKFLOW_KEYS`）、`workflow/engine.ts` 中的 `withCheckResults`、兩個 host 的 fire 邊界執行與定案時的下修；`checks.test.ts` |
| 09 | [階段提示詞的上下文預算](./09-context-management.zh-TW.md) | 提示詞不再隨疊代單調成長：計畫產出物不再累積稽核註記（也不會在 replan 後餵回舊計畫）、每個階段每份產出物的字元上限會裁剪階段讀到的內容但永不裁剪結構化裁定區塊與階段契約、有界的嘗試紀錄讓弱模型不再重試已失敗的修法，而提示詞大小也在管理面板中依階段可見 | `packages/core/src/workflow/budget.ts`、`config.ts` 中的 `contextFor`/`unknownStageContextKeys`、`task/store.ts` 中的 `extractPlan`、`workflow/engine.ts` 中的接縫與紀錄、`packages/hub/src/server/metrics/prompt.ts` 中的 `promptSize`；`budget.test.ts` |
| 10 | [將 replan 理由結構化地傳入 PLAN](./10-replan-reason-threading.zh-TW.md) | 計畫閘門的駁回理由以結構化提示詞區段送達下一次 PLAN（從稽核註記解析回來，新計畫落地後自動退役），取代「翻稽核註記」；多行理由壓成單行稽核形狀 | `packages/core/src/task/store.ts` 的 `PLAN_REJECTED_MARKER`/`extractReplanReason`、`workflow/gate.ts` 的 `oneLineReason`、`WorkflowState` 的 `replan`、`workflow/orchestrate.ts` 與 `workflow/engine.ts` 的串接、`workflows/engineering/stages/plan.md` 的區段；`store.test.ts`、`gate.test.ts`、`orchestrate.test.ts`、`engine.test.ts` |
| 11 | [在階段提示詞中揭示疊代預算](./11-iteration-budget-prompts.zh-TW.md) | 重建的 BUILD 被告知「iteration N of M」，最終疊代並被警告此後的 check 失敗會停止迴圈、交回人類重新規劃；VERIFY 的最後一趟被告知它的 FAIL 文字就是 replan 閘門讀到的內容。`iterationCap` 是停止判斷與提示詞共用的唯一解析點，兩者永不漂移 | `packages/core/src/workflow/engine.ts` 的 `iterationCap` 與 `iterations` context 鍵、`workflows/engineering/stages/build.md`/`verify.md` 的區段；`engine.test.ts` |
| 12 | [計畫契約](./12-plan-contract.zh-TW.md) | PLAN 的提示詞機械式攜帶計畫結構契約（標明檔案的步驟、將每條驗收準則對應到證明的 `### Verification`、`### Out of Scope`），park 閘門拒絕沒有 Verification 子節的計畫 —— 寬容標題比對、釋放 claim、任務留在 queued | `manifest/schema.ts` 的 `planContract`、`workflow/verdict.ts` 的 `planContractBlock`/`hasVerificationSection`、`workflow/engine.ts` 的組裝分支、`workflow/terminal.ts` 的 park 否決；`schema.test.ts`、`engine.test.ts`、`terminal.test.ts` |
| 13 | [選擇性加入的計畫視覺化](./13-plan-visualization.zh-TW.md) | 設定 `workflows.<kind>.planVisualization: true` 後，當變更的形狀值得（狀態／生命週期、跨套件流程、並行、資料形狀）時，PLAN 的提示詞要求在計畫中附上 mermaid 圖——由代理人判斷、永不由閘門強制——管理面板的計畫審查視圖在沙箱 iframe 中把圍欄渲染成圖，且每個區塊仍可留言 | `manifest/schema.ts` 的 `planVisualization`、`workflow/verdict.ts` 的 `planVisualizationBlock`、`config.ts` 的 `planVisualizationFor` 與設定、`workflow/engine.ts` 的組裝尾段、`packages/hub` 的 `MermaidBlock.tsx`/`mermaid-embed.ts`；`schema.test.ts`、`config.test.ts`、`verdict.test.ts`、`engine.test.ts`、`mermaid-embed.test.ts` |
| 14 | [對稱的階段情境](./14-symmetric-stage-context.zh-TW.md) | 計畫 09–11 給單一階段的情境現在也到達它的同儕：REVIEW 看得到 VERIFY 確立了什麼(經由新的 `verdicts.<stage>` 鍵取得記錄下來的裁決接縫、永遠不是逐字稿)並獲得最終迭代警告;VERIFY 看得到嘗試帳本,復發的失敗讀作復發;重新觸發的 BUILD 被指向先前迭代的累積 diff;內聯的檢查回饋與建置摘要帶上「是資料、不是指令」圍欄;plan.md 移除永不渲染的 worktree 區段 | `packages/core/src/workflow/engine.ts` 的 `verdicts` 情境鍵、`workflows/engineering/stages/*.md` 的區段與圍欄、oracle 鏡像與 `PRIOR_WORK_SECTION`/`VERDICTS_SECTION` 剝除;`engine.test.ts` |
| 15 | [未評估軸線政策](./15-unassessed-axis-policy.zh-TW.md) | 不帶阻斷性發現的少數軸線 `ERROR` ——審查契約自己邀請的「無法評估」逃生口——現在是非阻斷的：`effectiveVerdict` 略過它、它滿足覆蓋要求,並以「未評估」區段流入下一輪提示,不再以假的環境錯誤停掉整個 run 並困住任務。宣告 PASS 而*每一條*軸線皆未評估者仍被拒絕(最終化時惡化為 ERROR),帶發現的 ERROR 軸線保留既有的 onError 路由 | `workflow/verdict.ts` 的 `axisUnassessed`/`withUnassessedGuard` 與 `effectiveVerdict` 略過、`workflow/checks.ts` 的 `finalizeCheckRecord`、OpenCode driver 與 Claude MCP server 的呼叫點替換、`verdictContractBlock` 與 `prompts/agents/workflow-review/body.md` 的契約文字;`verdict.test.ts`、`checks.test.ts` |
| 16 | [Replan 串接重新規劃](./16-replan-chains-plan.zh-TW.md) | 被駁回的計畫不再閒置於 `queued/`：`replanTask` 為任務蓋上 plan-next（既有的 plan-request 標記,`source: "replan"`）,OpenCode 的 replan 直接串進 `plan <id>` 的認領與驅動,Claude/Qwen 的 replan 成為混合 verb,續行的回合只執行一次 PLAN——修訂後的計畫帶著駁回理由重新停回 `plan-review/`。從不驅動 stage 的 hub 得到 plan-next 排序;對已在 queued 的任務下 replan 會記下新理由,除非規劃者此刻正持有其 claim | `workflow/gate.ts` 的 `markPlanNext`/`replanQueued` 與 `data.id`、`task/plan-request.ts` 中 `requestPlan` 的 `source`、OpenCode driver 的 `claimForPlan` 與串接版 `handleReplan`、`plugins/claude/hooks/gate-parse.mjs` 的 `continueTurn`、`prompts/verbs/engineering.md` 重寫的 replan verb 區塊;`gate.test.ts`、`plan-request.test.ts`、`driver.test.ts`、`gate-parse.test.mjs` |
| 17 | [由計畫發現的檢查指令](./17-plan-discovered-checks.zh-TW.md) | VERIFY 的裁決預設不再建立在自我回報上：PLAN 在 `### Verification` 小節裡以 `agentic-checks` 區塊產出專案的測試／型別檢查／lint 指令，driver 執行它們，結束碼約束裁決。指令在計畫階段就被凍結（區塊是任務檔裡的文字，所以每次疊代的檢查方式完全相同），能跑什麼由該階段自己的 bash 白名單封頂——邊界是白名單而不是人工計畫把關點，因為任務檔是 repo 內容。任何 manifest 都不會拿到指令表：那對它沒預料到的每個 repo 都是錯的，而在這裡錯會走 `onError`。同時補上這件事讓「卡住」變得可達後所需的逐指令逾時 | `workflow/discovered-checks.ts`、在 `task/write-backstop.ts` 補完 twin 的 `commandAllowed`、`StageDefSchema` 上的 `discoverChecks`、`config.ts` 的 `checksFor`／`configuredChecks`／`discoverChecksFor` 與 `checkTimeoutMinutes`、`workflow/engine.ts` 的 `discoveringStage` 與組裝尾段、`runChecks` 逾時與 `ShellPromise.timeout`、兩個 host 的 `runStageChecks`；`discovered-checks.test.ts`、`checks.test.ts`、`config.test.ts`、`schema.test.ts`、`engine.test.ts`，以及 `write-backstop.test.ts` 與 `check-stage-guard.test.mjs` 共用的白名單向量 |
| 19 | [閘門會主動問下一步](./19-gate-follow-up-questions.zh-TW.md) | 生命週期的三個提問——核可這份草稿、現在就規劃、為這份計畫下閘門——不再取決於人走了哪條路徑。`GateResult.data` 現在會標明跨過的閘門（`task`/`plan`/`ship`）與其 id，因此 Claude/Qwen 的閘門 hook 能在 TASK 閘門後把回合交還而非封鎖，並自行注入「現在就規劃嗎？」的指令，而不是寄望動詞散文被遵守；同一段提問也搭上 MCP 工具的 `next`，讓工具呼叫路徑不可能與輸入動詞路徑不一致。OpenCode 取得 `workflow_gate`/`workflow_plan`——一個「是」分支真的能執行的提問——兩者都拒絕來自運行中迴圈的呼叫，讓階段代理永遠無法核可自己的任務。同時修掉一個 Qwen 的實際缺陷：閘門的 `next:` 字串把 `AskUserQuestion` 寫死，而該 host 並沒有這個工具 | `workflow/gate.ts` 的 `data.gate`/`data.id`、兩張 dialect 表的 `askTool`、`hooks/gate-ask.mjs` 加上 `gate-parse.mjs` 的 `continueOnGate` 與 `gate-command.mjs` 的條件分支、三個 approve 工具的 `okGate`、`prompts/verbs/engineering.md` 的 `approve|plan` 標記、OpenCode driver 的 `workflow_gate`/`workflow_plan` 與 `refuseIfDriven`；`gate.test.ts`、`gate-ask.test.mjs`、`gate-result.test.mjs`、`gate-parse.test.mjs`、`gate-command.test.mjs`、`dialect.test.mjs`、`verb-slice.test.mjs`、`driver.test.ts`、`impl.test.ts` |

仍未解決的殘留事項：跨行程的 `index.lock` 競速與遮罩選項。（本清單原本列出的
另外兩項已經完成——bash 工作樹釘選在 `packages/core/src/workflow/worktree-guard.ts`，
指標匯出在 `workflow/metrics-file.ts` 與 `packages/hub/src/server/metrics/`。）
計畫 09 明確把 persona／skill 的重量、以模型呼叫做摘要、以及以 token 為單位的
精確預算排除在範圍外。目前的殘餘風險見
[`../threat-model.md`](../threat-model.md)。

## 每項計畫都遵循的慣例

- **TDD**：每項計畫都先列出要撰寫的失敗測試。所有新增的設定項在未設定
  （unset）的狀態下，整個測試套件必須維持綠燈（向下相容是硬性要求——這裡的
  每項功能都是選擇加入或純附加性質）。
- **純粹性邊界**：`packages/core/src/workflow/state.ts` 以及
  `packages/core/src/task/store.ts` 中的判斷式輔助函式維持純粹（pure）。任何
  會碰到 shell、時鐘或檔案系統的東西都放在 `driver.ts`、`git.ts`、
  `store.ts` 的 IO 那一半，或是一個新的非純粹模組中。
- **文件是「完成」的一部分**：每項計畫最後都會列出需要更新的確切文件
  （`README.md`、`.opencode/commands/agent-loop.md`、
  `skills/workflow-orchestration/SKILL.md`、
  `skills/task-backlog-management/SKILL.md`、
  `docs/design/threat-model.md`），以避免重蹈先前那種 `in-review` 式文件
  漂移的覆轍。
