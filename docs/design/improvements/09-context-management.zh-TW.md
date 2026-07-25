[English](09-context-management.md) | 繁體中文

# 09 — 階段提示詞的上下文預算

**狀態：提案中。** 計畫 01–07 是已實作功能的設計紀錄；本計畫與 08 一樣尚未實作。

## 背景

系統裡沒有任何一處會限制階段提示詞的內容。`packages/core/src` 底下沒有任何
截斷、預算或摘要機制，設定檔裡也沒有任何旋鈕能限制上下文——`config.ts` 帶了
`maxIterations`（第 64 行）、`stageTimeoutMinutes`（第 78 行）、`worktreesDir`
（第 87 行）與 `reviewLenses`（第 95 行），除此之外沒有任何一項碰到提示詞大小。

階段提示詞的*樣板*本身很小，每個只有 11 到 15 行
（`workflows/engineering/stages/*.md`）。真正有份量的內容全都由
`promptContext`（`workflow/engine.ts:32-65`）從 `WorkflowState.artifacts` 注入，
而那是一個 `Record<string, string>`，裝著每個已完成階段的**完整輸出文字**
（`state.ts:69`，由 `engine.ts:16-19` 的 `withArtifact` 寫入）。那份文字是一整份
代理人逐字稿：驅動程式把該回合所有 text part 串接起來
（`driver.ts:681-685`），再原封不動往下傳。

在每個階段都跑在前沿模型上時，這還撐得住。但現在 `StageDef.model`
（`manifest/schema.ts:69`）與 `config.workflows.<kind>.stageModels`
（`config.ts:119`，由第 279-280 行的 `modelFor` 解析）明確地邀請你把某個階段指向
一個較小的模型——這就撐不住了。小上下文模型的可用空間更少、長上下文的注意力
明顯更差，而且——這才是本設計的關鍵——**無法被信任去自行篩選它自己的輸入**。
因此這裡提出的每一項控制都是**驅動程式端、決定性的**。「叫代理人講精簡一點」
不是一種控制。

### 到底哪裡出了問題

| # | 缺陷 | 證據 |
|---|------|------|
| 1 | **`extractPlan` 會把整條稽核尾巴一起洩出來。** 它從 `## Implementation Plan` 一路切到 body 結尾——但 `appendNote` 是把稽核引言附加到檔案結尾，`appendPlan` 也是把計畫寫在結尾。於是每一條 `> CLAIMED`、`> BUILD started`、`> VERIFY verdict`、`> REVIEW verdict` 註記都落在計畫*裡面*，`artifacts.plan` 就跨越每一次疊代**以及每一次先前的執行**不斷累積。BUILD／VERIFY／REVIEW 提示詞裡的計畫區塊只會單調成長，永遠不會重置。 | `task/store.ts:114-118` 對照 `:726-732` 與 `:773-777` |
| 2 | **多鏡頭 REVIEW 會把自己的產出物加倍。** 設了 `reviewLenses` 之後，該階段每個鏡頭觸發一次，而產出物是所有鏡頭的 `outputs.join("\n\n")`——最多五份完整的審查逐字稿（`reviewLenses` 上限為 `.max(5)`），再加上裁定重試時多出來的那一輪。這些全部都會進到下一次 BUILD 的提示詞。 | `driver.ts:786`、`:824-825`、`:892`；`config.ts:95` |
| 3 | **精簡通道被冗長通道淹沒。** `verdictFeedbackBlock` 早就把重新建置真正需要的東西渲染出來了——裁定理由、未通過的驗收條件、帶 `file:line` 的阻斷性軸向發現——只有寥寥數行。驅動程式把它放在前面，然後把整份逐字稿接在它後面。 | `verdict.ts:261-280`；`driver.ts:1132-1133` |
| 4 | **沒有疊代記憶。** 在第 N 次疊代時，BUILD 收到的是計畫加上*最近一次*的檢查失敗。它從來收不到第 N−1 次疊代已經試過什麼：`build.md` 沒有引用 `{{artifacts.build}}`，而且 `withArtifact` 每輪都會覆寫那個鍵。沒有任何機制能阻止模型在兩個錯誤修法之間來回擺盪，直到上限被觸發。 | `workflows/engineering/stages/build.md`；`engine.ts:16-19` |
| 5 | **提示詞大小沒有被觀測。** sidecar 早就持久化了每階段的 `input`／`output`／`reasoning`／`cacheRead`／`cacheWrite`，hub 也早就算出了每階段以 token 加權的快取命中率。但沒有任何地方記錄驅動程式組出來的提示詞大小，所以上述所有成長在 Metrics 分頁裡都看不見。 | `metrics.ts:34-52`、`metrics-file.ts:33-46`、`packages/hub/src/server/metrics/cache.ts` |

