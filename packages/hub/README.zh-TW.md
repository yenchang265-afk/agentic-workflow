[English](README.md) | 繁體中文

# @agentic-workflow/hub

> **測試版（Beta）。** 這個管理面板功能齊全，且在 API 層級經過測試，
> 但還很年輕：預期建立器（creator）畫布 UX 會有粗糙的地方，而且
> HTTP/JSON 介面可能還會在沒有遷移路徑的情況下變動。見
> [測試版狀態](#測試版狀態)。

agentic-workflow 框架的本機管理面板：**工作流程監視器**和**視覺化工作流程建立器**，以一個小型 web 應用程式的形式提供服務。

```bash
npm run hub -- --dir /path/to/repo    # from the repo root — builds core + hub, serves http://127.0.0.1:4317
node dist/server/main.js --dir /path/to/repo --port 4317        # direct, after building
node dist/server/main.js --dir /path/a --dir /path/b            # watch several repos
node dist/server/main.js --dir "/mnt/c/Users/me/projects/*"     # every loop repo under a parent
```

這個管理面板只會監看你指名的儲存庫：如果沒有 `--dir`，且使用者層級
設定中也沒有 `hub` 區塊，它會印出用法說明後結束，而不是假設用目前的
工作目錄。

**工作流程監視器** —— 每種類型一個看板，由其清單衍生而來：把關點欄位、
帶有人工把關動作（approve／replan／ship）的任務卡片，以及帶有各階段
token 用量的執行歷史。

![帶有把關點欄位和執行歷史的工作流程監視器看板](docs/screenshots/monitor.png)

**工作流程建立器** —— 把清單狀態機畫在一個畫布上：階段、狀態轉換，以及
一個側邊面板，用來編輯與引擎執行時相同的 `WorkflowManifestSchema`。

![顯示 engineering 迴圈各階段與狀態轉換的工作流程建立器畫布](docs/screenshots/creator.png)

**設定（Config）** —— 一次編輯 `.agentic-workflow.json` 的一個層級，
並為每個欄位標示其生效值的來源（這裡是 `REPO`）。

![帶有 REPO 來源欄位標記的設定分頁](docs/screenshots/config.png)

## Monitoring multiple repos

`--dir` 可以重複指定，其值可以包含 `*` 萬用字元（`*` 只在單一路徑
片段內比對，絕不會跨越 `/` 或比對開頭的點——shell-glob 風格；請加上
引號，避免你的 shell 先展開它）。明確指定的路徑會被逐字監看；萬用
字元比對到的結果只有在看起來像迴圈儲存庫時（存在 `.agentic-workflow.json`
或 `docs/tasks`）才會保留，因此一個裝滿無關檢出的父目錄會保持安靜。
被略過的比對結果會在啟動時列印到 stderr。

除了旗標之外，你也可以在**使用者層級**的 `~/.config/agentic-workflow/agentic-workflow.json`
（遵循 `$XDG_CONFIG_HOME`，且當此檔案不存在時仍會讀取舊有的
`~/.agentic-workflow.json` 作為後備；或 `$AGENTIC_WORKFLOW_USER_CONFIG` 所指向的檔案）中加入一個 `hub` 區塊。
它只有在沒有給出 `--dir` 時才會被使用；`--port` 仍然優先。管理面板
橫跨多個儲存庫，因此任何單一儲存庫 `.agentic-workflow.json` 中的 `hub`
鍵都會被忽略：

```json
{
  "hub": {
    "repos": ["/path/to/repo", "/mnt/c/Users/me/projects/*"],
    "port": 4317
  }
}
```

每個儲存庫都會拿到一個穩定的 id（它的 basename，slug 化，衝突時
加上 `-2` 後綴）。以儲存庫為範圍的 API 路由帶有 `?repo=<id>`，並預設
指向第一個儲存庫；`GET /api/repos` 會列出它們。當監看的儲存庫不只
一個時，SPA 的表頭會顯示一個儲存庫選擇器（選擇會保存在
localStorage 中），SSE 事件和把關點通知也都會標上儲存庫 id。工作流程類型不是以儲存庫為範圍的——它們存在於每個儲存庫共用的核心套件中，
因此建立器分頁不受影響。

## Tabs

- **工作流程監視器**：每個已啟用的工作流程類型都有一個子分頁，每個檢視都是
  由該類型的清單衍生而來——待辦型的類型會拿到一個看板，架在它自己的
  `docs/tasks/<status>/` 資料夾之上，把關點欄位取自清單中的
  park/done 目標（不是寫死的），PR 形態的類型則會拿到一個帳本
  （ledger）面板——再加上即時活動列（任一 host 的階段標記——Claude 的
  `.stage.json` 或 OpenCode 的 `.stage-opencode.json`——watch 租約
  存活狀態、可恢復的快照）、從 `runs/<id>.md` 解析出的執行歷史，以及
  各階段的 token 用量。即時更新透過 `fs.watch` + 一個輪詢協調器
  （DrvFs 安全）→ SSE 完成；啟用 🔔 可以在任務暫停於某個把關點時
  收到瀏覽器通知。

  任務卡片帶有各自欄位對應的**人工把關動作**——核准一份草稿或一份
  暫存的計畫、replan、ship——這些動作透過與各 host 呼叫的完全相同的
  `@agentic-workflow/core` 進入點執行，因此瀏覽器上的核准動作和斜線指令
  的核准動作是同一個經過稽核、經過提交的動作。每一個動作背後都有
  一個會明確說出其真實效果的確認步驟；**ship 還會開啟一個 pull
  request**。管理面板只把關、從不*驅動*：它從不認領工作、從不執行
  任何階段，並且會拒絕對一個已經有迴圈在驅動的任務做出動作。

  當待辦有結構性損壞時（一個迷途的檔案、一個憑空出現的資料夾、
  一個當機的迴圈留下的認領標記），異常標記（chip）會打開
  **待辦醫生（backlog doctor）**——和 CLI 執行的是同一個 `workflow_doctor`
  修復。它會把迷途檔案救援到 `draft/`、移除空的迷途資料夾，並釋放
  那些*過期、無迴圈在驅動*、否則會永遠拒絕把關動作的認領標記；
  重複的 id 則只會回報，不會處理。
- **工作流程建立器**：把清單狀態機畫在一個 React Flow 畫布上——
  work/check 階段是節點，fire/park/done/stop 狀態轉換是邊，側邊面板
  表單用來編輯階段欄位、效果（effects）、工作來源和階段提示詞。
  驗證執行的是真正的 `WorkflowManifestSchema`（前端即時回饋，儲存時
  再做一次伺服器端驗證）。儲存動作**只**會寫入
  `packages/core/workflows/<kind>/workflow.json` + 提示詞骨架，並回傳一份
  它刻意不產生的步驟檢查清單（agent persona、`gen:prompts`、指令
  wrapper、hook 註冊、啟用）。

  每個階段表單都能**預覽它的提示詞**，以迴圈實際組成時的樣子呈現，
  並附有可選狀態（task／git／worktree／platform）的切換開關——一個
  階段提示詞大部分都是條件式區塊，而值得抓出來的錯誤，就是一個
  悄悄永遠不會被觸發的區塊。
- **設定（Config）**：讀寫 `.agentic-workflow.json`。它**一次編輯一個
  層級**（這個儲存庫，或使用者層級），並為每個欄位標示其生效值實際
  來自哪裡——合併後的檢視永遠不會被寫回去，因為那樣會把你的使用者
  層級攤平進儲存庫檔案裡，還可能把 `ado.pat` 複製進一個你很可能會
  提交的檔案。核心 schema 不認得的鍵（僅限 host 用的
  `watchIntervalMinutes`、`hub` 區塊）會被保留，並列為「已保留」，
  因為編輯器寫入的是原始 JSON，而不是解析後的物件。各類型的專屬
  參數會有提示性的警告——迴圈是按位置讀取它們的，所以打錯字否則
  會被悄悄忽略。儲存後會重新載入管理面板；在 `$EDITOR` 中手動編輯
  也一樣會觸發重新載入。見
  [docs/configuration.md](../../docs/configuration.md)。

## Token usage sources

1. `runs/<id>.metrics.json` 側車（sidecar）檔案 —— 精確數字，由
   opencode 驅動程式寫入（每個階段的 tokens／花費／模型 + sessionID），
   也由 Claude 的 MCP 伺服器寫入（只有時間／裁定；它本身從不呼叫
   LLM）。
2. Claude 逐字稿（`~/.claude/projects/<slug>/*.jsonl`）—— 針對
   Claude host 的執行，用時間窗口歸因，並標記為 `estimated`。
3. `~/.local/share/opencode/opencode.db` —— 為舊的 opencode 執行提供
   session 總量回填；需要 Node ≥ 22.5（`node:sqlite`），否則會降級
   並附上原因。

## Safety model

本機工具，依設計沒有身分驗證：只綁定 `127.0.0.1`、拒絕非本機的
`Host` 標頭（防 DNS rebinding）、絕不提供 CORS，而且會產生變更的
路由都需要 `X-Hub-Client: 1` 標頭（跨來源頁面若不觸發失敗的
preflight 就無法送出這個標頭）。任務 id 在抵達檔案系統之前會先經過
slug 篩檢；工作流程類型的寫入被限制在 `packages/core/workflows/<kind>/` 內，
並經過 slug 驗證和前綴檢查。

管理面板只會用兩種方式寫入，而且沒有一種會驅動迴圈：

| 寫入動作 | 影響範圍 | 防護機制 |
|---|---|---|
| 儲存一個工作流程類型（建立器） | `packages/core/workflows/<kind>/` | slug + 前綴檢查；沒有 `overwrite` 就回傳 409 |
| 一次人工把關動作（approve／replan／ship） | `tasksDir` 下的任務檔案，加上一次 git commit——而 **ship** 還會額外開一個 draft pull request | `X-Hub-Client`；`expectStatus`（過期的看板會回傳 409，而不是把錯的任務放行）；當有迴圈正在驅動該任務時會被拒絕；有一個會明確說出其效果的確認步驟 |
| 儲存設定 | `.agentic-workflow.json` 的其中一層 | `X-Hub-Client`；層級明確（絕不是合併後的檢視）；以原始 JSON 寫入，因此未知的鍵會被保留；`ado.pat` 會被遮蔽，且拒絕寫入未被 gitignore 的儲存庫檔案；除非合併後的設定通過驗證，否則會被拒絕 |
| 待辦醫生修復 | `tasksDir` 下的任務檔案（救援迷途檔案、移除空的迷途資料夾、釋放**過期、無迴圈在驅動**的認領標記），加上一次 git commit | `X-Hub-Client`；只有在認領標記過期且沒有迴圈驅動時才會釋放；當 watch 租約仍存活時完全跳過認領釋放；絕不解決重複的 id |

它從不認領工作、從不執行任何階段，也從不合併任何東西。完整分析見
[docs/design/threat-model.md](../../docs/design/threat-model.md)
（T14–T16），包括誠實揭露的殘留風險：**沒有身分驗證**——任何以你的
身分執行的本機程序都能驅動它，所以不要在共用主機上執行它。

## Beta status

穩固（已做單元測試，並針對這個儲存庫做過即時驗證）：

- 每一個 `/api/*` 端點、SSE 監看器（fs.watch + 輪詢協調器）、
  執行紀錄／指標剖析器、graph↔manifest 的往返轉換，以及儲存防護

已知的測試版注意事項：

- **建立器畫布 UX** 還沒有經過互動式瀏覽器 QA——拖曳／連接和表單
  流程在設計上是可運作的，但需要真實滑鼠操作的磨合；如果發現任何
  卡頓，請回報
- **opencode.db token 回填**需要 Node ≥ 22.5（`node:sqlite`）；在
  較舊的執行環境上，面板會明確說明，並只顯示 sidecar／逐字稿的資料
- **Claude host 的 token 數字都是估計值**（從逐字稿做時間窗口歸因）——
  在 UI 中一律標記 `~`，絕不是精確值
- **API 形狀在測試版之間可能會變動**；管理面板是一個本機工具，目前
  還不應該有任何外部東西依賴它的 JSON
- **當有迴圈正在驅動該任務時，把關動作會被拒絕。** 管理面板是從
  檔案系統上讀出這件事的——一個認領標記，或是階段標記——因為它對
  某個 host 正在做什麼並沒有記憶體內的視圖。一個*擱淺*的認領
  （來自一個當機的迴圈）讀起來是一樣的，因此它會一直拒絕，直到那個
  認領被釋放為止；這是刻意的設計，因為另一個選項是在 BUILD 進行到
  一半時把任務重新排入佇列，並因此丟失工作成果
- **Ship 會開啟一個真正的 pull request** —— 這是唯一一個在你的機器
  之外可見的管理面板動作

## Development

```bash
npm run dev -w @agentic-workflow/hub        # esbuild --watch for the SPA (run the server via tsx separately)
npm run typecheck -w @agentic-workflow/hub  # server + web tsconfigs
npm run test -w @agentic-workflow/hub       # node --test via tsx
```

web bundle（`dist/web/`）是在本機建置的，從不會被提交進版本控制。
自動化測試涵蓋不到的手動 QA 項目：建立器的拖曳／連接 UX、關掉伺服器
後的 SSE 重新連線、Notification 權限流程、把關按鈕上的確認對話框，
以及在監看器（watcher）存活時嘗試進行一次把關動作——請在真實
瀏覽器中打開管理面板，並把兩個分頁都點過一遍。

伺服器 bundle 也需要建置（`dist/server/`），這裡有一個**經典陷阱：
過期的 `dist`**：`npm run hub` 會重新建置，但如果在編輯 `src/` 之後
直接執行 `node dist/server/main.js`，跑的會是舊的程式碼——一個新的
路由會回傳 404，看起來像是路由 bug。請先重新建置。
