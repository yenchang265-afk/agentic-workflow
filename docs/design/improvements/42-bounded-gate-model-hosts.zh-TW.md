[English](42-bounded-gate-model-hosts.md) | 繁體中文

# 42 — 模型 host 上的閘門操作不會吊死、也不會弄丟信封

**狀態：已實作。**

## 問題

設計 21 只在 OpenCode 綁住了閘門 shell——但吊死這一類故障與 host 無關。
在 Claude Code / Qwen 上，慢速檔案樹（WSL `/mnt/c`，正是 PR #266 那次
吊死發生的樹）上的 `workflow_approve` 或 `workflow_ship` 會讓 MCP 呼叫
永遠停在 `running`，把 orchestrator 的回合卡在後面。再深一層，gate
HOOK 有同樣的時間窗、但失敗更糟：Claude Code 會在它自己的期限（預設
60 秒）殺掉 command hook 並丟掉整個信封——GateResult 和
`decision: "block"` 一起丟——所以一次慢閘門（冷啟動 node 加上 `/mnt/c`
樹上的一次 commit）以無聲的重複派發收場：移動已經落地、block 丟了、模
型又經由 MCP 重跑一次動詞。

## 改了什麼

- **MCP server 的 `gateCtx` 交給 core 一個有界 shell**：每條命令有 60
  秒上限，走 shim 自己的 `.timeout`——它（不像 OpenCode 的計時器競速備
  援）真的會殺掉子行程並以 exit 124 結束（`timeout(1)` 的慣例，core 讀
  作普通的失敗命令）。移動照樣回報；只有 best-effort 的記帳被略過。
- **gate hook 的 `spawnSync` 加 50 秒期限**——比 host 自己殺 hook 早 10
  秒，信封因此始終在我們手上。`decideGateOutcome` 增加獨立的 ETIMEDOUT
  arm，直接 BLOCK（fail closed）：超時不是崩潰——CLI 死在半路，移動可能
  已經落地，fail open 等於邀請重複移動。block 訊息點名重試前該檢查什麼
  （`status`、backlog 資料夾）。
- Qwen 的 bundled `gate-command.mjs` 由同一份來源重新生成。

## 尖銳邊界

- **普通的 `sh` 維持無界。**checkpoint commit、worktree 建立與
  `runChecks` 本來就合法地跑很久、各有自己的機制——上限只接在
  `gateCtx()`，範圍規則與設計 21 相同。
- **60 秒是刻意寬鬆的**：最慢的合法閘門命令是出貨的 `git push` /
  `gh pr create`，把它切短的代價是一次人可以手動補完的 caveated ship
  ——而不設上限的代價曾是一個永遠不回來的呼叫。
- **超時 arm 必須排在 fail-open arm 之前**：通用的 spawn-error 放行是為
  「node 根本沒跑起來」而存在的，超時不符合那個前提。
