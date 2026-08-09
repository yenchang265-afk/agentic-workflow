[English](configuration.md) | 繁體中文

# 設定（`.agentic-workflow.json`）

儲存庫根目錄下的一份可選 JSON 檔案。每個欄位都有合理的預設值；一份
設定錯誤的檔案會快速失敗並附上清楚的訊息，而不是悄悄回退。

## 快速上手範本

把符合你平台的區塊複製進 `.agentic-workflow.json`，替換掉裡面的預留位置，
就完成了——其餘一切都維持預設值。本頁其餘部分是逐欄位參考；第一次
設定通常用不到。

**GitHub**（預設平台——空檔案，或完全沒有 `.agentic-workflow.json`，就已經
給你 `engineering`、`pr-sitter` 和 `review-sitter`）：

```json
{
  "workflows": {
    "pr-sitter": { "query": "is:open author:@me" }
  }
}
```

把 `query` 換成你想讓 sitter 監看的 PR 搜尋條件，或者想全部採用預設值
就整段刪掉 `workflows` 區塊。

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
    "pr-sitter": { "query": "is:open author:@me" }
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

**含 shell 的鍵是例外，只在「使用者層級」生效**：`worktreeSetup`、
`workflows.<kind>.scannerCommand` 與 `workflows.<kind>.stageChecks` 都是迴圈
原樣交給 shell 執行的字串。
`.agentic-workflow.json` 會跟著任何被複製的儲存庫一起散布，若在該層生效，
光是「觀察」一個儲存庫就足以在首次認領時執行任意 shell——等同 npm
postinstall 等級的風險，而且是無聲的。在儲存庫層設定這些會被捨棄並發出
警告（指名該鍵，巢狀的兩個還會指名 kind）；同一段落的其他鍵仍然生效，
使用者層級的同名值也會保留。

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
| `checkTimeoutMinutes` | `10` | 單一 driver 執行的檢查指令（`stageChecks` ／計畫發現的檢查）的牆鐘時間上限。與 `stageTimeoutMinutes` 分開，因為後者不涵蓋檢查：兩個 host 上檢查都跑在階段上限之外。超時的檢查會被殺掉並回報結束碼 `124` ⇒ 階段 ERROR。 |
| `watchIntervalMinutes` | `5` | `/agentic-workflow:engineering watch` 的預設輪詢週期；可透過 `/agentic-workflow:engineering watch <interval>` 依 session 覆寫。**僅限 OpenCode**——這個欄位是 OpenCode 外掛在 `src/config.ts` 中疊加在共用核心結構描述（`packages/core/src/config.ts`）之上的擴充欄位；Claude Code 外掛沒有 watch 計時器。 |
| `workflows` | `{}` | 各工作流程類型的區段——見下方。 |
| `codePlatform` | `"github"` | 決定 PR 形狀的工作來源要跟哪個平台對話：`"github"`（`gh` CLI）或 `"ado"`（Azure DevOps——透過 Azure DevOps MCP 伺服器 + 一個 PAT）。可用 `workflows.<kind>.codePlatform` 依類型覆寫。見下方。 |
| `ado` | 未設定 | Azure DevOps 的座標（`organization`、`project`、可選的 `repository`、`selfLogin`、`mcp`）；當任何一個生效平台是 `"ado"` 時**必填**——沒有它設定會快速失敗。`"ado"` 下 `selfLogin` 是**必填**的（PAT 無法解析出 sitter 的身分）。 |
| `projectManagement` | 未設定 | 團隊的任務追蹤系統（Jira / Azure DevOps）以及本機任務如何與它配對。驅動任務撰寫預設值和 `/agentic-workflow:engineering status` 中的配對視圖。見下方。 |
| `worktreesDir` | `".workflow-worktrees"` | 見下方強化項。設成 `false` 可退出此行為。 |
| `worktreeSetup` | 未設定 | 在一個剛建立的 worktree 內執行的 shell 指令（例如 `"npm ci"`）。**含 shell——僅限使用者層級**，見下方。 |
| `reviewLenses` | `[]` | 見下方強化項。最多 5 個視角。 |

三個外掛讀取的都是同一份檔案：結構描述位於共用核心套件
（`packages/core/src/config.ts`），每個 host 可以用只有自己能支援的
欄位去擴充它（目前：OpenCode 的 `watchIntervalMinutes`——見
[`plugins/claude/README.md`](../plugins/claude/README.md)）。

## 工作流程類型（`workflows`）

