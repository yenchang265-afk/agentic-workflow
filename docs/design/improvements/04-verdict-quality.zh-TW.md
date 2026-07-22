[English](04-verdict-quality.md) | 繁體中文

# 04 — 裁定品質：結構化原因 + 多視角審查

兩個獨立的功能；依序實作（A 很小，且 B 完全不依賴 A 的任何東西，但 A 會讓
B 更頻繁操練的回饋迴圈變得更犀利）。

## A. 結構化裁定原因

### 背景

`loop_verdict`（`src/index.ts:95-111`）只會記錄 `stage + PASS/FAIL/ERROR`。
*原因*則存在於階段的自由文字中，`composeArgs`（`state.ts:122`）會把它們當作
一整團原始散文（`Verify failure to address:` / `Review feedback to
address:`）串接進下一次疊代。重新規劃的 agent 得重新解析散文才能找出究竟
哪裡失敗，而稽核備註（`driver.ts:324-331`）只記錄裁定字母——稽核軌跡裡的
一個 FAIL 完全看不出*哪一項*驗收標準失敗了。

### 設計

為工具結構描述（`src/index.ts`）擴充可選的結構化欄位：

```ts
args: {
  stage: tool.schema.enum(["verify", "review"]),
  verdict: tool.schema.enum(["PASS", "FAIL", "ERROR"]),
  reason: tool.schema.string().max(500).optional()
    .describe("One-sentence summary of why — required in spirit for FAIL/ERROR."),
  criteria: tool.schema.array(tool.schema.object({
    criterion: tool.schema.string(),
    pass: tool.schema.boolean(),
  })).optional()
    .describe("Per-acceptance-criterion results, mirroring the criteria threaded into the stage prompt."),
}
```

一路傳遞下去：

- `recordVerdict` / `recordedVerdicts`（`driver.ts:141-157`）：儲存
  `{ stage, verdict, reason?, criteria? }`；`takeVerdict` 回傳完整記錄。在
  `verdict.ts` 中將其定型為 `VerdictRecord`（該型別的純淨歸屬地）。
- 稽核備註（`driver.ts:326-330`）：附加原因 + 未通過標準的數量 ——
  `VERIFY verdict: FAIL — 2/4 criteria unmet: "returns 429 over limit", … (iteration 2)`。
  維持在同一行（依照 `auditNote` 的契約，備註格式是按尾碼做 grep 比對——
  文字在前，時間戳尾碼在後）。
- 傳遞方式：`LoopState.artifacts` 維持 `string`（讓狀態機保持簡單）。取而
  代之的是，driver 會在 `advanceOnIdle` 把檢查階段的輸出存成 artifact
  *之前*，先在前面加上一個結構化區塊：

  ```
  FAILED CRITERIA (from loop_verdict):
  - returns 429 over the limit
  - limit configurable per route

  <stage's free text>
  ```

  `composeArgs`不需要變動；重新規劃／重新建置的提示詞現在會以機器記錄下來
  的失敗開頭，而不是把它們埋在散文裡。（僅變動 driver——`state.ts` 保持
  不動，純淨性得以保留。）

信任備註：`reason`/`criteria` 透過和裁定本身相同的權威工具呼叫傳入——
信任層級相同，沒有新增通道。它們引導的是下一次疊代的*提示詞內容*，而非
控制流程；控制流程仍然只由 `verdict` 決定。

- 更新 `.opencode/agents/verify.md` / `review.md` 的裁定契約章節：傳入的
  `criteria` 要對應你拿到的驗收標準；FAIL/ERROR 時務必傳入 `reason`。

### 測試

- 工具參數驗證（zod 接受／拒絕的形狀）——若既有工具測試存在就擴充它，
  否則用 driver 測試骨架。
- `recordVerdict` 會儲存、`takeVerdict` 會回傳完整記錄；階段／session 不符
  時仍會被忽略。
- Driver：帶有 criteria 的 FAIL → 下一階段組成的參數中會包含
  `FAILED CRITERIA` 區塊；PASS → 不含該區塊。
- 稽核備註會呈現原因 + 計數，尾碼格式維持不變（`auditNote` 的 grep 仍然
  比對得上）。

## B. 多視角審查

### 背景

