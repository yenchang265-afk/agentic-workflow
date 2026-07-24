[English](sitters.md) | 繁體中文

# sitter

四種類型，監看一個代管的目標面並驅動修復，永遠把終端
呼叫——合併、核准、關閉——留給人類。`engineering`（參考類型——
PLAN/BUILD → VERIFY → REVIEW）記載於 [architecture.md](architecture.md)
和 [`docs/workflows/engineering.md`](workflows/engineering.md)；本檔案只
涵蓋 `pr-sitter`、`review-sitter`、`dep-sitter` 和 `main-sitter`。

> **`pr-sitter` 和 `review-sitter` 已穩定**——它們的清單、設定項和
> 預設值都已定案，變更比照預設開啟的 `engineering` 的相容性標準。
>
> **`dep-sitter` 和 `main-sitter` 仍是實驗性的**——它們的清單、設定項
> 和預設值在各版本之間都可能還會變動。

每個 sitter 自己的架構——階段流水線、mermaid 圖、授權界線，以及
`.agentic-workflow.json` 設定項——現在都收在自己的檔案裡：

- [`docs/workflows/pr-sitter.md`](workflows/pr-sitter.md)
- [`docs/workflows/review-sitter.md`](workflows/review-sitter.md)
- [`docs/workflows/dep-sitter.md`](workflows/dep-sitter.md)
- [`docs/workflows/main-sitter.md`](workflows/main-sitter.md)

## 它們的共同點

每個 sitter 都遵循相同的形狀：一個 **check** 階段判斷是否有可認領
的工作，一個或多個 **work** 階段在 git worktree 隔離之下執行，一個
終端的 **publish** 階段透過一份窄的、清單宣告的 bash/平台白名單
寫入。`pr-sitter` 和 `review-sitter` 永遠開啟且無法停用，`dep-sitter`
和 `main-sitter` 則透過 `workflows.<kind>.enabled` 可選啟用。每一種類型會在
接線時從全域的 `codePlatform`（或自己的 `workflows.<kind>.codePlatform`
覆寫值）解析出 GitHub 還是 Azure DevOps，並把它讀到的任何 diff/
留言/CI 文字都當成**不可信輸入**——絕不當成指令。`workflows.<kind>.trigger`
控制一個正在 watch 的 host 如何為該類型排程認領（僅限 OpenCode 的
`watch` 模式）。完整的安全態勢見
[`docs/design/threat-model.md`](design/threat-model.md)，ADO 平台
機制（PAT、自訂標頭、寫入防線 hook）見
[`configuration.md`](configuration.md#code-platform-codeplatform--ado)，
完整的 `workflows.<kind>` 鍵參考見
[`configuration.md`](configuration.md#workflow-kinds-workflows)。
