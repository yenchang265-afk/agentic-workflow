[English](CLAUDE.md) | 繁體中文

# AGENTS.md — <專案名稱>

<!--
  給由 agentic-loop 外掛驅動的專案使用的起始 AGENTS.md。

  使用方式：
  1. 把這份檔案複製到你的儲存庫根目錄，命名為 `AGENTS.md`（OpenCode）或
     `CLAUDE.md`（Claude Code）。兩者都要？複製兩份，不要用符號連結——
     符號連結無法在每一種檢出路徑下存活（zip 匯出、某些 CI artifact 步驟）。
  2. 填入每一個 `<placeholder>`，並刪除這些註解。
  3. 保持簡短。Agent 每次 session 都會讀取這份檔案；這裡的每一行都會
     消耗 context。只陳述 agent 無法從程式碼推導出的事實，以及你真的
     希望被強制執行的規則。
-->

給在這個儲存庫中工作的 AI 編碼 agent 的指引。

## Project Facts

- **這是什麼：** <一行說明用途，例如「用於發票處理的 REST API」>
- **技術堆疊：** <語言、框架、套件管理工具，例如「TypeScript、Fastify、npm」>
- **目錄結構：** <2–4 條說明各項內容的位置，例如「src/ 應用程式碼、tests/ 對應 src/ 的結構、docs/ 設計筆記」>

### Commands (run these — definition of done)

```bash
<install command>        # e.g. npm install
<typecheck/lint command> # e.g. npm run typecheck && npm run lint
<test command>           # e.g. npm test
<build command>          # e.g. npm run build (omit if none)
```

只有當 typecheck、lint 和測試全部通過，且變更的行為已經被端對端
驗證過（執行應用程式、呼叫端點、點擊流程——不只是單元測試）時，
一項變更才算**完成**。

## Loop vs Ad-hoc

兩種執行模式。依範圍選擇，而不是憑習慣。

當一個目標是多步驟、且應該在大致無人看管的情況下執行時（一項功能、
一次帶測試的重構，任何值得建一份任務檔案的工作），**使用 agentic loop**：

1. `/agentic-loop:engineering new <idea>` —— 訪談會產生一份草稿任務，
   包含目標和可測試的驗收標準（一律來自你本人，絕不用猜的）
2. 審查草稿，然後執行 `/agentic-loop:engineering approve <id>` —— 將其排入佇列
3. `/agentic-loop:engineering plan <id>` 認領已排入佇列的任務，
   在執行前寫入 `## Implementation Plan`，並將其暫存在計畫把關點
   （`claim`/`watch` 絕不會自動為已排入佇列的任務產生計畫）
4. `/agentic-loop:engineering approve <id>`（或 `replan <id> [why]`）——
   核准後，一個 `claim`/`watch` worker 會在 `feature/<id>` 分支上無人看管地
   執行 BUILD→VERIFY→REVIEW；你審查結果，並用
   `/agentic-loop:engineering approve <id>` 發布它

`approve` 在每一個把關點都是同一個動詞——由任務所在的資料夾決定
要做的動作，因此永遠不會有歧義。省略 id 的 **`/agentic-loop:engineering approve`**
會推進目前唯一停在迴圈把關點上的任務（一份暫存的計畫或一份完成的
審查；兩者都沒有時，才退而推進唯一的一份草稿。如果不只一個在等待，就要帶上
id），而
**`/agentic-loop:engineering replan`** 會把一份暫存的計畫送回去。

對於單一、範圍明確的請求（重新命名、小修正、提問），**維持臨時
（ad-hoc）模式**：直接呼叫對應的 skill 並嚴格遵循它。

## Lifecycle (both modes)

| 階段  | Skill                                              | 結束條件                                  |
|--------|-------------------------------------------------------|------------------------------------------------|
| PLAN   | `spec-driven-development`、`planning-and-task-breakdown` | 規格／計畫已存在；任務夠小且可驗證 |
| BUILD  | `incremental-implementation`、`test-driven-development`  | 先寫測試；全部通過                |
| VERIFY | `debugging-and-error-recovery`                           | 行為已經過端對端驗證；指令全部綠燈 |
| REVIEW | `code-review-and-quality`                                | 審查發現已處理或明確豁免 |

## Intent → Skill Mapping

如果一項任務符合某個 skill，就呼叫它——只要有適用的 skill，絕不直接實作。

- 功能／新功能 → `spec-driven-development`，然後 `incremental-implementation` + `test-driven-development`
- 規劃／拆解 → `planning-and-task-breakdown`
- Bug／失敗／非預期行為 → `debugging-and-error-recovery`
- 程式碼審查 → `code-review-and-quality`
- 重構／簡化 → `code-simplification`
- API 或介面設計 → `api-and-interface-design`
- UI 相關工作 → `frontend-ui-engineering`
- 整個生命週期、無人看管 → 迴圈（見上方），而不是手動串接 skill

## Anti-Rationalization

以下想法是錯的；忽略它們：

- 「這太小了，用不到 skill。」
- 「我可以直接快速把它做完。」
- 「我先收集一下 context，之後再檢查 skill。」
- 「測試可以留到最後再寫。」
- 「這個邊界情況不可能發生，不用處理。」

正確的行為：先檢查並使用 skill；先寫會失敗的測試。

## Conventions

- **Commit：** conventional commits——`<type>: <description>`，其中
  type ∈ feat、fix、refactor、docs、test、chore、perf、ci。
- **分支／PR：** <分支命名 + PR 檢查清單，例如「feat/<slug>；PR 內文
  包含摘要 + 測試計畫」>
- **每次 commit 之前：** 沒有寫死的機密資訊；輸入在邊界處都經過驗證；
  錯誤訊息不會洩漏內部細節；diff 只包含可追溯到該任務的行。
- <專案特定規則，例如「絕不編輯 gen/ 底下的產生檔案」、
  「migration 需要一份 rollback 腳本」>

## Maintaining these rules

規則要靠自己爭取存在的位置——每一行在每個 session 都要消耗 context。

- **何時新增：** 在一個 agent *第二次*犯同樣的錯誤時。第一次——就地
  修正即可（有可能只是單一個案）；重複發生就代表這是系統性問題——
  把它寫下來。在一次計畫／發布**把關拒絕**的原因是缺少某條規則之後，
  或者當 VERIFY/REVIEW 持續標記出同一*類*缺陷時，也要新增。
- **要寫什麼：** 這個限制**以及它存在的原因**（這樣未來的 agent
  才不會把它「修」回去），而不是對這個 bug 的敘述。
- **放在哪裡：** 一項持久、跨任務的事實 → 放在這裡。一項任務特定的
  指示 → 放進任務檔案或階段提示詞（`loops/<kind>/stages/*.md`），不要放在這裡。
- **修剪：** 當一條規則所守護的程式碼被搬移、或它存在的理由已經消失，
  就刪掉它。一條過時的規則比沒有規則更糟。