`workflows` 底下的每一個鍵會啟用並設定一種工作流程類型（一份
`packages/core/workflows/<kind>/` 清單）。只有一種類型完全不需要任何設定
就是啟用的：

- **`engineering` 除非以 `"enabled": false` 明確停用，否則都會執行。**

其他每一種類型——四個 sitter（`pr-sitter`、`review-sitter`、`dep-sitter`、
`main-sitter`）以及你自行編寫的類型——都是**實驗性且可選啟用**的，需要
`"enabled": true`。只寫旋鈕不會啟用一種類型：在停用的 `pr-sitter` 上調整
`query`，它仍然是關的。已啟用的類型依認領優先順序輪詢：`engineering`、
再來是設定中依序排列的已啟用類型——所以沒有指名類型的認領，在排在前面的
都沒有可認領的工作時，也會觸及已啟用的 sitter。

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

> **四個 sitter 全都是實驗性的**——它們的清單、旋鈕和預設值在各版本之間
> 都可能還會變動，所以沒有 `"enabled": true` 就不會啟動。`engineering`
> 是唯一預設值已定案的類型。下面的 `ado` 平台依同樣的標準屬於實驗性。

```json
{
  "workflows": {
    "engineering": { "enabled": true },
    "pr-sitter": {
      "enabled": true,
      "query": "is:open author:@me"
    },
    "dep-sitter": { "enabled": true, "severityFloor": "high" },
    "main-sitter": { "enabled": true, "branch": "main" }
  }
}
```

- **`workflows.engineering.enabled`**——預設 `true`；設成 `false` 可以
  只執行其他類型（例如一個專用的 PR-sitter watcher）。
- **`workflows.pr-sitter`**、**`workflows.review-sitter`**、
  **`workflows.dep-sitter`**、**`workflows.main-sitter`**——每一個 sitter
  在你寫下 `"enabled": true` 之前都是關的。每個 sitter 做什麼、它的階段流水線，以及它完整
  的類型專屬鍵集合（`query`、`ecosystem`、`severityFloor`、
  `includeOutdated`、`branch`……）都只在一個地方權威記載，就是
  **[`docs/sitters.md`](sitters.md)**——不要在這裡重複那些內容。
- **`workflows.dep-sitter.scannerCommand`**——在 JVM 生態系統上，以自訂 CLI
  取代內建的 `osv-scanner --format json -L <target>`（`{{target}}`、
  `{{ecosystem}}` 會被代換）；npm 路徑不受影響。輸出可以是 osv-scanner 報告
  或原始 OSV 記錄清單，完整契約見
  **[`docs/workflows/dep-sitter.md`](workflows/dep-sitter.md)**。
  **含 shell——僅限使用者層級**（見下方）。
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

- **`workflows.<kind>.stageModels`**——階段名稱 → 該階段執行時使用的
  模型，讓便宜的階段跑便宜的模型、困難的階段跑強大的模型：

  ```json
  {
    "workflows": {
      "engineering": {
        "stageModels": {
          "build": "anthropic/claude-sonnet-4-5",
          "review": "anthropic/claude-opus-4-5"
        }
      }
    }
  }
  ```

  值是 host 專屬的模型字串：OpenCode 要的是 `provider/modelID`（如上）；
  Claude Code 和 Qwen Code 都要 Task 工具風格的模型（`sonnet`、`opus`、
  `haiku`，或一個裸的模型 id——`provider/` 前綴會被容許並去除，所以同一份
  設定在三個 host 上都能用）。Qwen 是在安裝時解析它，而不是在產生階段時
  ——見 [`docs/qwen.md`](qwen.zh-TW.md) 的「這個宿主上的每階段模型是靜態的」一節。
  每個階段的優先順序：這個鍵 → manifest 階段的 `model` 欄位 → 未設定
  （host 的預設模型）。沒列出的階段沿用 host 預設值。

  鍵必須是該類型的**階段名稱**，小寫，依 manifest 的拼法（engineering：
  `plan`、`build`、`verify`、`review`；其他類型請執行
  `/agentic-workflow:<kind> kinds`）。指向不存在階段的鍵——例如 `BUILD`，
  或另一個類型的階段名稱——在解析時無法被拒絕（此時 manifest 尚未載入），
  因此會被接受、忽略，該階段沿用 host 預設值。OpenCode 和 Claude Code
  在迴圈啟動時都會對這類鍵發出警告。

