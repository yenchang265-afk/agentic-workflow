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

然後載入外掛：

```bash
claude --plugin-dir /abs/path/to/plugins/claude
```

或者把這個儲存庫加成一個 marketplace 再安裝：

```
/plugin marketplace add /abs/path/to/repo
/plugin install agentic-workflow
```

`install.sh` 會在 `mcp-server/` 中執行 `npm install` + `npm run build`
（`.mcp.json` 會執行建置好的 `mcp-server/dist/server.js`），並為與平台
無關的 skills 和參考檢查清單建立相對符號連結。

從儲存庫根目錄執行時，`./install.sh claude` 最後會進入互動式
**設定精靈**，用它產生 `.agentic-workflow.json`（見
[`../../docs/configuration.md`](../../docs/configuration.md)）。
`cd plugins/claude && ./install.sh` 這個捷徑只會執行 Claude 那一半，
不包含精靈。

要解除安裝，從儲存庫根目錄執行 `./uninstall.sh claude`——它會移除
已建置的 `mcp-server/dist`；要卸載外掛本身則用
`/plugin uninstall agentic-workflow`（或拿掉 `--plugin-dir`）。儲存庫內的
skill／參考檢查清單符號連結是 git 追蹤的，會保留下來。要清除某個
專案的本機迴圈狀態，使用 `./scripts/clean.sh`（預設只清暫存的 `runs/`
狀態；`--backlog` / `--config` / `--purge` 會做得更徹底——見它的
`--help`）。

## Commands

編寫任務 + 把關（`/agentic-workflow:engineering`）：

- `/agentic-workflow:engineering new <idea>` —— 主 agent **一律會訪談你**
  （至少會重述並確認一次），以釐清目標和可測試的驗收標準，然後把一份
  **無計畫的草稿**寫進 `docs/tasks/draft/`。
- `/agentic-workflow:engineering retask <id> [note]` —— 在你核准之前重塑
  一份 `draft/` 任務：主 agent 會重新訪談你（由選填的 note 作為引子），
  並就地重寫同一份草稿——id 不變，沒有計畫。只適用於草稿。
- `/agentic-workflow:engineering approve [id]` —— *唯一*的把關動詞，統一且
  由資料夾驅動（在 agent 的回合開始前，由一個 hook 確定性地處理）。帶上
  明確的 `<id>` 時：一份已審查的 `draft/` → `queued/`（任務把關——依
  設計此時還沒有計畫）、一份暫存的 `plan-review/` 計畫 → `in-progress/`
  （計畫把關，需要 `## Implementation Plan`），或者一份完成的
  `in-review/` 任務 → `completed/`（發布——只有在你審查過分支 diff
  之後）。每一次搬移都會被稽核並提交（commit）；一項任務永遠只處於
  一個資料夾中，因此這個把關點永不含糊。省略 id 時，它會推進目前
  唯一停在迴圈等待把關點上的任務（`plan-review/` 或
  `in-review/`）——草稿一律需要明確的 id。（也以 `workflow_approve` 這個
  MCP 工具的形式對外開放。）
- `/agentic-workflow:engineering replan [id] [reason]` —— 唯一的拒絕動詞：
  把一份暫存的計畫（或以 id 指定、觸發上限的 `in-progress/` 任務）
  送回 `queued/`，原因會被稽核記錄。（也以 `workflow_reject` 這個 MCP
  工具的形式對外開放。）

迴圈本身（`/agentic-workflow:engineering`）：

- `/agentic-workflow:engineering plan <id>` —— 立即為一份已核准的 `queued/`
  任務執行 PLAN 階段：它會寫入計畫、把任務暫存在 `plan-review/`，然後
  迴圈就在那裡結束（驅動的 agent 接著會透過 AskUserQuestion 就地
  提供把關選項）。從 `plan` 無法到達建置——由 `claim` 驅動建置。
- `/agentic-workflow:engineering claim` —— 一次性拉取下一個已可建置的
  `in-progress/` 任務（優先權數字最小的優先；無計畫的 `queued/` 任務
  絕不會被自動規劃——請用 `plan <id>`）——是 OpenCode 上
  `/agentic-workflow:engineering watch` 的拉取式對應物；這個 host 上沒有
  常駐的 watch。
- `/agentic-workflow:engineering status` —— 目前執行中的迴圈，加上一份
  整體待辦彙總（單獨的 `/agentic-workflow:engineering` 效果相同）。
