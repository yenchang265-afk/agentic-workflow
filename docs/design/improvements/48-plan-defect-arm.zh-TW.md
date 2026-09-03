[English](48-plan-defect-arm.md) | 繁體中文

# 48 —— 檢查階段可以說「計畫是錯的」

**狀態：已實作。**

## 問題

只有 BUILD 能回報已核准的計畫無法實作（`workflow_blocked`，經工作階段的
`onError` 分支路由）——而 `workflow_blocked` 刻意拒絕檢查階段，兩個通道互不
替代。但 VERIFY 與 REVIEW 才是最常**發現**計畫錯誤的地方：一條沒有任何實作能
滿足的驗收條件、一個點名 SDK 根本沒有的 API 的步驟。它們能做的只有 FAIL，而
FAIL 會再次觸發 BUILD，於是執行對著一份不可能通過的計畫反覆重建，直到迭代上限
觸發——到那時上限訊息才建議 `replan`。停滯規則（設計 46）抓的是相同失敗的情
況；這裡是階段第一次就已經**知道**的情況。

## 改了什麼

- **`VerdictRecord` 上的 `planDefect?: boolean`**，以及兩種 host 的
  `workflow_verdict` 都多一個 `planDefect` 參數。`admitVerdict` 釘住它
  （`planDefectIssue`）：必須搭 FAIL——計畫有缺陷的 PASS 是自相矛盾，ERROR 是
  環境的錯——而且必須帶 `reason`，因為 reason 就是 replan 的 PLAN 回合要讀的
  東西。合併時只要任一回合舉旗，旗標就保留。
- **檢查階段 transitions 上的 `onPlanDefect`**，與其他分支一樣被驗證。
  `advance` 在記錄帶旗標的 FAIL 時走它；未宣告的 kind 把該 FAIL 一如既往地路由
  到 `onFail`。engineering 在 VERIFY 與 REVIEW 都把它指向一個點名 `replan <id>`
  的 `stop`；不消耗迭代。
- **該停止是帳本上的一次失敗嘗試。** `runStop` 從 `state.attempts` 寫出停止情境
  註記，`replanTask` 再把它熔進拒絕 reason——階段點名的缺陷因此不必人類重打就
  到達下一輪 PLAN。
- **契約區塊說明何時使用。** `verdictContractBlock` 帶有一段 PLAN DEFECT（依
  AGENTS.md，它是 verdict 載荷的唯一真相來源）：不用於建置能修的缺陷、不搭
  PASS、不用來逃避困難的任務。

## 尖銳邊角

- **永遠不要放寬 `workflow_blocked` 對檢查階段的拒絕來「修」這件事。** 兩個通
  道保持分離：工作階段不得對自己的工作記錄 verdict，而檢查階段的「做不了」
  **就是**一個 verdict——一個有具名原因的 FAIL——這正是它走 `workflow_verdict`
  的理由。
- **光有旗標不夠**——裸的 `planDefect: true` 會被拒絕。什麼都沒告訴下一位
  規劃者的停止，比一次重建更糟。
- **錯誤的旗標讓人類多付一次不需要的 replan**，契約裡就是這麼寫的。這種不對稱
  是接受的：多餘的 replan 是一道把關；多餘的三次迭代是三個階段。
