[English](65-sitter-claim-next.md) | 繁體中文

# 65 —— sitter 的終端會說還有什麼在等

**狀態：已實作。**

## 問題

`pollOnce` 回傳**第一個**認領，每個來源在那裡 `return`，丟掉它剛評估完的其餘候選集。
sitter 的終端因此只是一句話——「PR #7：審查通過」——對同一輪 walk 中需要注意的 PR #8
與 #12 隻字未提：一次性的 `claim` 就此結束，watch session 則沉默到下一個 tick。

## 改了什麼

- **`WorkItem.remaining?: number`**：來源在同一輪 walk 還會認領幾個，**不**認領也不抓取
  地計數。`github-pr` 與 `ado-pr` 對尾端重跑注意力判斷；`dependency-scan` 數已認領者
  之後 ledger 仍開放的候選。來源無法判斷時省略（待辦有 `status`；單一 head 的來源後面
  沒有東西）。
- **OpenCode**：認領的驅動 `done`/`stop` 之後，一行 log 與 toast 指名數量與下一步——該
  類型的 `claim` 動詞，或「這個 watch session 在下一個 tick 接手下一個」。
- **Claude/Qwen**：`workflow_advance` 的終端結果帶 `remaining` 與指名
  `workflow_claim({kind})` 的 `next`。

## 尖銳邊角

- **只計數，絕不認領。** 為尾端取標記會持有沒有驅動即將處理的工作；數字是提示，不是租約。
- **判斷需要呼叫 API 時有上限。** GitHub 的注意力測試重跑在 `gh pr list` 已回傳的資料上；
  ADO 的快照每個 PR 都要抓討論串與 pipeline，所以 `ado-pr` 最多判斷 `REMAINING_PROBE_MAX`
  （5）個合格的尾端 PR，超過後數字是下界。
- **不適用於待辦。** engineering 的看板有 `status` 與認領 walk 自己的略過理由；這裡再數
  任務會重複它們。
