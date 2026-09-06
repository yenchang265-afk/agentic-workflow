[English](69-sitter-docs-opt-in.md) | 繁體中文

# 69 —— 文件裡每個 sitter 區段都帶 `enabled`，由測試保證

**狀態：已實作。**

## 問題

每個 sitter 都需要選擇加入（`enabledWorkflowKinds`：非預設類型只在 `enabled: true` 時執行，
沒有它的區段會被警告為無效）。文件兩度偏離：sitter 區段缺少該鍵的快速上手設定了一個永遠
不會跑的 sitter。2026-08-23 的發現已修復，但 `docs/configuration.md`（及其 zh-TW 對照）
的 `prBase` 範例仍只顯示 `"dep-sitter": { "prBase": "main" }`，Qwen 頁面的指令表從未說任何
sitter 需要選擇加入。

## 改了什麼

- 兩個範例加上 `"enabled": true`；Qwen 頁面把四個 sitter 都標為（實驗性、需選擇加入）並
  陳述規則一次，旋鈕指向 `docs/sitters.md`。
- **`scripts/docs-sitter-enabled.test.mjs`** 解析整組文件中每個 ```json 圍欄區塊，遇到沒有
  `enabled` 的 `workflows.<選擇加入類型>` 區段就失敗——從 core 建好的 dist 讀
  `EXPERIMENTAL_KINDS`，新類型加入當天就被涵蓋。

## 尖銳邊角

- **無法解析的區塊會略過。** 帶 `<佔位符>` 的片段不是設定範例；只評判 `JSON.parse` 接受的。
