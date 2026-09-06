[English](68-build-test-rule-scope.md) | 繁體中文

# 68 —— 「先寫失敗測試」的規則限縮到行為

**狀態：已實作。**

## 問題

BUILD 人設要求「每個驗收條件（重建時每個審查發現）先寫一個失敗測試」——無條件。由可讀性、
架構、文件或命名發現、或沒有可利用路徑的安全強化驅動的重建，因此只有兩個誠實的結果：
恆真的測試（VERIFY 接著打回）或無聲的不遵守。`AxisFinding` 沒有行為旗標；到達 BUILD 的
唯一結構化訊號是軸名，`verdictFeedbackBlock` 已將其獨立成行渲染。

## 改了什麼

- **`prompts/agents/workflow-build/body.md` 第 2 步**現在要求每個驗收條件、以及每個修法會
  改變可觀察行為的發現——`correctness` 或 `performance` 發現、任何可重現的缺陷——先寫失敗
  測試，並禁止為不改變行為的發現製造測試，改為要求在 Test status 中指名守護該變更的既有
  測試。為了滿足規則寫出的恆真測試會被 VERIFY 打回。
- 由 `gen:prompts` 重新產生到每個 host 的代理檔。

## 尖銳邊角

- **以軸名為鍵，不改 schema。** 在 `AxisFinding` 上加 `behavioral` 旗標會碰到兩種 host 的
  `workflow_verdict` schema 與每個契約分支；軸名已在那裡，粗但足夠。只在證明太粗時再議。
- **人設，不是階段模板。** 規則住在代理本體，組合 oracle 不建模它，所以不需改 oracle。
