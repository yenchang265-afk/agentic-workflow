[English](README.md) | 繁體中文

# 文件索引

每個主題只有一份權威檔案——更新該權威檔案並連結到它；不要在文件之間
複製內容。如果一項關於行為、設定或安全態勢的事實看起來該同時出現在
兩個地方，它其實只該屬於其中一個；另一個應該連結過去。

| 文件 | 權威範圍 |
|-----|---------------|
| [workflows/](workflows/README.md) | 每種類型的完整全貌（engineering、pr-sitter、review-sitter、dep-sitter、main-sitter）——架構（階段流水線、mermaid 圖、設定項）、啟用片段、指令面，以及 1-2 個實戰範例，每種類型都收在同一份檔案裡 |
| [architecture.md](architecture.md) | 僅框架本身（核心套件、清單引擎、排程器、工作來源、watch 租約），以及 Claude Code 版本 + 管理面板有何不同——各類型的架構收在 `workflows/` 下 |
| [sitters.md](sitters.md) | 四個實驗性 sitter 的共同點（形狀、可選啟用、不可信輸入的處理方式），並索引到 `workflows/` 下它們各自的檔案 |
| [configuration.md](configuration.md) | 每一個 `.agentic-workflow.json` 欄位（分層/優先順序、`workflows`、`codePlatform`/`ado`、`projectManagement`、強化項、環境變數） |
| [opencode.md](opencode.md) | OpenCode 特有的執行細節（watch 觸發、ESC/recover）以及完整的 OpenCode 指令面 |
| [`../plugins/claude/README.md`](../plugins/claude/README.md) | Claude Code 安裝、MCP 伺服器指令面，以及已知限制 |
| [`../packages/core/workflows/README.md`](../packages/core/workflows/README.md) | 如何編寫一種新的工作流程類型（清單結構描述、提示詞範本、hooks、工作來源） |
| [`../packages/hub/README.md`](../packages/hub/README.md) | 管理面板（測試版）：安裝、各視圖，以及它自己的設定 |
| [design/threat-model.md](design/threat-model.md) | 安全態勢——每種工作流程類型的威脅與控制措施 |
| [design/proposed-workflows.md](design/proposed-workflows.md) | 尚未建置的工作流程類型提案（其中三項已經上線——目前行為見 `sitters.md`） |
| [design/proposed-hub-features.md](design/proposed-hub-features.md) | 管理面板提案——把關/doctor/設定寫入介面（基礎架構、提示詞預覽和把關動作已經上線；doctor 和設定編輯器尚未——管理面板目前實際做了什麼見 `../packages/hub/README.md`） |
| [design/improvements/](design/improvements/README.md) | 已上線強化工作的實作設計紀錄（worktree、狀態持久化、裁定品質……） |
| [migration.md](migration.md) | 從早期版面遷移（舊的 `/agent-loop` 指令、`in-planning/`、阻塞式 PLAN 把關） |
| [templates/AGENTS.md](templates/AGENTS.md) | 可複製到由 agentic-workflow 驅動的專案中的起始 `AGENTS.md`/`CLAUDE.md` |
| [`../prompts/README.md`](../prompts/README.md) | 單一來源的 agent 提示詞流水線如何運作（`prompts/agents/` → `npm run gen:prompts` → 兩個外掛） |

`manual.html` 是一份手動維護的單頁 HTML 手冊，為求方便而重述上述大部分
內容（快速上手、設定參考、指令速查表）。它**不會從這些文件重新產生**——
把它當成一個已知的過時風險，而不是權威來源；如果它和上面某份權威文件
有分歧，以權威文件為準。

## 翻譯

英文是權威版本；翻譯是人工維護的複本，不是自動產生的——當英文文件變更
時，請在同一個 PR 中更新翻譯（或提出後續追蹤事項），而不是任其悄悄
過期漂移。翻譯檔案命名為 `<name>.<BCP-47 語言代碼>.md`，放在英文原始檔
旁邊（例如 [`README.zh-TW.md`](../README.zh-TW.md) 就放在
[`../README.md`](../README.md) 旁邊），並在兩個檔案的第一行放上單行的
語言切換器，例如英文檔案中放 `English | [繁體中文](README.zh-TW.md)`，
翻譯檔案中放 `[English](README.md) | 繁體中文`。所有使用者面向的
文件（本索引、`docs/` 下的所有內容，以及套件／外掛的 README）目前
都已有 zh-TW 翻譯；隨著需求出現，用同樣的方式增加更多語言。
