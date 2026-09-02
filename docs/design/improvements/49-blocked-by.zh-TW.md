[English](49-blocked-by.md) | 繁體中文

# 49 —— `blockedBy`：迴圈唯一強制執行的相依把關

**狀態：已實作。**

## 問題

切片組的子任務本應彼此獨立，但 `new` 允許堆疊的子任務——建立在手足已合併程式碼
之上的子任務——而它能提供的排序只有 `priority`，它**排序**認領，不阻擋認領。
`epic` 刻意只是描述性的。於是人類成了相依把關：一次一個、依序核准與出貨堆疊的
子任務，且絕不能讓 `watch` 工作階段同時看到兩個 build-ready——因為 worktree 模式
下一個 watcher 會並行驅動 N 次，每次都從 `origin/main` 切出，第二個子任務會建立在
不含第一個的基底上。任務上沒有任何東西能說「還不行」。

## 改了什麼

- **`TaskFrontmatterSchema` 的 `blockedBy: string[]`**（預設 `[]`，為空時不寫入
  檔案），貫穿 `Task`、`TaskInput`、`taskToInput` 與 `serializeTask`，讓管理面板的
  就地編輯器能往返保留。放進 schema 的理由與 `epic`、`autoPlan` 相同：schema 外
  的鍵會被第一次改寫刪掉。
- **認領會跳過被阻擋的任務。** `openBlockers(task, openIds)` 留下仍在非終結資料夾
  （`ACTIVE_STATUSES`）裡的 id；`claimNext` 在 predicate 與排序**之前**就把這類
  任務從候選中剔除，所以不會對它們取 marker，排在後面的低優先手足反而被認領。
  open id 集合是**惰性**列出的——只在某個候選宣告了 blocker 時才列——所以從不
  使用此鍵的待辦每次 tick 不付額外列舉。
- **`status` 說明誰在等誰。** `summarizeBacklog` 多了 `blocked` 清單（為空時省略）
  並把被阻擋任務排除在 `awaitingPlan`/`claimable` 之外；`nextActions` 每個被阻擋
  任務渲染一行；整個 walk 都被阻擋時的 skip reason 會說哪些任務在等哪些 id。
- **撰寫端的提示會設定它。** `new` 第 3 步、task-author agent 的 schema、以及
  backlog skill 都說明何時寫：只在堆疊切片上，點名它建立於其上的手足，絕不點名
  epic。

## 尖銳邊角

- **blocker 是靠「離開板子」解除的**——completed、abandoned 或 removed——不是靠
  到達某個狀態。懸空 id 是正常狀態（如 `epic`），所以對永遠不會落地的工作的相依
  不會卡死任務；`remove --force` 與 `abandon` 都會釋放相依者。
- **只管認領。** 人類把關點不受影響：人類可以手動核准、規劃或出貨一個被阻擋的
  任務，`plan <id>` 也不是認領 walk。這裡強制的是**無人值守**的那道門。
- **自我參照被忽略而非死鎖**，且 `openBlockers` 從不讀 body 的文字。
