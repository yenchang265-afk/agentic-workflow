[English](README.md) | 繁體中文

# agentic-workflow

以受監督的狀態機方式執行長期目標，而不是聊天式的來回問答。本儲存庫是一個
**多種類工作流程框架**：每種工作流程類型都是
[`packages/core/workflows/<kind>/`](packages/core/workflows/README.md) 下的一份宣告式清單
（manifest）——階段（stage）、狀態轉換（transition）和工作來源（work source）——由共用引擎解讀執行，並由統一的排程器驅動。以兩個並行外掛的形式發布——一個面向
**OpenCode**，一個面向 **Claude Code**（[`plugins/claude/`](plugins/claude/README.md)）——兩者都建立在同一個核心套件（[`packages/core`](packages/core)）之上，共用人工把關點（human gate）、git 隔離、可信裁定（trusted verdict）和稽核軌跡。

目前已發布五種工作流程類型。**engineering**（預設開啟）在 `docs/tasks/` 任務待辦
（backlog）上驅動一個目標經歷 PLAN → BUILD → VERIFY → REVIEW，包含人工任務把關和
計畫把關。四個**實驗性**、可選啟用的 **sitter**——`pr-sitter`、
`review-sitter`、`dep-sitter`、`main-sitter`——監看一個代管的目標面
（開啟中的 PR、審查請求、有漏洞的相依套件、變紅的 CI）並驅動修復，同時把每一個
終端呼叫都留給人類。詳見下方 [The sitters](#the-sitters-實驗性)。

編寫一種新的工作流程類型只需要一個 `workflow.json` 加上階段提示詞——詳見
[`packages/core/workflows/README.md`](packages/core/workflows/README.md)。

## 工程（engineering）迴圈

編寫任務、把關和執行都是同一道指令。**`/agentic-workflow:engineering`** 會透過
訪談把你引導進一份草稿任務（`new <idea>` —— 一律如此，這樣目標和可驗證的
驗收標準來自你本人而不是猜測；**重量級構想會被拆成若干兄弟草稿**，每份都是
一個縱向切片，外加一個 `type: epic` 追蹤任務，因此不會有單一任務撐爆一次建置
上下文），而 `retask <id>` 則可以就地重塑一份你不滿意、且尚未規劃的任務——
可以是 `draft/` 中的草稿，也可以是已核准進入 `queued/` 的任務（後者會先被送回
`draft/`，核准因此撤銷，重塑後要再核准一次）。**`approve [id]`**
是唯一的把關動詞，由任務所在的資料夾驅動：它可以把一份已審查的草稿排入佇列
（任務把關），把一份暫存的計畫釋出進建置佇列（計畫把關），或者在你讀過
diff 之後交付一份已完成的審查（發布）——一個任務永遠只處於一個資料夾中，
因此這個動作永遠不會有歧義，省略 id 的 `approve` 會推進目前唯一停在迴圈
把關點上的任務；只有在兩個迴圈把關點都沒有任務等待時，才會退而推進唯一的
一份草稿。**`replan [id] [reason]`** 是唯一的拒絕
動詞：一份暫存的計畫（或以 id 指定、觸發了上限的任務）會被送回
`queued/` 重新規劃。規劃發生在**執行前的按需時刻**——`plan <id>` 為一個
已排入佇列的任務執行 PLAN 並將其暫存，這樣計畫就不會在任務暫停等待期間過期——而
`claim`/`watch` 只建置已核准計畫的任務（它們絕不會自動為已排入佇列的任務產生計畫）：

| 階段 | 作用 | 是否暫停？ |
|-------|------|---------|
| PLAN | 將 `## Implementation Plan` 寫入被 `plan <id>` 認領的已排入佇列任務，然後**將其暫存到 `plan-review/` 並結束** | 暫停 —— `approve` / `replan` 才是把關點，迴圈本身從不阻塞 |
| BUILD | 在自己的 `feature/<id>` 分支上以測試先行的方式實作已核准的計畫 | 否 |
| VERIFY | 執行測試；失敗則帶著失敗資訊重新建置 | 否 |
| REVIEW | 檢查分支 diff；失敗則帶著回饋重新建置 | 否 |

執行是在 `feature/<id>` git 分支上隔離進行的，裁定（verdict）只透過外掛工具
取信，每一次狀態轉換都會被稽核，迴圈本身從不推送或開啟 PR——由你審查 diff
並執行 `/agentic-workflow:engineering approve`，它會推送分支並開啟（或重複使用）一個
**draft** PR（GitHub 或 Azure DevOps，視 `codePlatform` 而定）作為發布流程的一
部分。完整的執行模型（watch 模式、疊代上限、還原）：
[docs/opencode.md](docs/opencode.md)。

## sitters（實驗性）

四個可選啟用的 sitter 會監看一個代管的目標面並驅動修復，每一個都有自己的
`/agentic-workflow:<kind>` 指令，共用 `claim` / `status` / `stop` 動詞（在
OpenCode 上還有 `watch [trigger]` / `unwatch`）。它們都是**實驗性的**——
其清單、設定項和預設值都可能還會變動。依儲存庫在 `.agentic-workflow.json` 中
啟用：

```json
{
  "workflows": {
    "pr-sitter":     { "enabled": true, "query": "is:open author:@me" },
    "review-sitter": { "enabled": true },
    "dep-sitter":    { "enabled": true, "severityFloor": "high" },
    "main-sitter":   { "enabled": true, "branch": "main" }
  }
}
```

每個 sitter 都把它讀取的 PR/留言/diff/CI 文字視為不可信輸入，處於按階段劃分
的 bash + 平台白名單之後，並且把終端呼叫——合併、核准、關閉——留給人類。
每一個 sitter 具體做什麼、它的流水線、它的設定項：
[docs/sitters.md](docs/sitters.md)；安全態勢：
[docs/design/threat-model.md](docs/design/threat-model.md)。

## 安裝

以下步驟假設系統先決條件已就緒（Node ≥ 20、git、`gh`、`curl`，如需瀏覽器相關
作業還需要 Chrome）。Azure DevOps 只需要 `curl` 加上 `AZURE_DEVOPS_EXT_PAT`
中的一個 PAT。對於全新的機器，`./bootstrap.sh` 會為你驗證/安裝這些相依項，
註冊 `chrome-devtools` MCP 伺服器，然後為你執行 `./install.sh`：

```bash
./bootstrap.sh                 # 全部；或 --no-ado / --no-browser / --check-only
```

手動路徑（相依項已安裝）：

```bash
git clone <this-repo>
cd agentic-workflow
npm install             # npm workspaces —— 同時建置 @agentic-workflow/core（prepare）
./install.sh            # 兩個外掛都裝；或者：./install.sh opencode | claude
```

- 在儲存庫根目錄執行 `npm install` 會安裝所有 workspace（OpenCode 外掛、
  `packages/core`、`plugins/claude/mcp-server`），並透過 `prepare` 腳本建置核心
  套件——兩個外掛都消費核心套件建置出的 `dist/`。
- `./install.sh opencode` 會把 agents/commands/skills/references 符號連結進
  `~/.config/opencode/`（或 `$OPENCODE_CONFIG_DIR`）並註冊外掛——細節和參數
  （`--copy`、自訂目錄）見 [docs/opencode.md](docs/opencode.md)。
- `./install.sh claude` 會建置內建的 MCP 伺服器並連結共用的
  skills/references，然後印出載入方式（`claude --plugin-dir` 或市集安裝）——
  細節見 [`plugins/claude/README.md`](plugins/claude/README.md)。
- 安裝完成後，互動式終端機會得到一個簡短的**設定精靈**來產生
  `.agentic-workflow.json`——見 [docs/configuration.md](docs/configuration.md)。

冪等——`git pull` 之後重新執行即可更新。

## 解除安裝與清理

兩個腳本分別復原兩種痕跡——已安裝的外掛，以及執行中的迴圈留下的本機狀態：

```bash
./uninstall.sh                 # 復原 install.sh；或 opencode | claude | all
./scripts/clean.sh             # 只移除 <tasksDir>/runs/ 中的暫存狀態
./scripts/clean.sh --purge     # 同時刪除待辦任務檔案 + .agentic-workflow.json
```

- **`./uninstall.sh`** 會移除本儲存庫連結進你 OpenCode 設定中的
  agents/commands/skills/references 項目和本機外掛檔案（只移除指回本儲存庫的
  符號連結；`--copy` 也會移除複本），並刪除已建置的 Claude
  `mcp-server/dist`。它不會動你的 `.agentic-workflow.json` 和待辦任務；解除安裝
  Claude 外掛本身需要 `/plugin uninstall agentic-workflow`。
- **`./scripts/clean.sh`** 清除驅動該專案的迴圈的本機狀態（`$AGENTIC_WORKFLOW_DIR`
  或目前目錄）。預設只清空暫存的 `<tasksDir>/runs/` 機器記憶——快照、指標、
  階段標記、watch 租約、認領標記，以及各種類型的去重帳本——迴圈會重新產生
  這些內容。`--backlog` 還會刪除各狀態資料夾中的任務檔案（保留 `.gitkeep`
  和資料夾本身），`--config` 還會移除 `.agentic-workflow.json`，`--purge` 三者
  全做。破壞性等級會先詢問確認（用 `-y` 略過）；`--dry-run` 只預覽不刪除。

## 指令

- `/agentic-workflow:engineering new <idea>` · `retask <id> [note]` —— 透過訪談得到一份或多份
  planless 草稿，存於 `docs/tasks/draft/`；`retask` 會重新訪談並就地重塑
  一份尚未規劃的任務——`draft/` 中的草稿，或先被送回 `draft/` 的 `queued/`
  任務（`plan-review/` 之後請改用 `replan`）
- `/agentic-workflow:engineering approve [id]` —— 唯一的按資料夾驅動的把關點：草稿 → 已排入佇列
  （任務把關）、plan-review → 進行中（計畫把關）、in-review → 已完成
  （發布，在你審查分支 diff 之後）。省略 id 的 `approve` 會推進目前唯一
  停在迴圈等待點上的任務；兩個等待點都沒有任務時，才退而推進唯一的一份草稿
- `/agentic-workflow:engineering replan [id] [reason]` —— 拒絕動詞：把一份暫存的計畫（或以 id
  指定、觸發了上限的任務）送回 `queued/` 重新規劃
- `/agentic-workflow:engineering plan <id>` · `claim` · `watch [interval]`（OpenCode）·
  `unwatch` · `recover <id>` · `stop` · `status` · `doctor [fix]` · `kinds` ——
  `plan` 為一個已排入佇列的任務執行 PLAN 並將其暫存（唯一的 PLAN 入口）；
  `claim` 拉取下一個可建置的 `in-progress/` 任務；`watch` 是一個僅作用於
  engineering 類型的常駐 worker
- `/agentic-workflow:pr-sitter claim` · `watch [interval]`（OpenCode）· `unwatch` ·
  `stop` · `status` —— 相同的 claim/watch 語意，作用範圍限定在 PR sitter
- `/agentic-workflow:review-sitter` · `/agentic-workflow:dep-sitter` ·
  `/agentic-workflow:main-sitter` —— 同樣的 `claim` / `watch`（OpenCode）/
  `unwatch` / `stop` / `status` 動詞，各自作用於自己的類型（透過
  `workflows.<kind>.enabled` 按需啟用）

完整指令參考：[docs/opencode.md](docs/opencode.md)（OpenCode）·
[`plugins/claude/README.md`](plugins/claude/README.md)（Claude Code —— 沒有
常駐的 `watch`；`claim` 就是拉取動作）。迴圈之外的臨時請求會透過
[AGENTS.md](AGENTS.md) 對應到內建的 skills 庫。

## 文件

- [docs/README.md](docs/README.md) —— `docs/` 下每份文件的索引，以及針對
  某個主題哪份文件是權威版本
- [docs/workflows/](docs/workflows/README.md) —— 每種類型一份檔案（engineering、
  pr-sitter、review-sitter、dep-sitter、main-sitter）：其架構（階段流水線、
  mermaid 圖、設定項）、如何啟用、指令面，以及 1-2 個實戰範例
- [docs/architecture.md](docs/architecture.md) —— 僅框架本身（核心套件、
  清單引擎、排程器、工作來源、watch 租約）以及 Claude Code 版本有何不同
- [docs/sitters.md](docs/sitters.md) —— 四個實驗性 sitter 的共同點，
  並索引到 `docs/workflows/` 下它們各自的檔案
- [packages/core/workflows/README.md](packages/core/workflows/README.md) —— 如何編寫一種新的工作流程類型
  （清單結構描述、提示詞範本、hooks、工作來源）
- [docs/opencode.md](docs/opencode.md) —— OpenCode 執行模型、指令、安裝細節
- [`plugins/claude/README.md`](plugins/claude/README.md) —— Claude Code 安裝、
  指令、已知限制
- [docs/configuration.md](docs/configuration.md) —— `.agentic-workflow.json`
  參考（使用者層級 + 儲存庫層級分層）、各類型的 `workflows` 區塊，以及可選的強化項
  （worktree、審查視角、去識別化）
- [docs/templates/AGENTS.md](docs/templates/AGENTS.md) —— 可複製到由
  agentic-workflow 驅動的專案中的起始 `AGENTS.md`/`CLAUDE.md`（迴圈工作流程 +
  skill 對應）
- [docs/migration.md](docs/migration.md) —— 從早期版本遷移（單一的
  `/agent-loop` 指令、`/agent-loop-plan`、`in-planning/`、阻塞式 PLAN 把關）
- [docs/design/](docs/design/) —— 威脅模型、強化設計紀錄
  （包括 [07 — 多迴圈排程器](docs/design/improvements/07-multi-workflow-scheduler.md)）
- [packages/hub/README.md](packages/hub/README.md) —— **管理面板（admin
  hub，測試版）**（`npm run hub -- --dir /path/to/repo` → http://127.0.0.1:4317）：
  工作流程監視器（待辦看板、即時把關點通知、執行歷史、按階段的 token 用量）和
  視覺化工作流程建立器；可以監看一個或多個儲存庫（`--dir` 可重複且支援 `*`
  萬用字元，或者在使用者層級 `~/.agentic-workflow.json` 中設定 `hub.repos` —— 不設定
  儲存庫就不會監看）

每個主題只在一份檔案中是權威的——完整的「哪份文件擁有哪個主題」索引見
[docs/README.md](docs/README.md)。更新權威檔案並連結到它，不要複製內容。

## 目錄結構

- `packages/core/` —— `@agentic-workflow/core`：純粹的工作流程引擎、清單層、
  工作來源 + 排程器、任務儲存、git 隔離、快照、裁定、指標、設定 ——
  兩個外掛共用的一切
- `packages/core/workflows/` —— 宣告式的工作流程類型，每種類型一個目錄
  （`engineering/`、`pr-sitter/`、`review-sitter/`、`dep-sitter/`、
  `main-sitter/`）：每種類型一份 `workflow.json` 清單 + `stages/*.md` 提示詞範本
- `packages/hub/` —— **管理面板（測試版）**：帶有工作流程監視器和視覺化工作流程建立器的本機 web 應用程式（[packages/hub/README.md](packages/hub/README.md)）
- `plugins/opencode/src/` —— OpenCode 外掛：host 接線、在
  `session.idle` 上執行引擎的驅動程式、設定擴充
- `plugins/opencode/agents/`、`plugins/opencode/commands/` —— 每個階段和
  斜線指令背後的 agent + 指令定義（從 `.opencode/` 符號連結過來，用於本儲存庫
  自我托管）；`.opencode/skills` 符號連結到 `skills/`
- `plugins/claude/` —— Claude Code 外掛：指令、agents、hooks，以及驅動
  迴圈的內建 MCP 伺服器（其 host 墊片位於 `mcp-server/src/shim.ts`）
- `skills/`、`references/` —— 階段 agent 和臨時請求所使用的工作流程庫
  （兩個外掛共用）
- `docs/tasks/` —— `/agentic-workflow:engineering` 各動詞讀取的檔案系統任務待辦
- `install.sh` —— 安裝一個或兩個外掛

## 開發

```bash
npm install && npm run typecheck:all && npm run test:all
```

`typecheck:all` / `test:all` 涵蓋每一個 workspace：核心套件
（`packages/core` —— 引擎、清單、排程器、來源、儲存）、管理面板
（`packages/hub`）、OpenCode 外掛（`plugins/opencode`），以及 Claude
Code MCP 伺服器（`plugins/claude/mcp-server`）。若只想執行 OpenCode 外掛的
測試套件，可限定到它的 workspace —— `npm run typecheck -w agentic-workflow` /
`npm test -w agentic-workflow`（或者在 `plugins/opencode/` 內執行
`npm run typecheck`）；根 package 只定義 `:all` 腳本。

## 授權條款

MIT
