[English](README.md) | 繁體中文

# agentic-workflow —— Claude Code 外掛

以受監督、由主 agent 驅動的迴圈方式，讓待辦任務經歷 **PLAN / BUILD →
VERIFY → REVIEW**，並具備 git 隔離、可信裁定通道、檔案系統任務待辦，以及
稽核軌跡。任務的編寫與把關都在 `/agentic-workflow:engineering` 中進行：一場
強制性的訪談（`new <idea>`）把你的想法轉成一份草稿，`approve <id>`
將其排入佇列；迴圈會在**執行前的最後一刻**才為其規劃（這樣計畫就不會在
任務暫存等待期間過期），並把計畫暫存在 `plan-review/` 等待計畫把關——
由同一個 `approve` 動詞釋出——而且從不會卡住等你。

這是 OpenCode `agentic-workflow` 外掛的 Claude Code 移植版。因為 Claude Code
沒有自主的背景驅動原語，這個迴圈是**由主 agent 驅動**的：
`/agentic-workflow:engineering plan <id>` / `claim` 會讓主 agent 把每個階段
以子 agent 的形式產生出來（透過 Task 工具），而內建的 **MCP 伺服器**則
負責狀態機、git 隔離、裁定、待辦搬移、快照和指標。確切的協定見
`skills/workflow-orchestration/SKILL.md`。

## Install

```bash
# from the repo root
./install.sh claude     # builds the MCP server + links the shared skills/references
# equivalent: cd plugins/claude && ./install.sh
```

在原生 Windows（沒有 WSL/git-bash）上，改用 PowerShell 版本：

```powershell
# from the repo root
.\install.ps1 claude     # builds the MCP server + links the shared skills/references
# equivalent: plugins\claude\install.ps1
```

然後載入外掛：

```bash
claude --plugin-dir /abs/path/to/plugins/claude
```

或者把這個儲存庫加成一個 marketplace 再安裝：

```
/plugin marketplace add /abs/path/to/repo
/plugin install agentic-workflow
```

`install.sh` 會執行 `pnpm install` + `pnpm --filter agentic-workflow-mcp run build`
（`.mcp.json` 會執行建置好的 `mcp-server/dist/server.js`），並為與平台
無關的 skills 和參考檢查清單建立相對符號連結。

從儲存庫根目錄執行時，`./install.sh claude` 最後會進入互動式
**設定精靈**，用它產生 `.agentic-workflow.json`（見
[`../../docs/configuration.md`](../../docs/configuration.md)）。
`cd plugins/claude && ./install.sh` 這個捷徑只會執行 Claude 那一半，
不包含精靈。

要解除安裝，從儲存庫根目錄執行 `./uninstall.sh claude`（Windows 上是
`.\uninstall.ps1 claude`）——它會移除
已建置的 `mcp-server/dist`；要卸載外掛本身則用
`/plugin uninstall agentic-workflow`（或拿掉 `--plugin-dir`）。儲存庫內的
skill／參考檢查清單符號連結是 git 追蹤的，會保留下來。要清除某個
專案的本機迴圈狀態，使用 `./scripts/clean.sh`（預設只清暫存的 `runs/`
狀態；`--backlog` / `--config` / `--purge` 會做得更徹底——見它的
`--help`；沒有 Windows 版本——請在 WSL 或 git-bash 下執行）。

## Commands

編寫任務 + 把關（`/agentic-workflow:engineering`）：

- `/agentic-workflow:engineering new <idea>` —— 主 agent **一律會訪談你**
  （至少會重述並確認一次），以釐清目標和可測試的驗收標準，然後把一份
  **無計畫的草稿**寫進 `docs/tasks/draft/`。
- `/agentic-workflow:engineering retask <id> [note]` —— 在任務被建置之前，重塑
  一份目標寫錯的任務：主 agent 會重新訪談你（由選填的 note 作為引子），
  並就地重寫同一份草稿——id 不變，沒有計畫。適用於 `draft/` 任務，也適用於
  `queued/` 任務（核准會被撤銷、檔案先移回 `draft/`；先前 `replan` 留下的
  舊計畫會一併移除——它是針對你正要改寫的舊目標寫的）。一旦計畫進入
  `plan-review/` 之後，就改用 `replan`。
