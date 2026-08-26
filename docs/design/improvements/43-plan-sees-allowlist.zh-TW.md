[English](43-plan-sees-allowlist.md) | 繁體中文

# 43 — PLAN 看得到它的 discovered check 要被判定的 allowlist

**狀態：已實作。**

## 問題

`checkDiscoveryBlock` 告訴計畫作者每條 discovered 命令「必須在 VERIFY
階段自己的 bash allowlist 上」——卻從不展示那份清單。PLAN 沒有 bash、也
無從探測，所以命令是在准入時被拿去對一份作者從未見過的 glob 清單判定。
設計 24/29/38 全都在事後補測（停泊預覽、deny log、拒絕遙測）；最便宜的
修正點——寫作當下——反而是唯一沒有儀表的一個。典型受害者：monorepo 的計
畫寫下完全可讀的 `pnpm --filter web test`，一個迭代之後才在一行警告背
後被拒。

## 改了什麼

- **`discoveryAllowlist`（core，`discovered-checks.ts`）**組出消費端階
  段的有效清單——有效平台下的 manifest glob 加上 `bashAllowlistExtra`
  ——並在 discovery 根本不會發生時回傳 `undefined`（沒有 discovering
  stage，或 config/manifest 的 checks 先占）。放在
  `previewDiscoveredChecks` 旁邊，讓它不可能偏離准入實際使用的參數。
- **`checkDiscoveryBlock` 把它渲染出來**：「That allowlist's patterns
  are: `npm test*` · … — a command is admitted only if it matches one」，
  以整條 pattern 為單位截斷（約 2KB）並點名省略數量，所以病態的
  `bashAllowlistExtra` 撐不爆每份 PLAN prompt。
- **`composePromptWithStats` 穿針引線**，作為 `composeStagePrompt` 新的
  可選參數；hub 的 creator 預覽顯式傳入，保住預覽逐字節相同的保證。

## 尖銳邊界

- **只展示裸形。**prefix twins（`bashAllowlistPrefix`）刻意不渲染：准
  入容忍代理前綴過的命令，但計畫「該寫」的形狀是裸的那些。
- **無 config 時只從 manifest 組**（預設平台、無 extras）——與預設
  config 逐字節相同，這正是 engine.test.ts 的 unset-knob pin 與 hub 預
  覽保證能同時成立的原因。
- **這是指引，不是閘門。**准入（`admissibleChecks`）未動；區塊展示清單
  不放寬也不收窄實際會跑什麼。