缺陷 1 與 2 會互相加乘：兩者都隨疊代次數*單調遞增*，所以提示詞最大的時候，
正好就是迴圈最卡、模型最沒有餘裕可以翻盤的時候。

### 裁切不會損失任何東西

每一輪的完整文字，在成為產出物之前就已經逐字寫進持久化的執行紀錄了
（`appendRunLog`，`driver.ts:824`）。產出物是一份*提示詞組裝用*的副本，不是
事件的紀錄。裁切它不會損失任何證據——執行紀錄與 `runs/<id>.metrics.json` 依然
完整。

這也正是本 repo 自己的準則早就否定了目前行為的原因：
`skills/context-engineering/SKILL.md:258` 訂出了「每個任務聚焦上下文少於 2,000 行」
的目標，並且把貼上整份測試輸出點名為浪費的做法。但沒有任何一個 engineering
階段代理人會去呼叫那個 skill——它只被 `spec-driven-development` 和
`using-agent-skills` 引用。

## 設計

### 一個純函式裁切原語

新增 `packages/core/src/workflow/budget.ts`。純函式、零相依——就是
[`README.md`](./README.md) 訂下的純度邊界（`state.ts` 與 `store.ts` 的述詞保持
純函式；任何碰到 shell／時鐘／檔案系統的東西都留在驅動程式）。

```ts
/** Marker left in place of elided text. Deliberately unmistakable: a clamped
 *  artifact must never read as a complete one to a model that will act on it. */
export const ELISION = (n: number): string => `\n\n[… ${n} characters elided by the stage context budget …]\n\n`

/**
 * Clamp `text` to roughly `limit` characters, preserving both head and tail.
 * `Infinity` (the default when nothing is configured) is the identity.
 *
 * Head AND tail, not a head truncate: a check stage opens with its verdict
 * rationale and closes with the concrete failing assertions, and a re-build
 * needs both ends. A plain head-slice reliably throws away the half that names
 * the failing file and line.
 */
export const clamp = (text: string, limit: number): string
```

以字元數而非 token 數計算，而且是刻意的：core 沒有 tokenizer，斷詞方式又因模型
而異，而位元組預算是精確、可測試且純的。文件裡應該註明換算比例（英文散文與
程式碼約 3.5–4 字元／token），讓操作者能自行換算。

### 兩層結構，比照 `model` / `stageModels`

`StageDef.model` 已經是層疊在 `config.workflows.<kind>.stageModels.<stage>`
之下。預算沿用完全相同的形狀——這份對稱性正是選擇它、而不是選擇單一全域旋鈕的
理由，因為整件事的重點就在於各階段的需求不同。

**Manifest 層** —— 在 `StageDefSchema`（`manifest/schema.ts:44-82`，接在第 77 行
的 `requiredAxes` 之後）新增一個選填欄位：

```ts
/**
 * Per-artifact character ceilings for this stage's composed prompt, keyed by
 * artifact name (`plan`, `build`, `verify`, `review`). Unset ⇒ unbounded.
 * A budget is a property of the CONSUMING stage — see "Apply at render".
 */
context: z.record(z.string(), z.number().int().positive()).optional(),
```

