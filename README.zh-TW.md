[English](README.md) | 繁體中文

# agentic-workflow

以受監督的狀態機方式執行長期目標，而不是聊天式的來回問答。本儲存庫是一個
**多種類工作流程框架**：每種工作流程類型都是
[`packages/core/workflows/<kind>/`](packages/core/workflows/README.md) 下的一份宣告式清單
（manifest）——階段（stage）、狀態轉換（transition）和工作來源（work source）——由共用引擎解讀執行，並由統一的排程器驅動。以三個並行外掛的形式發布——
**OpenCode**、**Claude Code**（[`plugins/claude/`](plugins/claude/README.md)）
和 **Qwen Code**（[`plugins/qwen/`](plugins/qwen/README.md)，重複使用 Claude
的 MCP 伺服器）——三者都建立在同一個核心套件（[`packages/core`](packages/core)）之上，共用人工把關點（human gate）、git 隔離、可信裁定（trusted verdict）和稽核軌跡。

目前已發布五種工作流程類型。**engineering**（預設開啟）在 `docs/tasks/` 任務待辦
（backlog）上驅動一個目標經歷 PLAN → BUILD → VERIFY → REVIEW，包含人工任務把關和
計畫把關。四個 **sitter** 監看一個代管的目標面（開啟中的 PR、
審查請求、有漏洞的相依套件、變紅的 CI）並驅動修復，同時把每一個終端呼叫都
留給人類。**四個 sitter 全都是實驗性的**，一律可選啟用；它們可以對接的
`ado`（Azure DevOps）平台同樣是實驗性的。詳見下方 [sitters](#sitters)。

編寫一種新的工作流程類型只需要一個 `workflow.json` 加上階段提示詞——詳見
[`packages/core/workflows/README.md`](packages/core/workflows/README.md)。

## 工程（engineering）工作流程

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
`queued/` 重新規劃。規劃發生在**執行之前**——`claim`/`watch` 先取可建置的工作，
沒有時才退而認領一個已核准的 `queued/` 任務來規劃，而 `plan <id>` 讓你不必等
巡查就為某一個任務執行 PLAN，這樣計畫就不會在任務暫停等待期間過期：

| 階段 | 作用 | 是否暫停？ |
|-------|------|---------|
| PLAN | 將 `## Implementation Plan` 寫入被認領的已排入佇列任務，然後**將其暫存到 `plan-review/` 並結束** | 暫停 —— `approve` / `replan` 才是把關點，迴圈本身從不阻塞 |
| BUILD | 在自己的 `feature/<id>` 分支上以測試先行的方式實作已核准的計畫 | 否 |
| VERIFY | 執行測試；失敗則帶著失敗資訊重新建置。檢查指令改由迴圈自己執行 —— 來自已核准計畫的 `agentic-checks` 區塊，或在 `workflows.<kind>.stageChecks` 手動釘選 —— 其結束碼會約束裁決，而不是由代理人自行回報 | 否 |
| REVIEW | 檢查分支 diff；失敗則帶著回饋重新建置 | 否 |

重新建置時會先收到結構化的失敗資訊——裁定理由、未通過的驗收條件、帶
`file:line` 的發現——再加上一份有界的紀錄，說明先前幾次疊代已經試過什麼；
`workflows.<kind>.stageContext` 可以限制階段提示還能帶上多少內容，當你把某個
階段指向小模型時這一點很重要（見
[docs/configuration.md](docs/configuration.md)）。

執行是在 `feature/<id>` git 分支上隔離進行的，且預設會在自己的 git worktree
（`.workflow-worktrees`）中簽出，因此你的工作樹永遠不會被動到——可設定
`worktreesDir: false` 退出，或設 `taskBranch: false` 直接在你目前已檢出的
分支上建置。裁定（verdict）只透過外掛工具
取信，每一次狀態轉換都會被稽核，迴圈本身從不推送或開啟 PR——由你審查 diff
並執行 `/agentic-workflow:engineering approve`，它會依 `shipPublish` 發布
（預設 `"pr"`：推送分支並開啟或重複使用一個 **draft** PR——GitHub 或 Azure
DevOps，視 `codePlatform` 而定；`"push"` 只推送、不開 PR；`"local"` 則完全
不對外發布）。可用 `approve <id> --pr`（或 `--push` / `--local`）逐次覆寫。
PR 會指向這次執行切出來的那個分支——在 `release/2.4` 上工作，PR 就開在那裡
——可用 `prBase` 或 `approve <id> --base=<分支>` 覆寫。
完整的執行模型（watch 模式、疊代上限、還原）：
[docs/opencode.md](docs/opencode.md)。

## sitters

四個 sitter 會監看一個代管的目標面並驅動修復，每一個都有自己的
`/agentic-workflow:<kind>` 指令，共用 `claim` / `status` / `stop` 動詞（在
OpenCode 上還有 `watch [trigger]` / `unwatch`）。**四個 sitter 全都是
實驗性的**——它們的清單、設定項和預設值在各版本之間都可能還會變動，因此
每一個都要靠 `"enabled": true` 才會啟用。`engineering` 是唯一不需要你開口
就會執行的類型。

```json
{
  "workflows": {
    "pr-sitter":   { "enabled": true, "query": "is:open author:@me" },
    "dep-sitter":  { "enabled": true, "severityFloor": "high" },
    "main-sitter": { "enabled": true, "branch": "main" }
  }
}
```

每個 sitter 都把它讀取的 PR/留言/diff/CI 文字視為不可信輸入，處於按階段劃分
的 bash + 平台白名單之後，並且把終端呼叫——合併、核准、關閉——留給人類。
每一個 sitter 具體做什麼、它的流水線、它的設定項：
[docs/sitters.md](docs/sitters.md)；安全態勢：
[docs/design/threat-model.md](docs/design/threat-model.md)。

## 安裝

以下步驟假設系統先決條件已就緒（Node ≥ 22.13、git、`gh`、`curl`，如需瀏覽器
相關作業還需要 Chrome）。Azure DevOps 需要附帶 `npx` 的 Node（用來啟動 Azure
DevOps MCP 伺服器），外加 `AZURE_DEVOPS_EXT_PAT` 中的一個 PAT。對於全新的機器，`./bootstrap.sh` 會為你驗證/安裝這些相依項，
註冊 `chrome-devtools` MCP 伺服器，然後為你執行 `./install.sh`：

```bash
./bootstrap.sh                 # 全部；或 --no-ado / --no-browser / --check-only
```

手動路徑（相依項已安裝）：

```bash
git clone <this-repo>
cd agentic-workflow
npm install             # npm workspaces —— 同時建置 @agentic-workflow/core（prepare）
./install.sh            # 全部外掛都裝；或者：./install.sh opencode | claude | qwen
```

在原生 Windows（沒有 WSL／git-bash）上，改用 PowerShell 版本——目標與參數相同：

```powershell
git clone <this-repo>
cd agentic-workflow
npm install
.\install.ps1            # 全部外掛都裝；或者：.\install.ps1 opencode | claude | qwen
```

`install.ps1` 會盡可能建立真正的符號連結（需要系統管理員權限，或 Windows
10/11 的開發人員模式——設定 > 更新與安全性 > 開發人員專用），否則會自動改用
複製（傳入 `-Copy` 可主動選擇這個模式並略過警告；複製模式下 `git pull` 後需
重新執行才能更新）。

- 在儲存庫根目錄執行 `npm install` 會安裝所有 workspace（OpenCode 外掛、
  `packages/core`、`packages/ado-mcp`、`packages/hub`、`plugins/claude/mcp-server`），
  並透過 `prepare` 腳本建置核心套件——每個外掛都消費核心套件建置出的 `dist/`。
- `./install.sh opencode`（`.\install.ps1 opencode`）會把 agents/commands/skills/references 符號連結進
  `~/.config/opencode/`（或 `$OPENCODE_CONFIG_DIR`）並註冊外掛——細節和參數
  （`--copy`、自訂目錄）見 [docs/opencode.md](docs/opencode.md)。
- `./install.sh claude` 會建置內建的 MCP 伺服器並連結共用的
  skills/references，然後印出載入方式（`claude --plugin-dir` 或市集安裝）——
  細節見 [`plugins/claude/README.md`](plugins/claude/README.md)。
- `./install.sh qwen` 會建置同一個 MCP 伺服器，把 agents/commands/skills/
  references 安裝進 `~/.qwen/`（或 `$QWEN_CONFIG_DIR`），並把 hooks 與 MCP
  項目併入 `settings.json`——細節見 [docs/qwen.md](docs/qwen.zh-TW.md)。
  **實驗性**：此宿主的介面與行為仍可能變動。
- 安裝完成後，互動式終端機會得到一個簡短的**設定精靈**來產生
  `.agentic-workflow.json`——見 [docs/configuration.md](docs/configuration.md)。

冪等——`git pull` 之後重新執行即可更新。

## 解除安裝與清理

兩個腳本分別復原兩種痕跡——已安裝的外掛，以及執行中的迴圈留下的本機狀態：

```bash
./uninstall.sh                 # 復原 install.sh；或 opencode | claude | qwen | all
./scripts/clean.sh             # 只移除 <tasksDir>/runs/ 中的暫存狀態
./scripts/clean.sh --purge     # 同時刪除待辦任務檔案 + .agentic-workflow.json
```

在 Windows 上：`.\uninstall.ps1`（目標／參數與 `install.ps1` 相同）會復原
`install.ps1`；`scripts/clean.sh` 沒有 Windows 版本——請在 WSL 或 git-bash
下執行，或手動刪除 `<tasksDir>/runs/`（`--purge` 的話還包括各狀態資料夾中的
任務檔案與 `.agentic-workflow.json`）。

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
- `/agentic-workflow:engineering abandon <id> [reason]` —— 取消一項任務：移到 `abandoned/`，
  也就是「不會再做」的終結資料夾。檔案會保留，因此可以再移回來；一份追蹤用的
  epic 草稿在所有子任務都出貨後，也是用這個動詞收尾
- `/agentic-workflow:engineering remove <id> --force` —— 硬刪除一項任務：檔案會被刪除，
  而不是移動。單獨的 `remove <id>` 不會刪除任何東西，只會回報該 id 解析到哪一份
  任務 —— `--force` 才是確認。只有在你設定 `ignoreBacklog: false` 時才能從 git
  還原；預設會把 `docs/tasks/` 完全排除在 git 之外，所以除非你真的要讓檔案消失，
  否則請優先使用 `abandon`
- `/agentic-workflow:engineering plan <id>` · `claim [id]` · `watch [trigger]`（OpenCode）·
  `unwatch` · `recover <id>` · `stop` · `status` · `doctor [fix]` · `kinds` ——
  `plan` 為一個已排入佇列的任務執行 PLAN 並將其暫存，不必等巡查；
  `claim` 拉取下一個項目——先取可建置的 `in-progress/` 工作，沒有時再取一個
  已核准的 `queued/` 任務來規劃——或給定任務 id 時，立刻執行那一個任務
  （建置就緒則進 BUILD，否則執行它的 PLAN 巡查）；`watch` 是一個僅作用於 engineering 類型的常駐
  worker，排程依 `workflows.<kind>.trigger` 決定，除非以參數覆寫
  （`poll [interval]`、像 `5m` 這樣的純間隔、`cron <schedule>` 或 `idle`）
- `/agentic-workflow:pr-sitter claim [<pr>]` · `watch [trigger]`（OpenCode）· `unwatch` ·
  `stop` · `status` —— 相同的 claim/watch 語意，作用範圍限定在 PR sitter
  （`claim` 可傳入選填的 PR 編號／網址以強制處理特定的 PR）
- `/agentic-workflow:review-sitter` · `/agentic-workflow:dep-sitter` ·
  `/agentic-workflow:main-sitter` —— 同樣的 `claim` / `watch`（OpenCode）/
  `unwatch` / `stop` / `status` 動詞，各自作用於自己的類型（透過
  `workflows.<kind>.enabled` 按需啟用）

完整指令參考：[docs/opencode.md](docs/opencode.md)（OpenCode）·
[`plugins/claude/README.md`](plugins/claude/README.md)（Claude Code —— 沒有
常駐的 `watch`；`claim` 就是拉取動作）。迴圈之外的臨時請求會透過
[AGENTS.md](AGENTS.md) 對應到內建的 skills 庫。

## 文件

- [docs/manual.html](docs/manual.html) —— **單頁使用手冊**：從安裝、設定精靈、
  迴圈、把關到參考表格的導讀。請用瀏覽器開啟；新手請從這裡開始
- [docs/README.md](docs/README.md) —— `docs/` 下每份文件的索引，以及針對
  某個主題哪份文件是權威版本
- [docs/workflows/](docs/workflows/README.md) —— 每種類型一份檔案（engineering、
  pr-sitter、review-sitter、dep-sitter、main-sitter）：其架構（階段流水線、
  mermaid 圖、設定項）、如何啟用、指令面，以及 1-2 個實戰範例
- [docs/architecture.md](docs/architecture.md) —— 僅框架本身（核心套件、
  清單引擎、排程器、工作來源、watch 租約）以及 Claude Code 版本有何不同
- [docs/sitters.md](docs/sitters.md) —— 四個 sitter 的共同點，
  並索引到 `docs/workflows/` 下它們各自的檔案
- [packages/core/workflows/README.md](packages/core/workflows/README.md) —— 如何編寫一種新的工作流程類型
  （清單結構描述、提示詞範本、hooks、工作來源）
- [docs/opencode.md](docs/opencode.md) —— OpenCode 執行模型、指令、安裝細節
- [`plugins/claude/README.md`](plugins/claude/README.md) —— Claude Code 安裝、
  指令、已知限制
- [docs/configuration.md](docs/configuration.md) —— `.agentic-workflow.json`
  參考（使用者層級 + 儲存庫層級分層）、各類型的 `workflows` 區塊，以及隔離與強化項
  （worktree——預設開啟、每軸審查 fan-out、審查視角、去識別化）
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
  萬用字元，或者在使用者層級 `~/.config/agentic-workflow/agentic-workflow.json` 中設定 `hub.repos` —— 不設定
  儲存庫就不會監看）

每個主題只在一份檔案中是權威的——完整的「哪份文件擁有哪個主題」索引見
[docs/README.md](docs/README.md)。更新權威檔案並連結到它，不要複製內容。

## 目錄結構

- `packages/core/` —— `@agentic-workflow/core`：純粹的工作流程引擎、清單層、
  工作來源 + 排程器、任務儲存、git 隔離、快照、裁定、指標、設定 ——
  所有三個外掛共用的一切
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
  （三個外掛共用）
- `docs/tasks/` —— `/agentic-workflow:engineering` 各動詞讀取的檔案系統任務待辦
- `install.sh` —— 安裝三個外掛中的任何一個（或全部）

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