- **`workflows.<kind>.stageContext`**——以「消費該產物的階段」為鍵，
  設定該階段組出的提示中每個產物的**字元**上限。未設定 ⇒ 無上限，
  與完全沒有預算時逐位元組相同。

  每個階段的提示都會原封不動地帶上先前階段擷取的輸出，所以一份很長
  的 BUILD 記錄、或一次五個 lens 的 REVIEW，都會整份落進下一個提示。
  在前沿模型上這沒問題，在小模型上則是致命的——而 `stageModels`
  正是在邀請你這樣做。預算宣告在**消費端**的階段上，因為同一份產物
  會被多個需求不同的階段讀取：

  ```jsonc
  {
    "workflows": {
      "engineering": {
        "stageModels": { "verify": "openrouter/qwen/qwen3-coder" },
        "stageContext": {
          "build":  { "goal": 16000, "plan": 24000, "verify": 8000, "review": 8000 },
          "verify": { "goal": 12000, "plan": 16000, "build": 8000 },
          "review": { "goal": 12000, "plan": 16000, "build": 8000 }
        }
      }
    }
  }
  ```

  鍵名對應該階段消費的產物（`plan`、`build`、`verify`、`review`），外加一個
  保留鍵：**`goal`** 裁剪任務目標本身。目標在組成提示時已經去重——計畫段
  只存在於 `plan` 產物中，稽核註記尾也已剝除——所以 `goal` 預算只會在任務
  敘述本身真的很長時才生效。

  這是一份**小上下文設定範例，不是預設值**——當你把某個階段指向小模型時
  它是必需的；而當 backlog 跑得夠久，即使在前沿模型上也值得啟用（用較寬鬆
  的上限）：工件隨每次迭代成長，提示正好在迴圈最吃力時最大。不要用猜的——
  Hub 的 Metrics 分頁的提示大小面板會顯示每個階段組成的提示大小以及預算
  省略了多少，依觀察到的數值設定上限，再逐步收緊到省略標記只出現在無關
  緊要的位置。換算大約是每個 token 3.5–4 個字元（散文與程式碼），
  所以 24,000 字元約等於 6–7k tokens。

  超出預算的文字會從**中間**省略，保留頭與尾，並留下明確的
  `[… N characters elided …]` 標記；因為檢查階段開頭是裁決理由、
  結尾是具體失敗的斷言——單純截頭會丟掉標出檔案與行號的那一半。

  有兩樣東西永遠不會被裁剪。**結構化的裁決區塊**（裁決理由、未通過的
  驗收條件、帶 `file:line` 的阻斷性發現）是豁免的：它在建構上就有界，
  而且是提示中訊號最強的內容。另外，階段的**契約**——目標、驗收條件、
  worktree 指示、裁決／範圍區塊——是在預算套用之後才組上去的。預算
  可以餓死歷史，永遠不會餓死契約。

  沒有任何東西會遺失：每一趟的完整文字在成為產物之前就已寫入持久的
  run log，所以不論提示帶了什麼，run log 與
  `runs/<id>.metrics.json` 都是完整的。

  每個階段的優先順序：這個鍵 → manifest 階段的 `context` 欄位 →
  無上限。和 `stageModels` 一樣，這個鍵會**整份取代** manifest 的
  對應表，而不是合併進去。鍵必須是階段名稱；指向不存在階段的鍵——
  或在有效階段內指向不存在階段的產物名稱——會被接受、忽略，並在迴圈
  啟動時發出警告（設定解析時 manifest 還沒載入）。與 `worktreeSetup`
  不同，這個鍵**會**從 repo 的 `.agentic-workflow.json` 生效：它的
  值域是正整數，所以被監看的 repo 只能縮小自己的提示，別的都動不了。