**設定層** —— `workflows.<kind>.stageContext.<stage>` 覆蓋它，由一個完全比照
`modelFor`（`config.ts:279-280`）的 `contextFor(config, kind, def)` 解析，並比照
`unknownStageModelKeys`（第 289-290 行）提供 `unknownStageContextKeys` 警告，
避免一個打錯的階段名稱默默地被解讀成「不設限」。

**未設定 ⇒ 不設限 ⇒ 與今日逐位元組相同。** 這是 [`README.md`](./README.md) 的
向後相容要求（「所有新增設定旋鈕都未設定時，測試套件必須維持綠燈」），也正是
這個改動能安全落地的原因：跑前沿模型的操作者不會看到任何變化；把 VERIFY 指向
小模型的操作者，就只調降 VERIFY。

在 `docs/configuration.md` 裡以**小上下文設定範本**的形式提供建議值，而不是設成
預設值：

```jsonc
"workflows": {
  "engineering": {
    "stageModels": { "verify": "…/qwen-…" },
    "stageContext": {
      "build":  { "plan": 24000, "verify": 8000, "review": 8000 },
      "verify": { "plan": 16000, "build": 8000 },
      "review": { "plan": 16000, "build": 8000 }
    }
  }
}
```

### 在渲染時套用，而不是在儲存時

裁切屬於 `promptContext`（`engine.ts:32-65`），**不屬於** `withArtifact`
（第 16-19 行）。預算是*消費端*階段的性質：BUILD 負擔得起一份大計畫，而 REVIEW
會希望建置摘要被裁得更狠，而同一份產出物會被好幾個需求不同的階段消費。

除了模型化的理由之外，還有一個正確性的理由。`persist.ts:52` 會把 `artifacts`
快照成 `recover` 用的復原狀態。在儲存時裁切會把裁過的文字持久化，於是被復原的
執行會從一份有損的副本繼續——而且每被重新裁切一次，損失就再疊加一次。

### `extractPlan` 停在稽核尾巴之前

缺陷 1 是**修 bug，不由設定把關**。`artifacts.plan` 跨執行無限成長在任何模型上
都是錯的；只不過在小模型上是致命的。

所需的機制早就存在了。`lastMarkerIndex`（`store.ts:69-79`）會找出限定在行
開頭的標記，而 `lifecycleWindow`（第 81-84 行）正是「只讀取當前生命週期視窗」
這個做法的既有前例——它本來就是為了同一類問題而寫的。`extractPlan` 應該把切片
結束在標題之後的第一行稽核註記，而不是一路切到 body 結尾。

稽核註記都是以 `\n> …\n` 寫入的完整行（`store.ts:726-732`），這正是這個做法可靠
的原因；`lastMarkerIndex` 已經載明的那個啟發式警告（一段被貼上的完整稽核行無法
區分）原樣適用。

### 結構化通道永不被裁切

在 `driver.ts:1132-1133`，順序本來就是對的——`verdictFeedbackBlock` 在前、散文
在後。改動在於**只有散文受預算約束**。結構化區塊本身就有天然上限（每個未通過
的驗收條件一行、每個阻斷性發現一行），而且是提示詞裡訊號密度最高的內容，所以
豁免。

值得明說的後果是：在很緊的預算下，重新建置可能只會收到結構化發現加上一小段
散文摘錄。這是刻意的取捨。發現本身帶著 `file:line`；散文是註解，而完整文字就在
執行紀錄裡。

### 疊代記憶：一份有上限的嘗試帳本

在 `WorkflowState`（`state.ts:58-100`）加上一份有上限的 `attempts` 清單——每次
計數疊代一筆短紀錄：階段、生效裁定，以及 `VerdictRecord` 上早就捕捉到的那行
`reason`。透過 `workflows/engineering/stages/build.md` 裡的新區段渲染進 BUILD：

