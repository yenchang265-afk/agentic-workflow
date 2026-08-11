[English](25-cap-context-threading.md) | 繁體中文

# 25 — 每條 replan 通道都要載有實質內容

**狀態：已實作。**

## 問題

方案 10 給了計畫閘門的拒絕理由一條通道（可解析的稽核註記，串進下一次 PLAN 的
`{{#replan}}` 區段）。但仍有三條 replan 路徑什麼都不帶：

1. **迭代上限（cap trip）。** 燒完迭代預算的 run 清楚知道每次嘗試敗在哪——
   VERIFY 的理由、REVIEW 的發現、attempts ledger——然後全部丟棄：`runStop` 清
   掉快照，capMessage 註記不是 `planRejectedNote` 的形狀，plan.md 也沒有
   `{{#attempts}}`。下一次 PLAN 盲目重規劃，人類打的理由是唯一載體——正是方案
   10 消滅過的「靠考古而非通道」模式，在最貴的 replan 上又回來了。
2. **無理由的 replan。** `replan <id>` 不帶理由時 `{{#replan}}` 什麼都不渲染
   ——規劃者拿到標成「已被取代」的舊計畫，卻沒有任何跡象顯示它被拒絕過，最可能
   的結果就是同一份計畫再交一次。
3. **claim 被持有時的 replan。** `replanQueued` 拒絕時（規劃者此刻正持有檔
   案）默默**丟掉**了打好的理由——人類唯一的一份隨 toast 一起死了。

另外沒有上界：沒有任何寫入端限制理由長度，hub 組出的長評論變成一行巨大的稽核
註記。

## 改了什麼

- **停止摘要**（`stopContextNote`/`extractStopContext`，
  `packages/core/src/task/store.ts`；`attemptsDigest` 在
  `workflow/terminal.ts`）：非暫時性的停止、且 ledger 上有嘗試紀錄時，追加
  `Run stopped — attempts: iteration N STAGE VERDICT: reason; …`（截至 800
  字）到任務檔——快照不耐久，它耐久。退役錨點與拒絕理由相同（更新的計畫標題或
  `Plan written` 停泊註記）。以 `!retryable` 為門檻：環境抖動造成的停止，其
  ledger 是雜訊。`replanTask` 接著**融合**——
  `<人類理由> — prior run: <摘要>`——進既有的 `planRejectedNote`，因此它經由
  `{{replan.reason}}` 抵達，零新增狀態欄位、零新增模板區段，正是方案 10 的通
  道。plan.md 加一句話，告訴規劃者 attempt ledger 要求實質不同的做法
  （`engine.test.ts` oracle 已更新）。
- **無理由時的後備**（`pendingPlanRejection`/`replanFor`，`task/store.ts`）：
  解析器現在能區分「沒有待處理的拒絕」與「待處理但無理由」
  （`extractReplanReason` 就是 `replanFor` 的 `.reason`），兩個 PLAN 進場建構
  器——`planEntryState`（`workflow/orchestrate.ts`）與 claim/watch 的
  `entryState`（`source/backlog.ts`）——都走同一個 `replanFor`，以
  `NO_REASON_FALLBACK` 文字替補。後備必須是**值**：模板語言沒有反向區段。
- **有上界的一行**（`REPLAN_REASON_MAX = 1200`，`oneLineReason` 在
  `workflow/gate.ts`）：在每個寫入端——CLI、MCP、hub 組稿——都會經過的唯一咽喉
  點夾一次。對融合摘要而言足夠寬裕。
- **回聲的拒絕**（`replanQueued`）：claim 被持有的分支現在把打好的理由回聲出
  來——「Your reason was NOT recorded — re-send it then: …」——讓它在拒絕後存
  活。（hub 的組稿器在拒絕時本就保留評論；那邊不需要改。）

## 刻意不做的事

- cap 情境不走 frontmatter 或記憶體載體——方案 10 明確拒絕過兩者；稽核註記是
  唯一通道。
- 不讓理由穿透被持有的 claim 存續（例如騎在 plan-request 標記上）：對正被規劃
  者改寫的檔案追加是 lost update，而暫態標記不可以變成第二條理由通道。
- 只有**最新**待處理的摘要會串入——與拒絕理由同樣的 last-note-wins 規則；多輪
  累積需要一個目前沒有任何消費者想要的多註記解析器。

## 落點

`RUN_STOPPED_MARKER`/`stopContextNote`/`extractStopContext`/`pendingPlanRejection`/
`replanFor`/`NO_REASON_FALLBACK` 在 `packages/core/src/task/store.ts`；
`attemptsDigest` + 摘要註記在 `runStop`（`workflow/terminal.ts`）；融合在
`replanTask`、夾限在 `oneLineReason`、回聲在 `replanQueued`
（`workflow/gate.ts`）；`replanFor` 串接在 `workflow/orchestrate.ts` 與
`source/backlog.ts`；ledger 句子在 `workflows/engineering/stages/plan.md`。
測試：`store.test.ts`、`terminal.test.ts`、`gate.test.ts`、`engine.test.ts`。
