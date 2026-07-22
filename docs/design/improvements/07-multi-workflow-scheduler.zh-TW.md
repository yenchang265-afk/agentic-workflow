[English](07-multi-workflow-scheduler.md) | 繁體中文

# 07 — 在共用排程器上執行多種工作流程類型

## 背景

本儲存庫過去把單一一種 agentic 迴圈寫死在程式碼裡：作用在 `docs/tasks/`
資料夾待辦（backlog）上的工程（engineering）PLAN → BUILD → VERIFY →
REVIEW 流水線。流水線的形狀、狀態轉換、提示詞組合、狀態資料夾和階段指令，
都是散落在 `state.ts` 和兩個驅動程式中的字面值——而這兩個驅動程式本身就是
一次分岔（fork）：OpenCode 外掛（`src/`）和 Claude MCP 伺服器
（`claude-plugin/mcp-server/src/lib/`）各自複製了一份狀態機、儲存層、git
和持久化模組，導致每一次變更都要做兩次。

目標：支援多種 agentic 工作流程類型——工程工作流程、PR sitter、未來的其他
類型——共用同一個排程器，同時不改變工程迴圈的可觀察行為。

## 已完成的工作（四個增量，每個都在綠燈狀態下落地）

1. **`@agentic-workflow/core`**（`packages/core/`，npm workspaces）：純粹的
   工作流程引擎，以及每一個與 host 無關的模組（任務儲存、git + 隔離、持久化、
   裁定、指標、設定）都移進了一個建置出的套件，供兩個外掛共用。MCP 的
   分岔版本（`src/lib/`，約 18 個檔案）已被刪除；`shim.ts` 現在只是實作
   核心套件的 host 介面（`host.ts`：`Shell`、`Client`、`Log`）。
2. **清單（manifest）引擎**：一種工作流程類型就是一個資料夾
   `workflows/<kind>/`——`workflow.json`（zod 結構描述：階段、工作／檢查類型、
   帶有 fire/park/done/stop 效果的狀態轉換表、疊代上限、工作來源綁定、
   把關點、逐階段的 bash 白名單）加上 `stages/*.md` 提示詞範本。純粹的
   引擎（`core/src/workflow/engine.ts`：`advance`/`composePrompt`/`firstStep`）
   負責解讀它們；`manifest/registry.ts` 中具名的 TS hooks 則是清單無法
   表達的邏輯的逃生艙口。`workflows/engineering/` 轉錄了原本的流水線。
3. **工作來源 + 排程器**：`source/types.ts` 定義了
   `WorkItem`/`WorkSource`（`claimNext`/`release`/可選的 `onTerminal`）；
   `scheduler/scheduler.ts` 的 `pollOnce` 會依認領優先順序走訪各個已啟用
   類型的工作來源。待辦資料夾來源（`source/backlog.ts`）把儲存層原子性的
   `.claims/` 走訪邏輯重新組裝到這個介面之後。設定新增了一個
   `workflows.<kind>` 區塊（engineering 預設開啟，其他類型須自行選擇啟用）。
4. **PR sitter**（`workflows/pr-sitter/`）：作用在 `github-pr` 來源上的
   TRIAGE → FIX → VERIFY → PUBLISH（`source/github-pr.ts` +
   `source/ledger.ts`）。

## 關鍵設計決策

- **核心套件是一個「已建置」的套件，而不是共用原始碼。** OpenCode 外掛
  以 `moduleResolution: "bundler"` + `.ts` 匯入方式編譯（Bun 直接執行
  原始碼）；MCP 伺服器則以 `NodeNext` + `.js` 匯入方式編譯，輸出
  `dist/`。單一一份原始碼樹沒辦法同時滿足這兩種編譯器，所以核心套件會
  建置到 `dist/`（NodeNext，含型別宣告），兩者都透過子路徑匯出
  （`@agentic-workflow/core/workflow/engine`）來使用它。根目錄的 `prepare` 腳本
  會在 `npm install` 時建置核心套件。
- **刪除之前先做黃金基準（golden parity）比對。** 清單引擎導入之前的
  `composeArgs`/`advanceOnIdle` 被逐字凍結在 `core/src/workflow/engine.test.ts`
  中作為對照基準（oracle）；測試套件會用真正的 `workflows/engineering/`
  檔案，斷言引擎在整張狀態轉換表上都能逐位元組重現它們（提示詞）並
  深度相等（狀態／動作）。只有通過之後，舊有的函式才會被刪除。
