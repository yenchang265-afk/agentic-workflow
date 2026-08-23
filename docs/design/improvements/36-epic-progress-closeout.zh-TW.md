[English](36-epic-progress-closeout.md) | 繁體中文

# 36 — Epic 的進度會被回報，收尾也會被主動提出

**狀態：已實作。**

## 問題

Slice set 的 tracking epic 永遠不被核准地待在 `draft/`，而文件寫明的關閉方式
——「每個 child 都 ship 之後，手動 abandon 它」——沒有任何介面呈現過：
`epicSiblings` 只有一個消費者（task gate 的下一片 walk），`shipTask` 完全
不碰 epic，也沒有任何介面計算一個 set 的進度。ship 最後一片看起來與 ship
任何其他 task 一模一樣，於是 tracker 在 `draft/` 裡累積，人得從資料夾列表
重建「這個 set 完了沒？」。

## 改了什麼

- **`shipTask` 回報整個 set**（`epicShipOutcome`，與 `remainingSlices` 同樣
  的 best-effort、同樣的理由——它在 ship 已提交之後執行，列舉失敗只能損失
  尾註，絕不能損失移動）。set 中途的 ship 說
  `Epic <id>: 1/3 slices shipped; still open: b, c`；最後一片說
  `all N slices shipped — abandon <id> closes the tracker`。data 鏡射同樣
  資訊（`epic`、`epicShipped`、`epicTotal`、`epicOpen`／`epicDone`），
  與所有 epic key 一樣缺席時省略。
- **`summarizeBacklog` 增加 `epics`**——每個仍有存活或已 ship children 的
  tracking draft 一列 `EpicProgress`（{id、shipped、open（按認領順序）、
  total}），純粹從 `epic:` 連結導出，絕不讀 tracker 的散文。set 被
  remove/abandon 清空的 tracker 不產生列。Claude host 的 `workflow_status`
  免費帶上它（它整個回傳 summary）。
- **`nextActions` 直接點名收尾**：全部 ship 完的 set 在兩個 host 的 status
  介面上渲染
  `epic <id>: all N slices shipped — <cmd> abandon <id> closes the tracker`。

## 尖銳邊角

- **被 abandon 的 slice 會縮小 set。**`total` = shipped + open，排除
  abandoned children：abandon 是文件寫明的縮減範圍方式，一個所有「存活」
  child 都 ship 了的 set 就是完成了，不管路上取消了什麼。
  `ACTIVE_STATUSES`（現在 export）是那條界線。
- 收尾建議 `abandon`——可逆的關閉——絕不建議 `remove`。
- `shipTask` 的 already-completed 重試 arm 不加尾註：重新發佈不是新的
  ship，在那裡重複建議會在每次重試都觸發。
