[English](46-stall-rule-and-finding-ids.md) | 繁體中文

# 46 —— 停滯規則，以及知道自己是重複的發現

**狀態：已實作。**

## 問題

一次執行唯一的界限是 `maxIterations`，而且只在一處判斷——`advance` 的
`countIteration` 分支——純粹以次數計。attempts 帳本（設計 25）記錄了每次迭代
失敗在什麼上，但只給提示詞讀：兩個階段的提示詞都要求模型「指出重複發生」、
「不要重蹈已失敗的修法」，卻沒有任何程式碼比較兩次嘗試。於是一個 VERIFY 連續
三次失敗在同樣兩條驗收條件與同一個 critical 發現上，會燒光全部迭代，直到上限
訊息終於說「計畫大概是錯的」——那是第二次相同失敗就已證明的結論，代價卻是一整
輪沒人要的 BUILD + VERIFY（+ REVIEW）。

重建的回饋區塊在下一層有同樣的盲點。`AxisFinding` 沒有身分，所以
`verdictFeedbackBlock` 每次迭代都逐字重發每個阻擋性發現：BUILD 說不出「已處
理」，REVIEW 說不出「仍未解」，而修完後又冒出來的發現讀起來就像新消息。

## 改了什麼

- **穩定的發現 id。** `findingId(axis, finding)` 是軸 + 嚴重度 + 正規化
  `location` 的 FNV-1a 雜湊（沒有位置的發現才退回用 detail 文字）。有位置的
  發現在改寫措辭後仍保有同一個 id——模型會換句話說，`file:line` 不會。回饋
  區塊把每個阻擋性發現渲染為 `… (finding a3f1c9d2)`，而帳本已在此階段持有其
  id 的則為 `(finding a3f1c9d2 — REPEAT, also raised in iteration N: the
  previous fix did not resolve it)`。
- **每次被計數的嘗試都有結構指紋。** `failureFingerprint` 對未達成的驗收條件
  集合與排序後的阻擋性發現 id 取雜湊——從不含 reason——`withAttempt` 把它
  （連同 id）存在 `AttemptRecord` 上；`persist.ts` 宣告兩者，恢復的執行才留得住。
- **計數 fire 上的 `stallAfter`。** 當這次失敗加上帳本尾端同階段的相同嘗試達
  到 N，`advance` 以 `stallMessage` 停止（`{stallAfter}`/`{maxIterations}` 可
  插值；退回 `capMessage`）。engineering 在 VERIFY 與 REVIEW 都設
  `stallAfter: 2`。上限先判、永遠優先。

## 尖銳邊角

- **只有 reason 的 FAIL 永不停滯。** 它沒有指紋。誤判停滯會終止一次原本可能收
  斂的執行；漏判的代價恰是今天上限的代價。缺乏結構讀作「不同」。
- **行號留在 id 裡。** 拿掉它會把同一檔案裡兩個不同的 critical 發現折成一個
  id，而誤判的「重複」正是終止執行的那種讀法——所以 id 偏向「新的」。
- **尾端指的是「這個階段」的尾端。** VERIFY、REVIEW、VERIFY 而兩次 VERIFY 失敗
  相同，就是停滯——review 驅動的重建後同一發現回歸，是兩個修法在打架，那是計畫
  該解決的問題。
- **逐分支選擇加入，且需要 `countIteration`。** 未宣告 `stallAfter` 的 kind 與
  之前逐位元組相同；manifest schema 拒絕未計數 fire 上的這個欄位。
