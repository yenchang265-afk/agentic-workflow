[English](README.md) | 繁體中文

# agentic-workflow — Qwen Code 外掛

**實驗性**——此宿主的介面與行為仍可能變動。

共用 `@agentic-workflow/core` 引擎的 Qwen Code 宿主。與 OpenCode 和 Claude Code
宿主使用相同的工作流程類型、相同的把關、相同的待辦清單。

**正式文件是 [`docs/qwen.md`](../../docs/qwen.zh-TW.md)**——安裝、執行模型、指令面，
以及已知缺口。本檔只描述這個目錄裡有什麼。

## 目錄結構

| 路徑 | 來源或產生物 |
|---|---|
| `agents/` | 由 `pnpm gen:prompts` 從 `prompts/agents/*/{body.md,qwen.yaml}` **產生** |
| `commands/` | 手寫——Qwen 載入為 `/agentic-workflow:<name>` 的 router |
| `verbs/` | 從 `prompts/verbs/` **產生**——hook 注入的各 verb 程序 |
| `skills/workflow-orchestration/` | 從 `prompts/skills/` **產生**——驅動協定 |
| `hooks/` | 由 `pnpm build:hooks` 從 `plugins/claude/hooks/src/` **產生** |
| `hooks/hooks.json` | 手寫——安裝腳本併入 `settings.json` 的片段 |

永遠不要編輯產生出來的檔案；請改它的來源並重跑產生器。CI 會在漂移時失敗。

## 為什麼有這麼多東西和 Claude 外掛共用

Qwen Code 的擴充介面比起 OpenCode，其實更接近 Claude Code：stdio 上的 MCP 伺服器、
以 Claude Code 相容方式解析 frontmatter 的子代理，以及一套 hook 系統——具有相同的
stdin-JSON／exit-0-JSON／exit-2-stderr 契約，外加
`hookSpecificOutput.updatedInput`。

所以這個宿主是 **Claude 宿主機制的另一種封裝，而不是它的 fork**：

- **MCP 伺服器**是同一個執行檔（`plugins/claude/mcp-server/`），由
  `AGENTIC_WORKFLOW_HOST=qwen` 切換到這個宿主；
- **防護 hooks** 是同一份原始碼，只有它們所依據的工具**名稱**在執行期經由
  `plugins/claude/hooks/src/dialect.mjs` 解析；
- **verbs** 與**編排 skill** 由同一份來源算繪，因為兩個宿主跑的是同一套協定，
  只有工具名稱不同。

MCP 工具名稱完全不需要翻譯：Qwen 以 `mcp__<server>__<tool>` 註冊 MCP 工具，而當名稱
長度 ≤63 且符合 `^[A-Za-z][A-Za-z0-9_-]*$` 時會原樣通過，本伺服器提供的每個工具都符合。

## 這裡刻意沒有 extension manifest

`qwen extensions install` 會複製擴充目錄，那會讓 manifest 指向共用 MCP 伺服器的
路徑立刻失效——而且 Qwen extension 根本無法攜帶 hooks，等於會在沒有安全基座的情況下
出貨。請使用 `./install.sh qwen`。
