[English](migration.md) | 繁體中文

# 跨版面遷移

## 遷移到 `workflows` ——內部由 `loop` 改名為 `workflow`

- **設定鍵現在是 `workflows`，不再是 `loops`。** 把你的
  `.agentic-workflow.json` 頂層 `"loops": { ... }` 區塊改名為
  `"workflows": { ... }`(每種類型的結構不變：`enabled`、
  `codePlatform`、`trigger`、`stageModels`)。**這是無聲的中斷，不是
  會報錯的中斷**：這個結構描述欄位是選填的，預設為 `{}`，所以還沒改名
  的檔案仍帶著 `loops` 鍵也能成功解析——卻會被讀成「沒有設定任何
  類型」，你以為已經啟用的每個 sitter 都會悄悄停止認領工作。沒有
  相容層；升級前請先改名這個鍵。
- **清單與文件路徑也跟著搬動**：`packages/core/loops/<kind>/loop.json`
  現在是 `packages/core/workflows/<kind>/workflow.json`，
  `docs/loops/<kind>.md` 現在是 `docs/workflows/<kind>.md`。只有在你
  自行編寫過自訂類型、或直接連結到這些路徑時才需要留意。
- **內部 agent 識別字也變了**(`loop-build` → `workflow-build`、
  `loop-verify` → `workflow-verify` 等,涵蓋全部 17 個階段 agent),
  `loop-orchestration` skill 現在是 `workflow-orchestration`。一般
  使用不受影響;只有在你自行編寫過引用舊名稱的自訂階段或 skill 時
  才需要留意。
- **Claude 外掛的 MCP 工具名稱也變了**(`loop_start` → `workflow_start`、
  `loop_verdict` → `workflow_verdict` 等,涵蓋全部 21 個工具;完整
  名稱現在是 `mcp__agentic-workflow__workflow_verdict`)。一般使用不受
  影響;只有在你自行以腳本呼叫 MCP 伺服器、或手寫的階段在 bash
  allowlist 中指名某個工具時才需要留意。
- worktree 隔離的預設目錄從 `.loop-worktrees` 改為
  `.workflow-worktrees`(`worktreesDir` 設定預設值)。如果你已經明確
  設定過 `worktreesDir`,不需要變更;如果你依賴預設值且用該名稱
  `.gitignore` 過它,請更新被忽略的路徑。

## 遷移到預設不追蹤的待辦清單（`ignoreBacklog`）

- **既有儲存庫的行為變更**：任務待辦（`tasksDir`，預設為
  `"docs/tasks"`）不再自動被提交。新增的 `ignoreBacklog` 欄位預設為
  **`true`**：迴圈不會再把每次任務移動（approve、plan、ship、park、
  done、stop）都提交為稽核紀錄，而是把 `tasksDir` 登記進
  `<git-common-dir>/info/exclude`——一份僅限本機、未被追蹤的排除
  清單，與 `worktreesDir` 使用的機制相同——並讓該次移動保留為未提交
  的工作樹變更。
- **想保留舊行為**，設定 `"ignoreBacklog": false`——每次任務移動就會
  恢復成跟以前一樣被提交。