- `/agentic-workflow:engineering approve [id]` —— *唯一*的把關動詞，統一且
  由資料夾驅動（在 agent 的回合開始前，由一個 hook 確定性地處理）。帶上
  明確的 `<id>` 時：一份已審查的 `draft/` → `queued/`（任務把關——依
  設計此時還沒有計畫）、一份暫存的 `plan-review/` 計畫 → `in-progress/`
  （計畫把關，需要 `## Implementation Plan`），或者一份完成的
  `in-review/` 任務 → `completed/`（發布——只有在你審查過分支 diff
  之後，且只依 `shipPublish` 決定的內容對外發布——`approve <id> --pr`／
  `--push`／`--local` 可逐次覆寫；PR 會指向這次執行切出來的那個分支，
  `prBase` 與 `approve <id> --base=<分支>` 可以覆寫）。每一次搬移都會被稽核並提交（commit）；一項任務永遠只處於
  一個資料夾中，因此這個把關點永不含糊。省略 id 時，它會推進目前
  唯一停在迴圈等待把關點上的任務（`plan-review/` 或
  `in-review/`）——草稿一律需要明確的 id。（也以 `workflow_approve` 這個
  MCP 工具的形式對外開放。）
- `/agentic-workflow:engineering replan [id] [reason]` —— 唯一的拒絕動詞：
  把一份暫存的計畫（或以 id 指定、觸發上限的 `in-progress/` 任務）
  送回 `queued/`，原因會被稽核記錄。（也以 `workflow_reject` 這個 MCP
  工具的形式對外開放。）
- `/agentic-workflow:engineering abandon <id> [reason]` —— 取消一項任務：移到
  `abandoned/`，也就是「不會再做」的終結資料夾，原因會被稽核記錄。可從
  任何非終結資料夾執行（已出貨的 `completed/` 任務會被拒絕）。檔案會
  保留，因此這個動作是可逆的——這是取消任務該用的動詞，也是每個子任務
  都出貨後、收尾一個追蹤用 epic 的方式。（也以 `workflow_abandon` 對外
  開放。）
- `/agentic-workflow:engineering remove <id> --force` —— 硬刪除一項任務：和其他
  動詞不同，檔案會被刪除而不是移動。單獨的 `remove <id>` 不會刪除任何
  東西，只會回報該 id 解析到哪一份任務；`--force` 才是確認——這很重要，
  因為 id 支援前綴解析，打錯字的短代號可能會指到另一份真實存在的任務。
  只有在待辦有被 git 追蹤時，檔案才會留在 git 歷史裡，而 `ignoreBacklog`
  預設為 `true`，所以強制刪除通常是永久的——優先使用 `abandon`。（也以
  `workflow_remove` 對外開放，接受相同的 `force` 參數。）

迴圈本身（`/agentic-workflow:engineering`）：

- `/agentic-workflow:engineering plan <id>` —— 立即為一份已核准的 `queued/`
  任務執行 PLAN 階段：它會寫入計畫、把任務暫存在 `plan-review/`，然後
  迴圈就在那裡結束（驅動的 agent 接著會透過 AskUserQuestion 就地
  提供把關選項）。從 `plan` 無法到達建置——`claim <id>` 會立即建置
  該任務；省略 id 的 `claim` 則依優先順序驅動建置。
- `/agentic-workflow:engineering claim [id]` —— 一次性拉取。省略 id 時，
  它會認領下一項工作（優先權數字最小的優先）：已可建置的 `in-progress/`
  任務優先，沒有建置工作時才輪到一份已核准的 `queued/` 任務去規劃。
  帶上任務 id 時，會透過 `workflow_start({id})` 立即執行該任務——已可
  建置就跑 BUILD，否則跑它的 PLAN 階段——是 OpenCode 上
  `/agentic-workflow:engineering watch` 的拉取式對應物；這個 host 上沒有
  常駐的 watch。
- `/agentic-workflow:engineering status` —— 目前執行中的迴圈，加上一份
  整體待辦彙總（單獨的 `/agentic-workflow:engineering` 效果相同）。
- `/agentic-workflow:engineering kinds` —— 列出各工作流程類型及其啟用狀態。
- `/agentic-workflow:engineering recover <id>` —— 從狀態快照恢復一個
  被中斷的迴圈。
- `/agentic-workflow:engineering doctor [fix|config]` —— 稽核待辦是否有結構性
  損壞（迷途的資料夾、位於所有狀態資料夾之外的任務檔案、重複的 id、
  被卡住的認領標記）；帶上 `fix` 時會套用沒有歧義的修復。帶上 `config`
  時改為回報實際生效的設定——各層檔案路徑、執行期忽略的 repo 層鍵、
  以及遮蔽機密後的生效設定。
