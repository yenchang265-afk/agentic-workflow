[English](sitters.md) | 繁體中文

# sitter（實驗性）

四種可選啟用的類型，監看一個代管的目標面並驅動修復，永遠把終端
呼叫——合併、核准、關閉——留給人類。`engineering`（參考類型——
PLAN/BUILD → VERIFY → REVIEW）記載於 [architecture.md](architecture.md)
和 [`docs/loops/engineering.md`](loops/engineering.md)；本檔案只
涵蓋 `pr-sitter`、`review-sitter`、`dep-sitter` 和 `main-sitter`。

> **四個 sitter 都是實驗性的**——它們的清單、設定項和預設值在各版本
> 之間都可能還會變動。`engineering` 是穩定的、預設開啟的類型。

每個 sitter 自己的架構——階段流水線、mermaid 圖、授權界線，以及
`.agentic-loop.json` 設定項——現在都收在自己的檔案裡：

- [`docs/loops/pr-sitter.md`](loops/pr-sitter.md)
- [`docs/loops/review-sitter.md`](loops/review-sitter.md)
- [`docs/loops/dep-sitter.md`](loops/dep-sitter.md)
- [`docs/loops/main-sitter.md`](loops/main-sitter.md)

## 它們的共同點

每個 sitter 都遵循相同的形狀：一個 **check** 階段判斷是否有可認領
的工作，一個或多個 **work** 階段在 git worktree 隔離之下執行，一個
終端的 **publish** 階段透過一份窄的、清單宣告的 bash/平台白名單
寫入。每一種類型都是可選啟用的（`loops.<kind>.enabled`），會在
接線時從全域的 `codePlatform`（或自己的 `loops.<kind>.codePlatform`
覆寫值）解析出 GitHub 還是 Azure DevOps，並把它讀到的任何 diff/
留言/CI 文字都當成**不可信輸入**——絕不當成指令。`loops.<kind>.trigger`
控制一個正在 watch 的 host 如何為該類型排程認領（僅限 OpenCode 的
`watch` 模式）。完整的安全態勢見
[`docs/design/threat-model.md`](design/threat-model.md)，ADO 平台
機制（PAT、自訂標頭、寫入防線 hook）見
[`configuration.md`](configuration.md#code-platform-codeplatform--ado)，
完整的 `loops.<kind>` 鍵參考見
[`configuration.md`](configuration.md#loop-kinds-loops)。
