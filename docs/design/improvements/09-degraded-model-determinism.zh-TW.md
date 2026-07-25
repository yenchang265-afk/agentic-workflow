[English](09-degraded-model-determinism.md) | 繁體中文

# 09 —— 降級模型下的決定性

**狀態：部分發布。** 下列四項合約介面修正已實作並通過測試。最後一節列出的
決定性缺口只做了稽核、尚未實作——它們與
[08](./08-deterministic-gate-commands.zh-TW.md) 一起構成本計畫留下的 backlog。

## 背景

這個迴圈的信任邊界本來就很窄，而且是刻意如此。`advance()`
（`workflow/engine.ts:117-168`）完全依據 manifest 的轉移表決定下一個階段；
迭代計數、任務移動、提交、工作樹、PR 以及每一個工作來源都是程式碼。模型對
控制流只有一個把手：`workflow_verdict` 工具。就連那個把手也是推導出來的、
而非被信任的——`effectiveVerdict`（`verdict.ts:120-121`）只能把階段自行宣告
的裁定**變得更糟**。

但這個設計同時假設模型能夠 (a) 穩定地呼叫工具、(b) 在一次呼叫中填完一個
五元素的結構化酬載、(c) 送出精確的列舉字串。`stageModels`
（`config.ts:279-280`）一直允許你把某個階段指向小型的本機模型——而你一這麼
做，這三個假設就全部崩潰：

| 降級行為 | 迴圈原本的反應 | 位置 |
|---|---|---|
| 從不呼叫 `workflow_verdict` | 一次免費重跑，接著合成 `ERROR` → `onError` → **每一個檢查階段都停下來等人** | `driver.ts:797-891`、`server.ts:842-887` |
| 分兩次呼叫送出五個軸 | 兩次都被拒絕**並丟棄**——`axisCoverageIssue` 在與 `pending` 合併之前就先執行 | `verdict.ts:234-239` |
| 寫出 `severity: "nit"` | 被 zod 列舉拒絕——而弱模型面對被拒絕的呼叫通常是放棄，而不是修正 | `impl.ts:456`、`server.ts:672` |
| 在散文中寫 `WORKFLOW_VERIFY: PASS` | 被解析、被記錄、被丟棄 | `verdict.ts:356-365` |

第一列才是關鍵：迴圈不是降級，而是停止。第三列則是自己造成的——REVIEW 代理
人被**指示**去呼叫 `code-review-and-quality` 技能
（`prompts/agents/workflow-review/body.md:14`），而該技能自己的表格教的是
Critical / Nit / Optional / Consider / FYI。照著指示做的代理人，送出的嚴重度
反而被自己的工具拒絕。

這裡沒有任何一項是為了讓弱模型審查得更好。重點是讓迴圈能撐過弱模型的**形
狀**，好讓它確實得出的裁定被採用，而不是被丟掉。

## 設計

### 1. 由 nonce 把關的第二條裁定通道

`verdict.ts:7-12` 所保護的規則是：**不是模型自己寫的文字**——README、diff
片段、被引用的逐字稿——絕不能翻轉控制流。nonce 正好能把那種情況和我們想放行
的情況區分開。

新增 `workflow/verdict-block.ts`，純函式且為全函式（total）：

```ts
export const VERDICT_BLOCK_FENCE = "workflow_verdict"
export const VerdictPayloadSchema = z.object({ stage, verdict, reason?, criteria?, axes? })
export const verdictBlockContract = (stage: string, nonce: string): string
export const parseVerdictBlock = (text: string, stage: string, nonce: string): VerdictRecord | null
export const redactNonce = (text: string, nonce: string): string
```

設定沿用 `codePlatform` 的「全域＋每種類型覆寫」形狀（`config.ts:115/130`），
而不是 `stageModels` 的每階段形狀——因為這個設定是跟著「檢查階段被指向弱模型
的那個工作流程類型」走的：

