[English](58-hub-ship-gate-diff.md) | 繁體中文

# 58 —— 管理面板的出貨把關點顯示它所核准的 diff

**狀態：已實作。**

## 問題

設計 33 與 34 給了 CLI 出貨把關點一個經驗證的 `git diff` 視圖與 REVIEW 階段的
非阻擋性 `suggestion` 發現。管理面板的出貨按鈕——把關點唯一以滑鼠點擊呈現的
介面——核准的是它只顯示過**大小**的 diff：佇列列渲染了 done 註記的 diffstat 與
分支，沒有任何東西渲染 diff。建議更慘：`runDone` 把 `> Review suggestions (N) — …`
寫在 done 註記**之前**，好讓 done 註記維持紀錄的最新一行，而佇列的 `lastEvent`
正好顯示那最新一行——為這個把關點而寫的那條註記，正是這個把關點看不到的。

## 改了什麼

- **`extractRunSuggestions`**（`task/store.ts`）依蓋章行規則解析建議註記，錨定於
  **最後一次**完成的執行：沒有建議的執行不寫註記，所以較舊執行的那行不得對著較新的
  diff 顯示。`runDone` 改由 `SUGGESTIONS_MARKER` 建構註記，把寫入者與解析器釘在一起。
- **`diffText`**（`workflow/git.ts`）：像 `diffShortstat` 一樣從主 checkout 依 ref 跑
  `git diff <base>...<branch> --`，以 `maxLines` 截斷，附真實行數與 `truncated` 旗標。
- **`GET /api/review/:status/:id/diff`**：分支與 base 來自 done 註記——出貨時 push 的
  同一組欄位——絕不來自請求，所以這條路由不可能被指向任意的 ref 組；base 的後備與
  出貨完全相同（repo 預設分支）。以 `workflows.<kind>.maxDiffLines`（review sitter
  的旋鈕；一個數字，不是兩個）截斷，未設時用 `DEFAULT_MAX_DIFF_LINES`。
- **佇列列**帶有 `suggestions` 與一個只在展開時才抓取的 Diff 揭露區——佇列在每次
  SSE tick 都會重抓，而 diff 沒有上限——截斷時指名看其餘部分的指令。

## 尖銳邊角

- **絕不把建議文字拆回發現。** 發現的細節可能含分號；註記是一行截斷過的文字，就以
  一行顯示。
- **diff 是證據，不是第二次審查。** 管理面板仍然從不執行階段；它顯示執行記錄了什麼、
  git 對它怎麼說。
