[English](05-secret-redaction.md) | 繁體中文

# 05 — 持久化 artifact 上的密鑰遮蔽（redaction）

## 背景

威脅模型 T6 是唯一只有**部分**控制措施的威脅：各階段沒有理由去讀取密鑰
檔案，REVIEW 的檢查清單也會標記密鑰處理相關的問題，但沒有任何機制能
阻止一個 agent *回顯*出來的密鑰（測試的環境變數傾印、一段引用的設定、
帶有連線字串的 stack trace）落入持久化、會被提交的 artifact 中——任務
檔案的稽核備註、已保存的計畫，以及 `runs/<id>.md` 日誌。這些內容都會
被提交進 git（待辦異動時的 `commitPaths`），因此一個外洩的密鑰就會變成
「歷史紀錄中的外洩密鑰」。

修法：在每一個持久化 artifact 的寫入邊界加上一道遮蔽（redaction）處理。

## 設計

### 新的純函式模組：`src/task/redact.ts`

```ts
export interface RedactionHit { readonly pattern: string; readonly count: number }
export interface Redacted { readonly text: string; readonly hits: readonly RedactionHit[] }

/** Replace recognized secret shapes with "[REDACTED:<pattern>]". Pure, total. */
export const redact = (text: string): Redacted
```

模式清單（都有命名，這樣命中結果可以在不回顯密鑰本身的情況下被診斷）：

| 名稱 | 模式（草案） |
|---|---|
| `aws-access-key` | `AKIA[0-9A-Z]{16}` |
| `aws-secret-key` | `(?<=aws.{0,20})[A-Za-z0-9/+=]{40}`（已加防護——高偽陽性的形狀需要靠上下文錨點） |
| `openai-key` | `sk-[A-Za-z0-9_-]{20,}` |
| `anthropic-key` | `sk-ant-[A-Za-z0-9_-]{20,}`（要放在 `openai-key` 之前——順序有影響，先比對到者優先） |
| `github-token` | `gh[pousr]_[A-Za-z0-9]{36,}` \| `github_pat_[A-Za-z0-9_]{20,}` |
| `slack-token` | `xox[baprs]-[A-Za-z0-9-]{10,}` |
| `private-key-block` | `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----` |
| `jwt` | `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` |
| `generic-assignment` | `(?i)\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?[^\s"']{8,}` ——只遮蔽值的部分 |

取代後的字串會保留名稱：`[REDACTED:openai-key]`。橫跨多行的
`private-key-block` 會摺疊成單一個標記。

精準度取捨：在稽核備註和執行日誌中，**寧可誤判也不要外洩**——遮蔽掉
一個非密鑰的內容只是損失一點日誌保真度；外洩一個密鑰的代價卻是要輪替
金鑰。`generic-assignment` 模式偶爾會誤吃掉測試 fixture 引用中無害的
`password: "hunter2-example"`；這是可以接受的。

### 接線——`src/task/store.ts` 中的三個寫入邊界

- `appendNote`（第 174 行）、`appendPlan`（第 207 行）、
  `appendRunLog`（第 192 行）：在 `printf` 之前對 payload 執行
  `redact()`。這些是唯一會把迴圈產生的文字寫入持久化檔案的函式
  （已驗證——`writeTask` 寫入的是人類／任務作者已確認過的內容；即使
  如此，為了一致性把它也納入的成本很低，實作時再決定）。
- 簽章選擇：保持 store 函式的簽章不變，在函式內部做遮蔽（現在和未來
  所有呼叫者都會預設被涵蓋），而不是讓呼叫者自行選擇加入。新增一個
  可選的 `log?: Log` 參數（好幾個 store 函式已經有這個參數了）來發出
  警告：`"redacted 2 secret-shaped strings (openai-key, jwt) from runs/<id>.md"`
  —— 警告只會列出模式名稱，絕不會列出值本身。
- `auditNote` 的時間戳／執行者尾碼必須在遮蔽處理**之後**加上，以免被
  打亂——順序是：先組出備註文字、進行遮蔽、尾碼在文字裡（其實已經是
  文字的一部分）；更簡單的說法是：對最終字串做遮蔽；尾碼不含任何密鑰
  形狀，所以會原封不動通過。標記用的 grep（`> BUILD started`）不受
  影響——遮蔽處理絕不會動到這些字面值。

### 對威脅模型如實以告

這是一種基於形狀（shape-based）的掃描：自訂格式的密鑰（例如長得像
UUID 的公司內部 token）會漏網。把 T6 從「部分」更新為「已緩解（基於
形狀），殘留風險：無法辨識的密鑰格式；縱深防禦仍然是『讓密鑰遠離工作
目錄』」。既有的「把 `runs/` 視為敏感內容」建議依然成立。

## 邊界情況

- Payload 整個都是密鑰（某階段單獨回顯出一把金鑰）→ 備註會變成
  `> [REDACTED:openai-key] [timestamp]` —— 沒問題，稽核事件依然存在。
- 巨大的執行日誌 payload：所有模式大致都是線性複雜度；
  `private-key-block` 的正規表達式使用惰性量詞（lazy-quantified）。
  清單中沒有會造成災難性回溯的形狀（實作時要針對這點檢查每一個
  模式——這是唯一一項正規表達式安全性要求）。
- 冪等性：對已經遮蔽過的文字再做一次遮蔽是無作用的（`[REDACTED:…]`
  不會命中任何模式）。要為此寫測試。
- 誤判的逃生口：依設計不存在（沒有允許清單設定項）——一個可以關掉
  遮蔽功能的設定項，就是一個被注入的提示詞可以說服人記錄下來繞過去的
  設定項。如果偵錯時需要保真度，沒有密鑰的原始內容存在 session
  transcript 裡，而不是已提交的 artifact 中。

## 測試計畫（TDD——純函式模組、表格驅動）

新增 `src/task/redact.test.ts`：
- 每個模式各一個正例 + 一個反例（例如 `sk-` 後面接 10 個字元*不會*命中
  `openai-key`；`AKIA` 加 15 個字元也不會命中）。
- `generic-assignment` 只遮蔽值本身（鍵名會保留下來）。
- 多重命中計數；命中名稱；冪等性；空字串；沒有命中的文字會回傳相同的
  字串（不要求參照相等）。
- 橫跨多行的 PEM 區塊 → 單一標記。

Store 整合測試（擴充 `src/task/store.test.ts`）：`appendNote` 傳入
金鑰形狀的 payload 時會寫入遮蔽後的內容；warn 回呼只會帶入模式名稱。

## 需要更新的文件

- `docs/design/threat-model.md` —— T6 改寫（見上文）。
- `README.md` —— 在強化／功能清單中加一行。
- `skills/workflow-orchestration/SKILL.md` —— 註明執行日誌和稽核備註都經過
  基於形狀的遮蔽處理，以及其殘留風險。
