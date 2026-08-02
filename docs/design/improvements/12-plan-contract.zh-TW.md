[English](12-plan-contract.md) | 繁體中文

# 12 — 計畫契約

**狀態：已實作。** `StageDefSchema` 的 `planContract`
（`packages/core/src/manifest/schema.ts`）、`workflow/verdict.ts` 的
`planContractBlock` 與 `hasVerificationSection`、`workflow/engine.ts` 的組裝
分支、`workflow/terminal.ts`（`runPark`）的 park 否決、engineering `plan`
階段的 `"planContract": true`；測試在 `schema.test.ts`、`engine.test.ts`、
`terminal.test.ts`。

## 背景

check 階段的契約是機械式附加的：`verdictContractBlock` 在組裝時附上，因此
綁錯 subagent 或被剝掉 allowlist 都不影響。PLAN 只有 scope fence。計畫必須
*包含*什麼 —— builder 能照做的步驟、每條驗收準則的驗證方式、明確的邊界 ——
過去只寫在 skill 與 persona 裡（可被跳過），而決定論的 park 閘門只檢查
`## Implementation Plan` 標題存在且其下有文字。一份沒有驗證故事的計畫一路
漂到人類閘門，缺口要到兩個階段之後才以 VERIFY 空轉的形式浮現。

## 設計

- stage schema 增加 `planContract: z.boolean().default(false)`（沿用
  `requireEvidence` 模式 —— 逐階段 opt-in，預設讓所有既有 kind 逐位元不變；
  `check` 階段設定它是 manifest 錯誤，它不寫計畫）。engineering 的 `plan`
  階段開啟。
- `planContractBlock`（在 `verdict.ts`，緊鄰 `workScopeBlock` —— 該檔就是
  提示詞契約區塊的家）要求：編號步驟並標明檔案路徑；`### Verification`
  子節，將每條驗收準則對應到證明它的指令或可觀察檢查；`### Out of Scope`
  子節。旗標開啟時 `composeStagePrompt` 把它附在 scope fence 之後。
- `runPark` **只強制 Verification 標題**，且是擴充**既有的**失敗分支 ——
  它已經承載所有精細之處（檔案仍在才寫註記、*無條件*釋放 claim、metrics）
  —— 絕不新增退出路徑。檢查跑在 `extractPlan` 的輸出上而非原始 body，因此
  不可能與 `hasPlan` 對「什麼是計畫」意見分歧。stage 查找是寬容的（不用會
  丟例外的 `stageDef`）：park 必須永遠走得到 claim 釋放。
- `hasVerificationSection` 刻意寬鬆 —— 不分大小寫、容忍空白、`\b` 讓
  `### Verification & Testing` 通過 —— 並與契約文字放在一起，需求與強制不
  會漂移。拒絕會釋放 claim 並讓任務留在 queued，因此過度嚴格的失敗模式是
  livelock（每個 tick 燒掉一次 PLAN run）；寬容比對加上契約區塊中明示的
  後果就是緩解。

## 捨棄的方案

- **決定論地強制步驟／Out of Scope** —— 屬於文章品質判斷，regex 只會產生
  誤拒；這些條款由契約文字與人類計畫閘門把守。
- **validateBeforeTransition hook** —— 否決點存在，但它跑在 plan-landed
  檢查*之前*，且其失敗分支早於 claim-release 教訓；「計畫在磁碟上但不合格」
  屬於 plan-landed 分支，而它已具備一次拒絕該做的一切。
- **在 `composeStagePrompt` 寫死 kind** —— manifest 旗標讓機制可被未來任何
  規劃型 kind 重用，也可獨立測試。
