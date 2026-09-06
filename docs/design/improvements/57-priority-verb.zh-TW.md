[English](57-priority-verb.md) | 繁體中文

# 57 —— `priority <id> <n>`：從終端機調迴圈自己的排序旋鈕

**狀態：已實作。**

## 問題

`priority` 是迴圈排程唯一會讀的 frontmatter 欄位（`selectOrder`：越低越先，同值依 id）。
管理面板的編輯器能改它；沒有任何 CLI 動詞能——驅動迴圈的終端機只有 `retask`（重寫
目標的訪談）和手動編輯 YAML，而後者跳過了 off-schema 檢查、稽核註記與提交。

## 改了什麼

- **`workflow/gate.ts` 的 `setTaskPriority(ctx, id, priority)`**：解析 id，拒絕超出
  `PRIORITY_MIN..PRIORITY_MAX` 的值、終結資料夾（沒有東西會排序已完成或已放棄的
  任務）、迴圈正在驅動或持有認領的任務，以及帶有 off-schema frontmatter 的檔案
  （`rewriteTask` 經 schema 序列化，zod 會剝掉不認識的鍵——這會被拒絕，絕不只是
  警告帶過）。目前值視為 `alreadyDone` 成功。否則：以只改一個欄位的 `rewriteTask`
  改寫、附 `Priority changed from X to Y` 稽核註記、`commitBacklog`。
- **`task/schema.ts` 匯出 `PRIORITY_MIN` / `PRIORITY_MAX`**，管理面板的
  `SaveTaskRequestSchema` 改用它們，兩個寫入者共用一組界限。
- **兩種 host**：`priority <id> <n>`（hook 解析「id 後面跟著整數」，因為它會阻斷回合，
  沒有模型能追問數字）、`workflow_priority`。

## 尖銳邊角

- **界限在寫入者上，不在解析 schema 上。** 超出界限的手寫任務仍必須能解析，否則它會從
  每個清單消失，而不只是排在最前或最後。
- **任何非終結資料夾，包括 `in-progress/`。** 等待認領的可建置任務是依優先序排序的；
  持有認領與即時迴圈的拒絕才是讓執行中的任務碰不到的機制。
- **沒有管理面板按鈕。** 編輯器已涵蓋；為單一欄位開第二條寫入路徑就是界限漂移的第二個
  地方。
