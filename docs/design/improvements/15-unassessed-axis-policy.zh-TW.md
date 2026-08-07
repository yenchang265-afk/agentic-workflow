[English](15-unassessed-axis-policy.md) | 繁體中文

# 15 — 未評估軸線（unassessed axis）政策

**狀態:已實作。** `packages/core/src/workflow/verdict.ts` 中的
`axisUnassessed` / `withUnassessedGuard` 與 `effectiveVerdict` 的略過邏輯、
`workflow/checks.ts` 中的 `finalizeCheckRecord`、OpenCode driver 與 Claude
MCP server 的呼叫點替換、`verdictContractBlock` 與
`prompts/agents/workflow-review/body.md` 的契約文字;測試見
`verdict.test.ts`、`checks.test.ts`。

## 背景

兩個刻意寫下的設計意圖互相衝突。審查契約——代理提示詞與
`axisCoverageIssue` 的重試訊息——都明確指示:*「對你確實無法評估的軸線,
使用 ERROR 判定」*(diff 中沒有熱路徑 → 效能無從評估),正是為了讓審查者
不必捏造發現來填空。但 `effectiveVerdict` 會被每一條軸線惡化,而
`verdict.test.ts` 又釘死了「任何 ERROR 軸線使整個階段 ERROR」——於是一條
誠實的軸線 ERROR 會把整個階段導向 `review.onError`:一個歸咎於
*「環境/基礎設施錯誤」* 的停止、一個困在 `in-progress/` 的任務(CLAIMED
註記使 `isClaimable` 為 false),以及一個每次都把 REVIEW 重新跑進同一個
誠實 ERROR 的 `recover`。`AxisResult` 的文件註解早已寫明意圖:每軸 ERROR
是承重設計,把它塌縮掉不得燒掉一次迭代——只是機器從未兌現。

## 設計

- **`axisUnassessed`** —— 宣告為 ERROR 且不帶阻斷性發現的軸線。合成的
  checks 軸線永遠不會被讀成未評估:壞掉的 runner 記錄的是*帶有* critical
  發現的 ERROR(`checkAxis`),因此「缺 runner → `onError`」的路由(靠
  ERROR 壓過 FAIL)得以保留。
- **`effectiveVerdict` 略過未評估軸線** —— 少數軸線的「無法評估」是中性
  的:它滿足覆蓋(`axisCoverageIssue` 只數出席、不看判定)、不惡化階段,
  並經由 `verdictFeedbackBlock` 新增的非阻斷「Unassessed review axes」
  區段流入下一輪提示(這也讓帶著它的 PASS 產生非空縫線,in-review 的
  人類能在 artifact 裡看到「效能從未被評估」)。
- **`withUnassessedGuard`** —— 邊界情形不得出貨:宣告 PASS 而*每一條*
  軸線都未評估者,惡化為帶說明理由的 ERROR(與 `withCoverageGap` 相同的
  「壞掉的審查,不是 FAIL」推理)。它在最終化階段對累積紀錄執行——與
  `withCheckFloor` 併入單一匯出 **`finalizeCheckRecord`**,兩個宿主都只
  呼叫它,誰也不可能套了 floor 卻忘了 guard。順序是承重的:紅色檢查先
  加入(已評估的)checks 軸線,所以只有「檢查全綠、什麼都沒評估」的
  PASS 會觸發。
- **宣告的 FAIL/ERROR 原樣通過** —— FAIL 保持 FAIL(`rejectedFallback`
  的規則);而每條軸線皆為無發現 ERROR 的 FAIL,如今在准入時就被拒絕
  (`blockingFindingsIssue` 看到的是一個什麼都沒點名的有效 FAIL),不再
  以有效 ERROR 之姿溜過。
- **契約文字** —— `verdictContractBlock` 三個軸線分支與審查代理提示詞
  現在都說明 ERROR 逃生口是非阻斷的;單一 pass 分支另加:每條軸線皆為
  ERROR 的 PASS 會被拒絕——若整場審查根本無法進行,請把*整體*判定宣告為
  ERROR。

## 為何不採

- **把 guard 放進 `effectiveVerdict`** —— OpenCode driver 對每個 fan-out
  pass 逐一評估 `effectiveVerdict`(`combineRecords`),單軸 pass 自己的
  軸線無法評估正是合法的少數情形;內聯 guard 會讓每個
  `fanout: "axis"` 階段重新引入這個 bug。
- **把未評估軸線塌縮成 FAIL** —— 文件明載的反目標:它在從未出錯的工作上
  燒掉一次重建迭代,還誘使審查者捏造發現。
- **把帶發現的 ERROR 降為 FAIL**(「別讓 ERROR 壓過 FAIL」)——
  `checkAxis` 正是靠 ERROR 壓過 FAIL,把缺 runner 導向 `onError`、紅色
  測試導向 `onFail`;強制 FAIL 會無聲破壞這個機制。
