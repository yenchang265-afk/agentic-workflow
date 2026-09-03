[English](52-verify-pass-facts.md) | 繁體中文

# 52 —— REVIEW 看得到 VERIFY 確立了什麼，而不只是它失敗了什麼

**狀態：已實作。**

## 問題

review.md 的「What VERIFY established」一節由 `advance` 記錄的 verdict 接縫餵
入——`verdictFeedbackBlock`，只渲染失敗。在最常見的路徑——乾淨的 VERIFY PASS——
區塊是空的、接縫被丟棄，REVIEW 完全拿不到這一節：它在不知道 VERIFY 檢查了哪些條
件、靠什麼檢查、哪些 driver 執行的檢查是綠的情況下評審程式碼。而一條 criterion 只
帶 `{ criterion, pass }`，即使渲染了 PASS 也說不出第 3 條是**如何**達成的。

## 改了什麼

- **`CriterionResult.evidence?: string[]`**——每條 criterion 的簡短參照（指令列、
  `path:line`），加在兩種 host 的 `workflow_verdict` schema 與 metrics sidecar 的
  criterion schema（要宣告，否則下一次執行的 read-modify-write 會剝掉）。從不設
  門檻：record 層級的 evidence 才是 `evidenceIssue` 交叉比對的對象；這是逐條的
  讀法。
- **`verdictPassBlock(stage, record, checksLine)`** 渲染 PASS 的事實：達成的條件
  及其證據、迴圈跑過的檢查（一行，由 `checksSummaryLine` 預先渲染——`checks.ts`
  匯入 `verdict.ts`，摘要不能在那裡建）、該回合引用的證據、非阻擋備註、以及無法
  評估的軸。對除了 verdict 之外什麼都沒確立的紀錄為空，所以裸 PASS 一如既往清掉
  接縫。
- **`advance` 在檢查階段 PASS 時熔入它**，如同 FAIL 熔入回饋區塊：同一接縫、同一
  `EXEMPT_MAX` 豁免、同一 `promptContext.verdicts` 路徑——review.md 的那一節終於在
  它被寫來服務的路徑上渲染。
- **契約區塊說了這件事**：每條 criterion 可加 `evidence`，REVIEW 把它讀作該條件
  是如何確立的。

## 尖銳邊角

- **裸 PASS 仍清掉接縫。** 舊測試——VERIFY FAIL → BUILD → VERIFY PASS 不得把過期
  的 FAIL 當事實端上——正是區塊在沒有確立任何事時為空、而非只有一個標題的理由。
- **工作階段與 FAIL 逐位元組相同。** PASS 分支以 `def.kind === "check"` 與 verdict
  把關；oracle 一致性測試涵蓋其餘。
- **逐條證據是一種讀法，不是證明。** 它不與觀察帳本比對；record 層級的
  `evidence` 仍然會。
