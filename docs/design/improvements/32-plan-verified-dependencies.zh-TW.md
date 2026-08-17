[English](32-plan-verified-dependencies.md) | 繁體中文

# 32 — 計畫不得指名一個它沒讀過的相依

**狀態：已實作。** `packages/core/src/workflow/declared-deps.ts`
（`DepDeclSchema`、`parseDeclaredDeps`、`hasDepsFence`、`previewDeclaredDeps`、
`depsSummaryLine`、`unverifiedDepsCaveat`、`dependencyContractBlock`）、
`workflow/engine.ts` 的組合尾段、`workflow/terminal.ts` 的 park 預報、
`workflow/gate.ts` 的 `approvePlan` caveat、
`prompts/agents/workflow-plan-author/body.md` 與
`skills/planning-and-task-breakdown/SKILL.md` 中的「先重用」層級與
`### Dependencies` 詞彙，以及 `workflows/engineering/stages/build.md` 的
「計畫缺陷」段落；`declared-deps.test.ts`、`terminal.test.ts`、`gate.test.ts`、
`engine.test.ts`。

## 問題

計畫指名一個套件，就等於指示 BUILD 去安裝它，而沒有任何機制檢查那個套件是否
拿得到。在指向內部鏡像的 repo 上——`.npmrc` 的 `registry=`、`settings.xml` 的
`<mirror>`、`pip.conf` 的 `index-url`——計畫可能指定一個鏡像沒有的套件，或一個
在鏡像後面從未存在過的版本。迴圈要到安裝時才發現，那已經是一個 BUILD 之後了；
而 `maxIterations` 預設是 3，所以這樣一行就燒掉三分之一的預算，去重建根本沒壞
的東西。

原因不是模型不小心，而是計畫作者**根本沒有辦法查**，而且沒有人注意到這兩件事
會複合起來：

- engineering 的 PLAN 沒有宣告 `bashAllowlist`
  （`workflows/engineering/workflow.json`），而 `workflow-plan-author` 設定
  `permission: {bash: deny}`，Claude/Qwen 的 frontmatter 只給
  `Read, Grep, Glob, Write`。在任何 host 上都沒有 shell、沒有網路。
- 所以計畫裡每一個版本都來自模型的記憶——而那是在**公開** registry 上訓練出來
  的。在企業鏡像後面，那不是一個稍微過時的答案，而是對另一個問題的答案，卻用
  跟正確答案一樣的自信說出來。

昂貴的從來不是這個失敗本身，而是它**在變昂貴之前都是隱形的**。在計畫閘門上，
一個作者確實查證過的相依，和一個它猜出來的相依，長得一模一樣。

## 這次的改動

沿用設計 18 的形狀，只是換了個名詞：*那個本來就在讀 repo 的模型宣告一項事實，
只宣告一次；迴圈把它凍結成任務檔裡的文字；人類在閘門上看到它。* 該設計的三條
規則原封不動搬過來，而且每一條都在做事。

**指出來源，永遠不要給答案。** 沒有任何核准套件清單，任何地方也沒有逐生態系的
registry 指令表。設計 18 拒絕過指令表，理由是「那是一張對它沒見過的 repo 所做
的猜測表」；核准套件清單是同一個東西，而且除了寫它的那一家公司以外，在每一家
都是錯的。所以 `dependencyContractBlock` 指出要**讀**哪些檔案——`.npmrc`、
`.yarnrc.yml`、`settings.xml`、`pip.conf`、Cargo 的 source replacement——鏡像的
身分來自 repo，永遠不來自我們。

**凍結，而非重新推導。** 宣告以文字形式落在計畫文件裡，`entryState` 會在認領時
重新萃取，所以每一次 BUILD→VERIFY→BUILD 迭代讀到的都是逐位元組相同的內容。
只有 `replan` 能改變它。

**退化成「少一點保證 + 一則警告」。** 沒有圍欄、JSON 壞掉、條目被拒，甚至模組
本身有 bug，代價都只是那份預報，不會是別的。park 完全照舊進行——預報被包在自己
的 `try` 裡正是為此，因為 `runPark` 的每一條離開路徑都必須走到 `releaseClaim`，
而一個被持有的 marker 宣稱有一個**活著的**迴圈，之後每一個閘門動詞都會因此拒絕
處理該任務。

契約要求：先重用的排序（先看 lockfile 裡已有的相依 → 標準函式庫 → 才是新的）、
版本必須是**讀到並以 `file:line` 引用**而非回想、指出這個 repo 實際解析的
registry，以及——對任何無法確立的項目——直接明講。機器可讀的那一半是
`agentic-deps` 圍欄：

~~~markdown
### Dependencies
- `zod` 3.23.8 — lockfile 裡已經有（pnpm-lock.yaml:1204）
- `p-retry` — 新增；本 repo 的 npm 從 https://nexus.corp/… 解析（.npmrc:1）；可得性**未能確立**

