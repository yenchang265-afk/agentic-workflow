[English](proposed-loops.md) | 繁體中文

# 提案中的迴圈類型——一份企業工作流程目錄

這是一份**提案目錄**，不是已出貨工作的設計紀錄（那是
[`improvements/`](./improvements/README.md)）。它回答一個問題：除了已出貨的
`engineering` 和 `pr-sitter` 類型之外，還有哪些迴圈可以把企業環境中軟體工程師的
日常工作流程自動化？

以下三個項目——`review-sitter`、`dep-sitter`、`main-sitter`——已經出貨；每一個
都標示為**已出貨（SHIPPED）**並附上與原始草案的差異。**要看它們目前的行為和
設定，請見 [`docs/sitters.md`](../sitters.md)**——以下的草案僅作為設計歷史保留，
不是它們今日行為的第二份權威來源。

每個項目都是依照真實的清單（manifest）合約撰寫的
（[`packages/core/loops/README.md`](../../packages/core/loops/README.md)，
zod 結構描述在 `packages/core/src/manifest/schema.ts`），因此任何一個都能不經
重新轉譯直接升級為實作計畫：

- **工作來源（work source）**——這個類型是重用 `backlog` / `github-pr`，
  還是需要在 `packages/core/src/source/` 下新增一個 `WorkSource`。新的來源
  主導了實作成本。
- **階段圖（stage graph）**——各階段及其 `kind`（`work` 會自行完成，
  `check` 必須記錄一個 `loop_verdict`，否則會 FAIL）、隔離方式，以及狀態轉換
  （transition）草案（`fire` / `park` / `done` / `stop`、疊代上限）。
- **人工把關點（human gates）**——迴圈在哪裡暫停以及為什麼。每個類型都
  遵守框架的一貫立場：agent 提出建議，人類做決定。
- **權限與威脅備註**——這個類型持有什麼權限（見下方圖例），並回連到
  [`threat-model.md`](./threat-model.md)。
- **設定草案**——它在 `.agentic-loop.json` 中的 `loops.<kind>` 區塊
  （以下每個類型都是選擇性啟用的，就像 `pr-sitter` 一樣）。
- **成本**——S / M / L：
  - **S**——只需要清單 + 階段提示詞 + agents；重用既有的工作來源，且不授予
    任何新權限。
  - **M**——需要一個新的工作來源或一項新權限，外加測試。
  - **L**——同時需要新的來源*和*新的外部權限；出貨前需要補充威脅模型。

以下按影響範圍遞增排列所使用的權限等級：

1. **backlog-write**——寫入設定的 `tasksDir` 下的任務檔案（engineering
   類型已經持有的權限）。
2. **push**——將分支推送到遠端（絕不會是受保護分支）。
3. **comment**——在 PR、issue 或工作項目上發布留言/審查。
4. **external-read**——讀取程式碼平台以外的外部系統（套件註冊表的漏洞資料庫、
   Sentry、PagerDuty）。
5. **external-write**——寫入外部系統（Slack webhook、警示認可）。範圍最廣，
   一律會明確標示出來。

## 摘要