- **`workflows.<kind>.stageChecks`**——以檢查類階段名稱為鍵，值是**驅動程式**
  在該階段 fire 之前、於其工作樹中執行的指令。它們的結束碼對該階段而言是既定
  事實：會渲染進提示詞、計為已觀察到的證據，並折進該階段的裁決。未設定 ⇒
  該階段改用已核准計畫所宣告的指令（下方的 `discoverChecks`）；若計畫也沒宣告，
  就不執行任何檢查。

  這是給「想手動釘選專案指令」用的測試／型別檢查／lint 旋鈕。這個鍵與
  `discoverChecks` 共同解決的問題是：放著不管，VERIFY 每次執行都自己挑指令——
  於是同一個 repo、同一個 commit，這次疊代用 `npm test` 檢查，下次變成
  `npm test` 加 `npx tsc`，程式碼沒動，裁決卻動了。

  ```jsonc
  {
    "workflows": {
      "engineering": {
        "stageChecks": {
          "verify": [
            { "name": "tests", "command": "npm test" },
            { "name": "types", "command": "npx tsc --noEmit" },
            { "name": "web-tests", "command": "npm test", "cwd": "packages/web" }
          ]
        }
      }
    }
  }
  ```

  `name` 是結果的標籤（同一階段內不可重複），`command` 是原樣執行的 shell，
  `cwd` 是工作樹底下的選填子目錄。它們會依序執行，時機在 isolation 之後、
  每次階段 fire 執行一次——所以五軸 REVIEW 或多視角 REVIEW 只花一次測試套件的
  成本，不是五次。

  結束碼如何約束裁決：

  | 結束碼 | 意義 | 效果 |
  |------|---------|--------|
  | `0` | 通過 | 什麼都不加；裁決就是代理人記錄的那一個 |
  | `124`／`126`／`127` | 檢查逾時或跑不起來（找不到／不可執行） | 階段 **ERROR** → 迴圈停下來等人，且不消耗疊代 |
  | 其他 | 檢查跑了，而且說不行 | 階段 **FAIL** → 重新 build，消耗一次疊代 |

  紅燈的檢查無法被辯掉：不論該階段回報什麼，它都不可能 PASS。如果是檢查本身
  壞了，逃生口是把它從這份清單移除——而不是在轉錄稿裡跟它爭辯。每一條指令都受
  `checkTimeoutMinutes`（預設 10）限制；超過就會被殺掉並回報結束碼 `124`，依上表
  讀作 ERROR。`stageTimeoutMinutes` **不**涵蓋檢查——兩個 host 上檢查都跑在階段
  上限之外。

  每個階段的優先順序：這個鍵 → manifest 階段的 `checks` 欄位 → 計畫發現的指令
  → 沒有檢查。和 `stageModels` 一樣，這個鍵會**整份取代** manifest 的清單，而不是
  合併進去。**存在但為空**的清單（`"verify": []`）是明確的退出開關：它的意思是
  「這就是我專案的檢查，而且一個都沒有」，所以也會一併關閉發現機制。鍵必須是檢查
  類階段的名稱；指向不存在階段的鍵會被接受、忽略，並在迴圈啟動時發出警告——那個
  階段於是退回發現機制或完全不執行檢查，所以這個警告值得一看。

  **只在使用者層級生效**（`SHELL_BEARING_WORKFLOW_KEYS`），與 `worktreeSetup`、
  `scannerCommand` 相同：它是驅動程式會執行的 shell，被複製的 repo 不能提供
  它。在 repo 的 `.agentic-workflow.json` 設定它會被捨棄並發出指名該 kind 的
  警告；同段落的其他鍵與使用者層級的同名值都會保留。

- **`workflows.<kind>.discoverChecks`**——當一個檢查類階段既沒有 `stageChecks`
  項目、manifest 也沒有 `checks` 時，是否從**已核准的計畫**取得指令。未設定 ⇒
  依 manifest 階段的宣告；engineering 的 VERIFY 宣告為開，其餘出貨階段皆為關。

  PLAN 階段本來就必須把每一條驗收標準對應到「證明它的確切指令或可觀察檢查」。
  打開這個開關後，它的提示詞會額外要求把那些指令寫成機器可讀的形式——放在
  `### Verification` 末尾的一個 fenced 區塊：

  ~~~markdown
  ### Verification
  - AC1「超過限制回傳 429」→ `npm run test:all`（root package.json 定義了
    `test:all`；沒有裸的 `test` script）

  ```agentic-checks
  [
    { "name": "tests", "command": "npm run test:all" },
    { "name": "types", "command": "npm run typecheck:all" }
  ]
  ```
  ~~~

  為什麼掛在計畫而不是檢查階段自己：**指令必須被凍結**。區塊是任務檔裡的文字，
  每次疊代都重新讀取，所以 BUILD→VERIFY→BUILD 每輪的檢查方式相同。一個每次執行
  都重新推導指令的階段，會把上面描述的飄移原封不動地帶回來。唯一會改變這組指令
  的途徑是 `replan`——它重跑 PLAN，並重新停在你的把關點。

  能執行什麼，由**該階段自己的 bash 白名單**封頂：被發現的指令只有在該階段的
  agent 本來就能主動執行時才會被接受。邊界是白名單，而不是你對計畫的核准，因為
  任務檔位於 `tasksDir`，那是 repo 內容，被 clone 的 repo 可以夾帶。指令另有上限
  5 條、`cwd` 必須是工作樹內的單純相對路徑，而二進位檔在本機沒安裝的指令會被
  丟棄並發出警告，而不是讓整趟執行 127。

  白名單擋不住的一條規則：被發現的指令必須會**自己結束**。dev server 或
  `--watch` 執行器是可接受的（`npm run dev` 命中 `npm run *`）、二進位檔也找得
  到，所以下游沒有任何一關會丟掉它——它會一路跑到 `checkTimeoutMinutes`，回報
  exit `124`，而那是 ERROR，也就是停下整趟執行等人。PLAN 的提示會說明這條規則；
  要證明執行期行為，請指名自己會啟動並關閉伺服器、而且會結束的指令（e2e 或整合
  測試），絕不要指名 serve 指令本身。

  所有出錯情況都退化成**少跑幾個檢查加一則警告**——絕不會拒絕計畫、也絕不會停掉
  迴圈。沒有區塊、JSON 壞掉、指令被拒、二進位檔缺失：迴圈的檢查方式與這個功能
  出現之前完全相同。

  與 `stageChecks` 不同，這個鍵**不是** shell 承載鍵，會從 repo 的
  `.agentic-workflow.json` 生效：它的值域只有一個布林，而且打開它並不會給 repo
  任何它沒有的能力——把關的白名單，就是它的 VERIFY agent 本來就在遵守的那一份。

  要關閉可用 `"discoverChecks": false`，或直接釘選自己的指令——
  `"stageChecks": { "verify": [] }` 會同時關掉兩者。

