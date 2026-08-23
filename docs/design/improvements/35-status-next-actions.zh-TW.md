[English](35-status-next-actions.md) | 繁體中文

# 35 — Status 直接說下一步要打什麼

**狀態：已實作。**

## 問題

`summarizeBacklog` 把 backlog 彙總成計數加七個可行動的 id 清單——而 host 們
渲染了計數、吞掉了動詞。OpenCode 只對七個中的兩個記了提示（interrupted →
`recover`、in-review → `approve`）；一個停在 gate 的 plan——整個 loop 阻塞
所在的狀態——只是一行 roll-up 裡光禿禿的 `1 plan-review (awaiting approve)`。
Claude host 一條提示都沒有。更糟的是，那個 host 呼叫
`summarizeBacklog(byStatus)` 時沒帶 claim id，所以 `claimHeld` 永遠是空的，
每個被 claim 的 task 都誤報成 `claimable`——status 對沒有任何 watcher
撿得起來的工作說「ready」。

## 改了什麼

- **`nextActions`**（`task/store.ts`）：緊鄰它所渲染的 summary 的一個純
  renderer——每個非空清單一行帶動詞的提示，人類等待的 gate 優先
  （plan-review、in-review），然後是 drafts、queued、build-ready、
  interrupted、claim-held。id 清單超過 5 個就省略（`+N more`）；指令前綴是
  參數而非寫死，因為每個 kind 擁有自己的指令。一個 renderer 由兩個 host
  共用，狀態→動詞的對應就不可能漂移。
- **OpenCode** 把兩條手挑的提示換成完整集合（interrupted 與 claim-held
  維持 `warn` 等級）。
- **Claude host** 的 `workflow_status` 結果增加 `nextActions` 陣列——並且
  現在把 `listClaimIds` 傳進 `summarizeBacklog`，修掉 claimable/claim-held
  的誤報（OpenCode host 一直有傳；這個 host 靜靜地沒傳）。

## 尖銳邊角

- 這些行是給人類的提示，不是機器資料——沒有東西 parse 它們，summary 的
  id 清單仍是結構化介面。改寫一行的措辭不會弄壞任何東西，只會弄壞記憶。
- `claimHeld` 的提示導向 `doctor`（報告）與 `doctor fix`（僅證明已死的
  holder），而不是任何釋放動詞——被持有的 claim 通常表示有 loop 正在驅動
  這個 task，在這裡邀請釋放正是 claim 存在要防止的 double-drive。
- 空 backlog 渲染零行；兩個 host 都整段省略，安靜 repo 的 status 不變。
