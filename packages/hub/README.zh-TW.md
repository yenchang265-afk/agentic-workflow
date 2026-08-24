[English](README.md) | 繁體中文

# @agentic-workflow/hub

> **測試版（Beta）。** 這個管理面板功能齊全，且在 API 層級經過測試，
> 但還很年輕：預期建立器（creator）畫布 UX 會有粗糙的地方，而且
> HTTP/JSON 介面可能還會在沒有遷移路徑的情況下變動。見
> [測試版狀態](#測試版狀態)。

agentic-workflow 框架的本機管理面板：**工作流程監視器**和**視覺化工作流程建立器**，以一個小型 web 應用程式的形式提供服務。

```bash
pnpm hub --dir /path/to/repo    # from the repo root — builds core + hub, serves http://127.0.0.1:4317
node dist/server/main.js --dir /path/to/repo --port 4317        # direct, after building
node dist/server/main.js --dir /path/a --dir /path/b            # watch several repos
node dist/server/main.js --dir "/mnt/c/Users/me/projects/*"     # every loop repo under a parent
```

這個管理面板只會監看你指名的儲存庫：如果沒有 `--dir`，且使用者層級
設定中也沒有 `hub` 區塊，它會印出用法說明後結束，而不是假設用目前的
工作目錄。

**審查佇列（Review queue）** —— 進站畫面，也是這個管理面板存在的理由。
每一列代表一個正在等待人工決定的任務，涵蓋所有已啟用的待辦型類型，
等最久的排在最前面；每一列都帶著做出把關決定所需要的證據：已經等了
多久、上一次執行的結果、是哪個階段沒通過、迭代預算燒掉多少、該次執行
diff 所在的分支與異動統計，以及計畫的開頭。`GET /api/review`。

**工作流程監視器** —— 每種類型一個看板，由其清單衍生而來：把關點欄位、
帶有人工把關動作（approve／replan／ship）的任務卡片，以及帶有各階段
token 用量的執行歷史。看板是「總覽庫存」的檢視；上面那個佇列才是做
決定的地方。

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

## 網址，以及網址帶著什麼

每個檢視都有自己的位址。網址的 hash 標明畫面與目前的選取狀態——
`#/monitor/engineering?repo=web-app&run=fix-pagination`、
`#/review?task=plan-review/fix-pagination`——所以任何檢視都可以被連結、
加入書籤、重新載入；Back 會關掉抽屜而不是離開整個應用程式；切換分頁
也不再摧毀上一個分頁裡的內容。

刻意用 hash 而不是真正的路徑：靜態處理器會把網址路徑對應到 `dist/web`
底下的檔案，對應不到就回 404，那正是防路徑穿越與 DNS rebinding 的護欄。
真正的路徑會需要在那道護欄上打一個 SPA fallback——為了讓一個本機工具的
網址好看一點，而去動一個與安全相關的伺服器行為，並不划算。

## 回饋

所有變更都會同時回報到一個 toast **和**一份工作階段的**活動紀錄**
（標頭上的 `Activity` 按鈕），因為一個成功的把關動作會把任務移到別的
欄位，連帶把那張本來要顯示確認訊息的卡片一起卸載掉。這份紀錄也會列出
**被拒絕**的動作——那些沒有寫出任何 commit，所以 git 無法告訴你它們
發生過。它只存在記憶體中、只涵蓋這個工作階段；git 仍然是那份持久的紀錄。

## Tabs

- **審查佇列**（進站畫面）：所有停在把關點上的任務，涵蓋每一個已啟用的
  待辦型類型，等最久的排最前面。把關點欄位取自每份清單的 park/done
  目標，所以一個停在不尋常位置的類型也會自動被納入。每一列都帶著等待
  時間（由任務自己的稽核軌跡推導而來——core 並不儲存時間戳記，而一個
  沒有時間戳記的任務會顯示「age unknown」，不會假裝自己是剛到的）、
  上一次執行的結果、沒通過的階段、迭代用量對上限的比值、該次執行 diff
  所在的分支與異動統計（若完成註記有記錄的話），以及計畫的開頭。一份
  執行紀錄的 id 就是它任務的 id，所以每一列都能直接連到它的執行紀錄。
  `GET /api/review`。

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
  一個會明確說出其真實效果的確認步驟；**ship 的確認步驟還帶有發布
  選擇**——開一個 pull request、只推送分支不開 PR，或完全只在本機
  完成——預設依專案的 `shipPublish`，且可每次逐一覆寫；另外還有一個
  **base branch** 欄位決定 pull request 的目標（留白 ⇒ 這次執行切出來的
  分支，其次是專案的 `prBase`，再其次是平台預設）。管理面板只
  把關、從不*驅動*：它從不認領工作、從不執行
  任何階段，並且會拒絕對一個已經有迴圈在驅動的任務做出動作。

  `queued/` 卡片還多帶一顆 **Plan**——「下一個規劃這一個」。它是唯一
  不屬於把關動作的按鈕：它在 `tasksDir/queued/.requests/` 寫下一個規劃
  請求標記，不移動任何檔案、不產生 commit，管理面板自己也不會啟動任何
  東西。下一次 `claim` 或 `watch` 巡查會讀到這個標記，把該任務排在
  queued 池中其他任務之前規劃，然後消耗掉它；規劃請求絕不會插隊到
  建置就緒的 `in-progress/` 工作之前，而在被消耗之前，這顆按鈕會變成
  **Cancel plan request**。所以「從不執行任何階段」這條線和以前一樣
  成立——管理面板寫下一個排序提示，真正決定怎麼處理的是另一個行程裡的
  driver。任務已經離開 `queued/` 的請求不會造成任何影響，待辦醫生會清掉它。

  點擊卡片標題會打開**任務抽屜（task drawer）**：frontmatter、內文、
  計畫，以及稽核時間軸——把關動作固定在底部，所以計畫可以在同一個地方
  讀完並核准，而不是在這裡讀、再回看板上動作。在卡片上，往前推進的動作
  （approve／ship）是那顆按鈕，取消類的動作則收在 **More…** 之後；這也
  代表它們的確認對話框只有在那個選單被打開時才會被掛載。對一個**尚無計畫**的任務——位於 `draft/` 或
  `queued/` 且沒有 `## Implementation Plan` 的任務——抽屜同時也是一個
  **編輯器**：可以修改標題、type、priority、labels、acceptance 和內文，
  附上一段註解後儲存。這是管理面板對 CLI `retask` 的回應：`retask` 透過
  `interview-me` 訪談加上子代理人改寫來重塑任務，而管理面板沒有代理人，
  所以由人自己把重塑打出來。因此儲存一個 **`queued/`** 任務時，也會把它
  送回 `draft/` 並撤回它的任務關卡核准——一個迴圈已獲准去規劃的目標，
  不該被悄悄改掉。那段註解會寫進稽核註記，下一次 PLAN 會讀到它。

  已經有計畫的任務在這裡不能編輯——它的目標已經被規劃過了——所以抽屜
  改為**審閱**它：內文與計畫會以 Markdown 渲染出來（原始碼只差一次
  點擊），把游標移到任何一行都可以留下留言。送出留言會執行與卡片按鈕
  相同的 `replan`，並把留言組成它的 reason。replan 一直都收 reason，
  但那是在一個看不到計畫的輸入框裡打出來的，所以必然含糊，下一次 PLAN
  也就重蹈覆轍；每則留言都會引述它所依附的段落，因此稽核註記說得清楚
  是*哪一步*：

  ```
  > Plan rejected — sent back to queued for re-planning — plan “Add an mtime-keyed cache in `manifest/load.ts`.”: mtime is not enough on DrvFs — key on size too. [2026-07-26T13:49:07.371Z by you]
  ```

  留言只活在打開的抽屜裡——它是單一把關動作的組稿工具，不是討論串。
  留下來的是那則註記，也就是下一個階段真正會讀到的東西。沒有任何
  可攜帶留言之動作的欄位（`in-review`、`completed`）仍然會拿到渲染後的
  預覽，只是沒有留言功能。

  稽核軌跡從不經由瀏覽器往返：編輯器拿到的內文已經去掉尾端的 `> …`
  註記，而伺服器會在儲存時重新讀檔、把自己那份軌跡接回去。你在打字
  期間被追加的註記會自動保留，瀏覽器從頭到尾沒看過它，任何客戶端也
  刪不掉它。若某次編輯會刪掉編輯器*確實碰得到*的註記（夾在後續內文
  上方的那種），該次儲存會被拒絕並指出是哪一行。

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
- **指標（Metrics）**：跨執行的迴圈健康度，從監視器一次讀一個執行時
  所用的同一批 `runs/<id>.md` 記錄與 `runs/<id>.metrics.json` 側車檔案
  彙整而來。內容包括迭代用量與觸頂率（迴圈是在收斂，還是在耗盡迭代
  次數？）、首趟通過率、各階段的裁定計數與 fail→pass／pass→fail／
  fail→fail 的翻轉次數、結果組成、各階段的實際耗時，以及提示詞快取
  命中率。`GET /api/metrics`。

  有兩個約定讓這些數字值得信任，而且兩者在介面上都看得到：

  - **單位是「一趟（pass）」，不是檔案。** 一份執行記錄可能先累積
    一趟計畫、再累積一趟建置——各自是獨立的執行，各有自己的上限與
    裁定串流——所以這個分頁會分開回報 `runs` 與 `passes`，每個比率
    也都會指名它衡量的母體。
  - **量不到不等於零。** 沒有有效分母的比率會顯示 `—`，絕不是
    `0%`：「沒有任何一趟觸頂」和「沒有任何一趟被記錄」是兩個不同的
    結論。被排除在某個比率之外的趟數會被計數並說明。

  已知的限制，都寫在分頁的頁尾而不是藏起來：**快取命中率只涵蓋由
  OpenCode 驅動的執行**（Claude host 從不自己呼叫 LLM，所以它觀察不到
  任何 token；每次執行的 token 面板所用的、依逐字稿歸因的後備方式，
  在這裡刻意**不**採用，因為兩個時間窗估計值的比率，會與觀察值不一致，
  而且沒有辦法調和）。以及**階段名稱不依類型命名空間化**——所有類型都
  附加到同一個扁平的 `runs/`，而一份執行記錄摘要並不會記錄它屬於哪個
  類型，所以 engineering 裡的 `build` 和某個 sitter 裡的 `build` 會被
  合併計入同一列。
- **設定（Config）**：讀寫 `.agentic-workflow.json`。它**一次編輯一個
  層級**（這個儲存庫，或使用者層級），並為每個欄位標示其生效值實際
  來自哪裡——合併後的檢視永遠不會被寫回去，因為那樣會把你的使用者
  層級攤平進儲存庫檔案裡，還可能把 `ado.pat` 複製進一個你很可能會
  提交的檔案。核心 schema 不認得的鍵（`hub` 區塊、僅限 host 用的鍵、
  已退役的鍵）會被保留，並列為「已保留」，
  因為編輯器寫入的是原始 JSON，而不是解析後的物件。執行期只認使用者
  層級、不認 repo 檔案的鍵（帶有 shell 的設定、ADO 目的地／憑證）會
  有自己的「Set here, ignored at runtime」面板，逐一列出——生效檢視
  本來就已經排除它們，這個面板正是用來說明為什麼某個 repo 檔案的設定
  沒有生效。各類型的專屬
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
   session 總量回填；需要 Node ≥ 22.13（`node:sqlite`），否則會降級
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
| 一次人工把關動作（approve／replan／ship） | `tasksDir` 下的任務檔案，加上一次 git commit——而 **ship** 則依對話框的發布選擇而定（draft pull request、只推送，或完全不對外發布） | `X-Hub-Client`；`expectStatus`（過期的看板會回傳 409，而不是把錯的任務放行）；當有迴圈正在驅動該任務時會被拒絕；有一個會明確說出其效果的確認步驟 |
| 編輯一個尚無計畫的任務（抽屜） | `tasksDir` 下的任務檔案（就地改寫——id、檔名、資料夾都不變），加上一次 git commit；從 **`queued/`** 儲存時還會執行送回 `draft/` 的 retask 移動 | `X-Hub-Client`；僅限尚無計畫的任務（中途出現計畫會回傳 409）；`expectStatus` **加上**內容雜湊（看板過期或內文已漂移會回傳 409）；schema 無法保留的 frontmatter 會回傳 409 而不是被悄悄剝除；稽核軌跡由伺服器端接回並再次驗證；當有迴圈正在驅動該任務或持有認領標記時會被拒絕；掃描疑似含有密鑰的內文會被拒絕；有一個會明確說出其效果的確認步驟 |
| 儲存設定 | `.agentic-workflow.json` 的其中一層 | `X-Hub-Client`；層級明確（絕不是合併後的檢視）；以原始 JSON 寫入，因此未知的鍵會被保留；`ado.pat` 會被遮蔽，且拒絕寫入未被 gitignore 的儲存庫檔案；除非合併後的設定通過驗證，否則會被拒絕 |
| 請求規劃（queued 卡片） | `tasksDir/queued/.requests/` 下的一個標記檔案——**不移動檔案，也不產生 git commit** | `X-Hub-Client`；僅限 `queued/`；`expectStatus`（看板過期會回傳 409）；當有迴圈正在驅動該任務時會被拒絕；有一個會明確說出其效果的確認步驟。用同一顆按鈕撤回 |
| 待辦醫生修復 | `tasksDir` 下的任務檔案（救援迷途檔案、移除空的迷途資料夾、釋放**過期、無迴圈在驅動**的認領標記、清掉任務已離開 `queued/` 的規劃請求），加上一次 git commit | `X-Hub-Client`；只有在認領標記過期且沒有迴圈驅動時才會釋放；當 watch 租約仍存活時完全跳過認領釋放；迷途的規劃請求則無條件清除（它的任務已經不在，不可能有東西在驅動它）；絕不解決重複的 id |

它從不認領工作、從不執行任何階段，也從不合併任何東西——它只寫下一個排序
提示（規劃請求），而且仍然從不認領。完整分析見
[docs/design/threat-model.md](../../docs/design/threat-model.md)
（T14–T16），包括誠實揭露的殘留風險：**沒有身分驗證**——任何以你的
身分執行的本機程序都能驅動它，所以不要在共用主機上執行它。

## Beta status

穩固（已做單元測試，並針對這個儲存庫做過即時驗證）：

- 每一個 `/api/*` 端點、SSE 監看器（fs.watch + 輪詢協調器）、
  執行紀錄／指標剖析器、graph↔manifest 的往返轉換，以及儲存防護

已知的測試版注意事項：

- **隨核心一起出貨的類型在建立器中是唯讀的。** 儲存路由一直都會拒絕
  覆寫這種類型；現在工具列會在你按下去之前就說明這件事，並改為提供
  **Save as new kind**。要就地編輯一份出貨的 manifest，仍然是
  `$EDITOR` 的工作。
- **底下的截圖早於審查佇列**與導入路由的外殼。
- **建立器畫布 UX** 還沒有經過互動式瀏覽器 QA——拖曳／連接和表單
  流程在設計上是可運作的，但需要真實滑鼠操作的磨合；如果發現任何
  卡頓，請回報
- **任務編輯器只寫入 schema 定義的 frontmatter 欄位。** 帶有未知鍵
  （`sprint:`、追蹤系統同步自己的欄位）的任務會被拒絕並指出是哪個鍵，
  而不是被悄悄剝除——那種檔案請直接編輯
- **opencode.db token 回填**需要 Node ≥ 22.13（`node:sqlite`）；在
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
pnpm --filter @agentic-workflow/hub run dev        # esbuild --watch for the SPA (run the server via tsx separately)
pnpm --filter @agentic-workflow/hub run typecheck  # server + web tsconfigs
pnpm --filter @agentic-workflow/hub test       # node --test via tsx
```

web bundle（`dist/web/`）是在本機建置的，從不會被提交進版本控制。
自動化測試涵蓋不到的手動 QA 項目：建立器的拖曳／連接 UX、關掉伺服器
後的 SSE 重新連線、Notification 權限流程、把關按鈕上的確認對話框，
以及在監看器（watcher）存活時嘗試進行一次把關動作——請在真實
瀏覽器中打開管理面板，並把兩個分頁都點過一遍。

伺服器 bundle 也需要建置（`dist/server/`），這裡有一個**經典陷阱：
過期的 `dist`**：`pnpm hub` 會重新建置，但如果在編輯 `src/` 之後
直接執行 `node dist/server/main.js`，跑的會是舊的程式碼——一個新的
路由會回傳 404，看起來像是路由 bug。請先重新建置。
