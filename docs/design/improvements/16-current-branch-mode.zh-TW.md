[English](16-current-branch-mode.md) | 繁體中文

# 16 — 在已檢出的分支上建置（`taskBranch`）

**狀態：已實作。** `packages/core/src/config.ts` 中的 `taskBranch` 設定鍵與
`taskBranchFor` / `taskBranchPrefix` / `worktreesDirFor` 存取器；
`workflow/state.ts` 的 `GitRef.onCurrentBranch`（並在 `workflow/persist.ts`
鏡射）；`workflow/git.ts` 的 `headSha` / `defaultBranchName` / `gitCommonDir`；
`workflow/isolate.ts` 中 `ensureIsolation` 與 `teardownIsolation` 的
current-branch 分支，以及 `assertNotDefaultBranch` 和一工作樹一迴圈的鎖；
`task/store.ts` 的 `extractRunBranch` 與 `workflow/terminal.ts` 中寫入它的那行
稽核記錄；`workflow/ship-pr.ts` 的分支解析與 PR base 修正；`workflow/engine.ts`
的 `git.cut` / `git.current` 與三個 engineering 階段樣板。測試：
`current-branch.git.test.ts`、`isolate.test.ts`、`git.test.ts`、`config.test.ts`、
`store.test.ts`、`ship-pr.test.ts`。

## 背景

`ensureIsolation` 原本只有兩種模式，而且兩種都把工作帶到別的地方：在
`feature/<id>` 上開一個 `git worktree`（預設），或在主工作樹裡執行
`git checkout -b feature/<id>`（`worktreesDir: false`）。分支名稱本身則被寫死在
三個地方。

對無人看管的工作而言這是對的，但它完全沒有為另一種情況留空間：人已經坐在
這份工作應該落腳的分支上——正在做某個 PR、在一條審查分支上、在做一個探索性
實作。對他們來說，迴圈把成果擱在另一條分支上，接著 `teardownIsolation` 又把
他們簽出離開那條分支，於是他們要的東西並不在他們所在之處。

`worktreesDir: false` 看起來像是逃生口，其實不是：它只拿掉 worktree，仍然會
切出並檢出 `feature/<id>`。

## 一個不那麼顯而易見的後果

迴圈是用 `git diff <base>...<branch>` 來界定自己的工作範圍——正是這條邊界讓
REVIEW 不會去評斷既有的程式碼。當迴圈會切分支時，`base` 就是它切出來的來源
分支。當它**不切**分支時，base 與 branch 指向同一個 ref，diff 因此是**空的**：
REVIEW 什麼都看不到，然後通過。

所以在這個模式下，`base` 是第一次 BUILD 當下 HEAD 的 **sha**——它是後續每個
檢查點的祖先，因此三點形式等同於一般的兩點 diff。這讓 `base` 變成多型的，而
有兩處呼叫端無法容忍這件事：

- `teardownIsolation` 會執行 `checkoutBranch(base)`。當 ref 不是分支時，
  `checkoutBranch` 會落到 `git checkout -b <ref>`，於是憑空造出一條以 commit
  命名的分支，並把人留在上面。
- `shipGithub`/`shipAdo` 會退回用 `currentBranch(directory)` 當 PR 的 base。
  而 teardown 現在刻意讓工作樹留在被出貨的那條分支上，於是那個 fallback 等於
  要求開一個從某分支到它自己的 PR。

`GitRef.onCurrentBranch` 就是這兩者（以及提示詞——樣板不能把 sha 稱作分支）的
判別依據。它必須在 `persist.ts` 的 `GitRefSchema` 中鏡射，因為 zod 會剝除未知
的鍵——否則從快照恢復的執行會遺失這個旗標，然後踩到上面第一個 bug。

## 這個模式保證了什麼

- **強制關閉 worktree**（`worktreesDirFor`），因為 git 不會讓同一條分支被檢出
  兩次。選擇強制而非在 schema 中拒絕：`worktreesDir` 有一個為真的預設值，因此
  `superRefine` 會讓只寫了 `taskBranch: false` 的使用者收到一個關於他們從未
  設定過的鍵的驗證錯誤。捨棄設定值時會記錄一次。
- **拒絕在預設分支上啟動。** 這裡的檢查點是在人自己的工作樹裡執行
  `git add -A && git commit`；從 `main` 起跑就會提交上去。偵測完全在本地進行
  （`origin/HEAD`，接著 `init.defaultBranch`，最後是慣用名稱）——絕不使用
  `gh repo view`，那會在每次全新的 BUILD 前加上一次網路往返。
- **一個工作樹同時只跑一個迴圈，且跨行程有效。** OpenCode driver 的
  `executingDirs` 集合只存在於單一外掛實例中。在共用工作樹模式下，一次衝突的
  代價是分支被切走；在這裡代價是一個錯誤的裁定，因為第二個執行的 commit 會落
  進第一個執行的 diff 邊界內。其餘則由一個採用 claim marker 陳舊判定契約的
  mkdir marker 負責。

這個 marker 位於 `<git-common-dir>` 之下，而不是與狀態快照一起放在待辦目錄裡。
這是唯一一個檢查點會對人自己的檢出執行 `git add -A` 的模式，而放在待辦目錄時
marker 會直接被帶進使用者的功能 commit——這是由 `current-branch.git.test.ts`
抓到的，任何假 shell 的斷言都抓不到。

## 出貨

`shipPr` 只拿得到一個任務 id，而那時狀態快照早已消失（`clearState` 在
`runDone` 中觸發，`shipTask` 則在之後由一個全新的行程執行）。因此分支被記錄在
**任務檔**上——`runDone` 的稽核記錄寫下它，`extractRunBranch` 再讀回來，並要求
該行帶有稽核戳記，讓一份僅僅引用了這行文字的計畫無法把分支名稱注入
`git push`。

這同時修掉了切分支模式中一個潛伏的 bug：若 `taskBranch` 前綴在執行與出貨之間
被改過，先前會推送到錯的分支。

## 適用範圍

只有 `engineering` 這個 kind 會採用此設定鍵。`pr-sitter` 與 `main-sitter` 會從
工作來源**預先設定** `state.git`——某個 PR 自己的 head 分支、以出問題的 commit
命名的修復分支——那不是迴圈選的，也無法覆寫。`dep-sitter` 的 publish 階段在它的
bash allowlist 中寫死了 `git push origin feature/*`，而那些 manifest 是以唯讀
形式隨核心套件一起發佈的，因此任何其他前綴都會讓它自己的守衛拒絕它的 push。

## 遷移

不需要。`taskBranch` 預設為 `"feature/"`，與舊有寫死的名稱完全一致。
