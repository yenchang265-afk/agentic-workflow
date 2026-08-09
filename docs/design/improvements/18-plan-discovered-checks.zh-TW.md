[English](18-plan-discovered-checks.md) | 繁體中文

# 18 —— 由計畫發現的檢查指令

**狀態：已實作。** `packages/core/src/workflow/discovered-checks.ts`
（`parseDiscoveredChecks`、`admissibleChecks`、`resolvableChecks`、
`resolveStageChecks`、`checkDiscoveryBlock`）、在 `task/write-backstop.ts` 補完
twin 的 `commandAllowed`、`StageDefSchema` 上的 `discoverChecks`、`config.ts` 的
`checksFor`／`configuredChecks`／`discoverChecksFor` 與 `checkTimeoutMinutes`、
`workflow/engine.ts` 的 `discoveringStage` 與組裝尾段、`workflow/checks.ts` 的
`runChecks` 逾時與 `host.ts` 的 `ShellPromise.timeout`、兩個 host 的
`runStageChecks`、engineering verify 階段的 `"discoverChecks": true`；
`discovered-checks.test.ts`、`checks.test.ts`、`config.test.ts`、
`schema.test.ts`、`engine.test.ts`、`write-backstop.test.ts` 與
`check-stage-guard.test.mjs`（共用向量表）。

## 背景

計畫 08 把自我回報的「測試是綠的」換成了結束碼——但只對「有人宣告過的指令」有效。
而沒有人宣告過。沒有任何出貨 manifest 設定 `checks`，`stageChecks` 也沒有預設值，
`docs/configuration.md` 更是明說「未設定 ⇒ 不執行任何檢查，也就是今天的行為」。
所以開箱即用時，VERIFY 的裁決仍然建立在代理人對自己跑了什麼的自述上，而 08 的機制
就一直閒置，直到使用者手寫一段沒有任何文件告訴他怎麼填的設定。

顯而易見的修法——在 manifest 裡出貨一份預設指令表——比這個缺口更糟。迴圈跑在任意
repo 上，而框架**沒有任何工具鏈偵測**（唯一的 repo 檢視是
`source/dependency-scan.ts` 的 `detectEcosystems`，只是餵給相依性建議路由的存在性
檢查）。寫死的 `npm test` 在不適用的地方並非無害：

- 缺少 runner 會 exit 127 ⇒ `classifyExit` 判 ERROR ⇒ engineering 的
  `verify.onError` **stop** 分支——每一次 VERIFY 都會停下整趟執行等人；
- `package.json` 沒有宣告 `test` script 的 repo 會回 exit 1 ⇒ **FAIL** ⇒ BUILD
  重新開火，把每一次疊代燒在從來沒壞過的工作上。（本 repo 就是這個案例：root 有
  `test:all`、`test:hooks`、`test:scripts`，就是沒有裸的 `test`。）

述詞欄位（`when: { exists: [...] }`）被考慮過並否決：一張述詞表，仍然是一張對沒見過
的 repo 所做的猜測表。

## 這次的改動

**由本來就在讀 repo 的模型挑指令，只挑一次，然後由迴圈凍結它。** PLAN 的契約本來
就要求 `### Verification` 小節把每一條驗收標準對應到「證明它的確切指令或可觀察
檢查」——發現這件事不是新工作，只是把它渲染成機器可讀的形式。
`checkDiscoveryBlock`（組裝到提示詞上，絕不寫進樣板——`planContractBlock` 的規則）
要求一個 fenced 區塊：

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

JSON 由 `CheckDefSchema` 自己解析——與 manifest、config 兩層完全相同的形狀，所以三者
不可能漂移。

這個區塊同時告訴 PLAN **該從哪裡取得指令**，依權威性排序：repo 的 CI workflow 定義、
其次是 `AGENTS.md`／`CLAUDE.md` 中有指名檢查指令的地方，最後才是套件 manifest 宣告的
script——而且只取 test／型別檢查／lint／build，絕不取 CI job 的 checkout、安裝、部署或
發布。這個排序是整個功能失敗模式上最便宜的槓桿：猜測的替代品不是更好的猜測，而是一個
**來源**，而 CI workflow 正是這個專案每次 push 都已經在強制執行的指令集。從它抄來的
計畫在人工把關點幾乎不需要判斷，而下面那條昂貴的殘留——在沒有 `test` script 的 repo 上
寫出看起來很正常的 `npm test`——不可能從一條「讀來的」而非「假設的」指令中產生。只排序：
per-ecosystem 的指令表正是這個設計否決掉的東西，而指出該去哪裡看並不是指令表。

