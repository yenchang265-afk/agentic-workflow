[English](33-ship-gate-diff-aid.md) | 繁體中文

# 33 — Ship gate 以它所把關的 diff 開場

**狀態：已實作。**

## 問題

Ship gate 的整個契約是「人類審閱分支 diff，然後批准」——但沒有任何地方真的算過
那個 diff。done note 只寫了分支名就停了；OpenCode 的 toast 說「Review the diff
on branch X」，讓人自己重建範圍；Claude host 把這件差事寫成 prose（「show the
user the loop branch's diff summary」），也就是要 MODEL 去推導這個 gate 唯一
在乎的東西；hub 的 review queue 完全沒有 diff 檢視。產品程式碼裡找不到任何
`--stat`、`--shortstat` 或 `--numstat`。要判斷這是兩行修正還是四十個檔案的重寫，
人得自己去查。

## 改了什麼

- **`diffShortstat`**（`workflow/git.ts`）：從主 checkout 以 REF 執行一次
  `git diff --shortstat <base>...<branch>`——不論分支在 worktree、在這棵樹上、
  或根本沒被 checkout 都可用。輸出以 shortstat 的形狀驗證而非信任：它會落在
  下游 parser 錨定的 audit 行上，所以 git 的雜訊必須讀成「沒有 stat」。
- **`runDone` 在 run 還記得自己範圍時就計算**——ship gate 稍後才在全新的
  process 裡執行——並串到三個地方：
  - done note 尾端加上 `; diff: 3 files changed, …` 子句
    （`RUN_DIFF_PREFIX`）。放在最後是因為它的文字帶逗號，而 `runDoneField`
    在各前綴後的第一個逗號截值——branch/base 都在行的更前面，所以不受影響
    （store.test 釘住的正是這個 regression）。
  - `TerminalReport` 的 done arm 增加 `diffstat` 與 `diffCmd`（可直接交給
    人類的 `git diff <base>...<branch>` 字面指令）——OpenCode toast 與 Claude
    `workflow_advance` 的 ship-gate descriptor 現在以數字和指令開場，而非一件差事。
  - **`extractRunDiffstat`**（`task/store.ts`）從 note 讀回——與旁邊的 ref
    同樣的 last-marker + stamp 規則——hub 的 review queue
    （`ReviewItem.branch`/`diffstat`）在每張 in-review 卡上顯示
    「3 files changed, … on feature/x」，且不花任何額外 IO（body 本來就在手上）。

## 尖銳邊角

- 每種失敗都退化成 clause 出現之前的行為：探測失敗 → 沒有子句、舊 note
  逐位元組相同；note 早於 clause → hub 與 parser 讀到 `null`/`undefined`，
  永遠不是錯誤。
- stat 是顯示資料，但它與會進 `git push` 的 ref 只隔一行——所以兩端（writer
  與 parser）都做嚴格形狀檢查，不是只做一端。
- Current-branch 模式不變照樣可用：base 是 sha，而
  `git diff <sha>...<branch>` 對 stat 與交付的指令都是合法範圍。
