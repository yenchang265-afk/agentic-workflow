[English](migration.md) | 繁體中文

# 跨版面遷移

## 遷移到分層設定（使用者層級 + 儲存庫層級）

- 設定現在從**兩個層**解析而來：一個可選的使用者層級
  `~/.agentic-loop.json`（適用所有儲存庫），疊放在儲存庫的
  `.agentic-loop.json` 之下，儲存庫層級逐欄位優先——見
  [configuration.md](configuration.md#layers--precedence)。不需要
  遷移任何東西：一個只有儲存庫層級的設定行為和之前完全一樣。
- **注意**：一份因為先前實驗而遺留下來的雜散
  `~/.agentic-loop.json` 現在會被讀取並疊加進來。刪除它，或者設定
  `AGENTIC_LOOP_USER_CONFIG=""` 來停用這一層。
- 給多儲存庫 ADO 使用者的建議分工：把 `ado.organization`、
  `ado.selfLogin` 和 `ado.pat` 移到使用者層級檔案；把
  `codePlatform`、`ado.project`/`repository` 和 `loops` 留在各個
  儲存庫裡。

## 遷移到各類型專屬指令（`/agentic-loop:engineering`、`/agentic-loop:pr-sitter`）

- **總管式的 `/agent-loop` 指令已經消失**——每一種迴圈類型現在都有
  自己、以外掛命名空間區隔的指令。Engineering：
  `/agentic-loop:engineering`（`new <idea>` · `retask <id> [note]` ·
  `approve [id]`——統一的、以資料夾驅動的把關點，行為不變 ·
  `replan [id] [reason]`——唯一的拒絕動詞，先前叫 `reject` ·
  `plan <id>` · `claim` · `watch [interval]` / `unwatch`
  （OpenCode）· `recover <id>` · `kinds` · `doctor [fix]` · `stop` ·
  `status`）。PR sitter：`/agentic-loop:pr-sitter`（`claim` ·
  `watch [interval]` / `unwatch`（OpenCode）· `stop` · `status`）。
- **隨總管指令一起消失的**：`ok`/`go` 這兩個 approve 別名；
  `reject` 和它的 `redo` 別名（改用 `replan`）；明確的
  `approve-plan <id>` 形式（統一的 `approve <id>` 已涵蓋計畫把關）；
  `task <id>`、它的 `run` 別名，以及裸 id 簡寫（用 `plan <id>` 來
  規劃單一任務，用 `claim` 來建置下一個）；還有 `ship <id>`（統一的
  `approve <id>` 會從 `in-review/` 發布）。
- **範圍限定**：`claim [kind]` / `watch [interval] [kind]` 不再
  接受類型過濾器——指令本身就是過濾器。把舊的 `/agent-loop watch`
  session 重新啟動為 `/agentic-loop:engineering watch`（如果啟用了
  sitter，再加上 `/agentic-loop:pr-sitter watch`）。
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