`resolveStageChecks` 是兩個 host 共用的唯一接縫，而且每個分支都經由 `checksFor`
回傳，所以優先序只活在一個地方：config（**存在**即算，即使是 `[]`）→ manifest
`checks` → 發現的指令 → 沒有。

## 為什麼兩個難點是這個形狀

**凍結，而非重新推導。** 08 的理由就是「階段每次自己挑指令，會在程式沒動時讓裁決
飄移」。發現機制會原樣把它帶回來，所以它只做一次，並落成*任務檔裡的文字*：
`state.artifacts.plan` 在認領時重新萃取（`source/backlog.ts` 的 `entryState`），
engineering 的 `plan.onDone` 是 `park`，所以沒有任何 PLAN 轉錄稿會存活進一趟執行，
而 `dropArtifacts` 從未點名 `plan`。因此每一輪 BUILD→VERIFY→BUILD 讀到的都是
byte-identical 的指令集。唯一會改變它的途徑是 `replan`——重跑 PLAN 並重新停在人工
把關點。

**邊界是白名單，不是人工計畫把關點。** driver 執行的檢查完全繞過 `bashAllowlist`，
而計畫文件位於 `tasksDir`，那是 **repo 內容**：被 clone 的 repo 可以夾帶一份帶著
`## Implementation Plan` 的任務檔，第一個 watch tick 就會認領它。這正是
`SHELL_BEARING_WORKFLOW_KEYS` 為設定檔的 `stageChecks` 所擋下的同一個威脅，所以
「有人核准過計畫」不是一個安全性質。`admissibleChecks` 才是：被發現的指令只有在
`commandAllowed` 判定「該階段自己的白名單本來就會讓它的 agent 主動執行」時才會跑。
因此這個設計提出的宣稱是窄的、可查核的——*一份惡意區塊能讓 driver 跑的，恰好等於
VERIFY agent 今天在那個工作樹裡本來就能跑的東西*——而殘留被明說而非藏起來：跑一個
repo 的測試套件就是在跑那個 repo 的程式碼，這件事在 `npm test*` 進白名單的那天就
已經成立。

另外三條較小的規則，每一條背後都有具體的失敗：

- `cwd` 必須是不含 `..` 段的單純相對路徑。`runChecks` 用字串串接把它接到工作樹上，
  所以 `../..` 會逃出去。`..` 這條規則刻意**獨立於**字元類之外：`.` 是目錄名稱裡
  合法的字元，所以光靠字元類會match `..`——測試抓到的正是這一點。
- `name` 有字元類限制，因為它會進到提示詞（`checksBlock`）和 `critical` finding 的
  `detail`，而且沒有 untrusted-data 圍欄，與 `output` 不同。
- 一個經由 `bash -c` 的 `command -v` 前置檢查（Bun 的 `$` 只實作了一部分內建指令，
  一個它解析不了的探針會把每個二進位檔都回報成缺失，並悄悄殺掉整個功能），會丟棄
  二進位檔不存在的被發現指令。設定與 manifest 來源的檢查維持 127 ⇒ ERROR——那是人
  明確斷言過存在的東西——但「停下迴圈等人」對一個模型的猜測而言是錯誤的代價。

所有情況都退化成**少跑幾個檢查加一則警告**：沒有區塊、JSON 壞掉、指令被拒、二進位檔
缺失，甚至這個模組自己出 bug。絕不拒絕 park，絕不停止。`runPark` 那個寬容的
`hasVerificationSection` 原封不動，理由就是它自己寫下的那條——在那裡嚴格的失敗模式
是 livelock。

有兩個上限是逐指令而非逐階段的。`CheckDef.timeoutMinutes` 覆寫全域上限，因為單一的
階段層級上限只能由最慢的那條指令決定，於是所有比較快的等於沒有保護——20 秒的 lint 和
25 分鐘的整合測試會共用同一份預算。而**被發現的** `timeoutMinutes` 不得超過該階段自己
的牆鐘上限：那是惡意區塊唯一能用來把 driver 卡在一條指令上一整天的欄位，而且一條檢查
沒有理由活得比它所屬的階段還久。採取拒絕而非截斷——截斷會執行與計畫所寫不同的東西，而
計畫才是紀錄。另外 `MAX_DISCOVERED_CHECKS` 是 8 而不是最初出貨的 5：5 是對著單一生態
的 repo 挑的，而那恰好就是多語言 repo 開始靜默掉檢查的門檻（前端的 test、型別檢查、
lint 加上服務端的 build 與 test 就已經是五條）。8 與 `FANOUT_MAX` 一致，後者基於同樣的
理由界住另一個逐階段的成本乘數。

