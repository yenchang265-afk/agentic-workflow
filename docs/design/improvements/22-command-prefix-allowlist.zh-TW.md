[English](22-command-prefix-allowlist.md) | 繁體中文

# 22 — 代理前綴是把白名單重新表達一次，而不是取代它

**狀態：已實作。** `packages/core/src/config-layers.ts` 的
`bashAllowlistPrefixes`／`withCommandPrefixes`／`stripCommandPrefix`、
`packages/core/src/config.ts` 設定 schema 上的 `bashAllowlistPrefix`、
`packages/core/src/task/write-backstop.ts` 中認得前綴的 `chained*` 防線
（twin 同步到 `plugins/claude/hooks/src/allowlist.mjs`）、
`plugins/opencode/src/impl.ts` 的 `applyBashAllowlistConfig`、
`plugins/claude/mcp-server/src/server.ts` 寫入標記的 `bashPrefix` 欄位與
`plugins/claude/hooks/src/check-stage-guard.entry.mjs` 的消費端、
`packages/core/src/workflow/discovered-checks.ts` 的准入；
`config-layers.test.ts`、`write-backstop.test.ts`、`discovered-checks.test.ts`、
`impl.test.ts`、`server.test.ts`、`check-stage-guard.test.mjs`，以及端對端的
`plugins/claude/hooks/allowlist-prefix.test.mjs`。

## 背景

改寫指令的代理程式（rtk 這類省 token 工具）會在兩個 host 評估權限之前改寫每
一條 bash 指令，於是白名單上的 `git status*` 到達比對器時變成
`rtk git status`，該階段就餓死在 `"*": deny` 哨兵上。原本內建的解法是一條
`bashAllowlistExtra`——`"rtk *"`——而這條 glob 接受 `rtk npm publish` 與
`rtk gh pr merge` 的程度，和接受 `rtk npm test` 完全一樣。救回階段的代價是刪
掉它的邊界。

但邊界是可以衍生的。每個階段本來就宣告了自己能跑什麼，前綴只需要把同一份清
單換一種形狀再表達一次：`npm test*` 同時授權 `rtk npm test`，而且僅此而已
——不會有任何該階段本來跑不了的指令變成可達。

**而且同一個改寫會悄悄讓寫入防線失效。** 這是在盤點這次改動時發現的，也是它
不只動白名單的原因。`isGitPushViolation`、`isGithubPrMutation` 與
`isFindMutation` 全都錨定在裸指令名上，所以在任何代理之下它們什麼都分類不
到。對 rtk 0.42.3 實測：

| 指令 | 改寫後 | 分類器判定 |
| --- | --- | --- |
| `git push --force origin main` | `rtk git push --force origin main` | 無違規 |
| `gh pr merge 3` | `rtk gh pr merge 3` | 無違規 |
| `find . -delete` | `rtk find . -delete` | 非變更操作 |

收窄白名單救不了這一半：設定前綴後，`rtk git push origin main` 本來就會命中
衍生出的 `rtk git push origin *`，只有 `isGitPushViolation` 知道 `main` 是受
保護分支。也就是說，任何照著原本 rtk 建議設定的人，T8（「永不合併、永不推送
被監看或預設分支」）都是可繞過的。

## 改了什麼

- **`bashAllowlistPrefix`**（頂層設定，裸指令頭的陣列）。
  `withCommandPrefixes` 為階段授權的每條 glob 產生 `<前綴> <glob>`，跳過已
  經帶前綴的 glob（否則使用者自己的 `"rtk *"` 會衍生出 `rtk rtk *`），也跳過
  `cd * && ` 雙生形式作為來源——串接形狀是對**結果**再跑一次 `withCdTwins`
  得到的，因為代理是逐段改寫（`cd <wt> && git status` →
  `cd <wt> && rtk git status`）。
- **OpenCode** 直接從合併後設定的權限表衍生：`applyBashAllowlistConfig` 把每
  個帶哨兵的代理的 `allow` 鍵當成來源清單，因此不需要在 bootstrap 讀 manifest
  就有逐階段的精確度，使用者自訂 kind 的代理也一併涵蓋。附加位置在哨兵之後
  ——last-match-wins 之下，那是規則唯一有意義的位置。
