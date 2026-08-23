[English](37-effective-config-view.md) | 繁體中文

# 37 — 一個接縫回答「哪些設定生效，為什麼我的沒有」

**狀態：已實作。**

## 問題

執行期會從 repo 設定丟棄僅限 user 層的鍵（shell-bearing 鍵、巢狀的
`workflows.<kind>.stageChecks`/`scannerCommand`、ADO 目的地與憑證）——但每個
介面講的故事都不一樣。丟棄邏輯是 `loadConfigWith` 裡三個私有 async 函式，
只在載入時往沒人保存的 log 警告一次；**沒有任何 CLI 介面印出解析後的設定**
（`kinds` 只印檔案路徑）；hub 的「effective」視圖合併的是「原始」層，於是
repo 層的 `stageChecks` 顯示為生效，而 loop 其實忽略它；而
`readRawConfigLayers`——每個 bundled hook 信任的讀取器——只剝除頂層 shell
鍵，它自己的文件卻宣稱與 loadConfig 完全對齊。

## 改了什麼

- **`config-layers.ts` 裡一個純接縫**：`droppedRepoKeys(repoRaw)`（點分路徑
  ＋家族）與 `sanitizeRepoLayer(repoRaw)`。`loadConfigWith` 的警告、hub 的
  effective 視圖、`readRawConfigLayers`、doctor 報告全都讀同一份清單——
  載入時警告過的鍵，永遠不可能在另一個介面顯示為「生效」。三個丟棄函式
  刪除；警告文字逐字保留，按家族措辭。
- **`readRawConfigLayers` 現在套用完整丟棄集**——補上 repo 層巢狀
  `stageChecks` 或 `ado.organization` 能到達信任它的 hook 的缺口。
- **`doctor config`**（兩個 host；MCP host 上是
  `workflow_doctor({config: true})`）回傳 `effectiveConfigReport`：各層檔案
  路徑（user 路徑只在檔案存在時列出）、被丟棄的 repo 鍵、以及行程「實際」
  運行中的設定——host 已載入的物件，絕不重新推導合併——經
  `maskConfigSecrets` 遮蔽（按鍵名：任何深度的
  pat/token/secret/password/api-key）。
- **hub 的 effective 視圖誠實了**：`getConfig` 合併經 sanitize 的 repo 層
  （effective、provenance、issues 全都反映執行期），回應新增的
  `droppedRepoKeys` 渲染為「Set here, ignored at runtime」段落，直接點名
  搬到 user 設定這個解法。

## 尖銳邊角

- 每層的 `raw` 視圖刻意「不」sanitize：它呈現檔案本身；`droppedRepoKeys`
  才是說明哪些鍵被執行期丟棄的東西。
- `effective` 在所有地方都是僅供顯示、離開前已遮蔽——絕不寫回（hub 標頭的
  規則 2 已禁止；doctor 報告帶著 `[REDACTED]` 值繼承同一規則）。
- `maskConfigSecrets` 刻意比今天唯一的機密欄位更寬：未來新增的憑證鍵在
  加入當天就被遮蔽。