- **磁碟上的內容不受任何一種設定影響**：任務檔案仍然會照常在狀態
  資料夾之間移動；改變的只是迴圈是否提交這些移動。共用、被追蹤的
  `.gitignore` 在兩種設定下都不會被碰到。見
  [configuration.md](configuration.md#optional-hardening)。

## 遷移到僅用 az CLI 的 Azure DevOps（移除 `ado.access`）

Azure DevOps 現在**只**透過 `az` CLI（`azure-devops` 擴充）觸達,端
到端——階段提示、階段 bash 允許清單,以及 driver 自己的輪詢／ship
把關點呼叫。三選一的 `ado.access` 旋鈕（`az` | `rest` | `mcp`）以及
它所把關的兩個只在原生 fetch 下作用的旋鈕都已移除。這把每個 ADO
階段過去必須手動維持一致的三套平行指令集,收斂成一套。

- **`ado.access` 已移除。** 它本就預設 `"az"`,所以若你從未設定過
  (或設為 `"az"`),什麼都不會變——刪掉這個鍵即可。若你固定了
  `"rest"` 或 `"mcp"`,那條路徑已不存在;移除該鍵並改用 az CLI。
  殘留的 `access` 值會被**忽略並附一行警告**,不是硬性錯誤,所以
  進行中的迴圈仍會繼續——但它已無作用,請刪除。
- **`ado.customHeaders` 與 `ado.insecureSkipTlsVerify` 已移除。**
  它們只作用於被 az CLI 取代的原生 fetch 傳輸。兩者都會被同樣的
  警告忽略。對於坐落在自簽／內部 CA 憑證後面的自架 Azure DevOps
  Server,改為設定 CLI 自身的信任——環境中的
  `REQUESTS_CA_BUNDLE=<ca.pem>`,或 `az devops configure`。自訂
  proxy/路由標頭沒有 az CLI 的對應項;用 proxy 自己的環境變數
  （`HTTPS_PROXY` 等）去對接 CLI。`AGENTIC_WORKFLOW_ADO_HEADERS`
  同樣不再被讀取。
- **先決條件**:必須安裝並認證帶 `azure-devops` 擴充的 `az` CLI——
  `AZURE_DEVOPS_EXT_PAT`（和之前相同的環境變數;擴充直接採用它）、
  `ado.pat`,或互動式的 `az login`。既有的 PAT 設定原樣繼續生效。
- **進行中的迴圈不受影響**:在這次變更前認領的狀態快照載入時會失去
  已無作用的存取戳記並渲染 az 指令,而它們與 az 允許清單相符。見
  [configuration.md](configuration.md#code-platform-codeplatform--ado)。

## 遷移到分層設定（使用者層級 + 儲存庫層級）

- 設定現在從**兩個層**解析而來：一個可選的使用者層級
  `~/.config/agentic-workflow/agentic-workflow.json`（適用所有儲存庫；遵循
  `$XDG_CONFIG_HOME`，且當此檔案不存在時仍會讀取舊有的
  `~/.agentic-workflow.json` 作為後備），疊放在儲存庫的
  `.agentic-workflow.json` 之下，儲存庫層級逐欄位優先——見
  [configuration.md](configuration.md#layers--precedence)。不需要
  遷移任何東西：一個只有儲存庫層級的設定行為和之前完全一樣。
- **注意**：一份因為先前實驗而遺留下來的雜散
  `~/.agentic-workflow.json` 現在會被讀取並疊加進來。刪除它，或者設定
  `AGENTIC_WORKFLOW_USER_CONFIG=""` 來停用這一層。
- 給多儲存庫 ADO 使用者的建議分工：把 `ado.organization`、
  `ado.selfLogin` 和 `ado.pat` 移到使用者層級檔案；把
  `codePlatform`、`ado.project`/`repository` 和 `workflows` 留在各個
  儲存庫裡。

## 遷移到各類型專屬指令（`/agentic-workflow:engineering`、`/agentic-workflow:pr-sitter`）

- **總管式的 `/agent-loop` 指令已經消失**——每一種工作流程類型現在都有
  自己、以外掛命名空間區隔的指令。Engineering：
  `/agentic-workflow:engineering`（`new <idea>` · `retask <id> [note]` ·
  `approve [id]`——統一的、以資料夾驅動的把關點，行為不變 ·
  `replan [id] [reason]`——唯一的拒絕動詞，先前叫 `reject` ·
  `plan <id>` · `claim` · `watch [interval]` / `unwatch`
  （OpenCode）· `recover <id>` · `kinds` · `doctor [fix]` · `stop` ·
  `status`）。PR sitter：`/agentic-workflow:pr-sitter`（`claim` ·
  `watch [interval]` / `unwatch`（OpenCode）· `stop` · `status`）。
- **隨總管指令一起消失的**：`ok`/`go` 這兩個 approve 別名；
  `reject` 和它的 `redo` 別名（改用 `replan`）；明確的
  `approve-plan <id>` 形式（統一的 `approve <id>` 已涵蓋計畫把關）；
  `task <id>`、它的 `run` 別名，以及裸 id 簡寫（用 `plan <id>` 來
  規劃單一任務，用 `claim` 來建置下一個）；還有 `ship <id>`（統一的
  `approve <id>` 會從 `in-review/` 發布）。
- **範圍限定**：`claim [kind]` / `watch [interval] [kind]` 不再
  接受類型過濾器——指令本身就是過濾器。把舊的 `/agent-loop watch`
  session 重新啟動為 `/agentic-workflow:engineering watch`（如果啟用了
  sitter，再加上 `/agentic-workflow:pr-sitter watch`）。
- 更新之後重新執行 `./install.sh`；先前安裝的
  `commands/agent-loop.md` 符號連結現在會是懸空的——如果它還留著就
  刪掉它。

## 早期歷史（1.0 之前的內部疊代）

在目前這套依類型區分的指令版面出現之前，本儲存庫在最初幾週經歷過
好幾輪整併：`/task`/`/agent-loop-plan` 的拆分合併成單一的
`/agent-loop-task`，接著又合併成一個總管式的 `/agent-loop` 指令
（`new`/`retask`/`approve`/`reject`/`claim`/`watch [kind]`/
`kinds`）；規劃從一個前置的獨立指令，變成迴圈內建的 PLAN 階段
（`in-planning/` 變成了 `queued/` + `plan-review/`）；而待辦則多了
一道變更防護、一個單一 watcher 的租約
（`docs/tasks/runs/.watch-lease/`），以及互動式的 Claude Code 把關
點。這些過渡狀態沒有任何一個曾經出貨給實際開發團隊之外的人——如果
你要從這麼舊的版本遷移，上面依類型改名的部分可以直接取代它。刪除
任何懸空的 `commands/agent-loop*.md` 或 `commands/task.md` 符號
連結，並重新執行 `./install.sh`。
