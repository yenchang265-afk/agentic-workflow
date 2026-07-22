[English](01-worktree-isolation.md) | 繁體中文

# 01 —— 逐任務的 git worktree 隔離

## 背景

目前 `ensureBranch`（`src/loop/driver.ts:189`）是**在共用的工作樹中**
checkout `feature/<id>`：如果有人類正在同一個 checkout 中工作，分支會在
驅動過程中被從他們腳下切換掉，而且 `executingDirs`（`driver.ts:130`）
必須把同一個 opencode 實體內的所有驅動序列化成一次只能跑一個。共用同一個
clone 的多個獨立 opencode 行程則完全不會被序列化——這是威脅模型 T3 明確
列出的殘餘風險，手動的變通做法是「讓額外的 watcher 在自己專屬的
clone／worktree 中執行」。

修法：在認領（claim）時，於一個可設定的目錄底下為每個任務建立一個專屬的
`git worktree`，讓 BUILD/VERIFY/REVIEW 針對它執行，完成後移除它（分支
保留）。人類的 checkout 永遠不會被動到；同一個實體中的並行驅動也就變得
安全。

## 關鍵設計決策：提示詞層級的釘選（pinning），而非 SDK 工作階段目錄

已對照 `@opencode-ai/plugin` / `@opencode-ai/sdk` v1.17.11 驗證：

- `SessionCommandData` 和 `SessionCreateData` 確實接受
  `query: { directory?: string }`——但把一個階段工作階段指向該 worktree
  會**啟動一個以該處為根目錄的獨立 app 實體**，而它會載入自己的一套
  外掛。全新的 worktree 沒有 `node_modules`，所以本外掛在那裡無法載入——
  **`workflow_verdict` 工具在該階段工作階段中將不存在**，破壞了迴圈唯一可信的
  裁定（verdict）通道。就算真的載入了，那也會是另一個模組實體，帶著自己的
  `recordedVerdicts` map，對驅動端的實體不可見，還會有版本落差問題
  （該 worktree 帶的是基礎分支的外掛程式碼）。
- 現有工作階段沒有逐指令的 cwd 覆寫機制；`experimental_workspace` 是一個
  adapter 註冊掛鉤，不是「讓這個工作階段在那邊執行」。

因此：各階段仍然在外掛所在的那唯一一個實體中執行，而 worktree 是以
**提示詞層級的釘選**（`composeArgs`）加上檢查階段的白名單擴充來串接進去
的。釘選對 BUILD（擁有廣泛的 bash／編輯權限）而言是提示詞強制執行——與
今日「BUILD 在人工核准計畫後即為可信」的信任等級相同；§10 為編輯工具的
路徑加入了一道便宜的強制執行保護。

Worktree 模式是**選擇加入**的（設定項未設定 → 完全等同今日的行為）：全新
的 worktree 沒有安裝相依套件，若沒有專案專屬的 setup 指令，VERIFY 的
`npm test` 在大多數 JS 專案上會直接 ERROR。預設關閉也讓現有的 85 個測試
維持原本的意義不變。

## 1. 設定——`src/config.ts` + `src/loop/state.ts:74` 中的 `Config`

```ts
// ConfigSchema additions
/** Repo-relative (or absolute) directory for per-task worktrees. Unset → current shared-tree branch switching. */
worktreesDir: z.string().min(1).optional(),
/** Optional shell command run inside a fresh worktree after creation (e.g. "npm ci"). */
worktreeSetup: z.string().min(1).optional(),
```

在 `state.ts` 的 `Config` 介面上同步鏡射兩者（皆為選填）。建議的 README
值：`".workflow-worktrees"`。

## 2. 狀態——`src/loop/state.ts`

- `GitRef`（第 44 行）新增 `readonly worktree?: string`（絕對路徑）。
  不存在 ⇒ 共用樹模式；存在 ⇒ worktree 模式。
- `composeArgs`（第 122 行）：當 `state.git?.worktree` 有設定時，對
  `build`/`verify`/`review` 推入一段釘選區塊：

  ```
  Worktree: this loop's isolated checkout is <abs path> — every file you read,
  edit, or test lives THERE, not in the repo root. Use absolute paths under it
  for edit/read; prefix every shell command with `cd <abs path> && ` (or use
  `git -C <abs path> …`). Never modify anything outside it.
  ```