- **`agentModels`**（頂層，不在 `workflows` 之內）——代理名稱 → 該代理
  執行時使用的模型，適用於**不是階段執行**、因此沒有 `stageModels`
  項目可讀的生成：

  ```json
  {
    "agentModels": {
      "workflow-task-author": "anthropic/claude-haiku-4-5",
      "workflow-plan": "anthropic/claude-haiku-4-5"
    }
  }
  ```

  符合條件的有兩個：`/agentic-workflow:engineering new` 與 `retask` 用來
  撰寫草稿檔案的 `workflow-task-author`（在任何迴圈存在之前就執行），
  以及臨時性的 `/agentic-workflow:plan` 指令所用的 `workflow-plan`。兩者
  背後都沒有 manifest 階段，因此沒有任何 fire payload 會為它們帶上模型。

  之所以放在頂層而非各類型之下：代理名稱在各類型間是唯一的，而
  `workflow-plan` 根本不屬於任何類型。未設定的代理則使用主機預設模型。

  **各主機如何綁定，以及變更何時生效。** 這兩個生成都不是階段觸發，
  因此都無法像階段那樣由驅動器帶上模型。每個主機改以其他方式綁定——
  都不是靠「要求模型配合」，那正是這個設定過去的做法，也是它看起來
  不可靠的原因：

  | 主機 | 機制 | 設定變更何時生效 |
  | --- | --- | --- |
  | Claude Code | `PreToolUse` hook 直接改寫生成呼叫的 `model` | 下一次生成 |
  | OpenCode | 外掛的 `config` hook 設定 `agent.<name>.model` | 下一次**重啟 opencode** |
  | Qwen Code | 將 `model:` 烘進已安裝的代理檔案 | 下一次 `./install.sh qwen` |

  **值的寫法因主機而異**，其中 Claude Code 最嚴格：

  - **OpenCode** 使用帶 provider 前綴的完整 id（`anthropic/claude-haiku-4-5`）。
  - **Qwen Code** 使用裸 id——`provider/` 前綴會自動去除。
  - **Claude Code 的生成工具只接受 `sonnet`、`opus`、`haiku`、`fable`
    這四個別名。** 若設定值指向其中某個模型家族，會自動對應
    （`anthropic/claude-haiku-4-5` → `haiku`）；但無法對應到任何已知家族的
    值就無法綁定：該次生成會使用主機預設模型，並由伺服器發出警告。
    這是刻意不傳遞而非照傳——該工具會驗證 `model`，遇到不接受的值會讓
    **整次生成失敗**，照傳只會把一個無傷大雅的設定錯誤變成失敗的執行。

  代理名稱打錯同樣會被回報而不是默默忽略：在綁定已被強制執行之後，
  這是設定項目失效的主要剩餘原因。

  **在 OpenCode 上的優先順序為**：階段觸發的逐次模型（`stageModels`，由
  驅動器傳入）> 本設定所寫的 `agent.<name>.model` > 你自己在
  `opencode.json` 中為「本設定未指名的代理」所設的值 > 工作階段預設。
  因此在任何主機上，`agentModels` 都不會影響 `stageModels`。

  這個鍵**刻意與 `stageModels` 分開**，而不是併入 `stageModels.plan`：
  草稿撰寫與 PLAN 階段是兩件不同的工作，由不同的 agent 執行
  （`workflow-task-author` 與 `workflow-plan-author`），且只有後者是階段。
  把草稿撰寫指向便宜模型不應連帶悄悄改動規劃階段，反之亦然。設定
  `agentModels` 永遠不影響階段；設定 `stageModels` 也永遠不影響草稿撰寫。

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
解析為 `ado` 時，它的 publish 階段會透過 Azure DevOps MCP 伺服器而不是
`gh pr create` 來開啟草稿 PR。`ci-runs`（main-sitter）來源有一個
真正的 ADO 版本（`ado-ci-runs.ts`），透過 MCP 伺服器的
`pipelines_get_builds` 工具輪詢 Azure Pipelines 而不是 `gh run list`，把建置結果
正規化成和 GitHub 來源相同的、經過裁定的形狀——「只看最新的 head，
絕不看執行中途」這條邏輯兩邊完全一樣。`dependency-scan` 和
`ci-runs` 都不需要 `ado.selfLogin`（不像 PR 形狀的來源，它們不受限
於某個身分），但仍然需要 PAT（`AZURE_DEVOPS_EXT_PAT`）。