```agentic-deps
[{ "name": "zod", "ecosystem": "npm", "version": "3.23.8", "status": "existing", "evidence": "pnpm-lock.yaml:1204" },
 { "name": "p-retry", "ecosystem": "npm", "status": "unverified", "registry": "nexus.corp/npm-group", "evidence": "not in pnpm-lock.yaml; could not establish from here" }]
```
~~~

它不會安裝任何東西，也沒有閘門會因它拒絕計畫。它的讀者是計畫閘門前的人類——
知道貴組織鏡像裡有什麼的正是那個人——所以它的價值完全由 park 訊息、稽核註記與
`approvePlan` 的 caveat 交付。

## 為什麼尖銳的部分長成這樣

**獨立的組合區塊，而不是 `planContractBlock` 的第四個子句。** 該函式的
`### Verification` 子句是 `runPark` 唯一強制的標題，而 `hasVerificationSection`
記載了為什麼那個強制刻意保持寬鬆：「嚴格的失敗模式是 livelock——每次拒絕都會
釋放認領並重新排隊，而一個持續錯過精確字串的模型，每一個 tick 都燒掉一趟 PLAN。」
第二個被強制的標題會讓那個面積加倍，卻換不到任何東西。`### Dependencies` 由
agent 自行判斷、可省略，採用的是 `planVisualizationBlock` 的姿態。設計 24 的
章節詞彙衝突是**人格檔的用詞**與**契約的用詞**之間的衝突，不是章節數量的問題，
所以只要在同一次改動裡於區塊、人格檔與 `planning-and-task-breakdown` 三處逐字
指名同一個標題，它就仍然是關上的。

**章節是慣例；圍欄才是產出物。** `FENCE_RE` 比對整份文件、最後一個圍欄勝出，
所以就算模型把區塊放到別的地方，機器可讀的那一半仍然拿得到。這與
`agentic-checks` 接受的是同一種不對稱。

**沒有圍欄時「什麼都不印」，這點與檢查預報相反。** 檢查預報會回報自己的缺席，
因為缺少檢查區塊代表某個階段將執行零個檢查——那是一項損失。缺少相依區塊通常只
代表沒有東西要宣告，而在每一次 park 都印一行，會訓練讀者跳過整個後綴，連帶把
檢查那一半也一起跳掉。`hasDepsFence` 的存在是為了讓第三種情況仍然可讀：一個內容
為 `[]` 的圍欄說的是「考慮過，沒有新增」，那和沉默不是同一句話。

**上限訂在「呈現」，不在「解析」。** `MAX_DISCOVERED_CHECKS` 是 8，因為每一個被
發現的檢查都是迴圈在每一趟都要**執行**的指令——那是真實的每次開火成本。這個區塊
帶著走不花任何成本，所以在解析時丟掉條目，等於丟掉人類最需要看到的那一則宣告。
壓力來自可讀性，就在可讀性所在之處回應：`MAX_DECLARED_DEPS` 設為 20（失控時的
後擋），而 `MAX_NAMED_DEPS` 只列出三個名字然後計數其餘，因為這個後綴要和檢查預報
共用同一行 `> …`。

**自由文字在「解析」時就被攤平。** `evidence` 與 `registry` 由計畫作者撰寫，而且
會抵達一則沒有任何不可信資料圍籬的單行稽核註記。那裡出現換行會讓帶方括號的戳記
脫節，`AUDIT_NOTE_LINE_RE` 就此比對不到，而那些孤兒行接著會被當成計畫**散文**讀，
同時每一個「讀最後一則註記」的解析器（`extractReplanReason`、`extractRunBranch`、
`extractStopContext`）都會瞎掉——這正是 `oneLineReason` 存在的理由。攤平只做一次、
在解析處做，而不是在每一個呈現點做，因為一個在三個地方攤平的模組，遲早會長出忘記
攤平的第四個。`name`、`ecosystem`、`version` 因為同一個暴露面而套用字元類別，而且
是**拒絕**而非消毒：閘門那一行裡被悄悄改寫過的套件名，比一個缺席的套件名更糟。

**用「未確立」，永遠不要用「已驗證」。** 這個功能絕對不能用在自陳報告上的詞就是
*verified*。計畫是它的作者對自己讀過什麼的陳述；迴圈什麼都沒有探測。每一個呈現出來
的字串講的都是計畫**主張**了什麼，而 `unverifiedDepsCaveat` 說的是「無法確立」——
把一則宣告洗成一項保證，會讓這個功能嚴格劣於沉默，那是 `admissibleChecks` 關於偽造
PASS 的那條規則換了件衣服而已。

