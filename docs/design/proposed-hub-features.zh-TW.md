[English](proposed-hub-features.md) | 繁體中文

# 提議的管理面板功能 — 縮小讀寫落差

這是一份**提案 + 實作計畫**，不是已發布工作的設計紀錄
（那是 [`improvements/`](./improvements/README.md)，其七份計畫全部都是
**核心端（core-side）**的——在本檔案之前，管理面板一直沒有設計文件的歸屬）。

它回答一個問題：除了管理面板隨附發布的唯讀監視器和工作流程建立器之外，
[`packages/hub/`](../../packages/hub/README.md) 接下來應該做什麼？

答案由一個可量測的觀察所驅動：**核心暴露了一整套寫入 API，而管理面板從未
呼叫過它。** 下面的每個功能都會補上其中一個落差，而——這是承重的發現——
**它們沒有一個需要在核心中新增程式碼。**

關於管理面板*目前*做什麼，見
[`packages/hub/README.md`](../../packages/hub/README.md)；關於它在整個系統中的
定位，見 [`architecture.md`](../architecture.md)；關於設定項，見
[`configuration.md`](../configuration.md)。本文件不會重述這些內容。

每一條項目都是對照真實契約撰寫的（路徑和行號在撰寫時已對照原始碼驗證過），
因此其中任何一項都可以直接執行，不需要再重新轉譯：

- **Gap（落差）**——已存在、已測試、卻沒有任何管理面板呼叫者的核心匯出項。
- **Surface（介面）**——路由、線路型別（wire type）和元件，遵循
  `packages/hub/src/server/routes/kinds.ts` 中已建立的模式。
- **Authority（授權層級）**——這個功能讓瀏覽器上的一次點擊能做到什麼，對照
  [`threat-model.md`](./threat-model.md)。與
  [`proposed-workflows.md`](./proposed-workflows.md) 相同的分級階梯，外加一個新層級。
- **Cost（成本）**——S / M / L：
  - **S**——只有路由 + 元件；組合既有的核心匯出項，不授予新的授權。
  - **M**——新授權，附測試。
  - **L**——新授權*而且*有需要自己一套防護欄的新型失敗模式。

授權層級，依影響範圍由小到大排列：

1. **read（唯讀）**——不寫入（管理面板目前持有的層級）。
2. **backlog-write（待辦寫入）**——寫入設定的 `tasksDir` 下的任務檔案，並提交
   它們（engineering 迴圈已經持有的層級）。
3. **config-write（設定寫入）**——寫入 `.agentic-workflow.json`。**新層級，管理面板
   專屬**：設定是授予所有*其他*授權的檔案，所以即使只動到一個小檔案，寫入它
   仍然是比 backlog-write 更高的層級。
4. **push / comment（推送／留言）**——推送分支、開啟 PR。在機器之外可見。

---

## 摘要

