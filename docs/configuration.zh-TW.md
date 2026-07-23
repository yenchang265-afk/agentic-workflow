[English](configuration.md) | 繁體中文

# 設定（`.agentic-workflow.json`）

儲存庫根目錄下的一份可選 JSON 檔案。每個欄位都有合理的預設值；一份
設定錯誤的檔案會快速失敗並附上清楚的訊息，而不是悄悄回退。

## 快速上手範本

把符合你平台的區塊複製進 `.agentic-workflow.json`，替換掉裡面的預留位置，
就完成了——其餘一切都維持預設值。本頁其餘部分是逐欄位參考；第一次
設定通常用不到。

**GitHub**（預設平台——這份檔案等同於完全沒有 `.agentic-workflow.json`，
外加開啟 `pr-sitter`）：

```json
{
  "workflows": {
    "pr-sitter": { "enabled": true, "query": "is:open author:@me" }
  }
}
```

把 `query` 換成你想讓 sitter 監看的 PR 搜尋條件，或者如果你只想要
engineering 迴圈（它的預設值），就整段刪掉 `workflows` 區塊。

**Azure DevOps：**

```json
{
  "codePlatform": "ado",
  "ado": {
    "organization": "https://dev.azure.com/<your-org>",
    "project": "<your-project>",
    "selfLogin": "<your-login-or-service-account-email>"
  },
  "workflows": {
    "pr-sitter": { "enabled": true }
  }
}
```

