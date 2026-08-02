[English](13-plan-visualization.md) | 繁體中文

# 13 — 選擇性加入的計畫視覺化

**狀態：已實作。** `StageDefSchema` 上的 `planVisualization`
（`packages/core/src/manifest/schema.ts`）、`workflow/verdict.ts` 的
`planVisualizationBlock`、`config.ts` 的 `planVisualizationFor` 與
`workflows.<kind>.planVisualization` 設定、`workflow/engine.ts` 的組裝尾段、
管理面板的 mermaid 渲染
（`packages/hub/src/web/markdown/MermaidBlock.tsx` + `mermaid-embed.ts`）；
測試在 `schema.test.ts`、`config.test.ts`、`verdict.test.ts`、
`engine.test.ts`、`parse.test.ts`、`mermaid-embed.test.ts`。

## 背景

計畫閘門要求人類只憑散文核准一個變更的*形狀*。對某些形狀——狀態／生命週期
轉移、橫跨多個套件的流程、並行與鎖、資料形狀變更——散文恰恰藏住了審查者
最需要抓到的缺陷類別：本 repo 自己最嚴重的幾個 bug 就是「缺一條弧」的
bug（stop 處理器漏掉的 claim 釋放路徑、從未觸發的孤兒清掃），狀態圖讓它
可見，編號步驟清單不能。然而強加在每個計畫上的圖，對佔多數的機械式計畫
只是審查噪音，還是一份可能與它所描繪的步驟漂移的第二產出物。

## 設計

- 階段 schema 上的 `planVisualization: z.boolean().default(false)`
  （`planContract` 模式——逐階段選擇性加入，預設值讓每個 kind 位元組不變）。
  `check` 階段設定它是清單錯誤；沒有 `planContract` 而設定它也是：圖住在
  契約所定義的 `## Implementation Plan` 文件裡。
- 設定 `workflows.<kind>.planVisualization`（kind 層級布林值）雙向壓過清單
  旗標，由 `planVisualizationFor` 解析——內建 kind 的清單隨核心套件出貨，
  設定是唯一觸及得到的加入途徑（`stageFanout` 的理由）。用 kind 層級而非
  按階段記錄，因為每個 kind 至多一個階段帶 `planContract`，而解析器要求它。
  單一布林值——與 `stageContext` 一樣可從 repo 層生效。
- `planVisualizationBlock`（在 `verdict.ts`，`planContractBlock` 旁——只寫在
  persona 裡的契約可被跳過；組裝時機械式附加的契約在每條派發路徑上都存活）
  陳述啟發式：當變更涉及狀態／生命週期轉移、跨套件流程、並行／順序、
  資料形狀變更時，在計畫內附上 ```mermaid`` 圍欄；小型或機械式計畫略過；
  圖與編號步驟不一致時以步驟為準。SHOULD、永不 MUST——`runPark` 未動。
- 管理面板把圍欄渲染成圖：`Markdown.tsx` 把 `lang === "mermaid"` 的程式碼
  區塊交給 `MermaidBlock`，後者延遲載入 mermaid（esbuild 分割 chunk——只有
  文件真的含圖時才抓取），並把 SVG 渲染進 `<iframe sandbox="" srcdoc>`。
  安全邊界是 iframe 而非 mermaid 的消毒器：mermaid 內部以 innerHTML 渲染
  且有繞過 CVE 的歷史，而渲染器「絕不 `dangerouslySetInnerHTML`」的不變式
  必須對來自別人分支的 repo 內容成立——無腳本、無來源的框架即使在完全
  繞過下也守得住。`securityLevel: "strict"` 保留作為縱深防禦。區塊保有
  自己的 id，逐行 replan 留言像其他區塊一樣錨定到圖上；來源切換與渲染
  失敗時的 `<pre>` 後備讓計畫文字永遠可讀。

## 為什麼不

- **在 park 閘門強制要求圖**——圖的價值是散文品質的判斷；regex 只能檢查
  圍欄存在，這會招來每個計畫都放一張裝飾用的圖，以及計畫契約設計記錄
  已記載的活鎖經濟學。
- **草稿階段的圖**——草稿依 schema 是 1–4 句話加驗收準則
  （`workflow-task-author` 在正文之下不寫任何東西）；還沒有可畫的形狀。
  epic 的切片圖考慮過、暫緩。
- **用 DOMPurify 把 mermaid 渲染進管理面板 DOM**——消毒器是對 mermaid
  CVE 歷史的黑名單競賽；沙箱 iframe 是不依賴贏得那場競賽的能力邊界。
- **按階段記錄的設定**（`stageVisualization: {plan: true}`）——解析器以
  `planContract` 為鍵，而每個 kind 至多一個階段帶它；記錄形式會暗示一種
  不存在的逐階段選擇。