```ts
verdictChannel: z.enum(["tool", "tool+block"]).default("tool")   // 以及 workflows.<kind>.verdictChannel
```

由 `modelFor` 旁邊的 `verdictChannelFor` / `blockChannelEnabled` 解析。

它不帶 shell，所以 `SHELL_BEARING_KEYS`（`config.ts:494`）與 repo 層的丟棄
邏輯都不受影響。之所以值得寫出來，是因為過去每一次新增設定鍵都必須先對這條
規則交代清楚。

**支撐安全性論證的有四項性質，而且四項都是承重的：**

1. nonce 必須相符，而且是**每次嘗試**重新產生——重跑不能被上一次嘗試遺留在
   逐字稿裡的區塊滿足；
2. `stage` 必須相符，對應工具本身的階段檢查；
3. 只有**最後一個**相符的區塊算數，於是「自我修正」的讀法與既有的重複工具
   呼叫一致；
4. 工具永遠優先——只有在完全沒有記錄到裁定時才會去讀區塊。

**唯一新增的殘餘風險是 nonce 外洩。** nonce 是不記名憑證，因此絕不能流入任何
後續階段讀得到的地方：`redactNonce` 會把它從執行日誌、以及串接進下一段提示的
階段產出物中清除，兩個 host 也都會在階段結束時清空它。任何**新增**的階段輸出
持久化出口都必須針對這點加上測試——這正是那種會悄悄把後段階段變成前段階段
偽造者的失效模式。

**提示介面。** `promptContext` 從新的選用欄位 `WorkflowState.verdictNonce`
輸出 `verdict: { nonce }`，而 `composeStagePrompt` 只在 nonce 存在時，於工具
合約之後附加 `verdictBlockContract(...)`——因此未武裝的迴圈，其提示與先前
**逐位元組相同**。引擎維持純函式；nonce 在 host 端產生（`randomUUID`），落在
與 `git.ts`／`isolate.ts` 相同的純度邊界另一側。

**觸發路徑。** nonce 必須在階段被觸發的地方武裝，而不是在 `advance()` 提早
組合提示的地方：

- **Claude** —— 由單一的 `firePrompt(loaded, state, stage)` 輔助函式負責武裝
  與組合；四個觸發點全部走它。`workflow_compose` 刻意**不**走：它是冪等的讀取
  操作，必須重用已武裝的 nonce，而不是產生一個迴圈接著就會拒絕的新 nonce。
  一個原始碼層級的測試釘住了「只有 `firePrompt` 自己的函式體與
  `workflow_compose` 可以直接呼叫 `composePrompt`」。
- **OpenCode** —— `advance()` 早已提前組好 `args`，而且 lens pass 還會再加工，
  因此合約是在觸發邊界處附加，而不是重新組合。文字與 `composeStagePrompt`
  產出的完全相同。

### 2. 軸涵蓋率可跨呼叫累積

`admitVerdict` 原本是對 `incoming` 檢查涵蓋率，之後才與 `pending` 合併。現在
反過來：先合併，再對合併後的紀錄做判斷。

被拒絕的那些軸必須留存下來，而**留在哪裡**正是整個設計的重點。它們**不能**
進入 `pending`——那是已受理的紀錄，而被拒絕的呼叫從未被受理（這個性質由
`driver.test.ts:1514-1521` 釘住）。所以改由拒絕分支把它們帶出來：

```ts
| { readonly ok: false; readonly message: string; readonly partialAxes: readonly AxisResult[] }
```

host 端則把它們放在 `pending` 旁邊的槽位（`partialAxes` map／模組層級的
`pendingPartialAxes`），並在下一次呼叫時作為 `admitVerdict` 的第四個引數傳
回去。預設值 `[]` 讓每一個既有呼叫點的行為與先前完全一致。

