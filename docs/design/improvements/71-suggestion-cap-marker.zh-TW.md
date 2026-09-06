[English](71-suggestion-cap-marker.md) | 繁體中文

# 71 —— 建議上限會說它砍掉了什麼

**狀態：已實作。**

## 問題

`suggestionFindings` 把 REVIEW 的非阻擋性發現截在十筆，以前提前回傳而不計數，所以 done
註記的 `Review suggestions (N)` 是**截斷後**的數字、讀起來像真相；OpenCode 的 toast 與 Claude
的出貨描述重複它。第十一筆建議在人會看的每個地方無聲消失。

## 改了什麼

- **`suggestionsElided(record)`** 計算上限砍掉了幾筆；`advance` 的 done 動作帶
  `suggestionsElided`，`TerminalReport` 轉送它。
- **稽核註記**在自由文字那半、截斷清單之後附上 ` (+K more not shown)`，`extractRunSuggestions`
  的 `(N)` 仍是渲染出的數量、正規表示式仍匹配；管理面板的審查列免費顯示標記。
- **OpenCode toast** 與 **Claude 出貨描述**指名餘數（`+K more past the cap`），描述帶著數字。

## 尖銳邊角

- **上限不變。** 十是出貨把關點會讀的量；標記告訴人其餘在 metrics sidecar，不放寬清單。
- **絕不進重建接縫。** 建議與其餘數只給 diff 審查的人看。