REVIEW 是單一 agent、單一輪次。威脅模型 T1 的殘留風險：來自 repo 內容的
提示詞注入，說服*那一個 agent* 呼叫 `loop_verdict` PASS。目前的後盾是
疊代上限和人工 diff 把關。用 N 個具有不同視角、彼此獨立的審查輪次，能
大幅降低單一注入翻轉結果的機率——多元視角同時也能抓到不同類別的真實
缺陷（這正是 `references/orchestration-patterns.md` 建議採用視角多元化
驗證的原因）。

### 設計

- 設定（`src/config.ts` + `state.ts` 中的 `Config`）：

  ```ts
  /** Extra review lenses; each runs REVIEW once more with that focus. Unset/[] → single review (today). */
  reviewLenses: z.array(z.string().min(1)).max(5).default([]),
  ```

  建議的文件範例：`["correctness", "security", "test-adequacy"]`。

- Driver（`drive()`，在 `stage === "review"` 的觸發迴圈內部）：當設定了
  lens 時，在同一個 session 中**依序執行審查階段 N 次**（並行 session
  因為和計畫 01 相同的 SDK 發現而被排除——裁定工具就存在於這個
  instance 中）：

  1. 第 k 輪會附加到組成的參數上：
     `Review lens ${k}/${N}: focus exclusively on ${lens}. Other lenses are covered by separate passes.`
  2. 每一輪之後執行 `takeVerdict(sessionID, "review")`；在各輪之間清除
     `recordedVerdicts`（現有位於 `driver.ts:291` 的每階段清除邏輯，移進
     每輪的迴圈中）。
  3. **合併裁定 = N 輪中最差者**（`ERROR` > `FAIL` > `PASS` 的優先順序：
     只要有一個 ERROR 就停止迴圈；否則只要有一個 FAIL 就判定失敗；否則
     PASS）。任何一輪缺少裁定，就視同該輪 FAIL，與現行行為相同。
  4. 任務檔案上只有一則**合併後**的稽核備註，其原因欄位帶有由
     `combineRecords` 合併、以 `[lens]` 為前綴的反對意見；執行日誌則會有
     每一輪的輸出，並在標頭標明 lens（各 lens 的細分內容存在執行日誌中，
     而不是拆成多筆任務檔案備註）。
  5. 儲存的審查 artifact = 所有輪次輸出的串接（包含功能 A 帶來的結構化
     原因區塊），這樣重新建置的提示詞就能看到每個 lens 的反對意見。

- 成本是明確且有文件記載的：每次疊代要花 N 倍的審查 token／實際耗時。
  階段逾時是**按每一輪**套用的（每一輪都是一次 `runStage` 呼叫——逾時的
  計算方式不變）。

- 保持 `state.ts` 不動：lens 是在 driver 層級對單一邏輯審查階段所做的
  展開。`advanceOnIdle` 看到的仍然是單一次帶有合併裁定的審查完成事件。
  這讓純狀態機的契約（「審查以裁定 V 完成」）維持完整。

### 邊界情況

- 某一輪 lens 逾時 → 該輪拋出例外，迴圈進入錯誤狀態（和現行的審查逾時
  行為相同）。這比部分 lens 裁定要來得簡單也更安全。
- 在各輪之間執行 `/agent-loop stop` → 現有的 `!getLoop(sessionID)` 檢查
  （`driver.ts:304`）會逐輪執行；把它加進 lens 迴圈中。
- 設定了 `reviewLenses` 但達到了 `maxIterations` —— 互動方式不變；lens
  改變的是裁定品質，不是疊代計數方式。

### 測試

- 純函式形式的合併裁定函式（`worstOf(verdicts: (Verdict|null)[])`）——
  放進 `verdict.ts`，以表格驅動測試：只要有 ERROR → ERROR，否則只要有
  FAIL/null → FAIL，全部 PASS → PASS。
- Driver 測試骨架：3 個 lens → 3 次審查觸發，參數中帶有 lens 行；混合
  裁定 → 合併結果為 FAIL 並觸發重新建置；全部 PASS → 完成；空設定 →
  恰好觸發一次審查（作為現行行為的回歸防護）。

## 需要更新的文件

- `README.md` + `.opencode/commands/agent-loop.md` —— `reviewLenses`
  設定項、成本備註；裁定工具更豐富的參數。
- `skills/workflow-orchestration/SKILL.md` —— 裁定契約章節（reason/criteria）、
  多視角審查說明。
- `.opencode/agents/{verify,review}.md` —— 裁定契約更新（A）以及 lens
  聚焦行為（B）。
- `docs/design/threat-model.md` —— T1：新增多視角審查作為緩解措施；
  殘留風險縮小為「需要 N 次同時得逞的說服」。