| # | 功能 | 補上的落差 | 授權層級 | 成本 | 狀態 |
|---|---------|---------------|-----------|------|--------|
| [1](#1--把關動作) | 把關動作 | `workflow/gate.ts`——**沒有任何管理面板呼叫者** | backlog-write, push | M | **已發布** |
| [2](#2--待辦-doctor) | 待辦 doctor | `task/store.ts` 的寫入那一半 | backlog-write | M | **已發布** |
| [3](#3--建立器提示詞預覽) | 建立器提示詞預覽 | `manifest/template.ts` 的 `renderPrompt` | read | S | **已發布** |
| [4](#4--設定編輯器) | 設定編輯器 | **完全沒有任何地方會寫入 `.agentic-workflow.json`** | config-write | L | **已發布** |

**這四個功能全部都已發布**，外加 PR 0 的基礎建設。它們補上的落差在下面
以撰寫當時的現在式描述——關於管理面板目前做什麼，見 `architecture.md`、
hub 的 README 和 `configuration.md`。本文件現在是設計歷史，不是一份待辦清單。

建議順序——**PR 0（基礎建設）→ 3 → 1 → 2 → 4**——的理由見
[執行順序](#執行順序)。設定編輯器是最受矚目的訴求，卻刻意**最後**發布。

---

## 落差

> **寫於這一切都還沒發布之前**，並保留原本的時態：這是主張變更的論證，
> 不是對現況的描述。四個功能後來全部都已落地，所以 `architecture.md`、
> `packages/hub/README.md`、`configuration.md` 和 `threat-model.md`
>（T14–T16）現在都描述了寫入介面——關於管理面板做什麼，權威版本是它們，
> 不是本文件。

管理面板曾經是一個測試版的管理應用程式，**觀察**迴圈：待辦看板、即時
活動、執行歷史、token 用量、工作流程建立器。全部都是唯讀，這是刻意的設計——
[`architecture.md`](../architecture.md) 說它「**觀察**……而且從不驅動迴圈」。

這個立場在四個具體的地方已經過時：

| 核心能力 | 狀態 | 管理面板目前的狀況 |
|---|---|---|
| `workflow/gate.ts`——`approveTask:101`、`approvePlan:150`、`replanTask:200`、`shipTask:241` | 已發布、已測試 | **零呼叫者。**管理面板能偵測到把關點（SSE 的 `gate` 事件、`gateStatuses` 欄位高亮），卻對它們一個都無法動作。`packages/hub/README.md:111` 明確表示這部分留待日後處理。 |
| `task/store.ts` 寫入那一半——`rescueStray:549`、`releaseOrphanedClaims:456` | 已發布、已測試 | 未使用。`Board.tsx:65` 顯示一個走到死路的提示標籤，寫著*「backlog anomalies — run doctor」*——它只是叫你去打一個 CLI 動詞。 |
| `.agentic-workflow.json` | —— | **沒有任何東西會寫入它。**`routes/kinds.ts:108` 讓建立器流程以叫你手動編輯檔案作結。 |
| `manifest/template.ts` 的 `renderPrompt:61` | 已發布、已測試 | 未使用。建立器盲目地寫出提示詞草稿。 |

**這個立場在實務上其實已經被打破**：建立器會透過 `POST /api/kinds`
（`routes/kinds.ts:113`）寫入 `workflows/<kind>/`。所以誠實的做法是把這道界線
正式定義清楚，而不是假裝它還站得住腳。

### 新的界線

> 管理面板執行**人工把關動作**、**待辦修復**和**設定編輯**——透過
> *兩個 host 早已共用的同一批核心入口點*。它不驅動**階段（stage）**。

管理面板成為**把關點的第四個呼叫者，而不是第四個驅動者**。這個區別就是
整套安全論證的核心，無論在哪裡記載，都應該逐字這樣陳述。

### 為什麼核心不需要新程式碼

這是這個設計方向正確的最強訊號。`GateCtx`（`gate.ts:22-35`）是一個
host 注入點，其文件字串（docstring）**早就預期會有第三個 host**
「從磁碟上的階段標記」回答 `isDriving`。管理面板就是那個 host。

| 需求 | 核心匯出項 | 判決 |
|---|---|---|
| 把關操作 | `approveTask:101`、`approvePlan:150`、`replanTask:200`、`shipTask:241` | 組合。`HubDeps` 已經供應每一個 `GateCtx` 欄位；只需要把 `sh` 改名為 `$`。 |
| Doctor | `auditBacklog`、`rescueStray:549`、`releaseOrphanedClaims:456`、`isOrphanedPlanClaim:406`、`listClaimIds`、`appendNote:578`、`commitPaths` | 組合。 |
| 預覽 | `renderPrompt:61`、`promptContext:32`、`verdictContractBlock`（`verdict.ts:79`） | 組合——**不是** `composePrompt:68`（見 [3](#3--建立器提示詞預覽)）。 |
| 設定 | `mergeConfigLayers:248`、`readUserLayer:293`、`resolveUserConfigPath:230`、`ConfigSchema:150`、`BaseConfigSchema.shape` | 組合。 |
| 來源歸屬（provenance） | —— | **管理面板。**核心得再維護一份合併規則的複本。見 [關鍵問題 B](#關鍵問題-b--分層陷阱)。 |
| 逐類型旋鈕驗證 | —— | **管理面板，僅供參考。**收緊核心是一次破壞性變更。見 [關鍵問題 C](#關鍵問題-c--workflows-是-looseobject)。 |

只有兩處各約一行的核心改動，而且都只是註解：一處在 `orchestrate.ts:107`
指向管理面板的旋鈕登記表，另一處在 `config.ts:94` 註明這個寬鬆契約是刻意
的，並且會在下游被檢查（lint）。

**如果這裡的某個 PR 開始想要修改核心，那就是這個功能已經偏離方向的警訊。**

---

## 1 — 把關動作

**授權層級：backlog-write, push · 成本：M · 狀態：已發布**

把關欄位任務卡片上的核准（approve）／重新規劃（replan）／發布（ship）按鈕。

**伺服器端**——新增 `server/routes/gate.ts`，範圍限定在單一儲存庫，`mutating: true`：

```
POST /api/gate/:action    body: { id, expectStatus, reason?, kind? }
  action ∈ approve-task | approve-plan | replan | ship
```

這條路由靠三個決策撐起：

- **一對一對應到明確的操作**，而不是 `*Any` 這類捷徑。`approveAny:320`
  的存在是為了解決*人類在 CLI 中沒有輸入 id* 時的歧義。管理面板的按鈕位在
  特定欄位中的特定卡片上——這種歧義並不存在。使用 `approveAny` 會讓一場
  競速（race）執行*和按鈕上寫的不同的把關動作*。
- **`expectStatus`沒有商量餘地。**看板由 SSE 驅動，可能會落後。要驗證
  任務是否仍處於客戶端看到的狀態（一次 `findByIdIn`）；不符 → **409**，
  並附上目前的狀態。沒有這一步，在一塊過期的看板上點擊，可能會發布
  （ship）一個迴圈早已移走的任務。
- **200 規則。**對**每一個格式正確的請求都回傳 200**，原樣攜帶
  `GateResult`。`ok: false` 是一種*領域層級的拒絕*（例如「它在 queued，
  不在 draft」），不是傳輸層錯誤——而 `web/api.ts` 的 `parse` 會在
  `!res.ok`（:5-8）時拋出例外，這會丟掉 `variant`，也就是核心刻意建模的
  資訊 vs. 警告的區別（`gate.ts:38-46`）。400 留給格式錯誤的請求本體／
  錯誤的 id，409 留給 `expectStatus` 不符。

讓 `id` 在抵達檔案系統之前先經過 `isSafeId`（`http.ts:85`）過濾——
`backlog.ts:84` 早已套用這條規則。短雜湊前綴（例如 `f7k3`）會通過檢查。

**線路型別（wire types）**——`export type { GateResult, GateVariant } from
"@agentic-workflow/core/workflow/gate"`。採用 `shared/api.ts:7-8` 的純型別
re-export 模式；零手動維護的重複定義。

**前端**——`web/monitor/GateActions.tsx`，掛載在 `Board.tsx` 的
`TaskCardView`（:16）裡，它已經接收 `gated: boolean`。每一個按鈕都包在
`<Confirm>` 裡。

**Ship 是本文件中姿態變化最大的一步**，它的文案必須把這一點說清楚。
`shipTask:259` 會呼叫 `shipPr`——瀏覽器上的一次點擊，會在真實的遠端上開啟
一個真實的 pull request。`variant="danger"`，確認對話框的細節文字寫著：
*「commits to git AND opens a pull request. This is visible outside your
machine.」* 刻意**不**用 dry-run 來緩解——一次假裝發布卻其實沒有發布的
ship，比一個確認對話框還更會騙人。

不需要新的 SSE 型別：把關操作會移動 `tasksDir` 底下的檔案，而
`watch.ts` 早就會發出 `backlog` / `gate` 事件。先樂觀地渲染
`result.message`；讓 SSE 之後再對齊實際狀態。

---

## 2 — 待辦 doctor

**授權層級：backlog-write · 成本：M · 狀態：已發布**

**完全**鏡射 `loop_doctor` 的語意——MCP 伺服器和 OpenCode 的動詞早已
一致，第三套分歧的語意只會是製造 bug 的工廠。

**伺服器端**——新增 `server/routes/doctor.ts`：

- `GET /api/doctor`（範圍限定、唯讀）——`auditBacklog` + `formatAnomalies`
  + `listClaimIds` → `{ findings, anomalies, heldClaims }`。
- `POST /api/doctor/fix`（範圍限定，`mutating: true`）——對每個迷途任務
  （stray）執行 `rescueStray:549` 並附上一則稽核備註；把未知目錄
  rmdir 掉；用 `isOrphaned: isOrphanedPlanClaim`（`store.ts:406`）執行
  `releaseOrphanedClaims:456`，**只對 `queued` 生效**——這一點很容易漏掉，
  一旦弄錯就會釋放還在使用中的計畫認領（claim）。最後執行一次
  `commitPaths`。

**重複項目永遠不會自動修復。**兩個 host 都拒絕這麼做；管理面板也拒絕。
用相同的指引呈現它們（「保留一份，其餘搬去 abandoned」）。管理面板是*最不
適合*猜測哪一份才是正本的地方——不要加上一個只有管理面板才有的「解決重複」
按鈕。

**認領（claim）釋放是比較細膩的那一半。**釋放一個迴圈正在使用中的認領，
會讓第二個認領者搶走同一個任務。注意這裡和把關點是相反的：在把關點那邊，
持有認領代表「拒絕」；這裡，認領本身*就是*要被釋放的東西，所以
`isDriving` 不能拿來當判準——因為每一個候選對象按定義都是被認領的。要改用
核心自己的孤兒判斷式（`isOrphanedClaim:394`，以及給 `queued/` 用的
`isOrphanedPlanClaim:406`），這正是 `releaseOrphanedClaims:456` 拿它們
來用的目的。迷途任務和空目錄與此無關，永遠可以安全修復。

**前端**——`web/monitor/DoctorPanel.tsx`。掛接點早就存在：把
`Board.tsx:65` 那個走到死路的提示標籤，改成打開面板的按鈕。
`BacklogResponse.anomalies` 早就在驅動它的可見性。

---

## 3 — 建立器提示詞預覽

**授權層級：read · 成本：S · 狀態：已發布**

在建立器裡，用範例情境（context）渲染一段階段提示詞。

`POST /api/kinds/preview`——一個**非 `mutating`** 的 POST，遵循
`validateKind`（`main.ts:141`）已有的先例。沒有任何東西被寫入；
`X-Hub-Client` 標頭防護的是副作用，不是讀取。

**不要呼叫 `composePrompt`**（`engine.ts:68`）。它恰好會在建立器所
編寫的那些類型上拋出例外，原因有二：它需要一份從磁碟讀取的
`LoadedManifest`（正在預覽的清單還沒被儲存），而且它會透過登記表解析
`hooks.compose[stage]`——對一個由管理面板編寫的類型來說，這會指向一個
未登記的 hook。改成直接組合底層的匯出項：

```
renderPrompt(prompts[stage], promptContext(sampleState))
  + if stage.kind === "check" → append verdictContractBlock(stage)   // verdict.ts:79
  + if manifest.hooks.compose[stage] → note: "stage has compose hook <ref>;
                                              preview shows the un-hooked render"
```

忠實呈現 `composePrompt` 的輸出結果，而且不會拋出例外。

**範例狀態（sample-state）切換開關才是這個功能的核心。**價值不在於
「看到文字」——而在於*看到哪些條件區塊被觸發*。給 UI 三個開關
（with-task／with-git／with-worktree），讓編寫者能立即看到 `{{#task.id}}`
和 `{{#worktree}}` 亮起或消失。沒有這些開關，這就只是一個包裝過的 `cat`。

**放在伺服器端，而不是客戶端**——這是一個真實存在、被明確點出的取捨：
`renderPrompt` 是純函式，理論上*可以*在瀏覽器裡執行。但
`shared/api.ts:11-13` 明訂了這條界線——SPA 只以**純型別**方式匯入核心，
從不在執行期匯入。為了省下 2 毫秒的來回時間，把 `template.ts` +
`engine.ts` 拉進打包檔，會為了單一功能打破這條界線。還是老實用 POST。

---

## 4 — 設定編輯器

**授權層級：config-write · 成本：L · 狀態：已發布**

最受矚目的訴求，也是真正藏有陷阱的那一個。新增 `server/configfile.ts`
（原始層的 IO）、`configlayers.ts`（來源歸屬）、`knobs.ts`（僅供參考的
lint）、`routes/config.ts`。

成本是 **L**，不是 M，因為下面三個關鍵問題裡有兩個是全新的失敗模式——
靜默的資料毀損和機密外洩——它們需要自己的一套防護欄，而不只是測試。

### 關鍵問題 A — 欄位剝除陷阱

**原始資料才是模型；zod 只是一個 linter。**

`BaseConfigSchema`（`config.ts:61`）是一個普通的 `z.object` →
**zod v4 會剝除未知的鍵**。所以 `ConfigSchema.parse(raw)` 之後如果把結果
寫回去，會靜默地刪掉：

- **`watchIntervalMinutes`**——只在 host 端存在，由 OpenCode 外掛透過
  `safeExtend`（`plugins/opencode/src/config.ts:21`）加入，不在核心裡；以及
- **整個 `hub` 區塊**（`packages/hub/src/server/config.ts:12`）——*而
  管理面板正是靠這個區塊才一開始找到這個儲存庫的*。

寫入一份經過解析的設定，會讓管理面板刪掉自己的設定。下面這個演算法
就是為了防止這件事而存在：

```
READ(layer):
  raw    = JSON.parse(readFileSync(<layerPath>))   // parse error → 200 {parseError}, NOT 500 —
                                                   // the editor must render it
  merged = mergeConfigLayers(userRaw ?? {}, repoRaw ?? {})   // core's exported merge, verbatim
  issues = ConfigSchema.safeParse(merged).issues             // .data DISCARDED — validator only
  → { layer, raw, effective, issues, provenance, passthrough, redactedPaths }

WRITE(layer, patch):
  raw  = re-read from disk NOW (never trust a client echo)
  next = applyPatch(raw, patch)                    // key-path set/delete on the RAW object
  un-redact: patch value === "__REDACTED__" → keep raw's existing value
  issues = ConfigSchema.safeParse(merged-with-next).issues → any? 400.
                                                   // never write an invalid config
  warnings = lintWorkflowKnobs(next.workflows, boards)     // advisory, does NOT block
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n")
  repo.reload() → 200 { written, warnings }
```

`next` 是從 `raw` 衍生出來的，所以未知的鍵能夠留存下來，**因為它們
從來沒有被 zod 處理過一輪**。

**讓看不見的東西被看見。**不要只是靜默地保留未知的鍵——回傳
`passthrough`：出現在原始資料中、卻不在 `BaseConfigSchema.shape` 裡的鍵，
以唯讀區塊呈現。這樣 `watchIntervalMinutes` 和 `hub` 就會*有標籤、被保留、
不可編輯地*出現——而一個頂層的錯字（`maxIteration`）也會出現在那裡，而
不是憑空消失。同一套機制，誠實的使用者體驗，還能順手抓到一整類真實存在的
bug。

`hub` 區塊在 v1 中保持**唯讀**：它只在啟動時被讀取一次
（`main.ts:48`），所以從管理面板編輯它會靜默地什麼都不做——比根本不提供
這個功能還糟。儲存庫層級的 `hub` 鍵早就被刻意忽略，因為那會造成循環
（`hub/src/server/config.ts:5-10`）；編輯器會拒絕它，而不是去寫一個沒有
任何東西會讀取的鍵。

### 關鍵問題 B — 分層陷阱

**編輯一個具名的層；在管理面板端計算來源歸屬，而不是在核心端。**

`mergeConfigLayers:248` 會在解析*之前*，把使用者層（`~/.agentic-workflow.json`）
合併到儲存庫層**之下**。如果編輯器顯示*生效後*的合併設定，並把它存回儲存
庫的檔案，就會**把使用者層攤平寫進儲存庫的檔案**——把 `ado.pat` 從
`~/.agentic-workflow.json` 寫進一個 `config.ts:121-126` 明確警告過必須保持
gitignore 的檔案。

**那就是機密外洩，也是這個功能可能做出最糟的一件事。**四道防護欄：

1. **路由是分層顯式的。**`GET/POST /api/config?layer=repo|user`（外加
   `?repo=<id>`）。永遠沒有「生效後」的編輯模式。`effective` 只用於
   顯示，明顯是唯讀的，旁邊附上逐欄位的來源歸屬徽章。
2. **來源歸屬計算放在管理面板，不放在核心。**`readUserLayer:293` 正是
   為此而匯出（它的文件字串點名了管理面板）；儲存庫層則是一次檔案讀取。
   `provenanceOf(userRaw, repoRaw, path) → "repo" | "user" | "default"`
   大約 20 行。把它放進核心，就代表**要維護一份合併規則的第二套實作，
   還要和 `mergeConfigLayers` 保持同步**——這正是這個程式碼庫早就在對抗
   的「兩份複本互相漂移」失敗模式（`audit.ts:2-5`、`kinds.ts:98-108`）。
   核心的契約保持單一：一個匯出的合併函式。
   **但『鏡射』正是最容易出錯的地方**，所以要用一個判準（oracle）而不是
   信任來釘住它：寫一個屬性測試（property test），針對產生出來的成對層
   資料中的每一個葉節點路徑，斷言 `mergeConfigLayers(u, r)` 裡的值，
   等於層來源歸屬（layer provenance）所指名的值。漂移會變成一次紅色的
   測試失敗，而不是一個錯誤的徽章。鏡射必須使用**相同的遞迴規則**——
   只有純物件（plain object）才遞迴；**陣列、純量和 `null` 是整體替換**
   （`config.ts:248-257`）。對 `reviewLenses` 做天真的逐元素走訪，會回報
   出 `mergeConfigLayers` 根本沒有實作的來源歸屬。
3. **`ado.pat`永遠不會傳到瀏覽器。**在一個*已知路徑*做遮罩，而不是用
   正規表示式：用哨兵值 `"__REDACTED__"` 取代，並把該路徑列在
   `redactedPaths` 裡。寫入時如果原樣送回這個哨兵值，就代表「未變更」→
   保留原始資料中既有的值。這也是為什麼寫入要重新從磁碟讀取，而不是相信
   客戶端回傳的內容。
4. **Gitignore 防護。**在對**儲存庫**層執行會*設定* `ado.pat` 的寫入
   之前，先執行 `git check-ignore -q .agentic-workflow.json`。沒有被忽略
   → **400**，並附上 `config.ts:121-126` 裡的警告文字。兩行程式碼，
   就把一段沒人會讀的文件註解，變成一道在真正關鍵的那一刻會被強制執行
   的防護欄。

### 關鍵問題 C — `workflows` 是 `looseObject`

**在管理面板端做成警告等級的 lint；不要動核心的 schema。**

`orchestrate.ts:107-138` **靠字串鍵定位，並用最陽春的 `typeof` 檢查**
來讀取逐類型的旋鈕：

| `workSource.type` | 旋鈕 | 檢查方式 | 位置 |
|---|---|---|---|
| `pull-request` | `query` | string | `orchestrate.ts:112` |
| `dependency-scan` | `severityFloor` | string | `:124` |
| `dependency-scan` | `includeOutdated` | boolean | `:125` |
| `dependency-scan` | `ecosystem` | string | `:126` |
| `ci-runs` | `branch` | string | `:132` |

一個錯字（`severityfloor`）或錯誤的型別（`severityFloor: 7`）會
**被靜默忽略**——迴圈會照預設值執行，而且沒有人會被告知。抓到這種情況，
正是設定編輯器最大的賣點。

> **附註：**目前唯一能發現這張表格內容的方式，就是去讀
> `orchestrate.ts`。[`configuration.md:126`](../configuration.md) 宣稱這些
> 旋鈕「由該類型自行驗證」；事實並非如此。修正這份文件本身就值得做，
> 和這個功能無關。

**收緊核心 `workflows` schema 的做法是錯的**，這也是最需要據理力爭的一個
地方。`looseObject` 是*刻意*的設計（`config.ts:86-90`：特定類型的旋鈕
「隨行傳遞，由該類型自行驗證」），而且類型是可以由使用者編寫的——整個
建立器功能存在的目的就是為了編寫它們。把它改成嚴格模式是一次**破壞性
變更**：任何帶有核心不認識的旋鈕的既有設定，都會讓 `loadConfig` 失敗，
一次性打壞兩個 host 和每一個使用者的儲存庫。一個以
`manifest.workSource.type` 為鍵的逐類型 schema，勢必得放在核心裡、
逐類型載入，而且還是得和 `orchestrate.ts` 保持同步——同樣的漂移問題，
卻有更大的影響範圍。

取而代之的是：`server/knobs.ts`，一個以 `workSource.type` 為鍵
（可以從 `deps.boards[].sourceType` 取得）的僅供參考登記表。
`lintWorkflowKnobs(rawWorkflows, boards) → ConfigWarning[]`，共四類，全部都是
**不會擋下寫入的**——它們只是替寫入動作加上註記，永遠不會讓它失敗：

- **未知的鍵**——`severityfloor` → *「unknown knob; did you mean
  `severityFloor`? It will be silently ignored.」* 不分大小寫 +
  編輯距離為 1 的比對，幾乎能抓到所有真實的錯字。
- **錯誤的型別**——`severityFloor: 7` → *「read only when a string
  (`orchestrate.ts:124`); ignored.」*
- **錯誤的來源**——在一個 backlog 類型上出現 `query` → *「only applies to
  `pull-request` kinds; ignored.」*
- **未知的類型**——有一個 `workflows.<kind>`，卻沒有對應的 `workflows/<kind>/`
  清單。

**明確點出的取捨：**這個登記表重複了原本活在 `orchestrate.ts` 裡的
知識，而且可能會漂移。接受這一點，並用一個大約 15 行的緩解措施來
應對：一個**漂移警報測試**，讀取 `orchestrate.ts` 的原始碼，用正規
表示式抓出每一次旋鈕存取，並斷言這個集合等於登記表的鍵集合。萬一漂移
真的發生了，逃生口是把這個登記表升格進核心，放在 orchestrate *旁邊*，
讓 orchestrate 從它讀取——這是一個絕對更好的終局狀態，但不值得為此卡住
現在這個功能。

### 收尾 kinds.ts 的迴圈

`routes/kinds.ts:98-108` 用一個原始的 `fs.readFileSync` + `JSON.parse`
讀取 `.agentic-workflow.json`，繞過了核心的 `loadConfig`，純粹只是為了檢查
`workflows.<kind>.enabled`——然後在 :108 產生一個「請手動編輯檔案」的檢查清單
項目。把這個原始讀取換成 `readConfigLayer(deps, "repo")`，並把 :108 改成
`{ done: enabled, label: "enable in the Config tab", href: "#config" }`。

這正是這個功能存在的目的所要收尾的那個迴圈，也是為什麼 PR 0 要把
kinds 路由限定範圍。

### 重新載入（reload）的故事

設定**只在啟動時**被讀取一次（`main.ts:86`）；沒有任何東西會監看
`.agentic-workflow.json`。**兩個半邊都是必要的**——光有寫入路由，在任何一次
`$EDITOR` 手動編輯之後（這是常見情況），伺服器狀態就會過期：

1. **寫入路由 → `repo.reload()`。**在同一個行程內完成，不需要重啟。
2. **Watcher → 重新載入。**在 `WatchSnapshot`（`watch.ts:13-22`）
   和 `scanSnapshot`（:37）加上 `configKey`；`diffSnapshots` 發出一個
   新的 `{ type: "config" }` 事件；`main.ts:157` 的廣播回呼會在**扇出
   （fan-out）之前**呼叫 `repo.reload()`；`web/events.tsx` 新增一個
   `config` 版本計數器。

有兩個後果需要處理，不能假裝不存在：

- **重新載入可能會拋出例外**（錯誤的 JSON、在一份損壞的清單上呼叫
  `kindBoards`）→ 要捕捉它，**保留舊的 deps**，記錄下來，並且*仍然要
  廣播*，好讓設定路由能正確渲染這個解析錯誤。一次手動編輯出錯，絕對
  不能讓看板變空白或讓伺服器掛掉。
- **`tasksDir` 或狀態聯集可能會改變**，而 watcher 正是由這兩者建構出來
  的（`main.ts:149-158`）→ 重新載入時，只要其中一項變了，就要停掉並重啟
  該儲存庫的 watcher。否則管理面板會永遠靜默地監看著那個舊資料夾。

---

## 執行順序

**PR 0（基礎建設）→ 3（預覽）→ 1（把關）→ 2（doctor）→ 4（設定）。**

這四個功能彼此的耦合程度並不相同。把關、doctor 和設定這三個功能都
需要同樣三個目前還不存在的東西：`HubDeps` 上一個即時的 `Config`、一個
`isDriving` 判準，以及限定範圍到單一儲存庫的 kinds 路由。如果把這些放進
最先發布的那個功能裡建置，它們就會被埋起來；一次先把它們建起來，能讓後面
每一個 PR 都變小。

- **設定最後發布**，儘管它是最受矚目的訴求——它是唯一需要重新載入
  故事的功能，而一旦 `repo.deps` 變成 PR 0 引入的可變容器，並且經過
  PR 1–2 的實戰驗證，重新載入就會容易得多。
- **預覽第二個發布**——瑣碎又唯讀，它能在沒有寫入風險的情況下，把
  PR 0 的範圍限定 kinds 變更充分驗證過一輪。
- **把關排在 doctor 之前**——doctor 是在*更嚴格*的正確性標準下重用
  `isDriving`（釋放一個還在使用中的認領，比拒絕一次重新規劃還糟）。

### PR 0 — 寫入路徑基礎建設 — **已發布**

不發布任何使用者可見的功能。它之後的每一步都很小。

- **`server/deps.ts`**——在 `HubDeps` 上加入 `readonly config: Config`。
- **`server/repo.ts`**（新增）——儲存庫登記表，帶有 `reload()`。這是從
  `main.ts` 抽出來的，而不是加進去：`main.ts` 是一個帶有副作用的進入點
  腳本（解析 argv、綁定 socket、遇到錯誤輸入就結束），所以它裡面的東西
  沒辦法被測試匯入——而 `reload()` 那條「保留上一份可用設定」的防護欄，
  值得被驗證。`scoped()` 早就會在每個請求時重新讀取 `repo.deps`，所以
  重新賦值這個欄位不需要額外的 handler 接線工程。一次會移動 `tasksDir`
  或狀態聯集的重新載入，也會重啟 watcher，因為 watcher 是由這兩者建構
  出來的。
- **限定 kinds 路由的範圍**——`getKinds` / `getKind` / `validateKind` /
  `saveKind` 傳入的是 `defaultRepo.deps`，所以 `buildChecklist`
  （`kinds.ts:78-111`）**對第二個儲存庫來說是靜默錯誤的**。這是修掉一個
  潛伏的 bug，不只是前置準備：帶有未知 id 的 `?repo=` 現在會回傳 400，
  而不是靜靜地改用預設值。
- **新增 `server/gatectx.ts`**——六行程式碼，把 `HubDeps` 對映到
  `GateCtx`。這正是核心完全不需要改動的全部原因。
- **新增 `server/driving.ts`**——[`isDriving` 判準](#isdriving-判準)。
  同時也成為唯一的階段標記讀取者（`routes/active.ts` 會匯入它）。
- **新增 `web/ui/Confirm.tsx`**——仿照 `ui/Button.tsx` 單一元件的風格。
  `detail` 是**用文字明白說出真實世界會發生的副作用**（例如
  「commits to git and opens a pull request against `main`」），而不是
  「你確定嗎？」。PR 1–4 裡每一個會寫入的按鈕都會經過它。
- **`web/api.ts`**——`postAction<T>`，它不會在 200 但 `ok:false` 時拋出
  例外（見 [200 規則](#1--把關動作)）。
- **`tsconfig.test.json`**（新增、原本沒規劃）——測試檔案從來沒有被做過
  型別檢查；見 [驗證](#驗證) 一節裡的注意事項。

### `isDriving` 判準

本文件裡最細膩的一塊。把 `readStageMarker` / `StageMarkerSchema` 從
`routes/active.ts:23-29,86-98` 抽到 `driving.ts` 裡，讓 `active.ts` 改成
匯入它——只有一個讀取者，而不是兩個會彼此漂移的讀取者。

```
makeDrivingOracle(deps, now?) → { isDriving: (id) => boolean; markerTaskId; claimedIds; watcherLive; leasePid }
```

兩個訊號，依強度排序：

1. **認領標記（claim marker）——承重的那一個。**迴圈會在開始驅動一個
   任務*之前*先認領它（在 `<status>/.claims/` 底下做一次原子性的
   `mkdir`，`store.ts:341`），並在整個過程中持有這個認領，所以**正在
   驅動就代表已被認領**。這使得認領成為一個**逐任務**的訊號。要掃描
   任何已啟用類型所宣告的每一個 pool（`board.pools`，就像
   `routes/backlog.ts:51` 早就在做的那樣）——PLAN 的認領活在 `queued/`
   裡，不只是 `in-progress/`。
2. **階段標記**（`runs/.stage.json`）——由 Claude host 在階段執行期間
   寫入，並且會指名任務。OpenCode host 完全不寫這個。

`isDriving(id)` 就是 `claimed.has(id) || id === markerTaskId`。

這種偏向是刻意的：一個擱淺的認領會造成一次假性拒絕，這是一個可以
恢復的小麻煩，doctor 可以清掉它。但一次錯誤的「*沒有*在驅動」判斷，
會在 BUILD 進行到一半時把任務重新排入佇列，摧毀已完成的工作。**拿不
準的時候，就判定為正在驅動。**

**watch 租約刻意不被當成驅動訊號。**這很誘人——OpenCode host 不寫
階段標記，所以一個存活中的 watcher 看起來像個不透明的盲點。但事實不是
這樣：watcher 會先認領才驅動，所以一個存活中、卻*沒有*持有任何認領的
watcher，是在輪詢（polling），不是在驅動。如果拿租約來擋，只要 watcher
還在跑，就會拒絕每一次把關動作，而這正是正常的工作流程（你在核准的同時，
watcher 仍在輪詢）。它只會以 `watcherLive` / `leasePid` 的形式被回報，
純粹提供情境資訊和誠實的拒絕訊息之用。

剩下那個競速窗口——watcher 列出可認領的工作、你執行重新規劃、watcher
接著才去認領——和 `claimTask` 的原子性 `mkdir` 留給任何兩個認領者的
窗口是一樣的，而兩個 host 早就與它共存。`expectStatus`
（[1](#1--把關動作)）進一步縮小了這個窗口。

---

## 安全態勢

**這個態勢本來就是對的；這裡的工作不是去削弱它。**每一條新的會寫入
路由，都原封不動地繼承：

- 綁定在 127.0.0.1（`main.ts:167`）
- `isLocalHost` 的 Host 標頭／DNS 重綁定（DNS-rebinding）防護
  （`http.ts:196`）
- `mutating: true` 的路由必須帶有 `X-Hub-Client: 1`（`http.ts:221`）——
  這是 CSRF 防護。從不提供任何 CORS 標頭，所以跨來源頁面既讀不到回應，
  也無法在不讓預檢（preflight）失敗的情況下送出那個標頭。
- 1 MB 的請求本體上限（`http.ts:129`）、對每一個抵達檔案系統的 id 執行
  `isSafeId`（`http.ts:85`）、路徑侷限性檢查（`kinds.ts:131-133`）

**不新增任何新機制。**唯一真正的風險，是在新路由上忘了加
`mutating: true` 或 `isSafeId`——把它列為每一條路由審查清單上的項目。

依風險排序，各自附上對應的防護欄：

| # | 風險 | 緩解措施 |
|---|---|---|
| 1 | 設定寫入把使用者層攤平 → **提交了 `ado.pat`** | 分層顯式的路由；永遠不寫入 `effective`；哨兵值往返機制；gitignore 防護（[關鍵問題 B](#關鍵問題-b--分層陷阱)） |
| 2 | 設定寫入**剝除了 `watchIntervalMinutes` / `hub`** | 原始資料才是模型；頭條迴歸測試；可見的 passthrough（[關鍵問題 A](#關鍵問題-a--欄位剝除陷阱)） |
| 3 | **重新規劃在 BUILD 進行到一半時把任務重新排入佇列** → 摧毀工作成果 | `isDriving` 讀取認領（驅動代表已認領）+ 階段標記，偏向判定為「正在驅動」（[判準](#isdriving-判準)） |
| 4 | 一次點擊**開啟了一個真實的 PR** | 危險等級的 `<Confirm>`，用白話文說出實際的效果 |
| 5 | 過期看板上的把關動作 | `expectStatus` → 409 |
| 6 | Doctor **釋放了一個還在使用中的認領** | 核心自己的孤兒判斷式（`isOrphanedClaim` / `isOrphanedPlanClaim`），而不是 `isDriving`——每一個候選對象按定義都是被認領的 |
| 7 | 手動編輯錯誤的設定弄掛伺服器 | 拋出例外時保留舊的 deps |

風險 1 和 2 正是為什麼設定編輯器的**成本是 L**，並且最後才發布。

### 關於機密遮罩（redaction）

值得直白地說清楚，因為這裡很容易搞反：**機密遮罩早就已經處理好了，
管理面板是無償繼承到它的。**

[Improvement 05](./improvements/05-secret-redaction.md) 把 `redact`
發布成一道**寫入邊界**上的控制——核心會在持久化的產物落地到磁碟*之前*
清除機密，接線在 `store.ts:579`（`appendNote`）、`:610` 和 `:617`
（`appendPlan`）。所以管理面板在 `backlog.ts:90` 提供的任務檔案裡，
由 agent 寫入的那些部分，早在寫入的當下就已經被遮罩過了。

所以在管理面板的**讀取**路徑上再套用一次 `redact()`，對真正需要它的
那部分內容來說是多餘的，而它的一般賦值規則（`redact.ts:53`）反而會吃掉
任何*討論*到 auth 的任務裡的正常文字——而 engineering 任務經常就是在
討論這個。不要這麼做。

設定裡的 `ado.pat` 是另一個問題，需要另一套工具：它是一個**已知路徑**
上的機密，所以哨兵值機制能精準地處理它（[關鍵問題
B](#關鍵問題-b--分層陷阱)）。在那種情況下，正規表示式是錯誤的工具。

---

## 驗證

**管理面板目前的測試方式：**透過 `tsx` 執行 `node --test`，不使用
任何框架（`packages/hub/package.json`）。慣用模式
（`routes/kinds.test.ts:13-23`）：建構一個字面量的 `HubDeps`，用
`{ params, query, body }` 呼叫 handler，斷言 `JsonResponse`。透過
`os.tmpdir()`（`routes/save.test.ts`）使用真實檔案系統的測試固定資料
（fixture）。已發布的清單同時兼作測試固定資料。

**兩個陷阱：**

- `HubDeps` 在 PR 0 中新增了 `config` → **每一份既有的測試固定資料
  都必須加上它**。是機械式的改動，大約 6 個檔案；要在 PR 0 就做完，不要
  拖到之後。更糟的是，沒有任何東西會*告訴*你這件事：`tsconfig.json`
  同時兼作建置設定，所以它把 `*.test.ts` 排除在外，好讓測試不會進入
  `dist/`——而執行器是 `tsx`，它只會剝掉型別，不會做型別檢查。一份不再
  滿足 `HubDeps` 的固定資料，既不會讓建置失敗，也不會讓測試套件失敗。
  PR 0 新增了 `tsconfig.test.json` 來補上這個漏洞；`packages/core`
  有相同的漏洞，尚未修復。
- 測試的 glob 沒有涵蓋到 `creator/` 之外的 `src/web/*.test.ts`。新的
  前端測試要嘛放在那裡，要嘛就明確放寬這個 glob。

依功能逐一列出：

- **Gate**（`routes/gate.test.ts`）——tmpdir + `git init`。每個動作都
  會移動檔案並提交；`expectStatus` 不符 → 409；路徑穿越（traversal）的
  id → 400；**當標記指名了該 id 時，重新規劃會被拒絕**；**當任務持有
  認領時，重新規劃會被拒絕**；**當 watcher 租約存活、但任務未被認領時，
  允許重新規劃**（watcher 是在輪詢，不是在驅動）；`ok:false` 回傳 200
  並保留 `variant`。Ship 使用一個會讓 `gh` 失敗的樁（stub）`sh`——斷言
  任務仍然完成，備註記錄了「PR not opened」（`gate.ts:265-268`）。
  **測試中不能有網路存取。**（`driving.ts` 自己的完整矩陣由
  `driving.test.ts` 涵蓋，已於 PR 0 落地。）
- **Doctor**——報告是唯讀的（斷言一次 GET 之後檔案系統逐位元組
  完全相同）；修復動作會拯救一個迷途任務並提交；重複項目會被回報但不會
  被動到；**新鮮的**認領不會被釋放，而**孤兒**認領會；一個和既有草稿
  衝突的迷途任務，會落在 `failed` 裡而不拋出例外。
- **Preview**——engineering 真實已發布的提示詞能正確渲染；切換開關會
  改變輸出；check 類型的階段會拿到裁定契約區塊（verdict block）；一個
  掛了 compose hook 的階段會回傳提示訊息而不拋出例外；未知的階段 →
  400。
- **Config**——最重的一套測試，而且理應如此：
  - **剝除迴歸測試（頭條測試）**——一份包含 `watchIntervalMinutes`
    **和** `hub` 區塊的儲存庫檔案；修補 `maxIterations`；斷言兩者都
    逐位元組完整留存。
  - **層隔離**——使用者層裡有 `ado.pat`；在儲存庫層修補
    `maxIterations`；斷言儲存庫檔案**沒有**多出任何 `ado` 鍵。
  - **來源歸屬判準**——對照 `mergeConfigLayers` 的屬性測試；陣列和
    `null` 是整體替換。
  - **機密往返測試**——GET 會把值遮罩成哨兵值；POST 原樣送回哨兵值會
    保留真實的值；POST 送出新值則會取代它。
  - **gitignore 防護**——在檔案未被忽略的情況下設定 `ado.pat` → 400。
  - **驗證**——`codePlatform: "ado"` 卻沒有 `ado` 區塊 → 400，並附上
    路徑 `["ado"]` 上的 `superRefine` 問題；`ado` 缺少 `selfLogin` →
    400，路徑在 `["ado","selfLogin"]`（`config.ts:150-169`）。
  - **旋鈕 lint**——錯字 → 建議；型別錯誤 → 警告；來源錯誤 → 警告；
    **全部仍然會寫入**（僅供參考）。
  - **漂移警報**——登記表的鍵 === 從 `orchestrate.ts` 用正規表示式
    抓出來的旋鈕名稱。
  - **解析錯誤**——格式錯誤的 JSON → 200 並附上 `parseError`，不是
    500。
  - **重新載入**——一次失敗的重新載入，會讓舊的 deps 維持完整不變。

**端對端測試。**`npm run test:all` 和 `npm run typecheck:all`（型別
檢查會同時執行伺服器端和前端的 tsconfig，所以新的線路型別必須同時滿足
兩者）。接著實際操作真實的應用程式：啟動管理面板，點擊 `plan-review/`
裡某個任務上的把關按鈕，確認檔案被移動了**而且有一次提交落地**；啟動
一個 OpenCode watcher，確認重新規劃會被拒絕；在 Config 分頁裡編輯
`maxIterations`，確認看板**不需要重啟**就能反映出來；用 `$EDITOR`
手動編輯檔案，確認 watcher 會重新載入。

---

## 需要更新的文件

依照
[improvements 的慣例](./improvements/README.md#conventions-every-plan-follows)，
文件更新是「完成」的一部分：

- ~~**[`architecture.md`](../architecture.md)**~~——**已完成**（PR 1）。
  「observes … and never drives the loop」在 PR 1 落地的那一刻起就不再
  是真的了。現在陳述了精確的界線：管理面板透過兩個 host 都在用的
  **同一批共用核心入口點**執行人工把關動作——它不驅動*階段*。**是把關點
  的第四個呼叫者，不是第四個驅動者。**
- ~~**[`packages/hub/README.md`](../../packages/hub/README.md)**~~——
  **已完成**（PR 1）。「刻意唯讀」這句警語已經不見了；寫入介面、
  雙欄的寫入表格，以及誠實列出的限制都補上了（**對一個已被認領的任務
  執行把關動作會被拒絕，直到該認領被釋放為止**，以及**ship 會開啟一個
  真實的 PR**）。`docs/manual.html` 裡那個已過期的唯讀標籤，也因為同樣
  的原因被修正了。
- **[`configuration.md`](../configuration.md)**——還沒完成，牽涉到設定
  編輯器（[4](#4--設定編輯器)）。需要記載編輯器：分層顯式編輯、來源
  歸屬、passthrough 規則、`ado.pat` 遮罩、gitignore 防護、僅供參考的
  旋鈕 lint。**交叉連結 `workflows.<kind>` 的旋鈕表**（[關鍵問題
  C](#關鍵問題-c--workflows-是-looseobject)），並修正 :126 那句「由該類型自行
  驗證」的說法——這是一次獨立於本功能之外、本身就值得做的文件修正。
- ~~**[`threat-model.md`](./threat-model.md)**~~——**已完成**（PR 4）。
  新增了 T14–T16：HTTP 介面（localhost／Host／`X-Hub-Client`，以及誠實
  揭露「沒有身分驗證」這個殘餘風險）、過期看板和存活中迴圈的把關，以及
  config-write——這個模型裡授予所有其他授權的檔案。
