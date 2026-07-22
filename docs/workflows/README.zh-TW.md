[English](README.md) | 繁體中文

# 工作流程類型

每種類型都是一個獨立的 agentic loop。以下每份檔案都是該類型的完整全貌——
架構（階段流水線、mermaid 圖、設定項）、如何啟用它、其指令面，以及 1-2
個實戰範例。

- [**engineering**](engineering.md) —— PLAN（在人工把關點暫存）→ BUILD → VERIFY → REVIEW，作用於 `docs/tasks/` 待辦（backlog）
- [**pr-sitter**](pr-sitter.md) —— TRIAGE → FIX → VERIFY → PUBLISH，作用於開啟中的 pull request
- [**review-sitter**](review-sitter.md) —— FETCH → ASSESS → PUBLISH，作用於請求你審查的 pull request
- [**dep-sitter**](dep-sitter.md) —— SCAN → UPGRADE → VERIFY → PUBLISH，作用於有漏洞/過時的相依套件
- [**main-sitter**](main-sitter.md) —— DIAGNOSE → REMEDY → VERIFY → PUBLISH，作用於變紅的預設分支 CI

清單格式與如何編寫一種新的類型，詳見
[`packages/core/workflows/README.md`](../../packages/core/workflows/README.md)。