- **Claude Code／Qwen** 把加了前綴的清單寫進階段標記的 `bashAllowlist`（不加
  `cd * && ` 雙生形式——該 guard 是逐段比對），另外把前綴本身寫成
  **`bashPrefix`**。打包後的 hook 既讀不到設定也讀不到 manifest，這與
  `kindAgents` 是同一個限制。欄位不存在就不剝除，也就是完全維持先前行為。
- **防線對每段指令分類兩次**——原樣一次，剝掉一層前綴再一次
  （`stripCommandPrefix`）。只剝一層：迴圈式剝除會讓 `rtk rtk …` 把第二層洗
  過第一層已經騙過的分類器。原本會擋的一律照擋；沒設前綴時整套退回舊路徑。
  在 OpenCode 上還有第二個效果：防線不再取決於代理的外掛在
  `tool.execute.before` 裡是排在我們之前或之後。
- **發現的檢查**同樣接受加前綴的形式，所以在代理之下，計畫指名
  `rtk npm test` 不會被拒，而 `rtk npm publish` 仍然會被拒。

## 守住的邊界

- 前綴會被驗證為裸指令頭——不可含 `*` 或 shell 元字元。`*` 會衍生出
  `rtk * npm test*`，把這個衍生機制存在的目的（去掉任意中段）重新放進來。
  不合格的項目逐條丟棄：被丟掉的前綴會讓階段明顯餓死，被放行的垃圾前綴則是
  無聲地拓寬邊界。
- 不會授權任何該階段白名單原本沒授權的東西，因此與 `bashAllowlistExtra` 不
  同，這個設定完全不拓寬 T2 邊界。基於同樣理由，它**不是** `SHELL_BEARING_KEYS`
  的成員：與 `bashAllowlistExtra` 相同、與 `worktreeSetup` 不同，它的值永遠
  不會被執行——它只能把 manifest 本來就有的 glob 換個形狀表達，而組出來的
  glob 仍然是位置錨定的（拿 `env` 當前綴會得到 `env npm test*`，比不中任何
  裸 `npm test*` 比不中的東西）。
- 剝除時取**最長**的相符前綴。以常見的重疊組合 `["rtk", "rtk proxy"]` 為例，
  先剝掉較短的那個會讓 `rtk proxy git push origin main` 變成
  `proxy git push …`——所有分類器都認不得，而衍生出的
  `rtk proxy git push origin *` 又會放行它。這正是剝除機制要擋的洗白路徑，
  因此兩份 twin 的測試都以向量釘住。

## 殘留

會**換掉動詞**的改寫超出任何衍生機制的能力：rtk 0.42.3 把 `cat x` 變成
`rtk read x`、`head -20 x` 變成 `rtk read x --max-lines 20`、`npx tsc` 變成
`rtk tsc`、`npx eslint .` 變成 `rtk lint .`、`./gradlew build` 變成
`rtk gradlew build`、`bundle exec rspec` 變成 `rtk rspec`。這些仍然要靠額外
glob，已在 [`../../configuration.zh-TW.md`](../../configuration.zh-TW.md) 以可
直接複製的區塊記錄，並註明該清單跟著代理的版本走、不跟著本專案走。core 裡刻
意不內建改名對照表：它會隨代理每次發版腐爛，而且那是把特定供應商的政策塞進
一個供應商中立的引擎。

以真實產生的 `workflow-verify` frontmatter 與真實 `rtk rewrite` 輸出，對 19 條
代表性指令實測：15 條原本餓死、現在通過（含工作樹的 `cd … && rtk …` 形式），
1 條是動詞改名（`./gradlew :core:test` → `rtk gradlew :core:test`），3 條根本
不會被改寫、一直都通過。`npm publish`、`gh pr merge 3`、
`git push --force origin main`、`rm -rf build`、`npm --tag test publish` 改寫後
沒有任何一條被放行。