- 審查（review）的 `Diff boundary` 那一行（第 147 行），在 worktree 模式下
  變成：``review exactly `git -C <worktree> diff <base>...<branch>` ``
  （分支參照在各 worktree 之間是共用的，但仍要把 agent 釘在同一個地方）。

## 3. Git 輔助函式——`src/loop/git.ts`

全部都是 `($, cwd, …)` 形式、盡力而為（best-effort），與既有輔助函式相同
的慣例：

```ts
export const branchExists = ($: Shell, cwd: string, branch: string): Promise<boolean>
// git -C cwd rev-parse --verify --quiet refs/heads/<branch>

export const addWorktree = ($: Shell, cwd: string, wtPath: string, branch: string, base?: string): Promise<boolean>
// branchExists ? `worktree add <wtPath> <branch>` : `worktree add -b <branch> <wtPath> <base ?? HEAD>`
// (existing branch reused, never reset — same contract as checkoutBranch)

export const removeWorktree = ($: Shell, cwd: string, wtPath: string): Promise<boolean>
// `worktree remove <wtPath>` — deliberately NO --force: a dirty worktree
// (failed checkpoint) must survive for inspection. Branch always survives.

export const pruneWorktrees = ($: Shell, cwd: string): Promise<void>
// `worktree prune` — only clears registrations whose dirs vanished; safe.

export const worktreeForBranch = ($: Shell, cwd: string, branch: string): Promise<string | null>
// parse `worktree list --porcelain` for `branch refs/heads/<branch>` → its `worktree <path>`

export const ensureExcluded = ($: Shell, cwd: string, rel: string): Promise<void>
// idempotently append `/<rel>/` to <gitdir>/info/exclude (via `git -C cwd
// rev-parse --git-common-dir`) — keeps the nested worktrees dir out of the
// human's `git status` without mutating the tracked .gitignore
```

## 4. 驅動程式生命週期——`src/loop/driver.ts`

以 `ensureIsolation(deps, config, state)` 取代 `ensureBranch`：

1. **`state.git` 已經有設定：**
   - Worktree 模式：若 `state.git.worktree` 的目錄消失了（崩潰／手動
     刪除），就 `pruneWorktrees` 再重新 `addWorktree`（分支已存在 →
     直接重用）；否則什麼都不做。**在 worktree 模式下絕不重新 checkout
     共用樹。**
   - 共用模式：目前的重新 checkout 邏輯不變。
2. **全新隔離**，在 `config.worktreesDir` 已設定、`isGitRepo`、且有可解析
   的 `currentBranch` 時：
   - `base = baseBranch ?? currentBranch(directory)`；
     `branch = feature/<id>`；
     `wtPath = path.resolve(deps.directory, config.worktreesDir, workflowId(state))`。
     `baseBranch` 是一個可選的、由 host 端解析出的覆寫值：Claude Code MCP
     host 的 `directory` 被凍結在主要 checkout（通常是預設分支）上，因此
     它會改從 `AGENTIC_WORKFLOW_BASE_DIR`（使用者真正在用的工作樹）解析
     base。OpenCode host 則省略這個值——它的 `directory` 本身就已反映
     使用者所在的分支。未設定 ⇒ 從 `directory` 所在分支切出。
   - `ensureExcluded(main, worktreesDir)`。
   - 重用：`worktreeForBranch(main, branch)` → 若已註冊（恢復執行的情況），
     採用那個路徑（若與預期不同則記錄 log）。否則若 `wtPath` 存在於磁碟
     但未註冊 → `pruneWorktrees`，重試；仍然失敗 → **拋出錯誤**（見下）。
   - `addWorktree(main, wtPath, branch, base)`；失敗時**拋出一個迴圈
     錯誤**——絕不退回共用樹的分支切換。在 worktree 模式下，這次驅動有可能
     與另一次並行執行；靜默地在共用樹中 checkout 分支，會重新引入
     worktree 正是要移除的那種競速。（`onIdle` 在 `driver.ts:543` 的
     catch 會為任務加註記並跳出提示；由人類修復後執行
     `/agent-loop recover`。）
   - 若 `config.worktreeSetup` 有設定：透過 Bun shell 的 `.cwd(wtPath)`
     執行它（已對照 `plugin/dist/shell.d.ts:25` 驗證）；失敗時警告但
     繼續（BUILD 可以自行復原；VERIFY 若無法執行則會明顯地 ERROR）。
   - 當主要工作樹 `isDirty` 時記錄（但不阻擋）——未提交的人類變更在
     worktree 中是*不可見*的（這是相對於今日的一個行為變化，通常算是
     改善）。
   - 回傳 `{ ...state, git: { base, branch, worktree: wtPath } }`。
3. `worktreesDir` 未設定 → 沿用既有的 `ensureBranch` 內容原封不動。

重新對應兩個寫入點：

- `checkpoint`（第 220 行）：
  `commitAll(deps.$, state.git?.worktree ?? deps.directory, message)`。
- `restoreBase` → 更名為 **`teardownIsolation`**：
  - Worktree 模式：若 `!isDirty(worktree)` → `removeWorktree`（分支保留，
    與完成提示「review the diff on branch …」一致）；若有未提交變更或
    移除失敗 → 警告並保留原地以供檢視。主要工作樹的 HEAD 從未被動過；
    沒有東西需要還原。
  - 共用模式：目前的 checkout-base 行為不變。
  - 呼叫點維持原樣：中途停止某階段（`driver.ts:304-308`）、`done`
    （第 368-369 行）、`stop`（第 383-384 行）、`onIdle` 的 catch
    （第 554-557 行）——全都已經是先 `checkpoint(...)` 再
    `restoreBase(...)`，這個順序對 worktree 而言同樣正確。

## 5. Backlog 在主要工作樹中維持權威

追蹤了每一條寫入路徑——全都已經解析到主要工作樹，因此不需要改變 cwd，
只需要意識到這一點：

- `task.path` 永遠是解析到主要工作樹的絕對路徑：`listByStatus` 使用
  `client.file.list({directory: deps.directory})` 回傳的 `node.absolute`；
  `findByIdIn` 使用 `path.join(directory, rel)`（`store.ts:129`）。因此
  `appendNote`、`appendPlan`、`moveTask`、`claimTask`、`releaseClaim`
  （全都以 `task.path` 為鍵）即使在階段於 worktree 中執行時，動的也是
  主要工作樹。✔
- `appendRunLog(deps.$, deps.directory, …)`（`driver.ts:294`）→ 主要
  工作樹。✔
- `commitPaths(deps.$, deps.directory, [config.tasksDir], …)`（計畫把關點
  第 349 行、暫存第 453 行）→ 主要工作樹，發生在規劃階段，在任何 worktree
  存在之前。✔
- **唯一真正的缺口：**目前，執行階段的稽核記錄（BUILD 開始／結束、裁定、
  done／stop 記錄）會被一併掃進迴圈分支的 checkpoint 中，因為共用樹本身
  就位於迴圈分支上。在 worktree 模式下，`commitAll` 是在 worktree 中
  執行的，所以那些主要工作樹上的記錄就會**未提交地留在人類的分支上**。
  修法：在 worktree 模式下，於 `done`/`stop`/錯誤路徑的
  `appendNote` + `moveTask` 之後，額外加上
  `commitPaths(deps.$, deps.directory, [config.tasksDir], "loop(<id>): <event>")`——
  在人類目前所在的分支上做小型、只限定路徑範圍的提交（與既有的核准
  提交是同一個先例；`commitPaths` 只提交列出的那些路徑）。每個終端事件
  只做一次，不是每則記錄都做。這個行為變化要記進 README 和威脅模型 T4。
- 該 worktree 裡有自己一份過時的 `docs/tasks` 副本（是 base 當下的狀態）；
  階段 agent 從不修改任務（驅動程式才擁有這個權限）。在
  `.opencode/agents/build.md` 的硬性規則中加一行：「絕不編輯任務待辦
  檔案」。

## 6. 並行性

- 已驗證各個以 sessionID 為鍵的結構原本就是安全的：`pending`、
  `driving`、`watching`、`recordedVerdicts`，以及 `state.ts` 的
  store，全都以 sessionID 為鍵；跨任務的競速則靠 `claimTask` 的原子性
  `mkdir` 和獨一無二的 `feature/<id>` 分支／worktree 路徑來封閉。
- `executingDirs`（`driver.ts:130`）：把 `onIdle` 的鎖（第 498 行）改成
  在 `config.worktreesDir` 有設定時**完全略過這道鎖**——每次驅動都擁有
  自己專屬的樹；不會有任何東西在別人腳下切換分支。共用模式則原封不動
  保留。這之所以成立，是因為 `ensureIsolation` 現在會拋出錯誤，而不是
  退回共用樹切換。
- 殘留問題：兩個並行的 `commitPaths` 寫入主要工作樹時，可能在
  `index.lock` 上互撞——盡力而為（回傳 false），與本程式庫既有的檔案系統
  競速處理姿態一致；在註解中說明清楚。
- 更新威脅模型 T3：有 `worktreesDir` 時，同一實體內的並行是安全的；
  跨行程的殘餘風險則縮小為「backlog 的提交未序列化」。

## 7. 檢查階段白名單——`.opencode/agents/verify.md`、`review.md`

格式：OpenCode 的權限 glob 比對的是**原始指令字串**，採前綴方式
（`"npm test*": allow`，預設 `"*": deny`）。`cd /wt && npm test` 是以
`cd ` 開頭 → **今日會被拒絕**。變更如下：

- 在既有的 git 項目旁加上 `git -C` 的變體（glob 中間的 `*` 是支援的）：
  - verify：`"git -C * status*"`、`"git -C * diff*"`、
    `"git -C * log*"`、`"git -C * show*"` → allow
  - review：以上四項再加上 `"git -C * blame*"` → allow
- 為 verify.md 中每一條 runner 項目加上 `cd`-前綴的雙生版本（約 16 條
  機械式重複）：`"cd * && npm test*"`、`"cd * && npm run *"`、
  `"cd * && pnpm test*"`、`"cd * && pnpm run *"`、`"cd * && yarn test*"`、
  `"cd * && yarn run *"`、`"cd * && bun test*"`、`"cd * && node --test*"`、
  `"cd * && npx tsc*"`、`"cd * && npx vitest*"`、`"cd * && npx jest*"`、
  `"cd * && npx eslint*"`、`"cd * && pytest*"`、`"cd * && go test*"`、
  `"cd * && cargo test*"`、`"cd * && make test*"`、
  `"cd * && make check*"`。review.md 不需要 cd 雙生版本——它允許的指令
  本來就吃絕對路徑（`cat /abs`、`grep … /abs` 已經能匹配 `cat *` /
  `grep *`）。
- 安全性差異：本質上沒有變化——`"npm test*"` 本來就能匹配
  `npm test && anything`（原始字串比對）；`cd * && ` 前綴放行的是同一類
  指令，只是換了個位置。這點要寫進 commit message。
- **先做 spike**（成本低，先於接線進驅動程式之前）：加入一條
  `cd * && npm test*` 規則，確認比對器能接受 `cd /x && npm test`。這是
  方案 A 唯一的關鍵假設。

## 8. 提示詞／agent 文字

- `.opencode/agents/{build,verify,review}.md`：加入一段簡短的「Worktree
  isolation」小節——*當你的輸入中出現 `Worktree:` 這一行時，那個目錄就是
  這個任務的全部世界：用其下的絕對路徑做讀取／編輯、用
  `cd <path> && ` 前綴每一個 shell 指令、使用 `git -C <path>`；該目錄
  以外的任何東西都超出範圍，不得動它。* verify.md 額外加上：「如果某個
  測試指令被拒絕，`cd <worktree> && <runner>` 這種形式就是允許的
  寫法」。
- `.opencode/commands/{build,verify,review}.md` 不需要結構性變更——
  `$ARGUMENTS` 本來就會帶著已組合好的區塊。`plan.md` 不動（PLAN 是在
  worktree 存在之前、對主要工作樹唯讀執行——這是對的）。

## 9. 啟動時的協調——`src/index.ts:49-60`

在中斷任務掃描之後，當 `config.worktreesDir` 有設定時：先
`pruneWorktrees`（安全），再跑 `worktree list --porcelain`，對每一個位於
`worktreesDir` 之下的 worktree 記一則 `warn`：「stale loop worktree
<path> (branch <b>) — /agent-loop recover <id> will reuse it, or
`git worktree remove` it」。**絕不自動刪除**：可能有另一個 opencode
行程擁有它，而且一次崩潰的 BUILD 留下的未提交 diff 是重要證據。
`/agent-loop recover` 會透過 `ensureIsolation` 的 `worktreeForBranch`
路徑重用它。

## 10. 選用的強化措施（成本小，建議採用）

在 `index.ts` 既有的 `"tool.execute.before"` 掛鉤中（第 74 行）：當
`getWorkflow(sessionID)?.git?.worktree` 有設定，且該工具是編輯／寫入工具時，
拒絕任何落在 worktree 之外的 `filePath`（拋出並附上修正提示）。成本低；
為唯一會結構性修改檔案的工具強制執行釘選。Bash 仍然只靠提示詞強制
執行——這是已記載的殘留風險。

## 11. 邊界情況

| 情況 | 行為 |
|---|---|
| 分支 `feature/<id>` 已存在，沒有 worktree（舊的共用模式執行紀錄，正在恢復） | `addWorktree` 不帶 `-b` 直接重用它；絕不重置 |
| Worktree 已經註冊（恢復執行的情況） | `worktreeForBranch` → 採用既有路徑 |
| 路徑存在於磁碟但未註冊（崩潰導致註冊被清掉） | `pruneWorktrees` 之後重試；仍然失敗 → 迴圈錯誤，由人類清理 |
| `worktree add` 失敗（鎖、權限問題） | 迴圈錯誤（記錄 + 提示）；**絕不**退回共用樹的分支切換 |
| 拆除時 worktree 有未提交變更（checkpoint 提交失敗） | 保留原地並警告；分支保留已提交的任何內容 |
| `/agent-loop stop` 在階段執行中 | 沿用既有的 `driver.ts:304-308` 路徑：checkpoint 進 worktree → 拆除（乾淨則移除） |
| 外掛在驅動途中崩潰 | Worktree 存活；啟動時會記錄；`/agent-loop recover` 重用分支 + worktree |
| 不是 git 儲存庫／detached HEAD | 與今日相同的降級式非隔離路徑（worktree 模式需要一個 base 分支） |
| 認領當下主要工作樹是 dirty 的 | Worktree 是從 base 乾淨切出的；記錄「未提交的人類變更對這次建置不可見」 |
| `worktreesDir` 位於儲存庫內部 | 透過 `.git/info/exclude` 對 `git status` 隱藏，而不是編輯受追蹤的 `.gitignore` |

## 12. 測試計畫

- **純粹（擴充既有測試）：**
  - `src/loop/state.test.ts`：`composeArgs` 在設定了 `git.worktree` 時——
    build/verify/review 要有釘選區塊、plan 沒有；review 的 diff boundary
    要使用 `git -C`。
  - 設定測試：`worktreesDir`/`worktreeSetup` 為選填、拒絕空字串、預設值
    不變。
  - 從驅動程式中抽出並測試純函式輔助工具：
    `worktreePathFor(directory, worktreesDir, id)`。
- **依賴 shell（新增 `src/loop/git.test.ts`，整合測試風格）：**
  `git.ts` 是薄薄一層 `git -C` 包裝——在測試執行時用 `fs.mkdtemp` +
  `git init` 建立 fixture：`addWorktree` 全新／既有分支／重用三種情況、
  `removeWorktree` 乾淨 vs. dirty（dirty 必須失敗，不能刪除）、
  `pruneWorktrees`、`worktreeForBranch`、`ensureExcluded` 的冪等性。
  當 `git` 不存在時略過。
- **手動／端對端檢查清單：** §7 的比對器 spike；在一個範例專案上跑一次
  完整的 worktree 模式迴圈，搭配 `worktreeSetup: "npm ci"`；確認人類
  checkout 的 HEAD 在一次驅動過程中從未移動；兩個 watch 工作階段並行
  驅動兩個任務；`/agent-loop stop` 在 BUILD 中途，接著
  `/agent-loop recover`；在 BUILD 中途強制關閉 opencode → 啟動日誌 →
  recover。
- 在 `worktreesDir` 未設定時，全部 85 個既有測試維持不變地通過。

## 排序

1. 白名單比對器 spike（§7）——為整個方案去風險。
2. `git.ts` 輔助函式 + 測試。
3. 設定 + `Config` 型別。
4. `state.ts`（`GitRef.worktree`、`composeArgs`）+ 測試。
5. 驅動程式（`ensureIsolation` / `checkpoint` / `teardownIsolation`、
   終端事件的 `commitPaths`、`executingDirs` 鎖的閘門）。
6. Agent／指令提示詞 + 白名單編輯。
7. `index.ts` 的協調邏輯 + 選用的編輯守衛。
8. 文件。

## 待更新文件

- `README.md`——兩個設定項、worktree 模式下解除的「每個工作樹一次驅動」
  限制、backlog 提交行為的變化。
- `.opencode/commands/agent-loop.md`——並行性說明。
- `skills/workflow-orchestration/SKILL.md`——隔離小節、watch 並行性。
- `docs/design/threat-model.md`——T3（殘餘風險縮小）、T4（執行階段的
  記錄現在透過 `commitPaths` 提交到人類的分支）。
