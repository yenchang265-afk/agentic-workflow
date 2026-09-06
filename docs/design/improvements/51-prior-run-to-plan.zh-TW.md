[English](51-prior-run-to-plan.md) | 繁體中文

# 51 —— replan 的 PLAN 回合看得到上一次執行留下的東西

**狀態：已實作。**

## 問題

在迭代上限停下的執行（或被 `replan` 從 `in-progress/` 送回的執行）留下兩樣下一輪
PLAN 需要、卻從未被告知的東西。它的 commit 仍在 `feature/<id>` 上——分支撐過了
`closeIsolation`，下一次 BUILD 就是從它切出——但任務上沒有任何東西這麼說，於是
replan 當成乾淨的樹來規劃，builder 意外撞見舊工作。而 admission **拒絕**的
discovered checks 只記在 deny log 與 goal 渲染會剝掉的 checks-provenance 稽核註記
裡，所以下一份計畫又寫出同樣被拒的指令，VERIFY 在一行警告後面再次一個檢查也沒跑。
設計 25 把 attempts 摘要串進了 replan reason；這兩項事實則完全沒有通道。

## 改了什麼

- **`runStop` 寫下一條 `> Prior work` 註記**——在隔離執行的非暫時性停止時——
  分支、基底、以及驗證過的 `git diff --shortstat`——採用完成註記的欄位形狀，並寫在
  attempts 註記**之前**，讓那條註記仍是 `extractStopContext` 讀的最後一條
  `> Run stopped`。
- **`priorRunFor(task)`** 在 PLAN 認領時解析最後一條這種註記，**以及**最後一條
  checks-provenance 註記裡的 `discovered check "…" refused: …` 條目，兩者都由與停止
  情境相同的錨（新的計畫標題、`Plan written` 停靠、reshape）退役。每個欄位都驗證
  到它將被插值的形狀——分支會進到 git 指令。
- **`WorkflowState.priorRun`** 在兩條認領路徑（`backlog.ts` 與 `planEntryState`）
  都隨 PLAN 進入狀態，從不持久化（如 `replan`，plan 階段的快照依設計無效），
  plan.md 渲染成一節：分支及其 diffstat 與 diff 指令、要求**決定**建立於其上或
  捨棄的指示、以及被拒指令與改用可被接受指令的指示。

## 尖銳邊角

- **attempts 註記保持在最後。** 兩條 `> Run stopped` 家族的註記會讓較新者遮住
  摘要；prior-work 註記有自己的 marker 且先寫。
- **與停止情境相同的錨退役。** 一節描述較新計畫已決定過的分支會讓規劃者追逐過期
  事實；三個錨透過同一個 helper 共用，解析器無法漂移。
- **拒絕清單盡力而為。** provenance 註記的細節在寫入時被鉗住，很長的清單可能在
  條目中間截斷；留下來的仍是下一位規劃者不該再寫的東西。