- `/agentic-workflow:engineering kinds` —— 列出各工作流程類型及其啟用狀態。
- `/agentic-workflow:engineering recover <id>` —— 從狀態快照恢復一個
  被中斷的迴圈。
- `/agentic-workflow:engineering doctor [fix]` —— 稽核待辦是否有結構性
  損壞（迷途的資料夾、位於所有狀態資料夾之外的任務檔案、重複的 id、
  被卡住的認領標記）；帶上 `fix` 時會套用沒有歧義的修復。
- `/agentic-workflow:engineering stop`（別名 `abort`）—— 中止目前執行中的
  迴圈（未完成的工作會留在迴圈分支上）。

各個 sitter（**實驗性**——以下四個指令、它們的清單和設定項都可能
還會變動；`engineering` 才是穩定、預設開啟的類型）。**每一個 sitter
具體做什麼都只在
[`../../docs/sitters.md`](../../docs/sitters.md) 中記載一次**——在這個
host 上，每個 sitter 的指令面都相同：`claim`（對應到
`workflow_claim({kind: "<kind>"})`；這裡沒有常駐的 watch，所以 `claim`
就是拉取動作）以及 `status` · `stop`（回報／中止目前執行中的迴圈；
單獨的 `/agentic-workflow:<kind>` = status）：

- `/agentic-workflow:pr-sitter` —— 透過 `workflows.pr-sitter` 選擇啟用。
- `/agentic-workflow:review-sitter` —— 透過 `workflows.review-sitter.enabled` 選擇啟用。
- `/agentic-workflow:dep-sitter` —— 透過 `workflows.dep-sitter.enabled` 選擇啟用。
- `/agentic-workflow:main-sitter` —— 透過 `workflows.main-sitter.enabled` 選擇啟用。

附帶指令：

- `/plan <goal>` —— 臨時、唯讀的規劃，以聊天形式回覆，不會持久化任何東西。

舊的統一指令 `/agent-loop` 已經消失——連同它的自由文字模式，以及
`task <id>`、`ship <id>`、`approve-plan <id>`、`reject` 這些動詞。
整個 engineering 生命週期現在都在 `/agentic-workflow:engineering`
（`new`、`retask`、`approve`、`replan`、`plan`、`claim`）上，而 PR
sitter 在 `/agentic-workflow:pr-sitter` 上。

## What's inside

- `agents/` —— `workflow-plan-author`（寫入已確認的草稿；以任務模式執行
  迴圈的 PLAN 階段）、`workflow-plan`（獨立的唯讀規劃器）、三個建置階段
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
- `hooks/` —— 一個 PreToolUse 守衛，在 VERIFY/REVIEW 期間強制執行
  唯讀 bash 白名單、worktree 固定、階段期限，以及 Azure DevOps 寫入
  攔截；UserPromptSubmit hooks（`gate-command`/`gate-parse`）在 agent
  的回合開始前處理確定性的 `approve` 把關；以及 SessionStart hooks，
  負責調和被中斷的迴圈，並把設定中的 `ado.pat` 匯出到 session 環境
  變數中，供 sitter 的 ADO 階段使用。
- `mcp-server/` —— `agentic-workflow` MCP 伺服器
  （`mcp__agentic-workflow__workflow_*` 工具），重複使用原本的純狀態機，
  並移植了它的 git／待辦／持久化 IO。

## Configuration

儲存庫根目錄下可選的 `.agentic-workflow.json`，疊加在使用者層級的
`~/.config/agentic-workflow/agentic-workflow.json` 之上（遵循 `$XDG_CONFIG_HOME`；
當此檔案不存在時，仍會讀取舊有的 `~/.agentic-workflow.json` 作為後備）
（逐欄位比較時儲存庫層級勝出；所有欄位
都有預設值）——完整的欄位參考見
[`docs/configuration.md`](../../docs/configuration.md)。schema 與
OpenCode 外掛相同，**只是少了** `watchIntervalMinutes`（這裡沒有 watch
模式——見下方）；`workflows.<kind>.trigger` 可以被解析，但在這個
只能拉取的 host 上是無作用的（`workflow_claim` 仍然是手動觸發方式）；
已移除的 `gateBeforeBuild`/`interviewBeforePlan` 這兩個欄位會被靜靜
忽略。

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
- Skill／參考檢查清單的符號連結只在 Unix/WSL 上能正確解析；在不支援
  符號連結的 Windows 上，請改用複製的方式。
