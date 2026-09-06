[English](67-contract-block-paragraphs.md) | 繁體中文

# 67 —— 契約區塊讀起來是段落

**狀態：已實作。**

## 問題

每個提示契約區塊（`verdictContractBlock`、`workScopeBlock`、`planContractBlock`、
`planVisualizationBlock`、`checkDiscoveryBlock`、`noMachineChecksBlock`、
`dependencyContractBlock`、`passFocusBlock`）都以陣列元素一句一條撰寫、卻以單一空格接合。
VERIFY 提示的尾端因此渲染成一段約 900 字的段落，`PLAN DEFECT:`、`ACCEPTANCE CRITERIA:`
與 `PROOF OF WORK:`——三個不同的子契約——在句子中間彼此相撞。區塊之間有空行分隔；缺陷在
每個區塊內部。

## 改了什麼

- **`verdict.ts` 的 `joinClauses`**：以全大寫標籤開頭的子句另起一段；其餘子句維持空格接合。
  套用在全部八處。沒有改任何措辭。
- 引擎在區塊之間的 `\n\n` 接合未動，`engine.test.ts` 的 oracle 匯入真正的建構器，所以組合
  一致性不需改 oracle 就成立。

## 尖銳邊角

- **看標籤，不看換行。** 在每個陣列元素處斷行會把半句話變成參差不齊的行；標籤的正規表示式
  正是區分子契約與接續句的依據。
