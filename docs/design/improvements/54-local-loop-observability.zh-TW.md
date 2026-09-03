[English](54-local-loop-observability.md) | 繁體中文

# 54 —— 迴圈回報自己的時鐘與預算

**狀態：已實作。**

## 問題

設計 44 讓 `status` 看得到**其他**程序驅動的迴圈——階段、期限、host——卻把自己
的迴圈留在 `stage · iteration N`：沒有上限、沒有期限，儘管這個程序兩者都握著。
`notifyEvents` 只涵蓋四個終端事件，接到聊天 webhook 的人在「計畫核准」與「審查
通過」之間什麼都聽不到——三次迭代的執行可能沉默一小時以上。撞上牆鐘上限的階段
讓執行 ERROR，事前沒有任何警告。而 OpenCode 的 `deferIdle`——把輸入的
`plan`/`claim` 排在忙碌的樹後面的分支——是沉默的，指令看起來像被吞掉了。

## 改了什麼

- **`status` 回報自己迴圈的預算與時鐘。** 兩種 host 都渲染 `iteration N/cap`
  （`iterationCap`，與 `advance` 停止所用的同一解析）與階段期限：OpenCode 讀本程
  序自己的即時 stage marker（它已用來讀其他程序的 oracle），Claude host 讀
  `stageDeadline`。
- **`notifyEvents` 多了 `"stage"`**——選擇加入。`notifyLoopEvent` 就是
  `notifyTerminal` 一直以來的通知器，匯出後兩種 host 在每次階段觸發時呼叫，
  `AW_MESSAGE` 註明階段與迭代。未設定的 `notifyEvents` 仍只表示終端事件：為「把關
  點在等」而接上的通知器，不該在沒人要求下每個階段都響。
- **接近期限的警告。** OpenCode 的 `runStage` 在上限的 `NEAR_DEADLINE_FRACTION`
  （80%）處、階段仍在跑時觸發回呼，driver 記錄已跑多久、何時逾時。Claude host 沒有
  自己的計時器——它的期限在 `workflow_advance` 判定——所以沒有。
- **`deferIdle` 會記錄**樹正忙、排隊的工作在等。

## 尖銳邊角

- **`stage` 選擇加入，理由與終端事件不選擇加入相同。** 預設集合是設計 31 承諾的；
  放寬它會改變每個既有通知器的節奏。
- **警告是一行 log，不是停止。** 有界、從不 await、在與逾時相同的 `finally` 清除——
  慢的 log 不能拖住階段。
- **自己迴圈的期限來自 marker，不是新時鐘。** marker 已在每個階段邊界重新蓋章；
  第二個時間戳只是多一件要保持同步的事。