每種 sitter 類型的 publish 階段——在 ADO 上——都是透過 Claude host
的寫入防線 hook（`check-stage-guard`）開啟 PR 和發表討論串留言的，
這個 hook 只允許恰好三種 ADO 寫入形狀：讀取、討論串留言的回覆，
以及建立一個全新的草稿 pull request。在 MCP 上這對應到讀取工具、
`repo_create_pull_request_thread`/`repo_reply_to_comment`，以及帶有
`isDraft: true` 的 `repo_create_pull_request`。任何對*既有* PR 的變更
——完成、放棄、投票、加入審查者——以及任何未被列舉的 ADO 工具，都會被
直接擋下，不論是哪種工作流程類型或哪個階段；若你連了 Azure DevOps
MCP 伺服器，看起來會變更狀態的 ADO MCP 工具名稱也會被盡力
（best-effort）擋下，作為縱深防禦。

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

Azure DevOps **只透過 Azure DevOps MCP 伺服器觸達**
（[`@azure-devops/mcp`](https://github.com/microsoft/azure-devops-mcp)，以
`npx` 啟動）——階段 agent 依名稱呼叫它的工具，driver 自己的輪詢來源與 ship
把關點也走同一個伺服器。沒有 `curl`、沒有 `az` CLI，也沒有 REST 退路：
只有一條傳輸路徑，因此階段提示詞不可能和管轄它的白名單走偏。

**伺服器的註冊名稱必須剛好是 `azure-devops`。** 階段提示詞與產生出來的
agent frontmatter 以 `mcp__azure-devops__<tool>` 的形式指名工具；換成任何
其他註冊名稱，都會讓每一次 ADO 階段呼叫都指向一個不存在的工具。
`./bootstrap.sh` 會替你完成註冊。這是一個常數而非設定項，因為那些名稱存在
於 CI 會做 diff 檢查的產生檔案裡。

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
  就是如此），這樣密鑰就永遠不會被提交。driver 啟動 MCP 伺服器時，會自行
  把它 base64 編碼成伺服器的 `PERSONAL_ACCESS_TOKEN`——你不需要手動編碼任何
  東西。階段 agent 使用的是*你*註冊的那個伺服器，所以它們那份憑證存在該筆
  註冊裡（`./bootstrap.sh` 會寫入）。
- **`ado.mcp`**——選填；MCP 伺服器如何被啟動。每個欄位都有可用的預設值，
  所以多數安裝完全不需要它。
  - `command`（預設 `"npx"`）與 `args`（預設
    `["-y", "@azure-devops/mcp@<pinned>"]`）——離線／封閉網路的安裝可以把
    它們指向本機已安裝的執行檔。版本是**釘住**的：伺服器的工具名稱被寫死
    在階段提示詞與產生出來的 agent frontmatter 裡，浮動的版本可能在它們腳下
    重新命名整個工具面。
  - `authentication`（預設 `"pat"`）——`pat`、`azcli`、`envvar` 或
    `interactive`。注意伺服器*自己的*預設是 `interactive`，它會開啟瀏覽器；
    輪詢迴圈沒有人去點它，所以引擎會**拒絕**該模式，而不是卡在一個沒有人
    看得到的提示上（如果你真的坐在終端機前，可設定
    `ADO_MCP_ALLOW_INTERACTIVE=1`）。`envvar` 會從 `ADO_MCP_AUTH_TOKEN`
    讀取 bearer token。
  - `domains`（預設 `["repositories", "pipelines"]`）——要載入哪些工具領域。
    工具越少，模型面對的選單就越小。
  - `tenant`——Azure 租戶 id，供 `interactive`/`azcli` 對多租戶組織使用。
  - `env`——給被啟動的伺服器的額外環境變數，例如內部 CA 用的
    `NODE_EXTRA_CA_CERTS` 或 `HTTPS_PROXY`。**這裡不是放密鑰的地方**——PAT
    屬於 `ado.pat`（或環境變數），那是 hub 知道要遮蔽的欄位。

  ```jsonc
  {
    "ado": {
      "organization": "https://dev.azure.com/acme",
      "project": "widgets",
      "selfLogin": "sitter@acme.com",
      "mcp": { "env": { "NODE_EXTRA_CA_CERTS": "/etc/ssl/corp-ca.pem" } }
    }
  }
  ```

  `ado.mcp` **僅限使用者層級**，和 `organization`、`pat` 一樣：它指定的是一個
  會被啟動的命令，因此不能讓被複製下來的儲存庫決定它。

  隨 REST 傳輸一併移除的還有：`ado.customHeaders`、
  `ado.insecureSkipTlsVerify` 與 `AGENTIC_WORKFLOW_ADO_HEADERS`。被啟動的
  MCP 伺服器沒有可注入 per-request 標頭或 TLS 的接縫。殘留的鍵會被解析並
  忽略，並印一行警告指名它。**不再支援**自架的 Azure DevOps Server——該
  伺服器接受的是組織名稱，且以 `dev.azure.com` 為目標。

- **`"ado"` 的先決條件**：一個 Personal Access Token——放在
  `AZURE_DEVOPS_EXT_PAT`（優先）或 `ado.pat`——範圍需涵蓋 Code
  (read) + Pull Request contribute (comment)，另外還需要 Node 20+ 與
  `npx`，MCP 伺服器才能啟動。不需要 `az` CLI，也不需要 `curl`。
- **在 ADO 上的語意**：失敗的檢查來自 PR 的驗證**管線執行**——一個 PR
  不跑任何管線的儲存庫永遠不會觸發 `failing-checks`，而非管線的分支原則
  （最少審查者人數、留言解決狀態、必要的工作項目連結）**完全看不見**，
  因為 MCP 伺服器沒有提供原則工具。留言來自 PR 討論串；一次負面的
  審查者投票對應到 changes-requested；`mergeStatus: conflicts`
  對應到 merge-conflict。
- 階段的 bash 白名單是依平台分開的：清單的
  `platformAllowlist.github` / `.ado` 萬用字元模式，會被合併進該
  階段解析後平台所對應的 `bashAllowlist`。但 `.ado` 那份是**空的**：
  Azure DevOps 只透過 MCP 工具觸達，任何殘留的 bash 萬用字元模式都只會是
  通往同一組 API 的第二道、且不受保護的門。ADO 的可用面改由
  `platformTools.ado` 表達——該階段可呼叫的工具名稱，同時也會產生它在每個
  宿主上的 agent `tools:` frontmatter。

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
  約為 N 倍的審查時間；預設關閉。

  每一趟都被要求只專注在自己的視角上，並且**只針對該視角真正涉及的軸**回報
  逐軸結果——沒有實際檢視的軸要留白，絕不可記成乾淨的 PASS：各趟以最差者勝
  合併，這裡的臆測會直接變成整個階段在那個沒人審查過的軸上的裁定。因此
  **逐趟**的軸涵蓋強制檢查是關閉的（不能因為某個視角沒審它被告知不用審的軸
  就拒絕它）。

  至於該階段的 `requiredAxes` 會怎樣，取決於你的視角清單：

  - **視角合起來涵蓋了每一個必要軸**（例如 engineering 的全部五個）時保有
    保證：跨各趟**累積**的紀錄仍必須涵蓋每一個軸，有缺口就以 ERROR 停止迴圈，
    而不是拿一份根本沒跑完的審查去重建。這就是同時取得視角與涵蓋保證的方式，
    不需要額外設定。
  - **沒有涵蓋到**時（例如 `["security", "test-adequacy"]`），不能要求它們交出
    永遠不會回報的軸，所以該階段的涵蓋檢查關閉——沒有任何視角涵蓋的軸就不會被
    審查。兩個 host 都會在啟動時警告，並明確指出是哪些軸。

  無論哪一種，完全沒有記錄裁定的視角都會變成 ERROR，而不是悄悄消失的意見。
  如果你要的是逐軸的分趟而不是自由文字的視角，請改用下面的 `stageFanout`。
- **`workflows.<kind>.stageFanout`**——階段名稱 → `"axis"` 或 `"none"`：讓一個
  check 階段依它的 `requiredAxes` 各跑一趟，每一趟只被要求審查並
  回報**一個**軸。各趟以最差者勝合併，而且**在 OpenCode 上它們是平行跑的**——
  把 fan-out 打開本身就是「我要 N 趟聚焦審查」的請求，不需要再靠
  `stageConcurrency` 才不會慢。要夾住它請設 `stageConcurrency`（見下）；
  Claude Code 與 Qwen Code 這兩個 host 不論你怎麼設都是一趟一趟跑。

  ```jsonc
  { "workflows": { "engineering": { "stageFanout": { "review": "axis" } } } }
  ```

  成本與 `reviewLenses` 相同（約 N 倍），威脅模型上的好處也相同（沒有任何
  單一審查者能讓變更蒙混過關），但它是在視角模式做不到的層級上強制涵蓋——
  **逐趟**：每一趟
  都以自己的軸受到強制檢查，而且只要有任何一個軸沒有結果，這個階段就無法前進
  ——缺口會讓迴圈以 ERROR 停下，而不是拿一場根本沒發生的審查去重建。預設關閉；
  兩個旋鈕都沒設的階段與現況逐位元組相同。

  `"none"` 可以把清單檔（階段上的 `fanout`）宣告的 fan-out 關掉。設定檔勝過
  清單檔，與 `stageModels`、`stageContext` 一致——而且這也是你唯一能碰到內建
  類型的方式，因為它們的清單檔是隨 `@agentic-workflow/core` 套件一起出貨的。

  在名為 `review` 的階段上，**`reviewLenses` 勝過這個設定**，所以既有的視角
  設定行為完全不變；當設定好的視角清單覆蓋掉已宣告的 fan-out 時，兩個 host
  都會警告。命名到不存在階段的鍵會被接受、忽略並警告，與 `stageModels` 相同。
- **`workflows.<kind>.stageConcurrency`**——階段名稱 → 該階段的分趟最多可以有
  幾趟**同時**進行。沒設的話，逐軸的 `stageFanout` 會把**所有**分趟同時跑掉，
  其他情況則是一趟一趟跑。對上面兩種
  多趟模式都有效：`stageFanout` 的逐軸分趟，以及 `reviewLenses` 的視角分趟。

  ```jsonc
  // 把五個軸的 fan-out 夾到同時只有兩趟
  { "workflows": { "engineering": { "stageFanout": { "review": "axis" }, "stageConcurrency": { "review": 2 } } } }
  // ……或是替視角設定開啟平行，它預設不平行
  { "reviewLenses": ["a hostile attacker", "the next maintainer"], "workflows": { "engineering": { "stageConcurrency": { "review": 2 } } } }
  ```

  分趟的 check 階段在設計上彼此獨立——每一趟都是對同一個工作樹的唯讀審查，只被
  要求涵蓋自己的軸或視角、不涵蓋其他的，最後以最差者勝合併——所以同時跑它們是
  延遲上的收穫，而不是語意上的改變：五個軸的審查大約只花一次審查的時間，而不是
  五次。這也是 fan-out 不再需要第二個開關才會平行的原因。

  它仍然是個**成本旋鈕**：同時有 N 趟進行，代表對你的用量
  上限同時開了 N 個模型 session，所以 `1` 就是用量吃緊時把分趟階段拉回依序執行的
  方式。這個值會被夾到該階段的分趟數，所以不管你設多少，單趟的階段都不受影響。

  `reviewLenses` 維持原本依序執行的預設。它比 fan-out 更早存在，所以既有的視角
  設定——包括覆蓋掉已宣告 fan-out 的那種——在你設這個旋鈕之前，行為完全不變。

  **僅限 OpenCode。** 在那裡每一趟都有自己的 session，這正是逐趟的裁定、軸要求
  與證據帳本能夠分開的原因。Claude Code 與 Qwen Code 由編排者去產生分趟的
  subagent，而 MCP server 只保有一個 armed pass、一份 stage marker 與一份證據
  帳本——三者都被 guard hook 讀取——所以一趟沒有身分可以用來歸屬裁定或工具呼叫；
  這兩個 host 會**警告**，而不是默默忽略這個旋鈕。命名到不存在階段的鍵會被接受、
  忽略並警告，與 `stageModels` 相同。
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