## 這件事逼出來的前置條件

`runChecks` 在**兩個 host 上都沒有逾時**，而且沒有任何東西涵蓋它：`ShellPromise`
只暴露 `quiet`／`nothrow`／`cwd`，OpenCode 的 stage timer 只 race 模型 session（檢查
跑在它之外），而 Claude host 在 `workflow_advance` 檢查 deadline，檢查卻跑在
`workflow_stage`。這件事之所以還撐得住，只因為 `checksFor` 對每個 kind 都回 `[]`
——沒有 repo 會卡住。把檢查預設打開就讓「卡住」在每個 repo 都可達，所以上限與這次
改動一起出貨：`checkTimeoutMinutes`（10）、Claude shim 上真的會殺掉子程序的原生
`timeout(ms)`，以及 core 裡為做不到的 host 界住 drive loop 的 `Promise.race` 後備。
結束碼 124 在 `classifyExit` 裡被**明確**列出，而不是落到 FAIL：FAIL 會重新開火一個
VERIFY 會再卡一次的 BUILD，把每次疊代都燒在一個從未產出結果的階段上。

這道上限有一個接受規則表達不了的推論：不會結束的指令不是「跑得慢的檢查」，而是
**停機**。`npm run dev` 是可接受的（`npm run *` 就在 VERIFY 的白名單上）、二進位
檔找得到，下游也沒有任何一條規則會丟掉它——於是它跑滿十分鐘、回報 124，也就是
ERROR，也就是 `verify.onError`。沒有任何靜態規則分得出伺服器與測試套件，而一份
名稱黑名單正是本設計已經否決掉的「逐生態系指令表」，所以這條規則放在指令被選出
來的地方：`checkDiscoveryBlock` 要求 PLAN 只列會結束的指令，並且要用「自己啟動
再關閉伺服器」的那條指令來證明執行期行為。

有一種形狀是靠「符合這條規則」來擊敗它的，所以它由程式碼拒絕、而不是由散文勸阻：
`npm run dev &` 會把伺服器丟到背景，並交回 **shell** 的 exit 0——`classifyExit`
把它讀成 PASS，階段提示再把它渲染成 agent 被告知不得爭辯的既成事實，於是製造出一
份比 checks 所取代的自我回報更有權威的保證，外加每次疊代留下一個孤兒行程。
`commandAllowed` 看不見它（`splitSegments` 會丟掉那個單獨的 `&`，剩下的
`npm run dev` 正好命中 `npm run *`），因此 `admissibleChecks` 多了第五條規則
`backgroundsItself`。這條規則**不會**鏡射進 `commandAllowed` 或 hook 孿生檔：agent
把東西丟到背景只是丟失輸出、得不到任何判定，而 driver 跑的那一份卻會**變成**判定。

`planContractBlock` 把同一條規則往上搬一層，套在指令所源出的驗收標準上——因為問
題是在標準那裡誕生的。「在 `localhost:5173` 提供服務」沒有任何檢查階段評得了：
serve 指令會卡住，而所有能讓它變成可觀察的形狀（`&` 加轉向、`nohup`、`timeout`
包裝、`curl` 探測）都不在白名單上，而且必須維持不在——包裝式 glob 會是個洞，因為
`timeout * npm run *` 同時也命中 `timeout 5 bash -c "rm -rf x && npm run dev"`。
實際觀察到的失效模式是最省事的那種：VERIFY 把該標準標成已達成，然後在迴圈根本不
會儲存的散文裡加上免責聲明。所以 `workflow-verify` 的第 2 步現在明講：沒有觀察到
的標準就是**未達成**，並要求指名該向下一次 BUILD 要什麼；而 PLAN 一開始就被告知
不要寫出這種標準。

## 刻意沒做的事

- **任何 manifest 裡都沒有指令表。** `schema.test.ts` 的「沒有任何出貨 manifest
  宣告 checks」從相容性釘子翻轉成執行這條規則的釘子，並在註解裡說明。
- **park 時不強制檢查該區塊。** 沒有區塊的計畫仍然合法；迴圈只是照以前的方式檢查。
- **VERIFY 不重新發現。** 那正是 08 的全部重點。
