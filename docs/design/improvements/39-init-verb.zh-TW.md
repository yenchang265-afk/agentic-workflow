[English](39-init-verb.md) | 繁體中文

# 39 — `init` 在第一天就搭好一個 repo

**狀態：已實作。**

## 問題

沒有任何東西替 repo 做初始設定。狀態資料夾是惰性出現的（`moveTask`/
`createTask` 在使用點 mkdir）、repo 設定是一個要記得的檔名、要手寫的檔案，
backlog 的 git-exclude 發生在第一次 claim——對 loop 全都沒問題，對正在
onboarding 新 repo 的人全都不可見：結構是看著它逐漸實體化才學會的。
installer 設定的是「外掛」（含 user 層設定），刻意不碰任何 repo。

## 改了什麼

- **`initRepo`**（`workflow/init.ts`）：建立 `tasksDir` 的狀態資料夾、在
  不存在時寫入 `.agentic-workflow.json`，並在 `ignoreBacklog` 開啟且目錄是
  git repo 時，跑 claim 路徑用的同一個 `ensureExcluded`——init 後的第一個
  `git status` 就已經乾淨。回傳結構化報告（`createdDirs`/`kept`/
  `configCreated`/`excluded`）加上 host 呈現的一行摘要，結尾點名自然的
  下一步（`new <idea>`）。
- **每個 host 都有這個 verb**：OpenCode 像 `doctor` 一樣決定性地處理
  `init`；Claude/Qwen 得到 `workflow_init` MCP 工具與 verb 區塊。
  argument hint、router、文件的 verb 清單全都列上它。

## 尖銳邊角

- **可重複執行，絕不覆寫。**每一步都是「不存在才建立」；重跑會回報
  `kept` 並且不改任何東西。既有的設定檔——再怎麼殘缺——都是人類的，
  「init 修了我的設定」是一份等著發生的 bug report。測試釘住第二次執行
  不發出任何寫入。
- **骨架只含安全鍵**（`initConfigSkeleton`）：`tasksDir` 與
  `maxIterations`，把預設值變得可見。不含任何 shell-bearing 或憑證形狀的
  鍵——那些僅限 user 層（`droppedRepoKeys`），搭建它們等於寫出一個執行期
  立刻警告的檔案。
- `tasksDir` 內不放 README 或占位檔：`auditBacklog` 把那裡的任何雜散檔案
  讀成損壞，`doctor fix` 會把它「搶救」進 `draft/`。