替換 `<your-org>`、`<your-project>` 和
`<your-login-or-service-account-email>`——這三項在 `"ado"` 下都是
必填的。如果你會用到 ship 把關點或 `dep-sitter`/`main-sitter` 的
publish 階段（它們需要一個明確的儲存庫來開 PR），就在 `project`
旁邊加上 `"repository": "<your-repo>"`。不要把你的 PAT 放進這份檔案——
改成 export `AZURE_DEVOPS_EXT_PAT=<pat>`；回退方案和其取捨見下方
[Code platform](#code-platform-codeplatform--ado)。

## 分層與優先順序

設定從兩個可選的層解析而來：

1. **使用者層級**——`~/.config/agentic-workflow/agentic-workflow.json`（遵循
   `$XDG_CONFIG_HOME`；當此檔案不存在時，仍會讀取舊有的
   `~/.agentic-workflow.json` 作為後備），套用到你執行迴圈的每一個
   儲存庫。用 `AGENTIC_WORKFLOW_USER_CONFIG` 覆寫路徑；設成 `""` 可完全
   停用這一層（例如在 CI 中）。
2. **儲存庫層級**——儲存庫根目錄的 `.agentic-workflow.json`，會**逐欄位
   覆寫使用者層級**。

合併方式是欄位層級的深度合併：巢狀物件（`ado`、`workflows`、每個
`workflows.<kind>` 區段）會逐鍵遞迴合併；陣列（`reviewLenses`）和純量則
整個取代。分層合併發生在驗證**之前**，因此預設值永遠不會蓋掉任一份
檔案中的明確值，跨欄位的必要條件（例如 `codePlatform: "ado"` 需要
`ado.selfLogin`）是針對合併後的視圖去檢查的——依此設計，理想的
分工是：

- **使用者層級**：跨儲存庫共用的身分與憑證——`ado.organization`、
  `ado.selfLogin`、`ado.pat`——加上個人化的預設值，例如
  `maxIterations`。
- **儲存庫層級**：一切與專案綁定的東西——`codePlatform`、
  `ado.project`、`ado.repository`、`tasksDir`、`workflows`、worktree
  設定。

依慣例把 `codePlatform` 和 `workflows` 留在儲存庫檔案裡：使用者層級的值
會悄悄套用到*每一個*儲存庫。如果使用者檔案裡放了 PAT，請保護它
（`chmod 600 ~/.config/agentic-workflow/agentic-workflow.json`）；`AZURE_DEVOPS_EXT_PAT` 環境
變數仍然會贏過這兩層。在混合 Windows/WSL 的環境中，注意這兩個世界
有不同的家目錄——在 WSL 內執行的 host 會解析 WSL 的家目錄；如果你
橫跨兩者，就把 `AGENTIC_WORKFLOW_USER_CONFIG` 指向同一份檔案。

`./install.sh` 會為你產生這份檔案：在互動式終端機上，它會執行一個
簡短的精靈（程式碼平台、sitter、worktree，外加一個進階關卡處理
tracker、審查視角和疊代上限），並寫出一份有效的 `.agentic-workflow.json`。
它的第一個問題是**範圍**——寫到哪裡：

- **儲存庫層級**（預設）——`<project>/.agentic-workflow.json`，位於外掛
  在執行期讀取設定的那個目錄（`$AGENTIC_WORKFLOW_DIR`，否則就是目前
  目錄），它會詢問你這個路徑。專案專屬的設定放這裡。
- **使用者層級**——共用的使用者層級檔案（`$AGENTIC_WORKFLOW_USER_CONFIG`，
  否則就是 `~/.config/agentic-workflow/agentic-workflow.json`），你驅動的每一個儲存庫都會讀取
  它。跨儲存庫共用的設定（`ado` 區塊、審查視角）屬於這裡；儲存庫
  檔案會逐欄位覆寫它（見上方[分層與優先順序](#layers--precedence)）。

用 `--user` 或 `--repo` 以非互動方式強制指定範圍。它永遠不會覆寫
既有檔案，在管線（piped）/CI 執行下也會被跳過。其他旗標：
`--no-config` 跳過它，`--config` 強制執行它，`-y`/`--yes` 不經
詢問就寫出一份全預設值的檔案（尊重 `--user`/`--repo`）。以下所有
內容事後也都可以手動編輯。

| 欄位 | 預設值 | 作用 |
|-------|---------|--------------|
| `maxIterations` | `3` | 在因為重複的 check 階段失敗而停止之前，迴圈可執行的最大疊代次數（engineering：VERIFY/REVIEW；某個清單可能會依類型覆寫此值）。當 engineering 的上限被觸發時，代表計畫本身可疑——用 `/agentic-workflow:engineering replan <id>` 把它送回去。 |
| `tasksDir` | `"docs/tasks"` | 任務待辦的儲存庫相對根目錄；它的子資料夾就是各個任務狀態。也承載暫存的 `runs/` 機器狀態（快照、指標、階段標記、PR-sitter 帳本）。 |
| `ignoreBacklog` | `true` | 見下方強化項。設成 `false` 可將每次任務移動都提交為稽核紀錄（舊有行為）。 |
| `stageTimeoutMinutes` | `60` | 單一階段的牆鐘時間上限；超過此時限的階段會讓迴圈失敗，而不是卡住不動。 |
| `watchIntervalMinutes` | `5` | `/agentic-workflow:engineering watch` 的預設輪詢週期；可透過 `/agentic-workflow:engineering watch <interval>` 依 session 覆寫。**僅限 OpenCode**——這個欄位是 OpenCode 外掛在 `src/config.ts` 中疊加在共用核心結構描述（`packages/core/src/config.ts`）之上的擴充欄位；Claude Code 外掛沒有 watch 計時器。 |
| `workflows` | `{}` | 各工作流程類型的區段——見下方。 |
| `codePlatform` | `"github"` | 決定 PR 形狀的工作來源要跟哪個平台對話：`"github"`（`gh` CLI）或 `"ado"`（Azure DevOps——依 `ado.access` 透過 az CLI、原生 REST 或 MCP 伺服器）。可用 `workflows.<kind>.codePlatform` 依類型覆寫。見下方。 |
| `ado` | 未設定 | Azure DevOps 的座標（`organization`、`project`、可選的 `access`、`repository`、`selfLogin`、`customHeaders`、`insecureSkipTlsVerify`）；當任何一個生效平台是 `"ado"` 時**必填**——沒有它設定會快速失敗。`"ado"` 下 `selfLogin` 是**必填**的（PAT 無法解析出 sitter 的身分）。`access` 決定階段代理人如何觸達 ADO：`"az"`（預設）、`"rest"` 或 `"mcp"`。 |
| `projectManagement` | 未設定 | 團隊的任務追蹤系統（Jira / Azure DevOps）以及本機任務如何與它配對。驅動任務撰寫預設值和 `/agentic-workflow:engineering status` 中的配對視圖。見下方。 |
| `worktreesDir` | `".workflow-worktrees"` | 見下方強化項。設成 `false` 可退出此行為。 |
| `worktreeSetup` | 未設定 | 在一個剛建立的 worktree 內執行的 shell 指令（例如 `"npm ci"`）。 |
| `reviewLenses` | `[]` | 見下方強化項。最多 5 個視角。 |

兩個外掛讀取的是同一份檔案：結構描述位於共用核心套件
（`packages/core/src/config.ts`），每個 host 可以用只有自己能支援的
欄位去擴充它（目前：OpenCode 的 `watchIntervalMinutes`——見
[`plugins/claude/README.md`](../plugins/claude/README.md)）。

## 工作流程類型（`workflows`）

`workflows` 底下的每一個鍵會啟用並設定一種工作流程類型（一份
`packages/core/workflows/<kind>/` 清單）。**`engineering` 除非被明確
停用，否則都會執行**；其他每一種類型都是可選啟用的，需要
`"enabled": true`。已啟用的類型依認領優先順序輪詢：engineering
優先，接著是設定中依序排列的已啟用類型。

類型專屬的旋鈕就放在同一個區段裡。**它們不會被驗證**：`workflows` 依
設計是一個鬆散的記錄（各類型可由使用者自行編寫——見
[`packages/core/workflows/README.md`](../packages/core/workflows/README.md)），
迴圈會依名稱位置性地讀取每一個旋鈕，並做一次簡單的型別檢查。因此
一個拼錯或型別錯誤的旋鈕會被**悄悄忽略**——迴圈會照預設值執行，
且不會發出任何訊息：

| 適用於工作來源是……的類型 | 旋鈕 | 讀取為 |
|---|---|---|
| `pull-request` | `query` | string |
| `dependency-scan` | `severityFloor` | string |
| `dependency-scan` | `includeOutdated` | boolean |
| `dependency-scan` | `ecosystem` | string |
| `ci-runs` | `branch` | string |

（每個旋鈕在各 sitter 中*代表什麼意思*的權威文件在
[`sitters.md`](sitters.md)；上面這張表只是讀取的合約。）

管理面板的**設定分頁會精準標出這些錯誤**——未知旋鈕（附猜測建議）、
型別錯誤，以及某個旋鈕出現在一個其工作來源根本不會讀取它的類型上。
這些警告只是提示：它們會註記在儲存動作上，但從不阻擋儲存。見下方
[管理面板](#admin-hub-hub--user-scope-only)。

> **四個 sitter（`pr-sitter`、`review-sitter`、`dep-sitter`、
> `main-sitter`）都是實驗性的**——它們下面的旋鈕和預設值在各版本
> 之間可能還會變動。`engineering` 是穩定的、預設開啟的類型。

```json
{
  "workflows": {
    "engineering": { "enabled": true },
    "pr-sitter": {
      "enabled": true,
      "query": "is:open author:@me"
    },
    "review-sitter": { "enabled": true },
    "dep-sitter": { "enabled": true, "severityFloor": "high" },
    "main-sitter": { "enabled": true, "branch": "main" }
  }
}
```

- **`workflows.engineering.enabled`**——預設 `true`；設成 `false` 可以
  只執行其他類型（例如一個專用的 PR-sitter watcher）。
- **`workflows.pr-sitter`**、**`workflows.review-sitter`**、
  **`workflows.dep-sitter`**、**`workflows.main-sitter`**——每一個預設都是
  `enabled: false`。每個 sitter 做什麼、它的階段流水線，以及它完整
  的類型專屬鍵集合（`query`、`ecosystem`、`severityFloor`、
  `includeOutdated`、`branch`……）都只在一個地方權威記載，就是
  **[`docs/sitters.md`](sitters.md)**——不要在這裡重複那些內容。
- **`workflows.<kind>.codePlatform`**——依類型覆寫全域的
  `codePlatform`（例如讓某個 sitter 對接 ADO，同時其他一切都預設
  使用 GitHub）。
- **`workflows.<kind>.trigger`**——一個正在 watch 的 host 如何為這個
  類型排程認領（僅限 OpenCode 的 `watch` 模式；純拉取式的 Claude
  host 會忽略它）：

  ```json
  {
    "workflows": {
      "engineering": { "trigger": { "type": "idle" } },
      "pr-sitter": {
        "enabled": true,
        "trigger": { "type": "cron", "schedule": "0 9 * * 1-5" }
      }
    }
  }
  ```

  - `{ "type": "poll", "intervalMinutes"?: n }`——預設值：一個常駐
    計時器（回退到 `watchIntervalMinutes`），加上 idle 事件時的
    認領。
  - `{ "type": "cron", "schedule": "<5-field cron>" }`——**只有**
    排程觸發時才會認領；一般的 idle 事件永遠不會認領。若排程觸發
    落在 session 忙碌時會被跳過——下一次觸發會重試。語法在設定
    載入時就會被驗證。
  - `{ "type": "idle" }`——沒有計時器；只要正在 watch 的 session
    一進入 idle，新的迴圈就立刻開始，把各迴圈前後串連起來
    （「webhook 式」的即時性——但不涉及任何 HTTP 端點）。

  設定值是**預設值**；帶引數的 `/agentic-workflow:<kind> watch` 會為
  該 session 覆寫它：`watch poll [interval]`（或一個裸的間隔值）、
  `watch cron "<schedule>"`，或 `watch idle`。

## 管理面板（`hub`——僅限使用者層級）

管理面板只從**使用者層級**設定的 `hub` 區段讀取它的設定
（`~/.config/agentic-workflow/agentic-workflow.json` / `AGENTIC_WORKFLOW_USER_CONFIG`）。管理面板
會同時監看多個儲存庫，所以某個儲存庫 `.agentic-workflow.json` 中的
`hub` 鍵會被忽略而不是合併：

```json
{
  "hub": {
    "repos": ["/path/to/repo", "/mnt/c/Users/me/projects/*"],
    "port": 4317
  }
}
```

- **`hub.repos`**——要監看的目錄；項目可以含有 `*` 萬用字元（單一
  路徑片段）。只有在管理面板啟動時沒有帶 `--dir` 旗標的情況下才會
  用到。
- **`hub.port`**——監聽埠號（預設 `4317`）；`--port` 仍然優先。

`hub` 底下的未知鍵會被拒絕（防止拼錯）。見
[packages/hub/README.md](../packages/hub/README.md)。

### 從管理面板編輯這份檔案

管理面板的**設定分頁**會讀寫 `.agentic-workflow.json`。有四個行為值得
了解，因為每一個都是為了防止某種特定的資料遺失方式而存在的：

- **它一次只編輯一層，並且會說明是哪一層。** 你可以選擇「這個
  儲存庫」或「使用者（所有儲存庫）」；每個欄位都會顯示一個徽章，
  標示它的生效值實際來自哪裡（`repo` / `user` / `default`）。合併
  後的視圖從不會被寫回——那樣做會把使用者層級扁平化進儲存庫檔案，
  把 `ado.pat` 複製進一份可能被提交（commit）的檔案裡。
- **它不認得的鍵會被保留，並標示為已保留。** 編輯器寫入的是原始
  JSON，因此一個只有 host 認得的鍵（`watchIntervalMinutes`）或
  `hub` 區段在儲存後會原封不動存活下來。它們會列在「已保留、不可
  編輯」之下——這也代表一個頂層的拼錯會出現在那裡，而不是悄悄消失。
- **`ado.pat` 從不會傳到瀏覽器。** 它會被替換成一個佔位符；保持
  不動就會維持已儲存的值。把一個 PAT 寫進一份**沒有加入
  gitignore** 的儲存庫檔案會被拒絕——優先使用
  `AZURE_DEVOPS_EXT_PAT`。
- **除非合併後的設定能通過驗證，否則儲存會被拒絕**，旋鈕警告
  （見上文）只會註記而不阻擋。儲存後管理面板會立刻重新載入；在
  `$EDITOR` 中手動編輯也一樣會被偵測到，兩種情況都不需要重啟。

管理面板只會寫入這份檔案。一個已經在執行中的迴圈會在下一個階段時
讀到新設定；不會在階段執行中途重新讀取。

## 程式碼平台（`codePlatform` / `ado`）

平台的*機制*（設定欄位、驗證、ADO 的寫入防線）記在這裡；每個
sitter 類型實際做了什麼記在
[`docs/sitters.md`](sitters.md)。

PR sitter 和 review sitter 綁定到一個代管 PR 形狀的工作來源
（它們清單中的 `workSource.type: "pull-request"`）；這個來源實際上
會對哪個平台說話，是在接線時從設定中解析出來的——清單本身從不會
被分岔（fork）。清單的 `role` 決定 ADO 身分過濾器：`author` 類型
（pr-sitter）認領由 `ado.selfLogin` 建立的 PR，`reviewer` 類型
（review-sitter）認領其他人建立、且該登入帳號的審查投票仍待處理
的 PR。

四種 sitter 類型都支援 Azure DevOps。`dependency-scan`（dep-sitter）
來源是平台無關的（npm 報告不在乎儲存庫住在哪個 forge 上）；當平台
解析為 `ado` 時，它的 publish 階段會透過 ADO REST API 而不是
`gh pr create` 來開啟草稿 PR。`ci-runs`（main-sitter）來源有一個
真正的 ADO 版本（`ado-ci-runs.ts`），輪詢 Azure Pipelines 的 Build
REST API（`_apis/build/builds`）而不是 `gh run list`，把建置結果
正規化成和 GitHub 來源相同的、經過裁定的形狀——「只看最新的 head，
絕不看執行中途」這條邏輯兩邊完全一樣。`dependency-scan` 和
`ci-runs` 都不需要 `ado.selfLogin`（不像 PR 形狀的來源，它們不受限
於某個身分），但每種存取模式下都仍然需要 PAT
（`AZURE_DEVOPS_EXT_PAT`）。

每種 sitter 類型的 publish 階段——在 ADO 上——都是透過 Claude host
的寫入防線 hook（`check-stage-guard`）開啟 PR 和發表討論串留言的，
這個 hook 只允許恰好三種 ADO 寫入形狀：讀取、討論串留言的回覆，
以及建立一個全新的草稿 pull request。在 REST 上這對應一次 GET、
一次對 `/threads` 資源的 POST，以及一次對 `.../pullrequests` 不帶
id 片段的 POST（這正是 ADO 如何草擬一個 PR 的方式，`isDraft: true`
放在 body 裡，和其他任何呼叫的形式相同）；在 az CLI 上，同一套
界線落在 `az repos pr`/`az pipelines`/`az devops invoke` 指令上
（`create` 只允許帶 `--draft`，`invoke` 的 POST 只允許打到討論串
/PR 集合資源）。任何對*既有* PR 的變更——完成、放棄、投票、加入
審查者，或任何 PATCH/PUT/DELETE——都會被直接擋下，不論是哪種工作流程類型或哪個階段；看起來會變更狀態的 ADO MCP 工具名稱也會被盡力
（best-effort）擋下。

```json
{
  "codePlatform": "ado",
  "ado": {
    "organization": "https://dev.azure.com/acme",
    "project": "widgets",
    "repository": "widgets-api",
    "selfLogin": "sitter@acme.com"
  },
  "workflows": { "pr-sitter": { "enabled": true } }
}
```

- **`ado.access`**——選填，預設 `"az"`；**用哪種方式觸達 Azure
  DevOps**——它同時決定渲染進階段提示的指令範例、該階段的 bash
  允許清單，以及 driver 自己的資料傳輸（輪詢來源 + ship 把關點）：
  - `"az"`（預設）——帶 `azure-devops` 擴充的 `az` CLI，端到端：
    階段代理人執行 `az repos pr …` / `az pipelines runs …`（CLI 沒有
    動詞的操作——例如討論串留言回覆——則用通用的 `az devops
    invoke`），而 driver 的輪詢與 ship 把關點呼叫也走同一個 CLI
    （`az devops invoke` 是 REST 直通，回應解析完全相同）。認證用
    事先備妥的 `AZURE_DEVOPS_EXT_PAT`——azure-devops 擴充直接採用它。
  - `"rest"`——原生 REST，用 `AZURE_DEVOPS_EXT_PAT` 認證：階段提示
    用 `curl`，driver 用 fetch（`access` 出現之前的行為；想保留就
    固定住這個值）。只有這個模式下 `ado.customHeaders` 與
    `ado.insecureSkipTlsVerify` 才作用於 driver 的呼叫——az CLI
    自己管理傳輸（proxy/TLS 走它自身的設定）。
  - `"mcp"`——在你的代理主機中設定的 Azure DevOps MCP 伺服器（例如
    `microsoft/azure-devops-mcp`）——**只涵蓋階段代理人**：MCP
    伺服器不在 driver host 行程可及之處，所以它的輪詢與 ship 把關
    點走 `rest` 傳輸、需要一個 PAT。提示以能力描述而非工具名稱
    撰寫（各伺服器工具名不同）；找不到 ADO 工具的階段會記錄一個
    ERROR 判定並指名缺少的能力。MCP 的寫入防線是**盡力而為的名稱
    樣式黑名單**（第三方工具名不由我們列舉）——提示中的 NEVER
    條款仍是主要控制。

  存取方式會在**認領時蓋章進迴圈狀態**（就像 `platform` 一樣），
  所以迴圈進行中翻動設定不會讓提示與允許清單互相矛盾；沒有這個
  戳記的既有快照維持它們被認領時的 `rest` 行為。
- **`ado.organization` / `ado.project`**——必填的 ADO 座標。
- **`ado.repository`**——對 `pr-sitter`/`review-sitter`/
  `main-sitter` 類型而言是選填的（省略時 → `pr-sitter`/
  `review-sitter` 會看到整個專案下所有活躍的 PR；`main-sitter`
  會輪詢整個專案範圍的建置）；但對於開啟一個草稿 PR 是**必填**的
  ——engineering 迴圈的 ship 把關點，以及 `dep-sitter`/
  `main-sitter` 的 publish 階段——因為建立 PR 需要一個明確的
  儲存庫。不設定它，這些階段就會回報它們無處可開 PR，而不是去猜。
- **`ado.selfLogin`**——**必填**；sitter 自己的登入帳號，用來過濾
  它自己的 PR 留言。PAT 無法解析出 sitter 的身分——沒有它，每一則
  留言（包括 sitter 自己的回覆）都會重新觸發注意。
- **`ado.pat`**——選填；明碼存放的 PAT，作為 `AZURE_DEVOPS_EXT_PAT`
  環境變數未設定時的備援。兩者都設定時**環境變數優先**。優先使用
  環境變數；如果你要用 `ado.pat`，使用者層級的
  `~/.config/agentic-workflow/agentic-workflow.json` 是自然的歸屬（從不提交、跨儲存庫共用）——
  在儲存庫檔案中，保持 `.agentic-workflow.json` 加入 gitignore（預設
  就是如此），這樣密鑰就永遠不會被提交。它會傳達到每一個消費者：
  工作來源直接讀取它，而 triage/publish 階段 agent（透過
  `$AZURE_DEVOPS_EXT_PAT` 驗證）也會拿到它——在 OpenCode 上是在
  外掛初始化時（`applyAdoPatEnv`），在 Claude Code 上則是透過一個
  `SessionStart` hook（`inject-ado-pat.mjs`）把它寫進
  `$CLAUDE_ENV_FILE`。兩者都不會覆寫你自己 export 過的 PAT。
- **`ado.customHeaders`**——選填；附加在驅動程式發出的每一次 ADO
  REST 呼叫上的額外 HTTP 標頭（`pr-sitter` 工作來源和 engineering
  的 ship 把關點）。它的典型用途是 Azure DevOps 前面的一個企業
  代理伺服器——例如一個 `Proxy-Authorization` token 或一個路由用
  標頭。它是一個純粹的 string→string 物件；鍵和值都必須非空。這些
  標頭會被合併到內建的 `Authorization`/`Accept`/`Content-Type`
  **之上**，因此這裡的一個鍵可以覆寫其中之一（很少會需要，但由你
  決定）。`AGENTIC_WORKFLOW_ADO_HEADERS` 環境變數——一個同樣形狀的 JSON
  物件——會**逐鍵覆寫 `customHeaders`**（環境變數優先，和
  `AZURE_DEVOPS_EXT_PAT` 覆寫 `ado.pat` 的方式相同），因此一個攜帶
  密鑰的代理 token 可以來自你的密鑰管理系統，而非密鑰的路由標頭則
  留在設定裡。一個格式錯誤的環境變數值會被忽略（→ 不覆寫），而
  不是造成致命錯誤。和 `ado.pat` 一樣，攜帶密鑰的標頭該放在使用者
  層級的 `~/.config/agentic-workflow/agentic-workflow.json`（或環境變數）裡，而不是一份會被
  提交的儲存庫檔案裡。注意這只會傳達到驅動程式自己的 `fetch`
  呼叫；階段 agent 自己的原始 `curl`（透過 `$AZURE_DEVOPS_EXT_PAT`
  驗證）不會繼承它——如果它們也需要，就用代理伺服器自己的環境變數
  （`HTTPS_PROXY` 等）去對接它們。

  ```json
  {
    "ado": {
      "organization": "https://dev.azure.com/acme",
      "project": "widgets",
      "repository": "widgets-api",
      "selfLogin": "sitter@acme.com",
      "customHeaders": { "X-Route": "internal-network" }
    }
  }
  ```

  ```bash
  # env var overrides / augments ado.customHeaders (JSON object, env wins on clashes)
  export AGENTIC_WORKFLOW_ADO_HEADERS='{"Proxy-Authorization":"Bearer proxy-token"}'
  ```
- **`ado.insecureSkipTlsVerify`**——選填，預設 `false`；跳過驅動
  程式發出的每一次 ADO REST 呼叫上的 TLS 憑證驗證（PR/CI-runs 工作
  來源和 ship 把關點）。它是為了坐落在一張執行環境不信任的自簽或
  內部 CA 憑證後面的自架 Azure DevOps Server 準備的——絕對不要對
  代管的 `dev.azure.com` 服務啟用它，因為那會失去對 token 遭
  MITM（中間人攻擊）的防護。這些呼叫走的是一個專用的 `undici`
  dispatcher，所以這只會削弱這些 ADO 呼叫的 TLS，不會影響同一個
  行程中無關的請求（GitHub、npm……）。和 `customHeaders` 一樣，它
  只會傳達到驅動程式自己的 `fetch` 呼叫；階段 agent 的原始 `curl`
  不會繼承它——如果它們也需要，就自己傳入 `-k`/`--insecure`（或
  讓 `curl` 指向你的內部 CA bundle）。

  ```json
  {
    "ado": {
      "organization": "https://ado.internal.acme.com/tfs/DefaultCollection",
      "project": "widgets",
      "selfLogin": "sitter@acme.com",
      "insecureSkipTlsVerify": true
    }
  }
  ```
- **`"ado"` 的先決條件**：一個 Personal Access Token——放在
  `AZURE_DEVOPS_EXT_PAT`（優先）或 `ado.pat`——範圍需涵蓋 Code
  (read) + Pull Request contribute (comment)，以及 `curl`。這個
  token 是以 HTTP Basic auth 送出的
  （`curl -sS -u :"$AZURE_DEVOPS_EXT_PAT" <url>`）；不需要 `az`
  CLI。
- **在 ADO 上的語意**：失敗的檢查來自阻擋性的分支政策評估
  （`_apis/policy/evaluations`）——一個沒有建置政策的儲存庫永遠
  不會觸發 `failing-checks`；留言來自 PR 討論串；一次負面的
  審查者投票對應到 changes-requested；`mergeStatus: conflicts`
  對應到 merge-conflict。
- 階段的 bash 白名單是依平台分開的：清單的
  `platformAllowlist.github` / `.ado` 萬用字元模式，會被合併進該
  階段解析後平台所對應的 `bashAllowlist`。OpenCode 的 agent
  frontmatter（靜態 YAML）同時攜帶兩個平台的 CLI 白名單，這是一個
  刻意的廣度取捨——workflow.json/階段標記路徑則維持窄平台。

新類型的編寫方式見 [`workflows/README.md`](../packages/core/workflows/README.md)，
啟用 PR sitter 前的安全態勢見
[`docs/design/threat-model.md`](design/threat-model.md)。

## 專案管理（`projectManagement`）

把迴圈指向團隊的任務追蹤系統，讓**本機待辦任務與 tracker 項目
配對**（Jira issue / Azure DevOps 工作項目）。任務 frontmatter 已經
帶有一個可選的 `tracker` 區塊（見
[`task-backlog-management`](../skills/task-backlog-management/SKILL.md)
的結構描述）；這項設定提供撰寫時的預設值，並讓配對成為迴圈的一級
公民功能。配對是**手動**的——迴圈從不呼叫 tracker 的 API；由人類把
issue 的 key/id 複製進任務裡。

```json
{
  "projectManagement": {
    "system": "jira",
    "baseUrl": "https://acme.atlassian.net/browse/",
    "defaultType": "story"
  }
}
```

- **`system`**（必填）——`"jira"` 或 `"azure-devops"`。成為透過
  `/agentic-workflow:engineering new` 撰寫的任務上所蓋的預設
  `tracker.system`。
- **`baseUrl`**——選填的 URL 前綴，會被附加到任務的 `tracker.key`
  上，以建構一個深層連結（Jira：`…/browse/`；ADO：
  `…/_workitems/edit/`）。未設定 → 不建構連結。
- **`defaultType`**——選填的 issue/work-item 類型，蓋在新草稿上
  （例如 `story`、`task`、`bug`）。

配對永遠是**選填**的——任務從不強制要帶 `tracker` 區塊；這個區段
只是提供撰寫時的預設值和狀態視圖。

對指令的影響：

- **`/agentic-workflow:engineering new`** 會預先填入 `tracker.system`
  （以及來自 `defaultType` 的 `type`），讓草擬出來的任務已經準備好
  可以配對——你只需要填入 `tracker.key`。
- **`/agentic-workflow:engineering status`** 會加上一個 `pairing`
  彙總：tracker 系統、有多少個活躍任務已配對，以及還未配對的任務
  id。

## 可選的強化項

- **`worktreesDir`**——讓每個迴圈都在自己的 `git worktree` 中執行，
  而不是在共用的檢出（checkout）裡切換分支。人類的工作樹永遠不會
  被碰到，多個 `/agentic-workflow:engineering watch` session 可以在
  同一個實例中並行建置。**預設開啟**（`.workflow-worktrees`）——設成
  `worktreesDir: false` 可以退回共用工作樹的分支切換方式。一個
  全新的 worktree**沒有安裝任何相依套件**：搭配 `worktreeSetup`
  使用（例如 `"npm ci"`），否則 VERIFY 會在一個空的檢出上失敗。
  稽核記錄和任務移動仍然留在主工作樹中，是否在那裡提交則取決於
  下方的 `ignoreBacklog`。
- **`ignoreBacklog`**——完全不讓 `tasksDir` 進入 git：迴圈不會把每次
  任務移動（approve、plan、ship、park、done、stop）都提交為稽核紀錄，
  而是把它登記進 `<git-common-dir>/info/exclude`——一份僅限本機、
  未被追蹤的排除清單，與 `worktreesDir` 使用的機制相同——因此永遠
  不會碰到共用、被追蹤的 `.gitignore`。**預設開啟**——設成
  `ignoreBacklog: false` 可以恢復舊有的提交式待辦行為。無論哪種
  設定，任務檔案本身在磁碟上都不受影響；改變的只是迴圈是否提交
  它們的移動。
- **`reviewLenses`**——每個視角各跑一次 REVIEW（例如
  `["correctness", "security", "test-adequacy"]`），取最差的裁定，
  這樣單一個被提示注入攻擊的審查者就無法讓一項變更蒙混過關。成本
  約為 N 倍的審查時間；預設關閉。開啟後會**停用審查階段的軸涵蓋強制檢查**
  （`requiredAxes`）：每一趟都被要求只專注在自己的視角上，因此強制它交出
  全部五個軸會讓每一趟都被拒絕。視角模式有自己的涵蓋保證——沒有記錄裁定的
  視角會變成 ERROR，而不是悄悄消失的意見。
- 回顯進稽核記錄、計畫或執行紀錄中的密鑰會在寫入並提交之前被
  **依形狀遮蔽**（`AKIA…`、`sk-…`、token、PEM 區塊、
  `key/secret/token: …` 這類賦值）。
- 在一個終端事件發生時，執行紀錄會得到一張 **`## Run summary`**
  表格——逐階段的牆鐘時間、裁定歷史，以及用掉的疊代次數。

## 環境變數

有一個變數適用於**每一個 host**：

- **`AGENTIC_WORKFLOW_USER_CONFIG`**——使用者層級設定檔的路徑（預設
  `~/.config/agentic-workflow/agentic-workflow.json`）；設成 `""` 可停用這一層。見
  [分層與優先順序](#layers--precedence)。

Claude Code MCP 伺服器額外會讀取兩個目錄指標。這兩者都不適用於
OpenCode host，它會從你開啟的專案取得目錄。

- **`AGENTIC_WORKFLOW_DIR`**——伺服器運作所在的權威儲存庫根目錄：任務
  待辦所在之處、`worktreesDir` 下每個任務的 worktree 建立之處，以及
  執行紀錄寫入之處。預設為伺服器啟動時的工作目錄。當 Claude Code
  把伺服器的根目錄設在你想要的儲存庫以外的地方時，就設定這個變數。
- **`AGENTIC_WORKFLOW_BASE_DIR`**——新的 `feature/<id>` worktree 的
  **基底分支**要從哪裡讀取。Claude Code 會把 `AGENTIC_WORKFLOW_DIR`
  凍結在主要檢出（通常是預設分支）上，所以沒有這個變數的話，每個
  迴圈都會從那個分支切出。把它指向你實際工作的那棵樹，基底就會在
  **每次認領時即時**（`git rev-parse --abbrev-ref HEAD`）從那裡
  讀取，因此 `feature/<id>` 分支會從你目前所在的分支切出。未設定
  ⇒ 基底會回退到 `AGENTIC_WORKFLOW_DIR` 目前檢出的任何分支（先前的
  行為）。一個處於 detached 狀態的基底目錄會被忽略（同樣回退）。

安全態勢見 `design/threat-model.md`，這些功能背後的設計紀錄見
`design/improvements/`。
