[English](55-show-verb.md) | 繁體中文

# 55 —— `show <id>`：用把關點讀任務的方式讀一份任務

**狀態：已實作。**

## 問題

`status` 是總覽：每個資料夾的數量、等著某個動詞的任務。要了解**一份**任務——有沒有
計畫、上一份為什麼被拒、停止的執行留下了什麼、是否持有認領、稽核紀錄說了什麼——
CLI host 只有 `cat`，而 `cat` 是錯的讀法：把關點所依據的事實是由蓋章稽核行的解析器
推導的（`extractReplanReason`、`extractStopContext`、`priorRunFor`、`isClaimable`、
`wasInterrupted`），人讀原始檔會把引文當成紀錄。管理面板的任務抽屜有這份投影；驅動
迴圈的終端機沒有。

## 改了什麼

- **`describeTask` / `formatTaskDescription`**（`task/describe.ts`）——一份純投影
  （`TaskDescription`）與一個渲染器，兩種 host 共用。每個欄位都來自對應動詞所信任的
  解析器，所以 `show` 不可能與 `approve`、`replan`、`recover` 或認領 walk 的行為不一致。
  選填鍵省略而非留空。稽核紀錄只印最新 `SHOWN_NOTES` 筆，更早的只計數。
- **`extractAuditNotes` 移入 core**（管理面板改為重新匯出），抽屜顯示的時間線與 `show`
  印出的是同一個解析器。
- **`workflow/gate.ts` 的 `showTask(ctx, id)`**：像每個動詞一樣解析 id（短代號、模稜兩可
  時附候選拒絕、無法解析的檔案指名），讀該資料夾的認領標記與快照清單，以 `data`
  回傳投影、以 `message` 回傳渲染後的行。不移動、不提交。
- **兩種 host**：OpenCode 的 `show <id>`（首行 toast，報告取代 markdown 讓模型轉述）；
  Claude/Qwen 由把關 hook 派送 `gate show` 並以報告阻斷本回合——唯讀但確定性，模型
  回合改善不了什麼——工具形式為 `workflow_show`。

## 尖銳邊角

- **可認領 body 旁的快照不是中斷**——與 `summarizeBacklog` 相同的規則（設計 53），在
  此重述以確保兩個視圖一致。
- **`abandonedFrom` 只是顯示資料。** 只對 `abandoned/` 內的任務解析，永遠不驅動移動
  （見設計 56）。
- **hook 在讀取上阻斷。** 繼續回合只會讓模型花一回合重讀報告已摘要的檔案；阻斷本身就是
  答案。