- `/agentic-workflow:engineering init` —— 搭建這個 repo：建立 backlog 的
  狀態資料夾、在不存在時寫入只含安全鍵的 `.agentic-workflow.json`
  （絕不覆寫）、並在 `ignoreBacklog` 開啟時把 backlog 排除出 git；可重複
  執行。`approve --all` 對每一份已審閱的草稿批次過任務閘門（epic 除外）；
  計畫／出貨閘門仍然一次一個。
- `/agentic-workflow:engineering stop`（別名 `abort`）—— 中止目前執行中的
  迴圈（未完成的工作會留在迴圈分支上）。

各個 sitter（**四個全都是實驗性的**——它們的清單和設定項都可能還會變動，
因此每一個都要可選啟用；`engineering` 是唯一預設開啟的類型）。**每一個 sitter 具體做什麼都只在
[`../../docs/sitters.md`](../../docs/sitters.md) 中記載一次**——在這個
host 上，每個 sitter 的指令面都相同：`claim [<pr>]`（對應到
`workflow_claim({kind: "<kind>"})`；這裡沒有常駐的 watch，所以 `claim`
就是拉取動作——PR sitter 還可傳入選填的 PR 編號／網址以強制處理特定的
PR）以及 `status` · `stop`（回報／中止目前執行中的迴圈；
單獨的 `/agentic-workflow:<kind>` = status）：

- `/agentic-workflow:pr-sitter` —— 透過 `workflows.pr-sitter.enabled` 選擇啟用。
- `/agentic-workflow:review-sitter` —— 透過 `workflows.review-sitter.enabled` 選擇啟用。
- `/agentic-workflow:dep-sitter` —— 透過 `workflows.dep-sitter.enabled` 選擇啟用。
- `/agentic-workflow:main-sitter` —— 透過 `workflows.main-sitter.enabled` 選擇啟用。

每個 sitter 都要先寫上 `"enabled": true` 才會被觸及。裸的
`workflow_claim()` 會依認領優先順序輪詢每一種已啟用的類型，所以當排在前面
的都沒有可認領的工作時就會觸及已啟用的 sitter；`workflow_claim({kind})` 則把拉取範圍限定在一種類型，而
`workflow_claim({kind: "pr-sitter", target: 42})` 會強制處理特定的 PR——
即使沒有任何待處理訊號，也會直接取回並驅動它（fork PR 仍會被拒絕）。

附帶指令：

- `/plan <goal>` —— 臨時、唯讀的規劃，以聊天形式回覆，不會持久化任何東西。

舊的統一指令 `/agent-loop` 已經消失——連同它的自由文字模式，以及
`task <id>`、`ship <id>`、`approve-plan <id>`、`reject` 這些動詞。
整個 engineering 生命週期現在都在 `/agentic-workflow:engineering`
（`new`、`retask`、`approve`、`replan`、`plan`、`claim`）上，而 PR
sitter 在 `/agentic-workflow:pr-sitter` 上。

## What's inside

- `agents/` —— `workflow-task-author`（寫入已確認的草稿）、
  `workflow-plan-author`（迴圈的 PLAN 階段——把實作計畫寫到已排入佇列的
  任務上）、`workflow-plan`（獨立的唯讀規劃器）、三個建置階段
  子 agent `workflow-build` / `workflow-verify` / `workflow-review`、pr-sitter 的
  階段子 agent `workflow-pr-triage` / `workflow-pr-fix` / `workflow-pr-publish`，
  以及各個選擇啟用類型的 sitter 階段子 agent：review-sitter 的
  `workflow-review-fetch` / `workflow-review-assess` / `workflow-review-publish`、
  dep-sitter 的 `workflow-dep-scan` / `workflow-dep-upgrade` / `workflow-dep-publish`，
  以及 main-sitter 的
  `workflow-main-diagnose` / `workflow-main-remedy` / `workflow-main-publish`
  （共用的 `workflow-verify` 在其中好幾個類型中都被重複用作 VERIFY 階段）。
- `skills/` —— `workflow-orchestration`（Claude 專屬的驅動協定），加上
  共用的工作流程 skill 庫（符號連結過來，包括
  `task-backlog-management`）。
- `commands/` —— 斜線指令。`engineering.md` 是一份**路由表**：它帶著前言、
  一行一個動詞的索引，以及那些長期有效的禁令，但不含任何動詞的實際流程。
- `verbs/engineering.md` —— 那些流程，每個動詞一個 `<!-- aw:verb … -->` 區塊。
  只有你所呼叫的那個動詞的區塊會被注入這一回合，其餘的永遠不會送到模型面前。
  UserPromptSubmit hook 無法改寫 prompt，所以拆檔是唯一能讓
  `new <idea>` 不必為它根本不會執行的 `claim`、`doctor` 和各個把關動詞
  付出 context 代價的辦法。
