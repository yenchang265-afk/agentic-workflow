[English](main-sitter.md) | 繁體中文

# main-sitter

監看預設分支的 CI：一旦變紅，就針對那個確切的 head 診斷失敗原因（必要時執行
bisect），寫出一個已驗證的正向修復（forward fix）或還原（revert），然後
開啟一個 draft 補救 PR——並在肇因 PR 上留言一次。**絕不會推送被監看的分支；
合併永遠是人類的決定。**

DIAGNOSE → REMEDY → VERIFY → PUBLISH（最多 2 次疊代）

## 啟用

加進 `.agentic-loop.json`：

```jsonc
{
  "loops": {
    "main-sitter": {
      "enabled": true,
      "branch": "main"
    }
  }
}
```

`branch` 預設是遠端的預設分支。所有設定項見 [`docs/sitters.md`](../sitters.md)。

## 指令

**OpenCode**

```
/agentic-loop:main-sitter claim | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | stop | status
```

**Claude Code (MCP)**

```
/agentic-loop:main-sitter claim | status | stop
```

（Claude Code 沒有常駐的 watcher；再次呼叫 `claim` 以輪詢是否有變紅的 CI。）

## 架構

監看被監看分支的 CI（`gh run list`，或在 ADO 上透過 Azure Pipelines Build
API）：一旦最新一次已完成的 head 變紅，就依序執行 **diagnose**（worktree
釘選在那個變紅的 head 上，必要時執行 bisect）→ **remedy**（worktree；寫出
最小的正向修復，或執行一次 `git revert`）→ **verify** → **publish** 在
`main-sitter/*` 分支上開啟一個 **draft 補救 PR**，並在肇因 PR 上留言一次。
它**絕不會自行推送被監看的分支**；合併永遠是人類的決定。

- **`loops.main-sitter.enabled`** —— 預設關閉。
- **`loops.main-sitter.branch`** —— 覆寫被監看的分支；未設定時 ⇒ 遠端的
  預設分支（來自 `origin/HEAD`，找不到則回退到 `main`）。

## 範例：一次性 CI 修復

手動檢查 main 上是否有變紅的 CI 執行並修復它：

1. **認領變紅的 CI head**
   ```
   /agentic-loop:main-sitter claim
   ```
   輪詢被監看分支的 CI（GitHub Actions 或 Azure Pipelines），找出最新一次
   失敗的執行。若找到，執行 DIAGNOSE（checkout 那個確切的 head，必要時
   bisect 找出肇因 commit）、REMEDY（在 worktree 分支上寫出正向修復或
   revert）、VERIFY（再次執行測試套件），然後 PUBLISH（開啟一個 draft
   修復或 revert PR，並在肇因 PR 上留言）。由你手動審查並合併。

2. **檢查狀態**
   ```
   /agentic-loop:main-sitter status
   ```
   顯示目前正在診斷哪個 CI head，若 main 是綠燈則顯示「idle」。

## 範例：以 10 分鐘輪詢持續監看

設定一個常駐 watcher，快速攔截並修復變紅的 CI：

1. **啟動 watcher**
   ```
   /agentic-loop:main-sitter watch 10m
   ```
   （僅限 OpenCode。）`watch` 會把這個 session 變成 worker；它每 10 分鐘
   輪詢一次，每次認領一個變紅的 CI head 並無人值守地修復它。適合用在你希望
   CI 盡快恢復綠燈的高優先權儲存庫。

2. **停止 watcher**
   ```
   /agentic-loop:main-sitter stop
   ```
   從另一個 session/終端機執行（正在 watch 的 session 已被佔用），或先
   按 ESC/執行 `unwatch`。

## 延伸閱讀

- 四個 sitter 的共同點，以及威脅模型：[`docs/sitters.md`](../sitters.md)、[`docs/design/threat-model.md`](../design/threat-model.md)
- 指令參考：[`docs/opencode.md`](../opencode.md)（OpenCode）、[`plugins/claude/README.md`](../../plugins/claude/README.md)（Claude Code）
- 框架內部細節：[`docs/architecture.md`](../architecture.md)
