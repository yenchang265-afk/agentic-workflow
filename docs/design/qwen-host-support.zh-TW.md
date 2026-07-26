[English](qwen-host-support.md) | 繁體中文

# 加入第三個宿主：Qwen Code（`qwen` CLI）

這是一份**實作計畫**，不是已出貨工作的紀錄（那是
[`improvements/`](./improvements/README.md)），也不是推測性的提案目錄（那是
[`proposed-workflows.md`](./proposed-workflows.md)）。這裡描述的東西目前都還沒有做。
它是針對真實的宿主契約
（[`packages/core/src/host.ts`](../../packages/core/src/host.ts)）以及既有的兩個宿主
轉接層所寫，因此可以直接執行、不需要再翻譯一次。

## 為什麼

`agentic-workflow` 目前是一個引擎（`@agentic-workflow/core`）加上兩個薄的宿主轉接層
——OpenCode 外掛（`plugins/opencode/`），以及由內建 MCP 伺服器驅動的 Claude Code
外掛（`plugins/claude/`）。`host.ts` 刻意是**整個**宿主介面，而
[`architecture.md`](../architecture.md) 也早已把宿主定義成「一個核心之上的薄轉接層」。
因此加入 [Qwen Code](https://github.com/QwenLM/qwen-code) 是一個封裝與方言問題，
不是引擎問題。

Qwen Code（Gemini CLI 的 fork）其實比 OpenCode 更接近 Claude Code：

| 能力 | Qwen Code | 結果 |
|---|---|---|
| stdio 上的 MCP 伺服器 | `settings.json` / `qwen-extension.json` 裡的 `mcpServers` | **原封不動重用 `agentic-workflow-mcp`** |
| 子代理（subagent） | `.qwen/agents/*.md`，YAML frontmatter；明確接受 Claude Code 的 frontmatter 欄位 | 重用既有產生的 persona，新增一份 `qwen.yaml` 變體 |
| 自訂指令 | `.qwen/commands/**.md`、`{{args}}`、子目錄 → `/ns:name` | `commands/agentic-workflow/engineering.md` → `/agentic-workflow:engineering` |
| Hooks | `PreToolUse`、`UserPromptSubmit`、`SubagentStop`、`SessionStart`……——與 Claude Code **完全相同的 stdin-JSON / exit-0-JSON / exit-2-stderr 契約**，另外還有 `hookSpecificOutput.updatedInput` | **重用 hook 政策**；只換掉工具名稱方言 |
| 子代理啟動 | `agent(description, prompt, subagent_type, run_in_background, isolation)` | 沒有每次呼叫的 `model` 參數——見缺口 1 |

所以設計是：**Qwen 是 Claude 宿主機制的另一種封裝，而不是它的 fork。**
沒有任何東西被重新實作；隨宿主而異的部分都收攏到一個 `AGENTIC_WORKFLOW_HOST`
開關和一張工具名稱方言表後面。

範圍：與 `plugins/claude` 完全對等（不是薄包裝）、首發即支援全部五種工作流程類型、
每個階段的模型烘焙進產生出來的 agent 檔案裡。

## 先講清楚的已知缺口

1. **沒有每次呼叫的模型參數。** Qwen 的 `agent` 工具沒有 `model` 參數。
   緩解方式：`install.sh qwen` 會**產生**
   `$QWEN_CONFIG_DIR/agents/<name>.md`，並把從 `workflows.<kind>.stageModels`
   與 `agentModels` 解析出來的 `modelConfig.model` 寫進去。要記錄的後果是：
   改動這些設定鍵之後必須重跑安裝腳本。
2. **Extension 無法攜帶 hooks。** `qwen-extension.json` 沒有 `hooks` 欄位，
   而那些防護 hook **就是**安全基座。因此安裝腳本必須把一段 hooks 併進
   `settings.json`；只用 extension 安裝不是受支援的路徑。
3. **ADO PAT 注入沒有對應物。** `inject-ado-pat.mjs` 寫入 `$CLAUDE_ENV_FILE`；
   Qwen 沒有等價物。在 Qwen 上，SessionStart hook 退化成一則
   `additionalContext` 提示，README 則說明直接匯出 `AZURE_DEVOPS_EXT_PAT`。
   標示出來，不要假裝有。
4. **MCP 工具命名尚未確認。** Qwen 文件同時出現 `server_name-tool_name`（註冊）
   與 `mcp__server__tool`（停用樣式）兩種寫法。這必須在**切片 1 以實測釘死**
   ——它決定了 check 階段 agent 的 `tools:` 清單、`PreToolUse` 的 matcher，
   以及 spawn 提示語裡的裁決工具名稱。

## 切片 0——共用機制裡的一個宿主開關

其他所有東西都依賴這一步。小、機械式，對既有宿主沒有行為變化。

- `packages/core/src/workflow/metrics-file.ts`——run metrics 附屬檔的
  `host: z.enum(["opencode", "claude"])` 加上 `"qwen"`。`packages/hub` 會讀這個
  schema，所以這就是讓 Qwen 的 run 能在 hub 裡被看見的那一步。
- `packages/core/src/workflow/stage-marker.ts`——現在它寫死了 OpenCode 的 marker
  （`runs/.stage-opencode.json`），刻意作為 Claude 宿主 `runs/.stage.json` 的兄弟檔。
  新增一個通用的 `hostStageMarkerPath(tasksDir, host)`，並把既有的具名 export
  保留成薄包裝，讓 hub 的 driving oracle、doctor 和看板讀取維持不變。Qwen 拿到
  `runs/.stage-qwen.json`。
- `plugins/claude/mcp-server/src/server.ts`——讀一次 `AGENTIC_WORKFLOW_HOST`
  （預設 `"claude"`，或 `"qwen"`），並把隨宿主而異的值都導到單一
  `HOST_DIALECT` 表：
  - `agentRef(name)`——Claude 會為外掛子代理加上命名空間
    （`agentic-workflow:workflow-build`）；安裝到 `$QWEN_CONFIG_DIR/agents/` 的
    Qwen agent 則以裸 `name` 引用。
  - stage marker 路徑（透過核心的新輔助函式）與 metrics 的 `host` 欄位。
  - 餵給 `spawnNote(lead, tail)` 的 spawn 提示語——Claude：「Task 工具，`model`
    設為 X」；Qwen：「`agent` 工具，`subagent_type: X` 且
    `run_in_background: false`」，且**不含 model 那一行**（依缺口 1，已烘焙進
    agent 檔案）。

  `spawnNote` 仍然是唯一的收斂點，因此 `server.test.ts` 既有的原始碼 lint
  （每個 `note:` 都要經過 `spawnNote`）仍然成立。`dispatch.test.ts` 則補上
  agent 身分鏈的 Qwen 那一段。

- **可選但建議：** 把 `plugins/claude/mcp-server/` 移到 `packages/mcp-server/`
  （workspace 名稱 `agentic-workflow-mcp` 不變）。第二個宿主去用一個放在第一個
  宿主目錄裡的執行檔是個壞味道。純機械式改動：根目錄 `workspaces`、
  `plugins/claude/.mcp.json`、`install.sh`、`plugins/claude/install.sh`、CI 路徑。
  這一步可以放棄——計畫裡沒有別的東西依賴它。

## 切片 1——MCP 與 agent 基座

**前置作業：** 先用 `qwen` 對建好的伺服器跑一次，記下 `workflow_verdict` 實際的
MCP 工具名稱（缺口 4）。以下全部使用那個字面值。

- `prompts/agents/<name>/qwen.yaml`——`prompts/agents/` 裡每個 persona 一個新檔
  （今天是 17 個）。Qwen 接受 Claude Code frontmatter，所以以 `claude.yaml` 為起點：
  `name`、`description`、`tools`。check 階段的 agent（`workflow-verify`、
  `workflow-review`、`workflow-pr-triage`、`workflow-review-fetch`、
  `workflow-dep-scan`、`workflow-main-diagnose`）必須指名 Qwen 解析出來的裁決工具。
  不需要 `{{allowlist}}` 標記：Qwen 沒有 per-agent 權限表，所以 bash 白名單完全
  由 `PreToolUse` guard 執行，跟 Claude Code 一樣。
- `scripts/gen-prompts.mjs`——在 `HOSTS` 陣列加上
  `{host: "qwen", frontmatter: "qwen.yaml", outDir: "plugins/qwen/agents"}`。
  `{{#host <name>}}` 的 renderer 已經接受任意小寫宿主名，而 `expandAllowlist`
  本來就只給 OpenCode 用，所以那裡不必再改。
- `prompts/agents/*/body.md`——凡是驅動協定隨宿主而異之處（spawn 工具名稱、
  裁決工具名稱）都補上 `{{#host qwen}}` 區塊。既有的 `{{#host claude}}` 區塊
  就是需要補雙胞胎的指引。
- `scripts/qwen-agents.mjs`（新增）——一個安裝期產生器，讀取
  `.agentic-workflow.json`（repo 層加上 user 層，沿用
  `plugins/claude/hooks/verb-slice.mjs` 已經自帶的獨立解析），把
  `plugins/qwen/agents/<name>.md` 以**複製**（而非符號連結）的方式寫到
  `$QWEN_CONFIG_DIR/agents/<name>.md`，並注入從 `stageModels`/`agentModels`
  取得的 `modelConfig.model`。這就是缺口 1 的緩解。agent 是唯一以複製而非
  符號連結安裝的資產，README 要說明原因。

## 切片 2——指令與 verb 切片

Qwen 和 Claude Code 一樣，無法改寫已送出的提示——它的 `UserPromptSubmit` hook
只能封鎖，或加上 `hookSpecificOutput.additionalContext`。所以 Qwen 繼承的是
**Claude** 的切片形狀（實體 router 加上注入的 verb 區塊），而不是 OpenCode 那種。
Qwen 在指令內文裡支援的 `!{shell}` 注入曾被考慮並否決：它會在每次呼叫指令時
彈出執行確認。

因為 verb 的敘述現在跨**兩個**注入型宿主，就不要再手工維護它：

- **把 `plugins/claude/verbs/engineering.md` 移到 `prompts/verbs/engineering.md`**，
  用同樣的 `{{#host}}` 區塊，經由 `gen-prompts.mjs` 產生
  `plugins/claude/verbs/engineering.md` 與 `plugins/qwen/verbs/engineering.md`。
  `<!-- aw:verb … -->` 標記原樣通過。這消除了 `AGENTS.md` 警告的漂移風險：
  一個 verb 掉了它的區塊不會報錯，而是靜默地退化成沒有任何指示。
- `plugins/qwen/commands/`——對應 `plugins/claude/commands/` 的檔案（`engineering.md`
  router 加上 `plan`、`pr-sitter`、`review-sitter`、`dep-sitter`、`main-sitter`），
  把 `$ARGUMENTS` 換成 `{{args}}`，MCP 工具名稱換成 Qwen 方言。即使 Qwen 會忽略
  `argument-hint:`，仍保留這個 frontmatter 鍵——覆蓋率測試會把它當成 verb 名冊解析，
  留一個被忽略的鍵比多養一套機制便宜。
- 安裝到 `$QWEN_CONFIG_DIR/commands/agentic-workflow/*.md`，Qwen 的子目錄命名空間
  會把它呈現為 `/agentic-workflow:engineering`——與另外兩個宿主逐字相同的指令名稱。

## 切片 3——hooks，安全基座

hook 的**契約**已經相容；不同的只有工具身分。不要 fork 政策——把方言抽出來。

- `plugins/claude/hooks/src/dialect.mjs`（新增的共用原始碼）——依
  `AGENTIC_WORKFLOW_HOST` 把 `tool_name` 對應到一個標準種類，並正規化輸入鍵：
  - Claude：`Bash` → bash（`command`）；`Edit|Write|NotebookEdit` → write
    （`file_path|path|notebook_path`）
  - Qwen：`run_shell_command` → bash（`command`）；`write_file|replace|edit` →
    write（`file_path`）
- `plugins/claude/hooks/src/check-stage-guard.entry.mjs`——把寫死的 `"Bash"` 與
  `WRITE_TOOLS` 檢查換成方言查表。四道控制（永遠開啟的待辦清單變更防護、
  check 階段 bash 白名單、worktree 釘選，以及 ADO/GitHub/`git push` 後擋）
  和 `updatedInput` 改寫路徑都原樣沿用——Qwen 支援
  `hookSpecificOutput.updatedInput`，也支援相同的「exit 2 即封鎖」語意。
- `check-verdict-guard`、`reconcile`，以及
  `gate-command`/`gate-parse`/`gate-result`/`verb-slice`——邏輯不變。
  `gate-command.mjs` 在既有的 `CLAUDE_PLUGIN_ROOT` 查找之前，多加一個
  `AGENTIC_WORKFLOW_PLUGIN_ROOT` 後備；安裝腳本透過 hook 項目的 `env` 欄位提供它。
- `inject-ado-pat.mjs`——在 Qwen 上改成送出一則 `additionalContext` 提示，
  而不是寫入 env 檔（缺口 3）。
- `scripts/build-hooks.mjs`——再輸出**第二套、完全產生**的 bundle 到
  `plugins/qwen/hooks/`。連目前手寫的進入點（`gate-command.mjs` 與它的純函式輔助）
  也一起打包，讓 `plugins/qwen/hooks/` 100% 由產生器產出，CI 既有的
  `git diff --exit-code` 漂移閘門就能覆蓋它。hook 是在沒有 `node_modules` 的裸
  `node` 下執行，這正是所有與核心共用的東西都要內聯的原因——這個限制不變。
- `plugins/qwen/hooks/hooks.json`——安裝腳本要併入的 settings 片段。同樣四個事件；
  `PreToolUse` 的 matcher 變成
  `run_shell_command|write_file|replace|edit|<qwen mcp prefix>.*`。

## 切片 4——安裝與解除安裝

採用 **OpenCode** 的安裝腳本慣例（把符號連結放進設定目錄），而不是 Qwen 的
extension 慣例：`qwen extensions install` 會**複製**來源，破壞「改 repo 立刻生效」
的開發迴圈，而且 extension 本來就不能攜帶 hooks（缺口 2）。

`install.sh` 在 `opencode|claude|all|config` 之外多一個 `qwen` 目標——包含 dispatch
的 `case`、`has_claude`/`has_opencode` 旁邊的 `has_qwen()`、互動選單，以及預設目標
的挑選邏輯。`install_qwen()`：

1. 建置 core 與 `agentic-workflow-mcp`（在根目錄 `npm install`，它會跑 `prepare`）
2. 把 `plugins/qwen/commands/*.md` 符號連結到
   `$QWEN_CONFIG_DIR/commands/agentic-workflow/`
3. 用與 `plugins/claude/install.sh` 相同的相對符號連結模式連結 `skills/` 與
   `references/`，包含 `workflow-orchestration` 的例外——Qwen 需要自己的一份，
   因為驅動協定確實隨宿主而異，
   [`prompts/README.md`](../../prompts/README.md) 已經說明了為什麼它不是產生的
4. `node scripts/qwen-agents.mjs` → 產生已烘焙模型的 agent
5. `node scripts/qwen-settings.mjs merge` → 冪等地把
   `mcpServers.agentic-workflow`（`dist/server.js` 的絕對路徑，加上
   `env: {"AGENTIC_WORKFLOW_HOST": "qwen"}`）與 hooks 區塊併入
   `$QWEN_CONFIG_DIR/settings.json`，放在一個有標記、可移除的區域內。
   用 Node 合併 JSON，絕不用 `sed`；保留未知鍵。

`$QWEN_CONFIG_DIR` 預設為 `~/.qwen`，並提供明確覆寫，比照今天對
`OPENCODE_CONFIG_DIR` 的處理，讓 CI 可以在暫存目錄裡來回測試。

`uninstall.sh` 多一個 `qwen` 目標，移除符號連結、產生出來的 agent，以及那段有標記
的 settings 區域，讓 `settings.json` 其餘部分逐位元組不變。

同時附上 `plugins/qwen/qwen-extension.json` 供 `qwen extensions install <path>`
探索之用，但文件要註明它是**次要且不含 hooks**的——安裝腳本仍是受支援的路徑。

## 切片 5——測試與 CI

- `plugins/claude/hooks/dialect.test.mjs`——兩種方言、未知工具 id、缺少輸入鍵。
- `plugins/claude/hooks/qwen-command-coverage.test.mjs`——重用 `verb-slice.mjs` 的
  `verbsIn` / `unmarkedLines` / 已宣告 verb 解析，對 Qwen 的 router 與產生的 verbs
  檔案執行。這就是防止某個 verb 在新宿主上靜默掉了區塊的機制。
- `scripts/qwen-settings.test.mjs`——合併是冪等的、解除安裝是精準的、未知鍵存活。
- `mcp-server/src/dispatch.test.ts`——把 `workflow.json` 的 `stage.agent` ↔
  agent 檔案 `name` ↔ `agentRef` 這條鏈延伸到 `plugins/qwen/agents/`。
- `mcp-server/src/server.test.ts`——斷言 Qwen 方言的 spawn 提示語指名 `agent`
  工具與 `run_in_background: false`，比照既有的 Claude spawn 提示語 lint。
- `.github/workflows/test.yml`：
  - prompt 漂移閘門的路徑清單加上 `plugins/qwen/agents`、`plugins/qwen/verbs`、
    `plugins/claude/verbs`
  - hook 漂移閘門的路徑清單加上 `plugins/qwen/hooks`
  - MCP 冒煙測試以 `AGENTIC_WORKFLOW_HOST=qwen` 再跑一次
  - `bash -n` 與 `shellcheck` 清單加上任何新的 shell 腳本
  - 安裝來回測試：`./install.sh qwen "$d"` 跑兩次 → `./uninstall.sh qwen "$d"`
    → 斷言沒有殘留的符號連結**且** `settings.json` 是乾淨的

## 切片 6——文件

Repo 規則（[`docs/README.md`](../README.md)）：一個主題一份正式文件，而且每份文件
都有一個 `.zh-TW.md` 雙胞胎，要在同一次變更裡一起更新。

- `docs/qwen.md` + `.zh-TW.md`——新增，比照 [`opencode.md`](../opencode.md)
- [`architecture.md`](../architecture.md) + `.zh-TW.md`——`hosts` mermaid 子圖裡
  的第三個節點，以及與既有「Claude Code 變體」並列的「Qwen Code 變體」段落
- `plugins/qwen/README.md` + `.zh-TW.md`——安裝、指令，以及四個缺口的直白說明
- `AGENTS.md`——「Plugin Structure」樹狀圖，以及目前寫著「兩個宿主的差異」、
  必須改成三個的「Per-verb command slicing」段落
- 根目錄 `README.md` + `README.zh-TW.md`——安裝對照表

## 驗證

1. `npm run typecheck:all && npm run test:all`——跨所有 workspace 的單元測試與
   hook 測試。
2. `node scripts/gen-prompts.mjs && node scripts/build-hooks.mjs && git diff --exit-code`
   ——證明產生出來的 agent、verbs 和 hook bundle 與其來源同步。
3. `AGENTIC_WORKFLOW_HOST=qwen node <mcp>/dist/server.js < /dev/null` → stderr 出現
   「MCP server ready」，stdout 為空（stdout 保留給 MCP 傳輸層）。
4. 在暫存 `QWEN_CONFIG_DIR` 裡做安裝來回測試：安裝兩次（冪等），確認
   `settings.json` 裡恰好有一段標記區域，解除安裝，確認檔案回到安裝前的內容。
5. **在真正的 `qwen` session 裡對一個拋棄式 repo 做端對端測試**——這是唯一能證明
   宿主真的會驅動的步驟：
   - `/agentic-workflow:engineering new <idea>` → `docs/tasks/draft/` 出現一份草稿，
     這證明指令有解析到、router 有載入、verb 區塊有被注入。如果出現
     「no VERB INSTRUCTIONS block reached you」訊息，代表 hooks 沒有接上。
   - `approve` → `queued/`；`plan <id>` → 停在 `plan-review/`；`approve` →
     `in-progress/`
   - `claim` → BUILD → VERIFY → REVIEW 在 worktree 裡跑；確認
     `runs/.stage-qwen.json` 有被寫出，且 VERIFY 期間一個不在白名單上的 bash 呼叫
     會**被 guard 封鎖**
   - `approve` → 出貨
   - 確認 `runs/<id>.metrics.json` 帶著 `host: "qwen"`，且該次 run 出現在
     `npm run hub` 裡
6. 確認一個只在敘述裡宣稱「PASS」、卻沒有呼叫裁決工具的 check 階段，會被
   SubagentStop 的裁決 guard 攔下。可信裁決這條護欄是新宿主上最重要、最該先證明
   的一件事。