**只有軸會被帶著走，被拒絕呼叫的裁定絕不會**——這是不直觀的部分。把裁定也帶
著走會死鎖：一個因為沒有指名任何阻擋性發現而被拒絕的 FAIL，會以 worst-wins
的方式併入之後每一次呼叫，於是模型永遠無法藉由記錄一個乾淨的 PASS 來脫身。
只留軸不會損失任何東西，因為無論宣告的是什麼，`effectiveVerdict` 本來就會從
任何 critical／important 發現推導出 FAIL。因此 `blockingFindingsIssue` 造成的
拒絕帶著走的是**先前**的部分軸，而不是合併後的。

這一項無條件生效、不設開關：它對每一種模型都嚴格更好，而 worst-wins 合併確保
它無法把 FAIL 洗成 PASS。

### 3. 嚴重度改為正規化，而非拒絕

`verdict.ts` 中的 `normalizeSeverity` 會把模型實際會送出的同義詞——包含
`code-review-and-quality` 技能所教的那些——映射到被強制執行的三種，並且忽略
大小寫、空白與標點。`normalizeRecord` 把它套用到整筆紀錄；`admitVerdict` 會
呼叫它，因此 host 不可能忘記。兩邊的工具結構描述都把 `severity` 從 `z.enum`
放寬為 `z.string()`，並在 `.describe()` 中保留正規的三種。

**無法辨識的詞會變成 `important`，而不是 `suggestion`**——保守失敗（fail
closed）。沒有人預先規劃過的嚴重度，比較可能是真正的異議而不是雞毛蒜皮，而
判斷錯誤的代價是一次建置迭代，而不是一個被發布出去的缺陷。

該技能自己的表格現在多了一欄 **Machine severity**，讓兩套詞彙在源頭就不再互相
矛盾，而不只是在邊界處補救。

### 4. 重試預算可設定

兩個 host 原本都寫死恰好一次免費重跑（`driver.ts:801` 的 `attempt < 2`；
`server.ts:135` 的一個布林值）。現在改為 `verdictRetries`（預設 `1`——與今天
的行為完全相同，上限 `5`，設為 `0` 則第一次沉默就停止）。這些重跑仍然不消耗
迴圈迭代，而工作類階段永遠不會用掉任何一次。

## 邊界情況

- **所有選項都不設定** → 沒有 nonce、沒有區塊段落、`verdictRetries: 1`、
  `partialAxes: []` → 行為與組合出來的提示都與先前相同。這是
  [README](./README.zh-TW.md) 訂下的硬性向後相容要求，而且每個階段都有逐位元組
  相同的提示測試。
- **空字串的 nonce** 視為未武裝，而不是一個誰都無法匹配的 nonce——否則某個把它
  清空的臭蟲會在提示仍然宣傳該通道的情況下悄悄停用它。
