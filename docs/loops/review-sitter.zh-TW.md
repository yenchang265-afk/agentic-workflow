[English](review-sitter.md) | 繁體中文

# review-sitter

監看請求你審查的 pull request：在周圍程式碼的脈絡下閱讀 diff，並為每個被
請求審查的 head 張貼一則結構化的審查留言。**絕不核准、要求修改或合併——
人類審查者仍是正式的審查者（reviewer of record）。**

FETCH → ASSESS → PUBLISH（沒有重試迴圈）

## 啟用

加進 `.agentic-loop.json`：

```jsonc
{
  "loops": {
    "review-sitter": { "enabled": true }
  }
}
```

預設的查詢字串（`is:open review-requested:@me`）可透過
`loops.review-sitter.query` 覆寫（僅限 GitHub，與 pr-sitter 相同）。所有
設定項見 [`docs/sitters.md`](../sitters.md)。

## 指令

**OpenCode**

```
/agentic-loop:review-sitter claim | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | stop | status
```

**Claude Code (MCP)**

```
/agentic-loop:review-sitter claim | status | stop
```

（Claude Code 沒有常駐的 watcher；再次呼叫 `claim` 以拉取下一個 PR。）

## 架構

監看**別人的** PR 中請求你審查的項目——絕不是你自己的 PR。工作來源
`github-pr` 搭配 `role: reviewer`，查詢字串 `is:open review-requested:@me`
（可用 `loops.review-sitter.query` 覆寫，僅限 GitHub）；在 ADO 上它會認領
`ado.selfLogin` 是審查者且投票仍待處理（vote 0）的活躍 PR。**fetch**
（唯讀）→ **assess**（worktree；在周圍程式碼的脈絡下閱讀 diff，可能會
執行測試套件）→ **publish** 為每個被請求審查的 head 張貼**一則結構化的
審查留言**。權限**僅限留言**——它絕不核准、要求修改或合併，因此人類仍是
正式的審查者。只有在人類推送一個新的 head 時才會再次觸發；fork 和 draft
的 PR 會被跳過。

- **`loops.review-sitter.enabled`** —— 預設關閉。
- **`loops.review-sitter.query`** —— 僅限 GitHub；預設為
  `is:open review-requested:@me`。

## 範例：一次性審查一個 PR

手動觸發迴圈以審查一個待處理的 PR：

1. **認領一個 PR**
   ```
   /agentic-loop:review-sitter claim
   ```
   輪詢下一個請求你審查的 PR。執行 FETCH（取得 diff）、然後 ASSESS
   （閱讀程式碼並撰寫審查意見）、然後 PUBLISH（把審查意見張貼為留言）。
   留言內容包含觀察、問題和/或建議，但絕不核准或要求修改——你仍是正式的
   審查者。

2. **檢查狀態**
   ```
   /agentic-loop:review-sitter status
   ```
   顯示目前正在審查哪個 PR，若沒有待處理項目則顯示「idle」。

## 範例：以 idle 觸發的 watcher 持續審查

讓迴圈在你閒置（idle）時自動監看並審查 PR：

1. **啟動 idle 觸發的 watcher**
   ```
   /agentic-loop:review-sitter watch idle
   ```
   （僅限 OpenCode。）`watch` 會把這個 session 變成 worker；它會在每次
   session 進入閒置狀態時認領一則新的審查，而不是依固定的計時器觸發。
   適合用在你想要在不設定排程的情況下持續發出審查意見的情境。

2. **停止 watcher**
   ```
   /agentic-loop:review-sitter stop
   ```
   從另一個 session/終端機執行（正在 watch 的 session 已被佔用），或先
   按 ESC/執行 `unwatch`。

## 延伸閱讀

- 四個 sitter 的共同點，以及威脅模型：[`docs/sitters.md`](../sitters.md)、[`docs/design/threat-model.md`](../design/threat-model.md)
- 指令參考：[`docs/opencode.md`](../opencode.md)（OpenCode）、[`plugins/claude/README.md`](../../plugins/claude/README.md)（Claude Code）
- 框架內部細節：[`docs/architecture.md`](../architecture.md)