**BUILD 從另一端收尾**，而這是整個設計裡最便宜的一半。BUILD 有不受限的 bash，
它**一定會**在第一次安裝時發現無法解析的套件。昂貴的失敗從來不是這個發現——而是
BUILD 接著開始*即興發揮*：換一個套件、自己手刻一份替代品、放寬版本範圍，然後成本
在 REVIEW 或更晚的地方，以一份沒有人為它做過審查的 diff 浮現。`build.onError` 本來
就把「已核准的計畫無法照原樣實作」導向停下並 replan，所以 `build.md` 現在把「相依
無法解析」指名為正是那個條件。三個句子、零機制，就把一次燒掉的迭代換成一次停止。

## 刻意沒有做的事

**任何 host 上都沒有由 driver 執行的 registry 探測。** 那個顯而易見的下一步——讓
迴圈自己跑 `npm view <pkg> versions`，把宣告變成一個結束碼——設計過，然後因為三項
彼此獨立的發現而放棄：

- **PLAN 的 `bashAllowlist` 不是一個「准入邊界」。** `stageBashGlobs` 對沒有清單的
  階段回傳 `[]`，而 `config.ts` 逐字寫著這條規則：「因此 `[]` 代表『不受限』，
  絕不是『什麼都不允許』。」Claude MCP server 每次開火都把那份清單寫上活躍的階段
  marker，而 PreToolUse 守衛的白名單分支會對**任何**帶有非空 marker 清單的階段觸發，
  不只是 check 階段。所以為了准入探測而給 PLAN 一份窄清單，會在兩個 host 上、於整個
  PLAN 期間收窄**該 session 裡的每一個 Bash 呼叫**——而 PLAN 是 `isolation: "none"`，
  也就是人類自己的 checkout，是他們最可能正在打字的那個 session。它的拒絕訊息甚至會
  告訴他們「PLAN 階段是唯讀的」。
- **`runPark` 沒有有界 shell。** 它用的是不受限的 driver `$`；`boundedShell` 只接到
  `gateCtx`。對一個連不到的內部 Nexus 執行 `npm view`——VPN 沒開，而那正是這個功能
  面對的環境——會毫無期限地卡住，而 `runPark` 是在 `workflow_advance` 裡被走到的。
  那正是這個 repo 已經寫下規則的「外掛工具卡住，唯一出路是 ESC」那一類失敗。
- **park 上一個綠燈的探測會是一個帶著權威的謊。** park 繼承的是人類的互動環境——
  proxy 變數、一個 auth token、一條活著的 VPN——這些 BUILD 的工作樹都不保證有。在這裡
  得到一個 BUILD 無法重現的 PASS，等於把猜測洗成既成事實，而那正是 `admissibleChecks`
  存在要防止的顛倒。設計 24 以環境論證拒絕了 park 時期的二進位探測，那個論證原封不動
  地適用。

如果之後真的想要那個機器事實，唯一站得住腳的位置是 **BUILD 開火**，走
`runStageChecks` 這條本來就在每次開火前、且隔離已完成時執行的接縫——而它需要自己回答
一個本設計挖出來的問題：`admissibleChecks` 在 glob 清單為空時會拒絕一切，所以 BUILD
那個「不受限」的空白名單，對 driver 執行的指令而言是 fail-**CLOSED**。那是一個真正的
設計決定，不是接線細節，應該有它自己的設計紀錄。

**沒有設定鍵、沒有 manifest 改動、沒有 host 改動。** 這裡沒有任何東西是選用的，所以
不需要旋鈕：契約的成本是一個每任務只跑一次的階段上多一個組合區塊，預報的成本是對一個
已經在記憶體裡的字串跑一次正規表示式。這也讓波及範圍維持在零——沒有階段 marker、沒有
白名單、沒有 `knobs.ts` 漂移。

**park 時不做強制。** 沒有這個區塊的計畫是有效的，帶著未確立相依的計畫一樣會 park、
一樣可以核准。設計 18 的規則仍然成立：在這個閘門上嚴格的失敗模式是 livelock。

## 順帶發現的缺陷，記錄但未修

`packages/hub/src/server/knobs.ts` 用 `UNIVERSAL` + `BY_SOURCE` + `STRUCTURED_KEYS`
去檢查 `workflows.<kind>` 區段，而這三者加起來只涵蓋 `enabled`、`codePlatform`、
`trigger`、`stageModels` 與 `maxDiffLines`。core 的逐 kind schema 還定義了 `prBase`、
`stageContext`、`stageFanout`、`stageConcurrency`、`stageChecks`、`discoverChecks`
與 `planVisualization`，所以 hub 的 Config 分頁會把上述每一個都回報成
`unknown knob "…" — it is silently ignored`，而那與事實相反。`knobs.test.ts` 的漂移
警報抓不到，因為它只鏡射 `BY_SOURCE`，也就是 `orchestrate.ts` 以位置方式讀取的旋鈕。
這是在確認本設計不需要旋鈕時發現的；留給它自己的任務處理。
