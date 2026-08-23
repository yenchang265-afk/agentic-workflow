[English](34-review-suggestions-to-ship-gate.md) | 繁體中文

# 34 — 通過的 review 的建議會到達人類手上

**狀態：已實作。**

## 問題

`verdictFeedbackBlock` 刻意把 findings 過濾到 `isBlocking`——一條建議不該燒掉
一次 rebuild iteration——但那個過濾器是 check stage 唯一的出口，所以通過的
REVIEW 的非阻斷 findings（「考慮抽出這段」、「這個 fixture 洩漏了一個 pattern」）
去不了任何人類會看的地方：不在 task 檔、不在 done toast、不在 ship gate。
它們唯一的長存之處是打碼過的 metrics sidecar，而那只在 hub 的 Metrics tab
以跨 run 彙總現身——一個統計視圖，沒人讀，最不會在有人正決定要不要 ship 這個
diff 的時刻讀。reviewer 的判斷被付了錢又被丟掉。

## 改了什麼

- **`suggestionFindings`**（`workflow/verdict.ts`）：feedback 過濾器的精確補集——
  record 各 axis 上 `suggestion` 嚴重度的 findings，格式為
  `axis: detail (location)`，上限 10 條。
- **引擎把它們附在 done ACTION 上**（`advance` 的 done arm，僅 check stage）。
  刻意放在 action 而非 state：它們只在這個 run 的 terminal 有意義，
  `clearState` 反正即將丟掉 snapshot，而一個持久化欄位需要 schema key，
  否則 zod 會剝掉它（`GitRefSchema` 的教訓）。
- **`runDone` 寫一條 audit note**——`Review suggestions (N) — …`——依
  audit-note 契約壓成一行、像每段落在 task 檔上的模型文字一樣經過
  `redact()`、以 800 截斷，並附加在 done note 之前，讓 done note 維持
  trail 的最新一行（hub 的 `lastEvent` 與 `runDoneField` 都從尾端讀）。
- **`TerminalReport` 原樣攜帶它們**：OpenCode done toast 報數
  （「Review left 2 suggestions — noted on the task file」），Claude 的
  ship-gate descriptor 增加 `suggestions` 欄位，`next` 加一句要 orchestrator
  轉述——明確標為非阻斷，所以一條建議永遠不能被讀成拒絕 ship 的理由。

## 尖銳邊角

- **BUILD 的 feedback seam 保持乾淨。**建議進到下一輪 iteration 的 prompt
  正是 `isBlocking` 過濾器要防的失敗模式；新路徑僅通向人類，engine test
  釘住「帶建議的 PASS 讓 `state.feedback` 保持空」。
- FAIL 的建議也會搭車（engineering 的 done 只跟在有效 PASS 之後，但 sitter
  kind 會把其他 verdict 導向 done）——無害：上限與 redaction 兩者照樣成立。
- Metrics 不動：sidecar 本來就鏡射所有 findings，所以不會重複計數。
