[English](61-config-json-schema.md) | 繁體中文

# 61 —— 從解析器產生的 `.agentic-workflow.json` JSON Schema

**狀態：已實作。**

## 問題

設定的形狀只存在於 zod 裡。編輯器無法補全鍵或標出錯誤型別，`docs/configuration.md`
逐欄位的參考是唯一能對照的東西——會漂移的散文。zod 4 原生就能渲染 JSON Schema；
沒有東西呼叫它。

## 改了什麼

- **`configJsonSchema()`**（`config-schema.ts`）以 `io: "input"`（讓 `prBase` 的
  transform 顯示其輸入端）與 `unrepresentable: "any"` 渲染 `ConfigSchema`，
  `$schema`/`$id`/`title` 放在物件最前面，檔案的 diff 才乾淨。
- **`schema/agentic-workflow.schema.json`** 已簽入，由 `pnpm gen:schema`
  （`scripts/gen-schema.mjs`，像 `build-hooks` 一樣讀 core 建好的 dist）寫出。
  `scripts/config-schema.test.mjs` 是漂移閘門：新增設定鍵卻沒重新產生會讓
  `test:all` 失敗。
- **`$schema`** 是已宣告的選填鍵，所以 `"$schema": "./schema/agentic-workflow.schema.json"`
  （或 GitHub raw URL）能通過驗證，也不會被回報為未知（設計 60）。

## 尖銳邊角

- **refinement 不在 schema 裡。** `superRefine`（platform 為 `ado` 時需要 `ado` 區段）與
  `.refine` 述詞無法表達；執行期仍會強制，檔案的 description 也這麼說。
- **`workflows.<kind>` 維持 `additionalProperties: true`。** 該區段刻意寬鬆，所以 schema
  標不出 `enable`——設計 60 的近似 lint 是互補，不是重複。
