[English](73-per-repo-user-config.md) | 繁體中文

# 73 —— 使用者層級設定的每 repo 區段

**狀態：已實作。**

## 問題

使用者層級設定對每個 checkout 一視同仁。兩個 repo 想要不同的 `stageModels`、只有其中一個要
`notifyCommand`、或 `worktreesDir` 放在另一顆磁碟，只有一條路：把差異提交進各 repo 的
`.agentic-workflow.json`——而 repo 層設計上不能承載帶 shell 與允許清單的鍵。

## 改了什麼

- **使用者層的 `repos`**：`{ "<絕對路徑或 basename>": { …任何設定鍵… } }`。`userRepoOverrides`
  以精確的絕對路徑（`path.resolve` 後、展開 `~`）優先於 basename——確定性，絕不是「哪個鍵先
  來」——`applyUserRepoOverrides` 把區段疊在全域使用者鍵之上並移除 `repos` 本身。優先序：
  全域使用者鍵 < 使用者 `repos.<match>` < repo 檔。
- **每個讀取器都遵守**：`loadConfigWith`、無 zod 的 `readRawConfigLayers`（它餵給模型綁定
  hook——迴圈遵守而 hook 不遵守的每 repo `stageModels` 會讓每次生成跑錯模型且什麼都不會失敗）、
  管理面板的設定視圖與來源標記、Qwen 安裝程式自己的合併。
- **已宣告**：`RepoOverrideSchema` 是基底物件的 partial，所以區段會被驗證、被 JSON Schema 補全、
  且不能再巢套 `repos`；**repo** 檔裡的 `repos` 鍵會被丟掉並指名（family `userOnly`）——從
  clone 遵守它會讓 repo 用包裝重新授予自己帶 shell 的鍵。
- **`effectiveConfigReport.matchedRepoSection`** 指名套用的鍵；兩種 host 的 `doctor config`
  都會說。

## 尖銳邊角

- **區段只覆寫，不給預設。** 合併在解析前於原始層進行；schema 的預設只套用一次、在合併後
  的視圖上。
- **絕對路徑優先於 basename。** basename 方便但模稜兩可；完整路徑才是人刻意寫下的。
