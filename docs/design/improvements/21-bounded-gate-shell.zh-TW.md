[English](21-bounded-gate-shell.md) | 繁體中文

# 21 — 不可能永遠懸置的閘門移動

**狀態：已實作。** `packages/core/src/claim-marker.ts` 的 `sweepStampTemps`、
`plugins/opencode/src/bounded-shell.ts` 的 `boundedShell`（經由 `gateCtx` 接上）、
`plugins/opencode/src/impl.ts` 中包住四個模型可呼叫工具的 `withinDeadline`、
`plugins/opencode/src/workflow/driver.ts` 閘門路徑上射後不理的 toast 與階段日誌；
`bounded-shell.test.ts`、`claim-marker.test.ts`、`driver.test.ts`、
`scripts/shell-glob.test.mjs`。

## 背景

在 OpenCode TUI 回答任務閘門的「核可嗎？」之後，模型會呼叫 `workflow_gate`，
而該工具再也沒有回傳。TUI 一直轉，直到使用者砍掉 opencode。

儲存的 session 狀態與工作樹對「停在哪裡」的說法一致：那筆工具呼叫停在
`status:"running"`，有起始時間、沒有結束時間。任務檔在 200 毫秒內就**已經**從
`draft/` 移到 `queued/` 並寫好稽核註記——然後任何地方都不再有任何寫入。前一天同一個
工具也這樣過：懸置 105 秒，在人按下 ESC 後以 `"Tool execution aborted"` 結束，而幾秒
後的重試在 **116 毫秒**內完成，因為它走的是 `approveTask` 的 `alreadyDone` 分支。
那次重試正好排除了函式的尾段：它 await 的是懸置那次原本會走到的同一個 toast 與同一個
`armTaskGateAsk`。它沒有執行的，是這次移動自己的 shell 工作。

那裡的頭號嫌犯是一個 glob——全庫唯一的一個：

```ts
await $`rm -f ${stampPath(markerDir)} ${stampPath(markerDir)}.tmp-*`.quiet().nothrow()
```

兩個 host 都會逸出內插值，也都不會逸出樣板自身的文字，所以這個 token 是「被引號包住的
前綴」焊上「沒被引號包住的 `*`」，指向一個通常不存在的 `.claims/<id>/` 目錄。展開它，是
本庫任何 `$` 呼叫唯一能做的無界工作，而它展開的目錄樹是 WSL 的 `/mnt/c`（DrvFs）掛載。
同一次呼叫裡每個有界的兄弟指令——`test`、`mkdir`、`mv`、`printf`——都在毫秒前成功了。

glob 是個案。真正的類別是：**閘門移動在任何一層都沒有期限**——shell 沒有，工具也沒有。
OpenCode 本身不施加任何期限，所以「外掛還在等」與「使用者的 session 死了」是同一個狀態。

## 設計

三層，讓這個類別即使個案診斷錯了也一樣死透。

- **不得有字面 glob。** `releaseMarker` 改用
  `find <dir> -maxdepth 1 -name ${pattern} -delete` 清掉 stamp 暫存檔。樣式以逸出過的
  內插值進入——沒有任何 shell 會展開它，由 `find` 自己比對，`-maxdepth 1` 把走訪限制在
  marker 目錄內。`scripts/shell-glob.test.mjs` 用 TypeScript 自己的 parser 掃過每個出貨
  原始檔（本庫的散文滿是 `` `$` `` 與反引號括起的範例指令，純文字掃描只會產生誤報），
  任何 `$` 樣板裡出現字面 `*` 就失敗。
- **閘門動詞專用的有界 `$`**（`boundedShell`，每道指令 60 秒，只接在 `gateCtx`）。
  逾時的呼叫解析為 exit **124**——`host.ts` 早就為 Bun `$` 未實作的選用
  `ShellPromise.timeout` 指定的 `timeout(1)` 慣例——並記下一行點名該指令的警告。core 的
  呼叫端一律 `.nothrow()` 並依 exit code 分支，所以逾時的降級方式與「指令失敗」完全相同：
  閘門移動照樣回報，只有盡力而為的簿記被跳過。
- **每個模型可呼叫工具都有期限。** 閘門工具用模型能據以行動的句子回答；判決工具則用丟出
  例外，因為回傳字串會被讀成成功，而沒被記錄的判決必須重試。`workflow_gate` 的訊息會邀請
  重試——只因為 `alreadyDone` 讓重複核可成為 no-op 才安全——而 `workflow_plan` 明確不邀請，
  因為那次呼叫會認領任務並把人的 session 交給 PLAN 驅動。

調查過程還逼出兩件小事：`report()` 與 `gateFromAgent` 現在是射出 toast 而非 await
（`.catch()` 防的是 reject，不是懸置——而 `report` 跑在 command hook 路徑上，一個永不
settle 的 await 會無聲地殺掉整個回合），以及 `gateFromAgent` 在 `approveAny` 前後各加一
行日誌。這次懸置的位置得靠檔案 mtime 與一個 5 GB 的 session 資料庫回推；下一次它會自己
報上名來。

## 刻意不做

- **`deps.$` 不設界。** 檢查點 commit、工作樹建置與 `runChecks` 本來就會跑很久，且各有
  自己的時限機制；用為檔案搬移挑的上限一刀切下去只會誤砍。
- **不取消任何東西。** Bun 的 `$` 不交出殺掉子行程的handle，與 `runChecks` fallback 記錄
  的殘留相同。逾時的指令可能仍在跑；警告會這麼說。
- **hub 的閘門情境未動**，Claude/Qwen MCP server 的工具也一樣。
  `packages/hub/src/server/gatectx.ts` 傳的是自己的 `sh`，那裡懸置只會拖垮一個 HTTP
  請求，不會卡死 session；MCP 工具則與 OpenCode 先前屬於同一個無界類別，但那個 host 的
  shim 確實有實作 `ShellPromise.timeout`，所以那邊的修法是另一個接線決策。兩者都照樣拿到
  去 glob 化的 `releaseMarker`。
- **driver 裡還有十二個 `await toast(...)`**（`runPark`、`watchTick`、`onIdle` 的錯誤
  分支）。它們位於「驅動」路徑而非 command hook 路徑，因此在那裡懸置只會卡住迴圈，不會
  無聲殺掉一個回合——但「toast 一律射後不理」現在是兩處而非一處的理想值。那是一次清掃，
  不是缺陷修復。
- **確切懸置的指令仍未證實。** glob 是這條路徑上唯一無界的候選，但
  `revokePlanRequestAt` 的 `rm` 與 `ensureExcluded` 的
  `git rev-parse`/`grep`/`mkdir`/`printf` 並未被證據排除。這正是 124 警告存在的理由：
  若還有下一次，它會連同指令一起出現在 log 裡。