- **JSON 格式錯誤、酬載不符結構描述，或圍欄是 ` ```json ` 的區塊** → 忽略，
  絕不拋出例外。`parseVerdictBlock` 是全函式。
- **`workflow_compose` 被呼叫兩次** → 相同的提示、相同的 nonce；它永不重新武裝。
- **多視角 REVIEW** → 每個 lens pass 都是自己的一次嘗試、各自取得自己的 nonce。
  lens 模式仍然抑制每回合的軸強制檢查，因此累積在那裡是惰性的。
- **沒有把關的工作流程類型（所有 sitter）** → 沒有 `requiredAxes`，所以累積是
  無操作，只有嚴重度正規化會生效。

## 各項變更落在哪裡

| 變更 | Core | Hosts |
|---|---|---|
| nonce 圍欄區塊通道 | `workflow/verdict-block.ts`、`engine.ts`、`state.ts`、`config.ts` | `driver.ts` 觸發迴圈；`server.ts` 的 `firePrompt` + `workflow_advance` |
| 軸累積 | `verdict.ts` 的 `admitVerdict` / `VerdictAdmission` | `partialAxes` map；`pendingPartialAxes` |
| 嚴重度正規化 | `verdict.ts` 的 `normalizeSeverity` / `normalizeRecord` | `impl.ts`、`server.ts` 中放寬的工具結構描述 |
| 可設定的重試 | `config.ts` 的 `verdictRetries` | 兩邊的重試迴圈 |

測試：`verdict.test.ts`、`verdict-block.test.ts`（新增）、`engine.test.ts`、
`config.test.ts`、`driver.test.ts`、`server.test.ts`。
文件：`docs/configuration.md`（*Running check stages on a weaker model*）、
`skills/workflow-orchestration/SKILL.md`、`docs/design/threat-model.md`（T1）、
`skills/code-review-and-quality/SKILL.md`，以及兩份重新產生的代理人本文。

## 這份計畫刻意不提供的東西

弱模型仍然得**實際去做**審查。這些變更只是讓迴圈不再因為裁定通道壞掉而卡住；
它們無法把膚淺的裁定變得深入。五個空的 PASS 軸在任何模型上都能滿足檢查——
`requiredAxes` 本來就是完整性檢查，而非誠實性檢查（`verdict.ts:55-59`），這
一點沒有任何改變。

## 這份計畫刻意留下的後續事項

在同一次稽核中發現，各自獨立於上述變更、也獨立於
[08](./08-deterministic-gate-commands.zh-TW.md)。它們共有一個主題：**迴圈向
模型詢問它其實已經握有、或本來就能算出來的事實。** 其中每一項，在降級模型上
得到的答案都比根本不問還糟。

1. **VERIFY 自行回報測試是否通過。** 這是剩下最大的缺口，也正是
   [08](./08-deterministic-gate-commands.zh-TW.md) 的提案：宣告把關指令、由驅動
   程式端執行、並讓其結束碼約束裁定。在那之前，弱模型既要從 88 條 glob 的
   allowlist（`workflows/engineering/workflow.json:54-143`）挑指令，又要回報
   結果。
2. **Sitter 的檢查階段重新判斷工作來源已經算好的事。** `attentionTriggers`
   （`source/ledger.ts:104-128`）與 `upgradeCandidates`
   （`source/dependency-scan.ts:131-162`）本身就**把關**了認領，所以當
   `pr-sitter/stages/triage.md:7` 問「有可執行的工作時給 PASS」時，答案在結構
   上已經為真。只需改提示的修法：把問題從「**是否**有工作」收窄成「**某項列出
   的事實是否已經過期**」。
3. **未定義的門檻在把關控制流。** `review-sitter/stages/fetch.md` 用
   `gh pr diff <n> | wc -l` 量了 diff，卻從未拿它跟任何東西比較——FAIL 條件是
   「大得無法審查」這個形容詞。把數字宣告出來。
4. **提示以名稱委派技能，然後祈禱。** `workflow-build/body.md:11`、
   `workflow-review/body.md:14`、`workflow-verify/body.md:35` 都點名了模型必須
   自己選擇去呼叫的技能，而略過與否沒有任何偵測。在 manifest 加上 `skills: []`
   欄位並渲染進組合後的提示，就能讓它變成決定性的。
5. **`workflow-plan-author` 在一段 251 行的提示裡自行分流三種模式**（`new` /
   `retask` / `task`，各自寫入不同目標）。模式選擇是呼叫端的事實，因此應該由
   程式碼決定——三份提示，或由 manifest 選定其一——而不是靠推論。
6. **Sitter 必須重新推導從未被告知的指令。** dep-sitter 得推斷生態系
   （`npm ls` vs `mvn dependency:tree` vs `./gradlew dependencyInsight`）；
   main-sitter 在 VERIFY 階段重新推導 `diagnose` 早已找到的「失敗工作流程的
   指令」。應該當作結構化產出物傳遞下去。
7. **沒有降級模型的測試框架。** 現有單元測試套件替換的是傳輸層而不是模型，而
   兩支 e2e 腳本都會發出真實的 LLM 呼叫。一個腳本化的假模型——從不呼叫工具／
   送出部分軸／使用技能詞彙——就能把上述每一項行為以端到端而非逐單元的方式
   釘住。