```
{{#attempts}}Previous attempts on this task (do not repeat a fix that already failed):
{{attempts.lines}}{{/attempts}}
```

上限取最近 K 筆（K = 5 足以涵蓋任何實際的 `maxIterations`），為空時整段丟棄——
`renderPrompt` 本來就會丟棄渲染成空的區段（`template.ts:66-70`），所以第一次
疊代的提示詞完全不變。

這是唯一一項會*增加*提示詞的項目，也應該就以這個角度來辯護：用寥寥數行阻止
一個弱模型重試它已經試過的修法，遠比那幾行所取代的逐字稿更值得佔用視窗。它也
順帶給了疊代上限一個診斷——今天一次觸頂的執行只會告訴你三次疊代都失敗了，
不會告訴你這三次試的其實是同一件事。

### 可觀測性：把提示詞大小放進 sidecar

在 `StageSample`（`metrics.ts:34-52`）與 `MetricsSampleSchema`
（`metrics-file.ts:33-46`）加上選填的 `promptChars`——選填很重要，因為
`parseRunMetrics` 在結構描述不符時採取失敗即關閉（`metrics-file.ts:76-85`），
一個必填欄位會默默地讓現有的每一份 sidecar 失效。同時記錄組出來的大小與被省略
的字元數，這樣「預算開始咬人了」才能跟「提示詞本來就小」區分開來。

在 hub 的 Metrics 分頁中，把它放在現有的快取命中率旁邊按階段呈現
（`packages/hub/src/server/metrics/cache.ts`、`metrics/aggregate.ts`）。真正重要
的訊號是單次執行跨疊代的提示詞成長，而該分頁的分析單位本來就是「一輪
（pass）」，正好是對的單位。

沒有這一項，就沒有人能判斷預算到底有沒有幫上忙，這個旋鈕也就淪為傳說。

### 範圍紀律

刻意**不**納入本計畫的部分：

- **角色設定與 skill 的份量。** 已量測過，而且數字更大：在任何任務內容之前，
  PLAN 就已經載入 AGENTS.md（14,289 B）＋ `workflow-plan-author`（12,463 B）
  ＋ 它的角色設定要求的 skill——`workflow-orchestration`（29,293 B）與
  `task-backlog-management`（17,727 B）——大約 74 KB 的指令，此時任務都還沒被
  提到。要縮減它是一個提示詞架構的改動，波及範圍橫跨兩個 host 以及產生出來的
  `plugins/*/agents/*.md`。另立計畫。
- **用模型呼叫做摘要。** 靠請模型摘要來壓縮產出物，會在本計畫存心要保護的那條
  路徑上，正正加上一個失敗模式、一份延遲成本，以及第二個對弱模型的相依。只做
  決定性裁切。
- **跨階段共用 session。** `runStage` 用 `subtask: true` 的指令對同一個
  `sessionID` 觸發每一個階段（`driver.ts:659-672`）；要改動它是驅動程式的重新
  設計，不是上下文預算。
- **以 token 為準的預算。** 需要在 core 裡放一個 tokenizer。字元數精確又純；
  改為記載換算比例。

## 邊界情況

- **什麼都沒設定** → 每個上限都是 `Infinity` → `clamp` 成為 identity → 組出來的
  提示詞與今日逐位元組相同。這一點要有明確的測試，做法比照 08 的無把關路徑。
- **預算比省略標記本身還小。** 退化成只剩標記，而不是產生負長度的切片；該階段
  仍然拿得到永不被裁切的結構化區塊。
- **所有產出物都被裁到空。** 該階段仍然會收到目標、驗收條件、worktree 指示、
  diff 邊界，以及 `composeStagePrompt`（`engine.ts:81-86`）附加的契約區塊。預算
  可以餓死*歷史*，永遠不會餓死*契約*。
