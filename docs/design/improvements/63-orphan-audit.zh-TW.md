[English](63-orphan-audit.md) | 繁體中文

# 63 —— doctor 稽核迴圈的遺留物：worktree 與分支

**狀態：已實作。**

## 問題

迴圈的遺留物是設計上會累積的：`teardownIsolation` 保留 worktree 讓下次執行在其中
繼續，出貨把關點只釋放 `completed/` 任務的。被放棄、移除或手動刪除的任務會永遠留下它的
`.workflow-worktrees/<id>` 與 `feature/<id>`。OpenCode 的啟動 reconcile 只指名
in-progress/in-review 任務的 worktree 就停了；Claude host 沒有對應物；沒有任何 host
列舉過分支。跑了一百個任務的 repo 帶著一百條分支，沒有東西說一聲。

## 改了什麼

- **`auditOrphans($, directory, config, kind, liveIds)`**（`workflow/orphans.ts`）：
  設定根目錄下的 worktree 與 `taskBranchPrefix` 下的分支，其 id 不在 `liveIds`
  （所有非終結資料夾）中者。絕不是主樹、絕不是可修剪的登錄、絕不是根目錄外的路徑。
  每條分支帶 `merged`——以 `git merge-base --is-ancestor` 對照預設分支——報告因此能說
  「可安全刪除：`git branch -d`」或「**未**合併——保有 commit」。current-branch 模式下
  為空，那裡沒有命名空間。
- **`removeOrphanWorktrees`** 是唯一的修復，經 `releaseWorktreeAt`：絕不 `--force`
  （髒的會保留並指名）、絕不動分支。
- **三個 doctor**（`workflow_doctor`、OpenCode 動詞、管理面板的面板）都回報這個區段並在
  fix 時移除 worktree；管理面板的 `DoctorReport` 多了 `orphans`/`orphanWorktrees`，
  fix 回應多了 `removedWorktrees`。
- **`workflow/git.ts` 的 `listBranches`/`isAncestor`**——用 `for-each-ref`，絕不用
  `branch --list` 帶裝飾的輸出。

## 尖銳邊角

- **doctor 絕不刪分支。** 未合併的 commit 是工作，即使已合併的分支也由人執行那行指名的
  指令來刪。
- **活著指任何非終結資料夾。** 停在把關點的任務保有它的 worktree；只有離開看板的任務才是
  孤兒。
