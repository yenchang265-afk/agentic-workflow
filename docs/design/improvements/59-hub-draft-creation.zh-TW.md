[English](59-hub-draft-creation.md) | 繁體中文

# 59 —— 看板可以建立草稿

**狀態：已實作。**

## 問題

管理面板能把關、就地編輯、規劃、放棄、還原與移除任務，卻不能**建立**一份。第一欄
唯一的入口是 CLI 的 `new` 訪談與手寫檔案——而 core 的程式化建立者 `writeTask` 根本
沒有呼叫者：CLI 的 `new` 動詞刻意把回合交給撰寫代理，自己不寫檔案。

## 改了什麼

- **`POST /api/tasks/draft`**（`postTaskCreate`）：編輯器的欄位減去描述既有檔案的
  兩個（`expectStatus`、`baseHash`），相同的界限與單行規則（`CreateTaskRequestSchema`）、
  相同的機密形狀拒絕——指名，絕不改寫。在把關鎖之下，兩次建立不會從同一份落後的
  索引鑄出同一個 id；`writeTask` 鑄造看板唯一的 id 並拒絕覆蓋；附 `Task created in
  the hub` 註記與 `commitBacklog`，如同每一次待辦寫入。
- **看板 draft 欄的 `NewDraft`**（`+ new`），重用編輯器的 `Field`/`fromLines` 輔助與
  同一個 `<Confirm>`；成功後表單關閉、新任務在抽屜中開啟。

## 尖銳邊角

- **是表單，不是訪談。** CLI 的 `new` 透過訪談與子代理塑形一個想法；管理面板沒有代理，
  所以由人填寫訪談原本會填的欄位。草稿像其他任務一樣在任務把關點等待，核准前編輯器
  可以重塑它。
- **只有 engineering 欄。** 按鈕以 `sourceType: "backlog"` 把關；sitter 看板沒有可寫入的
  draft 資料夾。