- **多鏡頭 REVIEW。** 鏡頭輸出在產出物存在之前就已經串接完成
  （`driver.ts:892`），所以預算是套用在串接結果上。這是正確的——上限是針對
  BUILD 讀到的量，不是針對跑了幾個鏡頭——但這也代表五鏡頭的審查在緊預算下會被
  大量省略，而這正是結構化區塊必須豁免的最強論據。
- **對註記早於此修正的舊任務執行 `extractPlan`：** 修正讀的是 body 而不是歷史，
  所以舊任務的計畫會在下一次被 claim 時自動清乾淨。
- **計畫本身合法地含有 `>` 引言行。** 切片會提早結束。要比照稽核註記的形狀
  （行首的 `> …`，就像 `lastMarkerIndex` 那樣）而不是任何引言，並誠實載明殘留的
  啟發式風險——那正是 `lifecycleWindow` 已經背著的同一個。

## 測試計畫（TDD）

- `workflow/budget.test.ts`（新檔）：未超過上限時為 identity；`Infinity` 時為
  identity；超過上限時頭尾都保留且帶有標記；標記回報的省略字元數正確；上限小於
  標記長度時能合理退化；裁切具有冪等性。
- `task/store.test.ts`：**回歸測試，今天會失敗**——body 為 `${PLAN_HEADING}`
  ＋計畫文字＋`> CLAIMED …`＋`> BUILD started …`＋`> VERIFY verdict: FAIL …`
  時，只回傳計畫文字。另加：有註記但無計畫、有計畫但無註記（既有的第 119-121
  行案例必須仍然通過），以及計畫中含有合法引言的情況。
- `workflow/engine.test.ts`：`promptContext` 依解析出的階段預算裁切；無預算狀態
  下 `composePrompt` **逐位元組相同**；第 0 次疊代時沒有 `attempts` 區段。
- `manifest/schema.test.ts`：`context` 為選填，且在五份已出貨的 manifest 上都
  不存在；非正數的上限會被拒絕。
- `config.test.ts`：`stageContext` 勝過 manifest 的 `context`；階段名稱打錯時
  `unknownStageContextKeys` 發出警告——比照既有的 `stageModels` 案例。
- `workflow/metrics-file.test.ts`：在 `promptChars` 之前寫入的 sidecar 仍能解析
  （失敗即關閉的定樁）。
- 驅動程式：當散文預算被裁到零時，結構化的 `verdictFeedbackBlock` 完整倖存。

## 需要更新的文件

- `docs/configuration.md`（＋ `.zh-TW`）—— `stageContext` 旋鈕、它如何層疊在
  manifest 的 `context` 之上，以及上面那份小上下文設定範本。
- `skills/workflow-orchestration/SKILL.md` —— 產出物契約：一個階段保證會收到
  什麼、什麼可能被省略，以及執行紀錄才是完整紀錄。
- `docs/workflows/engineering.md`（＋ `.zh-TW`）—— 重新建置會收到結構化發現加上
  一段有上限的摘錄，以及嘗試帳本。
- `packages/core/workflows/README.md` —— manifest 的 `context` 欄位。
- `docs/architecture.md`（＋ `.zh-TW`）—— 把 `workflow/budget.ts` 放進 core 的
  模組地圖。
- `README.md` —— 一行即可，因為上下文預算是操作者可見的行為。

## 本計畫刻意留下的後續項目

1. **階段代理人不會呼叫 `context-engineering`。** 該 skill 陳述的正是本計畫要
   機制化的準則（`SKILL.md:258`），而最該受惠的那些角色設定——重新建置時的
   `workflow-build`、決定要讀多少程式碼的 `workflow-plan-author`——從來不會載入
   它。這是純提示詞的改動，但它屬於角色設定份量那份工作，不屬於這裡。
2. **角色設定與強制 skill 的份量**（任務內容之前約 74 KB），如上。
3. **`reviewLenses` 沒有任何上下文計量。** 打開鏡頭會同時放大成本與產出物大小，
   而執行摘要裡沒有任何訊號顯示這件事發生了；本計畫的度量工作正是要能回報它的
   前置條件。
