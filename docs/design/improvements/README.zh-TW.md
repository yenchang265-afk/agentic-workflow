[English](README.md) | 繁體中文

# Agentic loop —— 工程（engineering）工作流程改進計畫

**狀態：以下七項計畫全數已實作並測試完成**，目前存放於共用的
`@agentic-loop/core` 套件（`packages/core/`）中，供 OpenCode 外掛和 Claude
MCP 伺服器共同使用。這些文件保留作為這些功能的設計紀錄，而非待辦的
backlog。

來源：目前的程式碼（所有引用的路徑與函式名稱均已對照撰寫當下的原始碼驗證
過）、[`../threat-model.md`](../threat-model.md) 中列出的殘餘風險，以及
`README.md` / `skills/loop-orchestration/SKILL.md` 中記載的已知限制。

## 這些計畫（全數已發布）

| # | 計畫 | 帶來了什麼 | 現在位於何處 |
|---|------|----------------|--------------------|
| 01 | [Worktree isolation（工作樹隔離）](./01-worktree-isolation.md) | 人類的 checkout 永遠不會被動到；同一個實體中可安全地並行執行多個 watch 工作階段 | `packages/core/src/loop/git.ts`、`packages/core/src/loop/isolate.ts` 中的 `ensureIsolation`、`src/index.ts` 中的編輯守衛；`git.test.ts` |
| 02 | [State persistence（狀態持久化）](./02-state-persistence.md) | 崩潰／重啟後能在確切的階段連同產出物一起恢復，而不必重新規劃 | `packages/core/src/loop/persist.ts`；`persist.test.ts` |
| 03 | [Ship + status commands（發布與狀態指令）](./03-ship-and-status-commands.md) | 有稽核記錄的 `in-review → completed` 移動；待辦儀表板 | `src/loop/driver.ts` 中的 `/agent-loop ship` + status、`packages/core/src/task/store.ts` 中的 `summarizeBacklog`；`store.test.ts` |
| 04 | [Verdict quality（裁定品質）](./04-verdict-quality.md) | 結構化的失敗原因回饋給重新建置；可選的多視角審查 | `packages/core/src/loop/verdict.ts`；`verdict.test.ts` |
| 05 | [Secret redaction（機密資訊遮罩）](./05-secret-redaction.md) | 在寫入持久化產出物之前先清除機密資訊 | `packages/core/src/task/redact.ts`，接線於 `packages/core/src/task/store.ts`；`redact.test.ts` |
| 06 | [Run metrics（執行指標）](./06-run-metrics.md) | 每次執行的階段耗時 + 裁定歷史記錄寫入執行日誌 | `packages/core/src/loop/metrics.ts`；`metrics.test.ts` |
| 07 | [Multi-loop scheduler（多迴圈排程器）](./07-multi-loop-scheduler.md) | 一個排程器驅動多種迴圈類型（engineering + PR sitter）；抽取出 `@agentic-loop/core`，讓兩個外掛共用同一份實作 | `packages/core/src/manifest/`（結構描述、註冊表、範本）、`packages/core/src/scheduler/`（排程器、租約）、`packages/core/src/source/`（backlog、github-pr、ado-pr、帳本）；`loops/engineering/`、`loops/pr-sitter/` |

每項計畫明確延後處理的殘留事項（bash 工作樹釘選、跨行程的 `index.lock`
競速、指標匯出、遮罩選項）仍未解決——目前的殘餘風險見
[`../threat-model.md`](../threat-model.md)。

## 每項計畫都遵循的慣例

- **TDD**：每項計畫都先列出要撰寫的失敗測試。所有新增的設定項在未設定
  （unset）的狀態下，整個測試套件必須維持綠燈（向下相容是硬性要求——這裡的
  每項功能都是選擇加入或純附加性質）。
- **純粹性邊界**：`packages/core/src/loop/state.ts` 以及
  `packages/core/src/task/store.ts` 中的判斷式輔助函式維持純粹（pure）。任何
  會碰到 shell、時鐘或檔案系統的東西都放在 `driver.ts`、`git.ts`、
  `store.ts` 的 IO 那一半，或是一個新的非純粹模組中。
- **文件是「完成」的一部分**：每項計畫最後都會列出需要更新的確切文件
  （`README.md`、`.opencode/commands/agent-loop.md`、
  `skills/loop-orchestration/SKILL.md`、
  `skills/task-backlog-management/SKILL.md`、
  `docs/design/threat-model.md`），以避免重蹈先前那種 `in-review` 式文件
  漂移的覆轍。
