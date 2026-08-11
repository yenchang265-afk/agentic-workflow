[English](24-task-gate-validation.md) | 繁體中文

# 24 — 任務閘門驗證它核准的東西

**狀態：已實作。**

## 問題

`approveTask` 只驗證位置（在 `draft/`）與 epic 拒絕。其餘關於草稿的一切，在人
類唯一真正閱讀它的時刻，全靠信任：

- **沒有秘密篩查。** hub 的任務編輯器拒絕儲存掃出秘密的內文（`redact()`，
  `routes/tasks.ts`），但撰稿路徑——`workflow-task-author` 子代理用宿主原生
  Write 工具寫檔——沒有任何掃描，CLI/MCP 的核准路徑也沒有。方案 05 的理由引用
  `writeTask` 作為驗證過的寫入器，而 `writeTask` 沒有任何生產呼叫者。被核准的
  任務內文會進入 stage prompt、檢查點 commit，可能還有 PR。
- **驗收準則沒有可見性。** 訪談的「2–5 條可測試驗收準則」只是散文；schema 中
  `acceptance` 預設 `[]`，零準則的草稿照樣核准、規劃、建置——VERIFY 屆時沒有
  客觀事物可判，計畫契約的 `### Verification` 沒有東西可對映。從來沒有任何提
  示。

## 改了什麼

在 `approveTask`（`packages/core/src/workflow/gate.ts`）epic 拒絕之後：

- **秘密掃描——拒絕。** `redact(title + body)` 有命中即拒絕核准，指名命中的
  pattern 與 `retask` 出路。閘門動詞 fail closed，誤報的代價是一次 retask；漏
  報的代價曾是憑證進入所有下游工件。這是每份草稿無論由誰撰寫——子代理、手寫檔
  案、hub、CLI——都必經的唯一咽喉點。
- **空驗收——警告。** 成功訊息加上
  `Note: it has no acceptance criteria — VERIFY will have nothing objective
  to check …`，並在 `data.acceptanceMissing: true` 供宿主使用。警告、永不拒
  絕：合法的零準則雜務存在，訪談通常會填好欄位，而拒絕需要一個 force 旗標逃生
  口波及三個宿主與 hub——違背待辦清單「priority 排序、永不阻擋」的精神。

## 刻意不做的事

- 不做草稿解析巡檢、不在 CLI 路徑拒絕未知 frontmatter、不做訪談強制標記：閘
  門本就透過 `parseTask` 讀草稿（解析不了的草稿有 `unparseableAt` 的診斷），
  而訪談的主要產出——準則——正是新警告指名的東西，閘門無需新機制即可吸收該失
  敗。
- `writeTask` 保留（留給未來的同步轉接器；其 docstring 現在指名正確的撰稿代
  理）。

## 落點

`approveTask` 在 `packages/core/src/workflow/gate.ts`，自 `task/redact.ts` 匯
入 `redact`。測試：`gate.test.ts`（含 token 的草稿被拒且指名 pattern；零準則
草稿核准附註記；正常草稿不變）。