- `hooks/` —— 一個 PreToolUse 守衛，在 VERIFY/REVIEW 期間強制執行
  唯讀 bash 白名單、worktree 固定、階段期限，以及 Azure DevOps 寫入
  攔截；一個 PreToolUse 拒絕器（`check-stage-ask`），在迴圈階段執行中
  拒絕提問工具——計畫關卡與出貨關卡之間的驅動是無人看管的；
  UserPromptSubmit hooks（`gate-command`/`gate-parse`）在 agent
  的回合開始前處理確定性的 `approve` 把關，並注入所呼叫動詞的指示
  （`verb-slice`）；以及一個 SessionStart hook（`reconcile`），負責調和被
  中斷的迴圈。Azure DevOps 只透過 Azure DevOps MCP 伺服器存取——PAT 會
  直接進入該伺服器自己的啟動環境，絕不會進入 agent 的 session 環境。
- `mcp-server/` —— `agentic-workflow` MCP 伺服器
  （`mcp__agentic-workflow__workflow_*` 工具），重複使用原本的純狀態機，
  並移植了它的 git／待辦／持久化 IO。

## Configuration

儲存庫根目錄下可選的 `.agentic-workflow.json`，疊加在使用者層級的
`~/.config/agentic-workflow/agentic-workflow.json` 之上（遵循 `$XDG_CONFIG_HOME`；
當此檔案不存在時，仍會讀取舊有的 `~/.agentic-workflow.json` 作為後備）
（逐欄位比較時儲存庫層級勝出；所有欄位
都有預設值）——完整的欄位參考見
[`docs/configuration.md`](../../docs/configuration.md)。schema 現在與
OpenCode 外掛**完全相同**——該 host 最後一個自有欄位
`watchIntervalMinutes` 已經退役，它現在只多加一項只有它能處理的 cron
語法檢查；`workflows.<kind>.trigger` 可以被解析，但在這個
只能拉取的 host 上是無作用的（`workflow_claim` 仍然是手動觸發方式）；
已移除的 `gateBeforeBuild`/`interviewBeforePlan` 這兩個欄位會被靜靜
忽略。`workflows.<kind>.stageModels` 與 `agentModels` 都會在這裡繫結，
而且都不依賴協調用的模型自己配合：一個 `PreToolUse` hook
（`hooks/stamp-spawn-model.mjs`）會在工具真正執行前，改寫產生 spawn
呼叫裡的 `model`。階段模型搭著 MCP 伺服器已經在寫的階段標記走，並以
agent 為鍵，所以一個重新觸發的階段仍會保持繫結；`agentModels` 則涵蓋
背後沒有階段的 spawn（`new`／`retask` 裡的起草、以及臨時性的
`/agentic-workflow:plan`），並直接從設定各層讀取。

有一個 host 限制值得知道：**Claude Code 的 spawn 工具只接受
`sonnet`、`opus`、`haiku`、`fable` 這幾個模型別名。** 設定成這幾個家族
裡的一個 id 會自動幫你對應（例如 `anthropic/claude-sonnet-4-5` →
`sonnet`）；其他任何值都會保持未繫結並附上警告，因為這個工具遇到不
認得的 `model` 時，是讓整個 spawn 直接失敗，而不是退回預設值。

## Known limitations

- **沒有常駐的 `watch`（兩個指令都沒有）** —— watch 需要一個能在 idle
  事件和計時器上觸發階段的自主驅動程式；在這個移植版中，主 agent
  就是驅動程式，而 MCP 伺服器無法產生子 agent。
  `/agentic-workflow:engineering claim` / `/agentic-workflow:pr-sitter claim`
  是拉取式的對應物：由一次人為觸發來認領並驅動下一個項目。在同一個
  回合內，BUILD → VERIFY → REVIEW 仍然會在沒有人為輸入的情況下繼續推進。
- **訪談在主 agent 中進行** —— Task 子 agent 無法和你對話，因此
  `/agentic-workflow:engineering new` 的強制訪談是在撰寫子 agent 寫入檔案
  之前，於主對話中進行的。
- Skill／參考檢查清單的符號連結在 Unix/WSL 上能正確解析，在原生 Windows 上
  當 `install.ps1`／`plugins/claude/install.ps1` 能建立符號連結時（系統
  管理員權限，或 Windows 10/11 的開發人員模式）也能解析；兩者皆無時，
  安裝程式會自動改用複製（`git pull` 之後要重新執行以更新）。
