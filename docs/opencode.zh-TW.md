[English](opencode.md) | 繁體中文

# OpenCode 外掛

OpenCode 版本如何執行、它完整的指令面，以及安裝細節。共用的流水線
全貌見 [architecture.md](architecture.md)；Claude Code 版本見
[`plugins/claude/README.md`](../plugins/claude/README.md)。

## 執行模型

共用的 engineering 流水線（把關點、PLAN park、BUILD/VERIFY/REVIEW、
`maxIterations`、ship）只在一個地方記載：
[`docs/loops/engineering.md`](loops/engineering.md#architecture)——
這一節只涵蓋在 OpenCode 上執行它時特有的部分。

工作要麼按需執行（`/agentic-loop:engineering plan <id>` 規劃單一
任務，`/agentic-loop:engineering claim` 拉取下一個項目），要麼在一個
`/agentic-loop:engineering watch [interval]` worker session 中執行
——範圍限定於 engineering 類型——它會在每一次 idle tick 加上一個
輪詢計時器（預設 5 分鐘，例如 `/agentic-loop:engineering watch 30s`）
認領任務——先認領建置就緒的 `in-progress/` 任務，再認領 `queued/`
任務去規劃。

一次提早停止的執行——崩潰，或使用者**中斷（ESC）**於執行中途——可以
用 `/agentic-loop:engineering recover <id>` 恢復：迴圈狀態在每一個
階段之後都會被快照，所以恢復會從它抵達的確切階段接續下去。ESC 是一
個**暫停**——它會在執行中的階段收尾之後停止迴圈，並停止 watch 模式，
但會保留快照（recover 會從那裡接續）；一次刻意的
`/agentic-loop:engineering stop` 則會**終結**這次執行並丟棄快照，
因此沒有東西可以恢復。

這個底層上的把關點都是**只 park**：watch 模式沒有互動通道，所以一個
暫存的計畫或一個執行完畢的迴圈永遠都在等待
`/agentic-loop:engineering approve [id]`（或用
`replan [id] [reason]` 把計畫送回去）——Claude Code 版本提供同樣的
選項，但是就地互動式詢問，見
[`plugins/claude/README.md`](../plugins/claude/README.md)。

以上所有內容（以及可選的強化項：worktree、審查視角、密鑰遮蔽、執行
摘要）都在 `.agentic-loop.json` 中設定，並疊放在一個可選的使用者
層級 `~/.agentic-loop.json` 之上（儲存庫層級優先）——見
[configuration.md](configuration.md)。

## 指令

撰寫 + 把關（`/agentic-loop:engineering`）：

- `/agentic-loop:engineering new <idea>`——訪談你（一律如此——至少
  會重述並確認一次）之後產生一份 `docs/tasks/draft/` 下的**planless
  草稿**
- `/agentic-loop:engineering retask <id> [note]`——在你核准之前重塑
  一份 `draft/` 任務：重新訪談你（以可選的 note 作為引子）並就地
  重寫同一份草稿——id 不變，沒有計畫。僅限草稿（一份暫存的計畫要用
  `replan`）
- `/agentic-loop:engineering approve [id]`——*那個*把關動詞，統一且
  以資料夾驅動。帶上明確的 `<id>` 時，它會依該任務所在資料夾所隱含
  的把關點來推進它：一份已審查的 `draft/` → `queued/`（任務把關，
  迴圈會在認領時規劃它）、一份暫存的 `plan-review/` 計畫 →
  `in-progress/`（計畫把關，需要有 `## Implementation Plan`），或
  一份完成的 `in-review/` 任務 → `completed/`（ship——只有在你審查
  過分支 diff 之後）。每一次移動都會被稽核並提交，且提示訊息
  （toast）會指名發生了哪個動作；一個任務永遠只存在於一個資料夾中，
  所以這個把關點永遠不會有歧義。不帶 id 時，它會推進目前唯一停在
  迴圈等待點（`plan-review/` 或 `in-review/`）上的任務——草稿永遠
  需要明確的 id
- `/agentic-loop:engineering replan [id] [reason]`——唯一的拒絕
  動詞：把一份暫存的計畫（或一個觸發上限、以 id 指定的
  `in-progress/` 任務）連同稽核過的原因一起送回 `queued/`；下一次
  PLAN 必須處理這個原因

迴圈本身（`/agentic-loop:engineering`）：

- `/agentic-loop:engineering plan <id>`——立刻對一個已核准的
  `queued/` 任務執行 PLAN 階段：把計畫寫進任務檔案，將其暫存到
  `plan-review/`，然後結束。從 `plan` 無法抵達建置階段——建置由
  `claim`/`watch` 驅動
- `/agentic-loop:engineering claim`——一次性拉取下一個建置就緒的
  `in-progress/` 任務，優先數字最小者優先；planless 的 `queued/`
  任務永遠不會被自動規劃——用 `plan <id>` 來規劃它們
- `/agentic-loop:engineering watch [trigger]`——把這個 session 變成
  一個常駐 worker，**範圍限定於 engineering 類型**；只認領建置就緒
  的工作，就像 `claim` 一樣。裸 `watch` 使用
  `loops.engineering.trigger`（預設為 poll）；引數是每個 session 的
  覆寫值：`poll [interval]` / 一個裸的間隔值（`30s`、`5m`、`2h`，
  裸數字代表分鐘；預設為 `watchIntervalMinutes`）會在 idle 事件加上
  計時器時認領，`cron <schedule>` 只在排程觸發時認領，`idle` 則在
  每一次 idle 時串連一次新的認領。它會取得這個複本（clone）的
  **watch 租約**（`runs/.watch-lease/`，以固定的 30 秒計時器發送
  心跳）——監看同一個複本的第二個 opencode 行程會被拒絕；一旦一個
  已死亡 watcher 的心跳過期，它的租約就會被接管
- `/agentic-loop:engineering unwatch`——停止這個 session 認領新工作
  （包括計時器）。在執行中途按下 **ESC** 也會做這件事*並且*中斷
  正在執行的迴圈（見 `recover`）；`unwatch` 只清除 watch 旗標，並
  讓一個進行中的迴圈跑完
- `/agentic-loop:engineering doctor [fix]`——稽核待辦中的雜散資料夾
  /檔案、重複的 id，以及卡住的認領標記；`fix` 會套用沒有歧義的修復
  （把雜散項目搶救到 `draft/`、丟棄清空的資料夾、釋放陳舊標記）
- `/agentic-loop:engineering delete <id> [force]`——不可逆：將任務檔案、
  其 worktree，以及 `feature/<id>` 分支一併硬刪除。當這會丟棄工作時會拒絕
  （worktree 有未提交變更，或 commit 在別處都不存在），而且永遠拒絕正在被
  執行中迴圈驅動的任務；epic 會先回報其子切片，只有在 `force` 下才會連帶刪除
- `/agentic-loop:engineering recover <id>`——從狀態快照（或其已持久化
  的計畫）恢復一個提早停止的進行中任務——不論是崩潰/重啟，還是使用者
  **中斷（ESC）**——從它抵達的確切階段接續
- `/agentic-loop:engineering kinds`——列出本儲存庫提供的迴圈類型，
  以及哪些已啟用（`.agentic-loop.json` 中的
  `loops.<kind>.enabled`）；每一個已啟用的類型都有自己的
  `/agentic-loop:<kind>` 指令
- `/agentic-loop:engineering stop`（別名 `abort`）——中止、清除狀態
  並退出 watch 模式；**會丟棄快照**（刻意的終結——不像 ESC 暫停，
  沒有東西可以恢復）
- `/agentic-loop:engineering status`——印出目前的迴圈（階段、疊代
  次數、watch 週期）以及整個待辦的彙總（數量統計、
  待核准/可認領/已中斷/審查中）。裸 `/agentic-loop:engineering` 也
  做同樣的事

各個 sitter（**實驗性**——以下四個 `/agentic-loop:<sitter>` 指令、
它們的清單，以及它們的設定項都可能還會變動；`engineering` 才是
穩定、預設開啟的類型）。每一個都有完全相同的指令面——`claim`
（一次性拉取）、`watch [trigger]` / `unwatch`（常駐 worker，觸發/
間隔語法和每複本一個 watcher 的租約與 engineering 的 `watch` 相同，
範圍限定於該類型），以及 `stop`（別名 `abort`）/ `status`（裸指令
= status）。**每一個各自做什麼只在一個地方記載，見
[`docs/sitters.md`](sitters.md)**——這四個指令是：
`/agentic-loop:pr-sitter`（透過 `loops.pr-sitter` 可選啟用）、
`/agentic-loop:review-sitter`（`loops.review-sitter`）、
`/agentic-loop:dep-sitter`（`loops.dep-sitter`），以及
`/agentic-loop:main-sitter`（`loops.main-sitter`）。

舊的總管式 `/agent-loop` 指令已經消失——連同它的自由文字模式和它的
`task <id>`、`run`、`ship`、`approve-plan`、`reject`，以及
`go`/`ok` 動詞一起。整個 engineering 生命週期現在都在
`/agentic-loop:engineering` 上（`new`、`retask`、`approve`、
`replan`、`plan`、`claim`、`watch`），PR sitter 則在
`/agentic-loop:pr-sitter` 上。

在迴圈之外，臨時請求以 ad hoc 方式處理：intent 到 skill 的對應見
[AGENTS.md](../AGENTS.md)——外掛內建了一個 `skills/` 庫
（spec-driven-development、test-driven-development、
code-review-and-quality，以及另外 20 多個），迴圈的階段 agent 和
臨時請求都會透過 `skill` 工具依名稱呼叫它們。

## 安裝

```bash
git clone <this-repo>
cd agentic-loop
npm install
./install.sh opencode
```

`./install.sh opencode` 會把 agents、commands、skills 和 references
符號連結進 `~/.config/opencode/`（或 `$OPENCODE_CONFIG_DIR`），並
把外掛註冊為本機外掛檔案，這樣 `/agentic-loop:*` 指令和內建的
skills 就能在每一個 OpenCode session 中運作。它是冪等的——`git
pull` 之後重新執行即可更新。用 `--copy` 取代符號連結，或傳入一個
目錄以安裝到預設 OpenCode 設定目錄以外的地方。裸的 `./install.sh`
會同時安裝 Claude Code 外掛。

在互動式終端機上，安裝流程的最後會有一個簡短的**設定精靈**來產生
`.agentic-loop.json`——它會先詢問是要寫入儲存庫層級（迴圈驅動的
專案）還是使用者層級（跨所有儲存庫共用）；`--user` / `--repo` 可以
強制指定。見 [configuration.md](configuration.md)。

在 Windows 上，符號連結需要 WSL 或支援符號連結的 Windows（開發者
模式）；如果沒有這個條件，就用 `--copy`（不會即時更新——`git pull`
之後要重新執行）。

## 解除安裝與清理

`./uninstall.sh opencode [dir]` 會反轉安裝過程——它會移除從
`$OPENCODE_CONFIG_DIR` 指回本儲存庫的 agents/commands/skills/
references 項目和本機外掛檔案（加上 `--copy` 也會移除 `--copy`
安裝方式留下的複本）。外部項目和你的 OpenCode 設定檔則不受影響。

`./scripts/clean.sh` 會清除驅動該專案的迴圈的本機狀態
（`$AGENTIC_LOOP_DIR` 或 `$PWD`）：預設只清空暫存的
`<tasksDir>/runs/` 機器狀態（快照、指標、階段標記、watch 租約、
認領標記、各類型的帳本），這些會在下一次執行時重新產生。
`--backlog` 還會刪除狀態資料夾中的任務檔案，`--config` 還會刪除
`.agentic-loop.json`，`--purge` 三者全做；破壞性等級會先詢問確認
（`-y` 略過，`--dry-run` 只預覽）。
