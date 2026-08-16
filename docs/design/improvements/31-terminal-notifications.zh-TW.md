[English](31-terminal-notifications.md) | 繁體中文

# 31 — 終端事件可以推播通知

**狀態：已實作。**

## 問題

沒人看終端機時，閘門就靜音了。計畫停泊只是一則 toast 加 scrollback；
`watch` worker 默默把完成的 run 堆進 `in-review/`；停掉的迴圈等著一個
根本不知道它停了的人。hub 全都看得到——但只在開著的時候。每一次
「迴圈一小時前就完成了，我剛剛才發現」都是整條管線在付的延遲成本。

## 改了什麼

- **`notifyCommand`**（使用者層級設定）：在迴圈終端事件之後觸發的 shell
  指令，以 `env` 下的 `sh -c <command>` 執行，環境變數帶 `AW_EVENT`
  （`park` | `done` | `stop` | `error`）、`AW_KIND`、`AW_TASK` 與單行的
  `AW_MESSAGE`——足夠餵給 `notify-send`、`osascript` 或對聊天 webhook 的
  `curl`。每個值都以逸出後的插值抵達指令，任務標題或終端訊息裡的任何
  東西都不可能變成 shell 語法。
- **單一咽喉點**：`notifyTerminal` 包住 core 的 `runTerminal`——每個
  host、每種 kind 的終端本來就都經過它——所以 OpenCode 的 drive、watch
  worker、Claude/Qwen 的 `workflow_advance` 終端全都會發聲，不需要
  per-host 接線。它在終端自身簿記「之後」執行，上限 10 秒
  （`NOTIFY_TIMEOUT_MS`，逾時放棄並記警告——迴圈不等 webhook），所有
  失敗都降級為 `warn`。`park-free` 不觸發：無任務的自由文字計畫沒有
  閘門可宣告。
- **`notifyEvents`** 過濾事件集合（未設定＝全部四種）。它不含 shell——
  四個字面值——所以 repo 層可以收窄、永不能放寬貢獻者被通知的範圍。
- **`notifyCommand` 是含 shell 的鍵**：加進 `SHELL_BEARING_KEYS`，repo
  層設定它會被既有的按鍵警告丟棄——被 clone 的 repo 不可以在第一次
  停泊時執行任意 shell。兩個剝除點（loadConfig 與 raw-layer 讀取器）
  都迭代同一份清單，新鍵天生就被涵蓋。

## 銳利邊緣

- 出貨的 publish 步驟不通知——出貨閘門由定義上「在場」的人跨越。
  away 事件是 park、done、stop、error，正好就是 `TerminalReport` 的
  種類。
- 10 秒放棄會讓已生成的指令繼續在背景執行；這是「永不讓終端等通知器」
  的明文交換。
- `sh -c` 假設 PATH 上有 POSIX shell——Linux/WSL/macOS 皆成立，即支援的
  host。
