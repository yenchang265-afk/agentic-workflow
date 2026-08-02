[English](11-iteration-budget-prompts.md) | 繁體中文

# 11 — 在階段提示詞中揭示疊代預算

**狀態：已實作。** `packages/core/src/workflow/engine.ts` 的 `iterationCap`
與 `iterations` context 鍵，
`packages/core/workflows/engineering/stages/build.md` / `verify.md` 的區段；
測試在 `engine.test.ts`。

## 背景

`maxIterations` 為 BUILD→VERIFY→REVIEW 迴圈設限，且 `promptContext` 自
manifest 落地起就曝露了 `iteration` —— 但 engineering 的提示詞兩者都沒用。
實際做事的 agent 反而是唯一不知道預算的一方：重建時分不清這是 3 次中的第
2 次還是 20 次中的第 2 次；最後一次 VERIFY 也不知道它的 FAIL 文字即將成為
整場 run 的遺言 —— 而那正是人類 replan 閘門要讀的文字。

知道預算的 agent 會朝正確方向改變行為：升級策略而非重擲同一個修法，並為
必須據以行動的人類寫下最後的失敗說明。

## 設計

- `engine.ts` 的 `iterationCap(manifest, config?)` 是
  `manifest.maxIterations ?? config.maxIterations` 的唯一解析點，同時供
  `advance` 的停止判斷與提示詞組裝使用 —— 告訴 agent 的數字永遠不會與迴圈
  實際停止的數字漂移。
- `promptContext` 增加可選的 `cap` 參數與新的 `iterations` context 鍵
  （既有的字串 `iteration` 原封不動 —— 它已被文件化，改形狀會讓
  `{{iteration}}` 靜默渲染成空字串）：`{ human, cap, final? }`，以人類編號
  （iteration 0 是「1」），`final` 恰在 `iteration + 1 >= cap` 時為真 ——
  即 `advance` 的停止判準。
- 以 `iteration > 0` **且** cap 可解析為條件：每個階段的首次觸發與預算前
  的提示詞逐位元相同（凍結的 parity oracle 不動），無 config 的組裝（hub
  創建器預覽一份未宣告 cap 的 manifest）不會渲染出可能錯誤的數字，且訊息
  落在最需要的地方 —— FAIL 之後的重建。
- `build.md` 渲染「Iteration budget: this is iteration N of M」，外加最終
  疊代警告：此後的 check 失敗會停止迴圈、交回人類重新規劃；`verify.md`
  只在最終疊代警告它的 FAIL 文字就是 replan 閘門將讀到的內容。其他 kind
  不受影響 —— 模板不引用該鍵就什麼都不渲染。

## 捨棄的方案

- **常駐區段** —— 為一則在第 1 次疊代毫無內容的訊息，犧牲首次觸發逐位元
  不變的保證（以及 parity oracle）。
- **重用 `iteration` 鍵** —— 把文件化的字串改成物件，會讓既有的
  `{{iteration}}` 插值靜默變成空字串。
- **在組裝點再寫一次 `?? config.maxIterations`** —— 提示詞的數字與停止的
  數字必須出自同一個函式，否則會像當年 pass-mode 契約一樣漂移（見
  AGENTS.md：「focused pass 的契約必須符合實際會跑的 passes」）。
