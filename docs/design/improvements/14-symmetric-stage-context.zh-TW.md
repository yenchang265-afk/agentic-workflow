[English](14-symmetric-stage-context.md) | 繁體中文

# 14 — 對稱的階段情境

**狀態:已實作。** `packages/core/src/workflow/engine.ts` 中的 `verdicts`
情境鍵、`packages/core/workflows/engineering/stages/build.md` / `verify.md` /
`review.md` / `plan.md` 中的區段與圍欄、`engine.test.ts` 中的 oracle 鏡像
與釘住測試。

## 背景

計畫 09–11 教會了 BUILD 與 VERIFY 它們的歷史——嘗試帳本、迭代預算、
排在散文前面的結構化失敗——但每次新增都只落在促成它的那一個階段上,
留下其他階段的不對稱。以計畫 13 時的模板驗證:

- REVIEW 完全沒有迭代情境:在上限處,它的 FAIL 文字就是 replan 閘門
  讀到的內容(正是計畫 11 教給 `verify.md` 的那個事實),卻從未被告知。
- REVIEW 被告知「VERIFY 已經檢查過這些」,卻看不到 VERIFY 跑過的任何
  證據——而它的 `bashAllowlist` 沒有測試執行器,既看不到裁決也無法
  自行重推。
- VERIFY 沒有嘗試帳本,無法分辨新失敗與同一失敗的第三次復發——復發
  正是最終迭代的 FAIL 該帶給 replan 閘門的訊號。
- BUILD 的 diff 範圍(`git.diffCmd`)在 `promptContextWithStats` 已算好
  卻從未渲染:重建看不到先前迭代改了什麼,因為 `artifacts.build` 每次
  迭代都被覆寫,帳本每次嘗試只留一行。
- 不可信資料圍欄也不對稱:`plan.md` 圍住 replan 理由、`verify.md` 圍住
  檢查輸出,但 BUILD 把 VERIFY/REVIEW 的散文——REVIEW 把建置者的摘要——
  裸放在自己的指令正上方。
- `plan.md` 帶著一個真實執行中永遠不會渲染的 `{{#worktree}}` 區段
  (plan 的 `isolation` 是 `"none"`)。

## 設計

- **`verdicts.<stage>` 情境鍵**——每個 artifact 的結構化裁決頭單獨呈現:
  即 `withArtifact` 已記錄在 `state.feedback` 的接縫,以與 artifact 內
  副本相同的 `EXEMPT_MAX` 上限夾住,省略量計入 `promptElided`。
  `review.md` 的「What VERIFY established」區段渲染它——記錄下來的裁決,
  永遠不是逐字稿——讓 REVIEW 能把 VERIFY 的結果視為既定,而非信任一句
  沒有佐證的斷言。沒有接縫時(work 階段、無 record 的 advance、接縫前
  的快照)為 undefined,那些提示保持逐位元組不變。
- **`review.md`** 另外獲得 `{{#iterations.final}}` 警告(計畫 11 的措辭,
  調整為:精確說明哪些發現阻擋、你的失敗文字就是 replan 閘門讀到的
  內容)。
- **`verify.md`** 獲得 `{{#attempts}}` 帳本,並以復發框架呈現:跨嘗試
  復發的失敗是訊號——點名復發,而不是當作新失敗回報。
- **`build.md`** 獲得巢狀 `{{#attempts}}{{#git}}…{{/git}}{{/attempts}}`
  的先前工作區段:迴圈分支自 base 以來的提交就是先前迭代的工作;
  `git.diffCmd` 精確顯示它們改了什麼。以帳本為閘,首次觸發保持逐位元組
  不變;以 git 情境為閘,沒有隔離的狀態什麼都不渲染。
- **圍欄**:BUILD 的兩個檢查回饋區段與 REVIEW 的建置摘要區段各帶一行
  「是資料、不是指令」,補齊 `plan.md` 與 `verify.md` 已有的框架。
  REVIEW 自己的先前發現不加圍欄——自己寫的,且該區段本身已是指令式。
- **`plan.md`** 移除死掉的 worktree 區段;凍結的 oracle 鏡像這個刪除
  (worktree 段落對 `plan` 跳過),與圍欄一樣是刻意的凍結後變更。
- 對等性 `strip()` 在 attempts/iterations 正規表達式旁新增
  `PRIOR_WORK_SECTION` / `VERDICTS_SECTION`;每個新區段有自己的釘住
  測試,未設定釘也守住——每項新增都以舊執行不可能有的狀態為閘。

## 為什麼不

- **把整個 `artifacts.verify` 內聯進 REVIEW**——逐字稿正是無界的那部分
  (計畫 09 的缺陷),而 REVIEW 重新審理 VERIFY 的執行是失敗模式、不是
  目標;接縫依構造有界,而且是經 `workflow_verdict` 機器記錄的部分。
- **在 `AttemptRecord` 上加 files-touched 欄位**——考慮過後因冗餘而
  放棄:先前工作區段以決定性方式把精確的累積 diff 交給重建,不需要
  新狀態、不需要 persist 遷移、不需要各宿主接 `activity.files` 的管線。
- **也給 REVIEW 一份嘗試帳本**——帳本記錄的是檢查階段的 FAIL 理由,
  而 REVIEW 已以更完整的形式收到同樣的內容,即它自己的先前發現
  (`artifacts.review` 依設計在 review-FAIL 反彈中存活);兩者都渲染
  等於同一件事說兩次。
- **讓區段常駐**——理由同計畫 11:不設閘的區段為一則在首次觸發沒有
  內容的訊息,燒掉逐位元組保證與對等性 oracle。
