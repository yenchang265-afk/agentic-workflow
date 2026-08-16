[English](29-deny-telemetry.md) | 繁體中文

# 29 — doctor 讀取拒絕紀錄

**狀態：已實作。**

## 問題

Allowlist 飢餓已經人工診斷過四次——Maven 與 Gradle 的 argv 順序、JS 套件
管理器的 workspace 選擇器、rewriting proxy 的前綴——而每一次證據都埋在
stage transcript 裡：OpenCode 的 DeniedError 會不分 pattern 傾印每一條
bash 規則（transcript 因此「證明」deny-all sentinel 贏了），Claude/Qwen
守衛的 block 訊息只點名它拒絕的那一條指令。補救手段
（`bashAllowlistExtra` / `bashAllowlistPrefix`）早就存在；缺的是診斷。
`doctor`——run 出問題時操作者本來就會找的動詞——對這一切一無所知。

## 改了什麼

- **拒絕紀錄** —— `<tasksDir>/runs/.deny-log.jsonl`
  （`packages/core/src/workflow/deny-log.ts`）：每次拒絕一個 JSON 物件
  （`ts`/`host`/`kind`/`stage`/`command`）。純遙測，永不進控制平面——
  沒有任何東西讀它來做決策，所以一個共用檔案就能服務所有 host（stage
  marker 與 evidence ledger 之所以按 host 分檔，是為了保護裁決輸入；
  拒絕計數沒有裁決可污染）。寫入端全程 best-effort，超過位元組上限就
  停止追加而不是無限成長；讀取端取最後 `DENY_LOG_MAX` 條可解析的行。
- **寫入端** —— Claude/Qwen 檢查階段守衛的 allowlist block 分支
  （`check-stage-guard.entry.mjs` 經 `hooks/src/deny.mjs`，與 evidence
  ledger 相同的 bundle-local 模式），記錄的是「原始」指令——agent 要求
  的形狀就是操作者必須放行的形狀。OpenCode 側由 `impl.ts` 的
  `permission.ask` 觀察者記錄「live 迴圈驅動的 session 上、bash 權限被
  deny」的事件；只觀察不干預（`output.status` 只讀不寫），且本質上
  best-effort——硬性的 `"*": deny` 是否會諮詢這個 hook 是 host 的實作
  細節，紀錄安靜也不虧。driver 自己跑的檢查准入「不是」寫入端：設計 24
  已經回報那些拒絕（停泊預覽、稽核註記、metrics）。
- **doctor** —— 兩個 host 都按（kind、stage、command）彙整紀錄，並用
  `suggestFor` 機械式推導修法，沒有任何 per-ecosystem 表格（表格正是
  過去四次過期的東西）：若去掉指令開頭一或兩個 token 後，得到的指令
  已被該階段的有效 allowlist（manifest + 平台額外 + `bashAllowlistExtra`）
  接受，這次拒絕就是 rewriting proxy——建議 `bashAllowlistPrefix`，它
  不放寬任何東西；否則建議最窄的機械式 `bashAllowlistExtra` glob
  （`<tool> <next> *`）。`doctor fix` 會清除已回報的紀錄——遙測已被
  確認——連同它的其他修復一起。

## 銳利邊緣

- 建議是「報告」，永遠不是自動套用的設定變更：extra 會放寬階段的範圍
  邊界（T2），寬窄始終是操作者的決定。動詞說明文字明說了這一點
  （「設定的修改是人的決定，永遠不是你的」）。
- 前綴建議需要證據（剝除後的指令必須原本就被允許）——沒有 glob 可驗證
  時只提供 extra-glob 形式，因為一個無法驗證的前綴建議會招來靜默無效
  的 `bashAllowlistPrefix` 條目。
- `deny.mjs` 與 core 的 `deny-log.ts` 以慣例共用檔名與位元組上限常數，
  由 `deny.test.mjs` 的形狀測試釘住——bundled hook 無法 import core
  （與 marker 攜帶 `bashAllowlist` 同一個理由）。