| 類型 | 類別 | 工作來源 | 權限 | 成本 |
|------|------|---------|------|------|
| [debt-groomer](#debt-groomer) | 程式碼健康度 | `backlog`（重用） | backlog-write | S |
| [backlog-groomer](#backlog-groomer) | 協作 | `backlog`（重用） | backlog-write | S |
| [review-sitter](#review-sitter) **（已出貨）** | 協作 | `github-pr`（+ `review-requested` 觸發器） | comment | S/M |
| [coverage-filler](#coverage-filler) | 程式碼健康度 | `backlog`（重用，自有池） | push | S/M |
| [issue-triager](#issue-triager) | 協作 | 新增 `github-issue` | backlog-write、comment | M |
| [dep-sitter](#dep-sitter) **（已出貨）** | 程式碼健康度 | 新增 `dependency-scan` | push、external-read | M |
| [release-gardener](#release-gardener) | CI/CD 與發布 | 新增 `merge-window` | push | M |
| [main-sitter](#main-sitter) **（已出貨）** | CI/CD 與發布 | 新增 `ci-runs` | push、comment | M/L |
| [digest-reporter](#digest-reporter) | 維運與報告 | 新增 `cron` | backlog-write（+ 選用的 external-write） | S/M |
| [alert-triager](#alert-triager) | 維運與報告 | 新增 `alert-feed` | backlog-write、external-read（+ 選用的 push） | L |

---

## 程式碼健康度與維護

### debt-groomer

把程式碼中的 `TODO` / `FIXME` / 淘汰標記清掃出來，變成待辦（backlog）中
可供審查的任務檔案。絕不修改程式碼。

- **工作來源**：反向重用 `backlog`——這個整理者不會認領既有任務；一次排程
  掃描（每次執行一個合成任務，從它在輪詢時自行產生的 `groom-queue` 狀態
  資料夾中認領）在不新增來源的情況下維持了認領/鎖定紀律。如果這樣做把
  backlog 來源扭曲得太過頭，一個簡單的 `cron` 來源（與
  [digest-reporter](#digest-reporter) 共用）是備案。
- **階段圖**：
  1. `scan`（**check**，隔離方式 `none`，唯讀的 `bashAllowlist`：
     `grep *`、`git log*`、`ls*`、`cat *`）——盤點標記，與已開啟的待辦
     任務及自己的帳本去重，記錄一個裁定：PASS = 發現新的技術債，
     FAIL = 沒有新東西。
  2. `draft`（**work**，隔離方式 `none`）——為每一叢技術債寫一份任務檔案，
     存到 `tasksDir` 下，驗收標準指名標記所在位置。
- **狀態轉換**：`scan` onPass → 觸發（fire）`draft`；onFail → 結束（done）
  （「沒有新東西」）。`draft` onDone → 暫存（park）`toStatus: "queued"`——
  直接進入既有的 engineering **任務把關點**；由人類決定升級或刪除。
- **人工把關點**：全部。整理者只會產生暫存的任務檔案；修復工作由
  engineering 迴圈（有自己的計畫和發布把關點）完成。
- **權限與威脅備註**：僅 backlog-write——沒有 push，沒有 comment，沒有
  網路存取。是這份目錄中最便宜也最安全的類型；T3b（待辦損毀）是唯一相關的
  威脅，已由既有的、經稽核的任務儲存區寫入覆蓋。
- **設定草案**：
  ```json
  { "loops": { "debt-groomer": { "enabled": true, "markers": ["TODO", "FIXME", "@deprecated"], "maxTasksPerRun": 5 } } }
  ```
- **成本**：**S**。

### dep-sitter

> **狀態：已出貨** —— `packages/core/loops/dep-sitter/`。目前的行為和設定
> 見 [`docs/sitters.md`](../sitters.md) 和
> [`docs/loops/dep-sitter.md`](../loops/dep-sitter.md)；以下的原始草案僅為
> 歷史紀錄。v1 與草案的差異：主版本升級是*跳過並記錄*，而不是暫存等人工
> 處理（`dependency-scan` 來源只認領修補/次要版本修復，其目標版本由報告
> 釘死——不需要 `validateBeforeTransition` hook）；`maxIterations` 為 2；
> 支援的生態系是 **npm**（原生 `npm audit`）和透過 OSV-Scanner 的
> **Maven/Gradle**。見威脅模型 T12。

原始草案：處理過時/有漏洞的相依套件，新增 `dependency-scan` 工作來源，
`scan → upgrade → verify → publish`（push + external-read 權限），主版本
升級暫存等人工處理。**成本**：M。

### coverage-filler

為人類已排入佇列、需要補測試覆蓋率的模組撰寫缺少的測試。人類設定目標，
迴圈負責苦工。

- **工作來源**：重用 `backlog`，有自己的認領池——任務檔案存在
  `coverage-queue` 狀態資料夾中（由人類、由 [digest-reporter](#digest-reporter)
  的覆蓋率區塊，或由 CI 中的覆蓋率差異來播種），透過既有註冊表中的
  `coverage.isClaimable` 判斷式來認領。
- **階段圖**：
  1. `target`（**check**，隔離方式 `none`）——確認該模組仍然覆蓋不足，
     列舉未測試的分支；FAIL = 已經覆蓋（結束）。
  2. `write`（**work**，隔離方式 `worktree`）——遵循儲存庫的測試慣例撰寫
     測試。
  3. `verify`（**check**，隔離方式 `worktree`）——新測試通過、覆蓋率確實
     提升，且當受測程式碼被弄壞時測試會失敗（突變抽查——一個不會失敗的
     測試是沒有價值的）。
  4. `publish`（**work**，隔離方式 `worktree`）——推送分支並開啟一個
     draft PR。
- **狀態轉換**：`verify` onFail → 觸發 `write`，`countIteration: true`
  （上限 3）；onError → 停止（stop）。`publish` onDone → 結束
  `toStatus: "in-review"`。
- **人工把關點**：人類掌控佇列（沒有任何任務是在人類沒有暫存進
  `coverage-queue` 的情況下被認領的），且產出是一個 draft PR。
- **權限與威脅備註**：僅 push，與 engineering 的發布路徑姿態相同。
  T1（儲存庫內容注入）適用於被讀取的程式碼——由既有的「裁定僅能透過工具
  取信」的紀律所覆蓋。
- **設定草案**：
  ```json
  { "loops": { "coverage-filler": { "enabled": true, "coverageCommand": "npm run coverage -- --json" } } }
  ```
- **成本**：**S/M**（沒有新的來源；verify 中的突變抽查是新增的提示詞工作）。

---

## 協作與分流（triage）

### issue-triager

守著新進的 issue/工作項目：重現、去重、貼標籤，並把被接受的項目轉換成暫存在
任務把關點的待辦任務檔案——是「有人回報了一個 bug」到「engineering 迴圈可以
認領它」之間的橋樑。

- **工作來源**：新增 `github-issue`——鏡射 `github-pr`：一個 `query`
  （例如 `is:open is:issue no:label`）、觸發器（`new-issue`、
  `new-comments`）、一份存於 `<tasksDir>/runs/issue-triager/` 下、按 issue
  分別去重的帳本。ADO 版本透過既有的 REST/PAT 管線輪詢工作項目。
- **階段圖**：
  1. `triage`（**check**，隔離方式 `none`，唯讀 + 平台讀取白名單）——嘗試
     從回報內容重現問題，搜尋重複項，草擬嚴重程度/範疇分類。
     PASS = 可處理，FAIL = 不可處理（需要更多資訊 / 重複）。
  2. `respond`（**work**，隔離方式 `none`，平台留言白名單）——對於不可
     處理的 issue：發布一則留言（重複連結或具體的資訊索取要求）並套用
     標籤。
  3. `draft`（**work**，隔離方式 `none`）——對於可處理的 issue：寫一份
     附有重現步驟和驗收標準、並連結該 issue 的待辦任務檔案。
- **狀態轉換**：`triage` onPass → 觸發 `draft`；onFail → 觸發 `respond`。
  `draft` onDone → 暫存 `toStatus: "queued"`（任務把關點）。`respond`
  onDone → 結束。
- **人工把關點**：被接受的 issue 會變成*暫存的任務檔案*，而不是進行中的
  工作；由人類升級它們。分流者從不關閉 issue——只貼標籤和留言。
- **權限與威脅備註**：backlog-write + comment。issue 內文是典型的不可信
  輸入——T7 的注入紀律（外部文字是資料，裁定只能透過 `loop_verdict`）
  逐字適用，且 triage 階段的白名單確保它是唯讀的。留言權限被限定在
  被認領的那個 issue 之內，呼應 T8「權限不寬於工作本身」的原則。
- **設定草案**：
  ```json
  { "loops": { "issue-triager": { "enabled": true, "query": "is:open is:issue no:label", "labels": { "needsInfo": "needs-info", "duplicate": "duplicate" } } } }
  ```
- **成本**：**M**（一個新的來源；留言權限已經有既有模型可依循）。

### review-sitter

> **狀態：已出貨** —— `packages/core/loops/review-sitter/`。目前的行為和
> 設定見 [`docs/sitters.md`](../sitters.md) 和
> [`docs/loops/review-sitter.md`](../loops/review-sitter.md)；以下的原始
> 草案僅為歷史紀錄。v1 與草案的差異：中間的 work 階段命名為 `assess`
> （而非 `review`——OpenCode 驅動程式對名為 `review` 的階段有特殊處理，
> 用於視角（lens）分派）；沒有 `maxDiffLines` 旋鈕——遇到大到無法審查的
> diff 時，fetch 階段會直接 FAIL（→ 結束），而不是設一個閾值；沒有新推送的
> 重新審查請求不會重新觸發（去重依賴 head SHA）；fork 和 draft PR 依然
> 跳過不處理（威脅模型 T10/T11）。

原始草案：pr-sitter 的鏡像，重用 `github-pr` 加上 `review-requested`
查詢/觸發器，`fetch → review → publish`（僅 comment 權限，無疊代上限）。
**成本**：S/M。

### backlog-groomer

巡查停滯的 `queued` 待辦任務，讓它們保持隨時可動工的狀態：補上缺少的驗收
標準、拆分過大而無法驗證的任務、標記出程式碼庫已經超前的任務。

- **工作來源**：重用 `backlog`——用 `groomer.isStale` 認領判斷式（沒有
  驗收條列項目，或 N 天未被觸碰；兩者都可從任務檔案本身及其 git 歷史讀出）
  在 `queued` 上開一個池。
- **階段圖**：
  1. `assess`（**check**，隔離方式 `none`，唯讀白名單）——判斷這個任務
     是否需要整理，以及整理成哪種形式（補標準 / 拆分 / 已過時）。
     FAIL = 現狀就好。
  2. `groom`（**work**，隔離方式 `none`）——就地編輯任務檔案（經稽核的
     儲存區寫入），或寫出拆分出來的子任務，或附加一則附有證據的
     「是否已過時？」備註。
- **狀態轉換**：`assess` onPass → 觸發 `groom`；onFail → 結束。`groom`
  onDone → 暫存 `toStatus: "queued"`——整理過的任務會回到任務把關點，
  標記為已整理過（因此同一個任務下次輪詢不會再被認領；判斷式會檢查
  整理標記）。
- **人工把關點**：整理者從不刪除或升級任務——已過時的任務只是被*標記*，
  拆分結果只是*被提議成新的 queued 任務*，由人類在既有的任務把關點做
  決定。
- **權限與威脅備註**：僅 backlog-write，與 debt-groomer 相同的 T3b 範圍；
  既有的經稽核任務儲存區寫入和認領鎖已經覆蓋了它。
- **設定草案**：
  ```json
  { "loops": { "backlog-groomer": { "enabled": true, "staleAfterDays": 14 } } }
  ```
- **成本**：**S**。

---

## CI/CD 與發布

### main-sitter

> **狀態：已出貨** —— `packages/core/loops/main-sitter/`。目前的行為和
> 設定見 [`docs/sitters.md`](../sitters.md) 和
> [`docs/loops/main-sitter.md`](../loops/main-sitter.md)；以下的原始草案
> 僅為歷史紀錄。v1 與草案的差異：`ci-runs` 來源只判斷分支*最新*的 head
> （一旦有更新的推送，較舊的紅色 head 就不再重要；綠色的重新執行會自然
> 讓該項目退場），且從不認領仍在執行中的 head；補救分支是
> `main-sitter/<sha>`，push 白名單被限定在這個分支上，因此被監看的分支在
> 結構上就無法被推送。同時支援 GitHub（`gh run list`）和 Azure DevOps
> （Pipelines Build REST API，`ado-ci-runs.ts`，與 GitHub 來源共用帳本/
> WorkItem 機制）。見威脅模型 T13。

原始草案：監看預設分支的 CI，新增 `ci-runs` 工作來源，
`diagnose → remedy → verify → publish`（push + comment 權限），對根因
分支進行二分搜尋，提出一個修復或還原方案作為 draft PR——絕不直接推送到
main。**成本**：M/L。

### release-gardener

照料發布流程：當未發布的合併累積超過閾值（或到了排定的節奏）時，它會在
一個分支上草擬變更日誌（changelog）、發布說明和版本號提升，然後暫存在
發布把關點。打標籤和發布仍然由人類進行。

- **工作來源**：新增 `merge-window`——計算「自上一個標籤以來的合併數」
  （`git log <lastTag>..origin/main`，加上透過平台取得的 PR 中繼資料）；
  當閾值/節奏被觸發時產出一個工作項目，以其帳本中的候選基準 commit
  去重。
- **階段圖**：
  1. `collect`（**check**，隔離方式 `none`，唯讀 + 平台讀取）——蒐集自
     上一個標籤以來合併的 PR，依標籤和 conventional-commit 前綴分類
     （功能 / 修復 / 破壞性變更）；FAIL = 這個時間窗不值得發布。
  2. `draft`（**work**，隔離方式 `worktree`）——依照儲存庫的版本慣例
     撰寫變更日誌區塊、發布說明和版本號提升。
  3. `verify`（**check**，隔離方式 `worktree`）——用提升後的版本建置通過；
     變更日誌只引用真實存在的 PR（對照 collect 階段的產出物做抽查）；
     除了白名單內的發布檔案之外沒有動到其他原始檔。
  4. `publish`（**work**；push 白名單）——推送發布分支並開啟一個
     draft 發布 PR。
- **狀態轉換**：`collect` onPass → 觸發 `draft`；onFail → 結束。`verify`
  onFail → 觸發 `draft`，`countIteration: true`，上限 2。`publish`
  onDone → 暫存 `toStatus: "release-review"`——**發布把關點**。
- **人工把關點**：發布把關點正是重點所在——由人類審查說明、合併、打標籤
  並發布。園丁完全不持有任何標籤或註冊表權限。
- **權限與威脅備註**：僅 push。餵入說明的 PR 標題/標籤是輕度不可信的
  （T7-lite）：verify 階段對照 collect 產出物的交叉檢查，就是防範捏造
  變更日誌條目的控制手段。
- **設定草案**：
  ```json
  { "loops": { "release-gardener": { "enabled": true, "minMerges": 8, "cadence": "weekly", "versioning": "semver" } } }
  ```
- **成本**：**M**。

---

## 維運與報告

### digest-reporter

不用自己寫的每日站會摘要：每天早上把昨天的合併、開啟中 PR 的狀態、CI 健康
狀況，以及迴圈執行的指標，彙整成一份 markdown 摘要——提交到儲存庫，並可
選擇性地發布到聊天工具。

- **工作來源**：新增 `cron`——最簡單的一種來源：依每個設定的排程時段觸發
  一個工作項目，以帳本中的日期去重。（一旦這個來源存在，
  [debt-groomer](#debt-groomer) 和 [release-gardener](#release-gardener)
  的節奏模式也能搭它的便車。）
- **階段圖**：
  1. `gather`（**check**，隔離方式 `none`，唯讀 + 平台讀取白名單）——
     從既有的執行指標（`packages/core/src/loop/metrics.ts`）蒐集合併、
     PR 狀態、CI 狀態，以及每次執行各階段的耗時/裁定；FAIL = 沒發生什麼事
     （跳過安靜的日子）。
  2. `render`（**work**，隔離方式 `none`）——透過經稽核的儲存區寫入
     `<tasksDir>/runs/digest/YYYY-MM-DD.md`（依既有的機密內容遮蔽路徑，
     在寫入時套用機密內容遮蔽）。
  3. `post`（**work**，選用——只有在設定了 webhook 時才會接上；白名單
     恰好就是對已設定 webhook 主機的一個 `curl` glob）——把摘要發布到
     Slack/Teams。
- **狀態轉換**：`gather` onPass → 觸發 `render`；onFail → 結束
  （「安靜的一天」）。`render` onDone → 若已設定則觸發 `post`，否則結束。
  `post` onDone → 結束。
- **人工把關點**：已提交的摘要不需要任何把關點（唯讀式報告）；外部發布
  是由設定值把關，而不是每次執行都要人類把關。
- **權限與威脅備註**：摘要檔案本身是 backlog-write；只有在 webhook 那條
  路徑啟用時才會有 **external-write**——這是框架中第一個
  external-write，因此採用最嚴格的形式：單一目的地、白名單主機、摘要
  內容在離開機器前會先經過既有的機密內容遮蔽（T6）。威脅模型因此新增了
  一則「webhook 外送」備註。
- **設定草案**：
  ```json
  { "loops": { "digest-reporter": { "enabled": true, "schedule": "weekdays 08:00", "webhook": null } } }
  ```
- **成本**：**S/M**（來源很簡單；webhook 這條路徑是唯一新增的權限，
  且是選用的）。

### alert-triager

守著生產環境的警示（Sentry、PagerDuty、Datadog）：把每一則新警示與近期的
合併及堆疊追蹤（stack trace）做關聯，並為值班的人類暫存一份寫好的診斷——
也可以選擇性地繼續產出一個 draft 修復 PR。

- **工作來源**：新增 `alert-feed`——輪詢警示 API 取得符合篩選條件的
  新/未解決警示，以帳本中的警示 ID 去重；憑證透過環境變數提供
  （PAT 風格，鏡射 `AZURE_DEVOPS_EXT_PAT`）。
- **階段圖**：
  1. `triage`（**check**，隔離方式 `none`；針對警示 API 的
     external-read 白名單 + 唯讀 git）——拉取警示酬載和堆疊追蹤，與最近的
     合併做關聯（自上次部署以來的 `git log`），分類為：與程式碼相關、
     基礎設施、或雜訊。FAIL = 雜訊/已知問題。
  2. `diagnose`（**work**，隔離方式 `worktree`）——閱讀受牽連的程式碼，
     如果可以用測試表達就重現問題，寫出一份診斷文件：懷疑的 commit、
     機制、影響範圍、建議的補救方式。
  3. `propose-fix`（**work**，隔離方式 `worktree`；**選用**，預設關閉）——
     撰寫修復方案 + 回歸測試。
  4. `verify`（**check**，隔離方式 `worktree`）——回歸測試在修復前失敗、
     修復後通過。
  5. `publish`（**work**；push 白名單）——開啟連結該警示與診斷的
     draft PR。
- **狀態轉換**：`triage` onPass → 觸發 `diagnose`；onFail → 結束。
  `diagnose` onDone → 當 `autoFix` 關閉時（預設值）暫存
  `toStatus: "diagnosis-review"`——由值班人類閱讀診斷並做決定；當
  `autoFix` 開啟時 → 觸發 `propose-fix`。`verify` onFail → 觸發
  `propose-fix`，`countIteration: true`，上限 2。`publish` onDone → 結束。
- **人工把關點**：預設的終端狀態本身*就是*把關點——一份暫存的診斷。
  修復路徑是明確的選擇性開啟，即使開啟了，最終也只會落地成一個
  draft PR。分流者從不認可、解決或消音警示。
- **權限與威脅備註**：這份目錄中範圍最大的一個——對警示 API 的
  external-read，加上（選用的）push。在最壞情況下，警示酬載是攻擊者
  可影響的（錯誤訊息中含有使用者輸入）：T7 的注入紀律在此以最強的
  強度適用，triage 階段被白名單釘死為唯讀，且憑證絕不會進入持久化的
  產出物中（T6 遮蔽）。只有在補上自己的威脅模型章節（新增信任邊界：
  警示提供者）之後才能出貨。
- **設定草案**：
  ```json
  { "loops": { "alert-triager": { "enabled": true, "provider": "sentry", "filter": "is:unresolved level:error", "autoFix": false } } }
  ```
- **成本**：**L**。

---

## 建議的建置順序

從最便宜的開始，每一波都重用前一波建置好的成果：

1. **沒有新來源、沒有新權限**——[debt-groomer](#debt-groomer)、
   [backlog-groomer](#backlog-groomer)、
   [review-sitter](#review-sitter)*（已出貨）*：只需要清單、階段提示詞和
   agents。這些能在引擎現有的樣貌下驗證這份目錄格式是否可行。
2. **各自新增一個來源**——[issue-triager](#issue-triager)
   （`github-issue`）、[dep-sitter](#dep-sitter)（`dependency-scan`，
   *已出貨*）、[main-sitter](#main-sitter)（`ci-runs`，*已出貨*）、
   [release-gardener](#release-gardener)（`merge-window`），再加上
   [coverage-filler](#coverage-filler) 搭 backlog 的便車。每個來源都遵循
   `WorkSource` 合約和 pr-sitter 的帳本模式。
3. **外部整合放最後**——[digest-reporter](#digest-reporter) 的 webhook
   路徑和 [alert-triager](#alert-triager)，兩者都要先補上各自的威脅模型
   章節。

要把任何一個項目升級為實際工作，就要走一遍既有的
[新類型檢查清單](../../packages/core/loops/README.md#checklist-for-a-new-kind)——
清單 + 階段、透過 `gen:prompts` 為兩個外掛產生 agents、指令包裝、
來源 + 測試、註冊表 hooks，以及設定/威脅模型文件。那份檢查清單才是權威版本；
這份目錄只提供*要做什麼*。
