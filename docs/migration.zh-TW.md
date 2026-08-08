[English](migration.md) | 繁體中文

# 跨版面遷移

## `taskBranch`——不需要任何動作

新增了一個頂層設定鍵，用來指定 engineering 迴圈工作所在的分支名稱。它的
預設值 `"feature/"` 完全重現舊有寫死的 `feature/<id>`，因此**既有設定不需要
任何修改**，每次執行的行為都與過去相同。

想要以下兩種新行為時才需要設定它：

- `"taskBranch": "wip/"`——一樣是每個任務一個分支，只是換個前綴。
- `"taskBranch": false`——完全不切分支，直接在你目前已檢出的分支上建置。
  詳見 [configuration.md](configuration.zh-TW.md) 的強化項說明；它會強制關閉
  worktree、拒絕在預設分支上啟動，並限制一個工作樹同時只跑一個迴圈。

只有 `engineering` 這個 kind 會讀取它；各 sitter 仍維持 `feature/<id>`。

## 遷移到可選啟用的 sitter——每一種 sitter 類型都成為實驗性

- **`pr-sitter` 和 `review-sitter` 不再預設執行。** 四個 sitter
  （`pr-sitter`、`review-sitter`、`dep-sitter`、`main-sitter`）全都是實驗性
  的，因此每一個都需要在自己的 `workflows.<kind>` 區段寫上
  `"enabled": true`，就跟 `dep-sitter` 和 `main-sitter` 原本一樣。
  `engineering` 沒有變——除非停用，否則仍會執行。
- **這是無聲的中斷**：只帶旋鈕的設定（例如
  `"pr-sitter": { "query": "is:open author:@me" }`）仍能解析，但該類型現在
  是關的，只會靜靜停止認領。在同一個區段加上 `"enabled": true` 即可恢復
  原本的行為：

  ```json
  { "workflows": { "pr-sitter": { "enabled": true, "query": "is:open author:@me" } } }
  ```

- **在 sitter 上寫 `"enabled": false` 不再是設定錯誤。** 它以前會在載入時
  被拒絕（「永遠啟用且無法停用」）；現在可以解析，並讓該類型維持關閉——
  這也是預設值。如果你當初為了避開那個錯誤而刪掉這個鍵，不需要改回來。
- **`codePlatform: "ado"` 同樣是實驗性的**——設定不必改動，但請把 `ado`
  區段的鍵視為仍可能變動。

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

## Azure DevOps 改走 Azure DevOps MCP 伺服器

Azure DevOps 已完全不再透過它的 REST API 觸達。兩個層面——階段 agent 的呼叫，
以及 driver 自己的輪詢與開 PR 呼叫——都走微軟的
[`@azure-devops/mcp`](https://github.com/microsoft/azure-devops-mcp) 伺服器。
沒有 `curl`、沒有 `az`，也沒有存取模式旋鈕：只有一條傳輸路徑，因此階段提示詞
不可能再和管轄它的白名單走偏。

**你必須做的事**

- **註冊伺服器時名稱必須剛好是 `azure-devops`。** 階段提示詞與產生出來的
  agent frontmatter 以 `mcp__azure-devops__<tool>` 的形式指名工具，換成任何
  其他註冊名稱，都會讓每一次 ADO 階段呼叫都指向一個不存在的工具。
  `./bootstrap.sh` 會替 Claude Code、OpenCode 與 Qwen Code 完成註冊。這是一個
  常數而非設定項：這些名稱存在於本儲存庫會產生、且 CI 會做 diff 檢查的檔案裡。
- **保持匯出 `AZURE_DEVOPS_EXT_PAT`**（Code 讀取 + Pull Request contribute）。
  其他不變——引擎會自行把它 base64 編碼成伺服器的 `PERSONAL_ACCESS_TOKEN`。
  不要自己手動編碼任何東西。
- **執行迴圈的行程必須能用 Node 20+ 與 `npx`。** 離線／封閉網路的安裝可以把
  `ado.mcp.command` 指向本機已安裝的執行檔。

**破壞性變更**

- **失敗的檢查現在指的是失敗的**管線執行**，而不是失敗的分支原則。** MCP
  伺服器沒有提供原則評估（policy evaluation）工具，因此 pr-sitter 改為從 PR
  的驗證管線推導檢查狀態。**僅**因為非管線原則而被擋住的 PR——最少審查者
  人數、留言解決狀態、必要的工作項目連結、第三方狀態檢查——不再觸發
  `failing-checks`。它仍然會因為新留言、被要求修改與合併衝突而被喚醒。
  作為交換，失敗的檢查現在是一條 triage 階段真的讀得到、引用得到日誌的管線。
- **不再支援自架的 Azure DevOps Server。** `@azure-devops/mcp` 接受的是組織
  *名稱*，且以 `dev.azure.com` 為目標，沒有地端 collection URL 模式。若你執行
  ADO Server，請停留在較早的版本。
- **`ado.customHeaders` 與 `ado.insecureSkipTlsVerify` 已移除**，
  `AGENTIC_WORKFLOW_ADO_HEADERS` 亦然。被啟動的 MCP 伺服器沒有可注入
  per-request 標頭或 TLS 的接縫。殘留的鍵會被解析並**忽略**，並印一行警告
  指名它，因此進行中的迴圈仍會繼續執行。若需要內部 CA，改用
  `ado.mcp.env.NODE_EXTRA_CA_CERTS`。
- **`ado.access` 維持已移除**，並且同樣會出現在那一行警告中。

**新增**

- **`ado.mcp`** 設定伺服器如何被啟動——`command`、`args`、`authentication`
  （預設 `pat`；另有 `azcli`、`envvar`、`interactive`）、`domains`、`tenant`
  與 `env`。每個欄位都有可用的預設值，所以多數安裝完全不需要它。注意伺服器
  *自己的*預設是 `interactive`，它會開啟瀏覽器，在輪詢迴圈中無法運作——引擎
  會拒絕它，而不是卡在一個沒有人看得到的提示上。見
  [configuration.md](configuration.md#code-platform-codeplatform--ado)。
- **`ado.mcp` 僅限使用者層級**，和 `organization`、`pat` 一樣：它指定的是一個
  會被啟動的命令，因此不能讓被複製下來的儲存庫決定它。

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
