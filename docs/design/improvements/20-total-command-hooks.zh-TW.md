[English](20-total-command-hooks.md) | 繁體中文

# 20 — OpenCode host 上的全函式 hook

**狀態：已實作。** `withTimeout` 與全函式化的 `log`、拓寬的 command hook
`try`、`reconcileTimely`、加上防護的 `event` hook、旗標先行的
`warnIgnoredUserConfigOnce`，以及改為射後不理的 toast，全部位於
`plugins/opencode/src/impl.ts`；`impl.test.ts`（設定檔讀取懸置、logger
拒絕、event 隔離三個測試）。

## 背景

在 OpenCode TUI 裡，每個 engineering 動詞的第一次呼叫都憑空消失：沒有回合、
沒有 toast、沒有錯誤、沒有 log —— 幾秒後重打一次就能動。單日的 opencode log
就能看到五次被吞掉的呼叫：一行 `command=agentic-workflow:engineering`，之後
*什麼都沒有*。

機制是結構性的。opencode 的 `Plugin.trigger` 逐一 await 每個
`command.execute.before` hook，包在 `Effect.promise` 裡，**沒有 try/catch**；
呼叫端要等 trigger resolve 之後才會走到 `Session.prompt`。所以一個會
reject —— 或永不 settle —— 的 hook 會在*模型回合存在之前*殺掉整個指令，
而且沒有任何東西回報。兩個加重因素讓外掛的 hook 正好就是那個 hook：

- SDK 自己打回 opencode server 的 fetch 設了 `req.timeout = false`。hook
  路徑上 await 的任何 `client.*` 呼叫 —— 首當其衝是每個指令都要做的設定檔
  重讀 —— 在 server 卡住時可以永遠懸置。
- hook 的 `try` 從 dispatch 才開始，前面有約 60 行。之前的一切 ——
  `refreshConfig()`、kind 檢查、切片、draft note —— 都沒有防護，而那段
  前置裡的錯誤路徑自己又 await `log(...)`，也就是用剛剛壞掉的同一條通道
  回報錯誤。

「要打兩次」的形狀來自一次性守衛：`reportAgentModelsOnce` 與
`reconcileOnce` 在其未防護的 await *之前*就設了旗標，於是第一次呼叫死在
裡面、第二次整段跳過。這是同類缺陷第二次出貨 —— `gateFirst` 的重排只為
閘門動詞修掉了同樣的「試幾次就好了」症狀（它留下的註解就是證據），變體
在其他所有地方存活了下來。

## 設計

一條原則：**host 不會替你 catch 的 hook 必須是全函式** —— 永不 reject，
而且它上面每個可能懸置的 await 都要有時限。

- **prefix 比對之後的一切包進同一個 `try`。** catch 把 `failurePrompt`
  寫進提示詞 —— 死掉的指令唯一可見的通道 —— 而且在出去的路上絕不 await
  TUI 呼叫：hook 必須先*resolve*，覆寫才有意義。
- **`log` 是全函式。** `client.app.log` 被 `.catch` 吞掉並加上時限
  （`LOG_TIMEOUT_MS`）。它同時是 `deps.log`，所以 driver 裡每個
  `await log(...)` 都繼承這個保證。
- **設定檔讀取有時限**（`CONFIG_READ_TIMEOUT_MS`）；逾時落入既有的
  誤設定分支 —— 用上一次的好設定，指令照常運作。
- **`reconcileTimely`** 圈住啟動清掃：有時限（`RECONCILE_TIMEOUT_MS`）
  且被 catch，降級為一個 toast —— 失敗的清掃不能作廢一個已經成功的閘門
  移動。被放棄的清掃在背景跑完是安全的：`reconciled` 已經設了旗標，而
  `releaseOrphanedClaims` 以原子方式重新判定陳舊度
  （`releaseMarkerIfStale`），所以動詞在清掃收尾期間放下的 claim 能存活。
- **`event` hook 加上防護** —— 同樣的 trigger 機制，逃出去的 rejection
  就是未處理的 rejection。
- **toast 一律射後不理。** `.catch()` 擋得住 rejection，擋不住懸置。
- **一次性守衛先設旗標，之後不得再有未防護的 await**
  （`warnIgnoredUserConfigOnce` 併入 `reportAgentModelsOnce` 的形狀）。

`withTimeout` 從不取消：被放棄的 promise 保有其 handler（不會有遲到的
未處理 rejection），且每個呼叫點都容忍遲到的完成。

## 刻意不做的事

- **`handleCommand` 沒有時限。** 半途打斷一個真正的閘門移動比等待更糟；
  dispatch 本來就已在拓寬後的 try 裡面。
- **`command-slice.ts` 的 `tidy()` 定點迴圈仍約為立方複雜度** —— 貼上
  非常大的 `new <idea>` 可以讓 hook 卡在 CPU 上，這是 try/catch 與時限
  都碰不到的唯一機制。另立後續處理。