- **提示詞範本是分區塊的，而不是自由格式。** 一個階段提示詞檔案是以
  `---` 分隔的多個區塊；每個區塊各自獨立渲染（`{{var}}` 點路徑內插、
  `{{#path}}…{{/path}}` 真值判斷區塊），空區塊會被捨棄，剩下的區塊以
  一個空行連接——這正是原本 `composeArgs` 所用的「片段（parts）」模型，
  也正是能達成逐位元組一致性的原因。可推導出的內容（審查 diff 指令、
  worktree 釘選段落）由引擎（`promptContext`）預先算好，因此一般的工作流程類型不需要撰寫組合用的 hook。
- **資料夾狀態仍然是工程類型專屬的。** 狀態資料夾是待辦工作來源的一個
  屬性（在其清單綁定中具名），而不是一個全域概念：PR sitter 完全沒有
  資料夾——GitHub 加上它自己的帳本（ledger）就是狀態本身。儲存層具型別
  的 7 個資料夾生命週期，目前是刻意**不**參數化的（目前還沒有第二種以
  待辦資料夾為基礎的類型可以用來塑造它）。
- **`onTerminal` 讓工作來源的迴圈閉合。** 驅動程式會把每一個終端動作
  （done/park/stop/error）回報給進行認領的那個工作來源。待辦來源不需要
  做任何事（終端記帳搭著任務檔案本身走）；PR 來源則會在此結清它的帳本
  和認領標記。
- **帳本水位線（watermark）杜絕自我觸發。** PUBLISH 的 `onTerminal`
  會重新讀取這個 PR，並把推送後的 head SHA 和最新留言的時間戳記記錄為
  「已處理」——sitter 自己的推送／回覆絕不會再次觸發它自己。一次觸發
  上限或被中止的執行，會記錄一筆釘在該次認領 head 上的
  `failedAttempt`，因此這個 PR 會暫停，直到有人類推送改變了 SHA 為止。
  以 sitter 自己帳號發出的留言會在輪詢時被過濾掉。

## 功能 → 程式碼路徑

| 關注點 | 位置 |
|---|---|
| 清單結構描述 + 驗證 | `packages/core/src/manifest/schema.ts` |
| 提示詞範本語言 | `packages/core/src/manifest/template.ts` |
| Hook／判斷式登錄表（逃生艙口） | `packages/core/src/manifest/registry.ts`, `kinds/engineering.ts` |
| 清單載入（`workflows/<kind>/`） | `packages/core/src/manifest/load.ts` |
| 純粹引擎（advance/composePrompt） | `packages/core/src/workflow/engine.ts` (+ golden parity in `engine.test.ts`) |
| 工作來源介面約定 | `packages/core/src/source/types.ts` |
| 待辦來源（engineering） | `packages/core/src/source/backlog.ts` |
| GitHub-PR 來源 + 去重帳本 | `packages/core/src/source/github-pr.ts`, `source/ledger.ts` |
| 排程器輪詢 | `packages/core/src/scheduler/scheduler.ts` (`pollOnce`) |
| 各類型的設定與啟用 | `packages/core/src/config.ts` (`workflows`, `enabledWorkflowKinds`) |
| OpenCode 接線（watch/idle → pollOnce） | `src/workflow/driver.ts` (`tryClaim`, `sourcesFor`, `drive` returns the terminal outcome) |
| Claude 接線（`workflow_claim` → pollOnce） | `claude-plugin/mcp-server/src/server.ts` |
| 階段守衛（標記白名單） | `claude-plugin/hooks/check-stage-guard.mjs` + `runs/.stage.json` `{kind, bashAllowlist}` |
| PR-sitter 階段人設 | `.opencode/agents/workflow-pr-*.md`, `claude-plugin/agents/workflow-pr-*.md` |

## 限制／後續工作

- **會跳過來自 fork 的 PR**（`isCrossRepository`）——sitter 沒辦法把
  head 分支推送回去，而且無人值守地建置攻擊者撰寫的分支是明確不做的
  功能（威脅模型 T10）。
- **單一儲存庫的 `gh`**：這個來源只會輪詢目前簽出（checkout）的那個
  儲存庫。
- **目前還沒有逐類型的狀態資料夾**：等到出現第二種以待辦資料夾為基礎
  的類型，就會迫使我們把儲存層具型別的狀態集合做 `makeLifecycle`
  參數化。
- **MCP 仍維持單一運作中迴圈**；OpenCode 在共用樹（shared-tree）模式
  下則是依工作目錄序列化——並行策略仍然是逐 host 各自決定，這是刻意的
  設計。
- **`workflow_start <id>`／把關點／recover 仍然是工程類型專屬的動詞**；
  PR-sitter 的工作只會透過排程器（`watch` / `workflow_claim`）送達。
