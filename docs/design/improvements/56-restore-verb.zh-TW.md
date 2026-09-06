[English](56-restore-verb.md) | 繁體中文

# 56 —— `restore <id>`：`abandon` 一直承諾的反向動作

**狀態：已實作。**

## 問題

`abandon` 從一開始就被記載為**可逆**的取消：「檔案會保留，因此可以再移回來」。但沒有
任何東西能把它移回來。`canTransition` 在 `abandoned/` 上是終結的——對生命週期而言
是正確的——所以 `workflow_move`、管理面板的按鈕與每個把關動詞都拒絕，而文件所說的
反向動作是手動 `mv`：沒有稽核註記、沒有提交，還有一個 `moveTask` 在離開時刻意撤銷的
plan request。

## 改了什麼

- **`task/store.ts` 的 `restoreAbandoned($, task)`**：`abandoned/` → `draft/`，像
  `rescueStray` 一樣繞過 `canTransition`——這是修復回人工審閱收件匣，不是生命週期
  移動，所以 `moveTask` 維持嚴格。同樣的守衛：拒絕重複的目的地、`mv -n`、落地確認。
- **`workflow/gate.ts` 的 `restoreTask(ctx, id, reason?)`**：像每個動詞一樣解析、拒絕
  不在 `abandoned/` 的任務（指名它的資料夾；「已經是草稿」屬資訊性）、寫入
  `TASK_RESTORED_MARKER` 註記、經 `noteThenMove` 移動（新增選填的 mover，移動失敗時
  註記會被更正，與生命週期移動完全相同）並提交。
- **`ABANDONED_MARKER` + `extractAbandonOrigin`**：abandon 註記改由常數建構、以蓋章行
  規則解析，`show` 因此能回報任務是從哪裡被放棄的。只是顯示資料。
- **每個介面**：兩種 host 的 `restore <id> [reason]`、`workflow_restore`、管理面板
  abandoned 欄的 Restore 按鈕（`GateAction: "restore"`）。

## 尖銳邊角

- **永遠是 `draft/`，絕不是來源資料夾。** 還原到 `queued/` 或更後面會帶著一個沒人重新
  做出的任務把關核准；下一個 `approve` 是人的決定，跨過它會像任何草稿一樣清掉
  strike 計數（`TASK_APPROVED_MARKER`）。計畫區段與（若有）拒絕原因都留著——下一次
  PLAN 會把它們當 `priorPlan` 與待處理原因，對一個被擱置而非做錯的任務來說正是對的。
- **認領／即時迴圈守衛在此是空的**——放棄時已釋放兩者——所以不重複；拒絕條件只有
  資料夾與重複 id。
- **`canTransition` 未動。** 放寬成 `abandoned → draft` 會讓 `workflow_move` 與任何未來
  呼叫者在沒有註記的情況下做同一個移動；繞過是明確且單一用途的。
