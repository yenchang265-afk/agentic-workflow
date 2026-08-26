[English](44-cross-process-status.md) | 繁體中文

# 44 — status 看得到其他行程正在驅動的迴圈

**狀態：已實作。**

## 問題

兩個 host 的 status 都只從自己的行程回答——OpenCode 用
`getWorkflow(sessionID)`，Claude host 用記憶體裡的 `active`。另一個終端
機裡的 watch worker 正在驅動任務 X，這邊的 status 卻說「No active
loop」，引人打出競爭的 `claim X`（或 `recover`），然後撞上 status 從未
預告的拒絕——「剛被另一個 watcher 認領」，而且無從看見那個迴圈住在哪。
跨行程的 oracle 其實早就存在：`recover` 和 `doctor` 都在用的
`taskDrivenByStageMarker`。

## 改了什麼

- **`liveStageMarkers`（core，`stage-marker.ts`）**回報每個 host 的
  「活」stage marker 與 status 行需要的事實——任務、階段、kind、期限、
  寫入者 pid——判活規則與 `taskDrivenByStageMarker` 完全相同（期限在未
  來、帶 pid 的必須還活著）。兩個讀取器現在共用一個內部函式
  （`liveMarkerFor`），兩個 oracle 從此不可能漂移。
- **OpenCode 的 status** 在閒置行與活迴圈行都追加
  `driven elsewhere: <task> @ <stage>（<host> pid N，期限 M 分鐘內）`。
- **`workflow_status`** 增加 `drivenElsewhere` 清單，每一條以「gate
  verbs and claim will refuse it while that loop is live」收尾——拒絕在
  競爭命令將被打出的地方先被預告。

## 尖銳邊界

- **每個 host 過濾掉自己的 pid。**驅動中 session 的 status 不能把自己
  的迴圈報兩次；沒有 pid 的舊 marker 保留（無法證明是我們的，而且現在
  兩個寫入者都一定蓋 pid）。
- **僅供顯示。**期限在 marker 上本來就註明 display-only；這裡不做閘
  門、不做清掃——recover/doctor 保有自己的判活路徑。
- **和所有 marker 讀取一樣 best-effort**：缺失、亂碼、過期或寫入者已死
  的 marker 都退化成「沒有」，絕不拋錯。
