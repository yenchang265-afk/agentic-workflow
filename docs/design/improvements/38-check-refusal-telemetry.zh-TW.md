[English](38-check-refusal-telemetry.md) | 繁體中文

# 38 — Check admission 的拒絕加入 deny log

**狀態：已實作。**

## 問題

設計 29 給了 allowlist 飢餓一條遙測通道——但只涵蓋 AGENT 那條接縫。計畫
指名、被 stage admission 拒絕的 discovered check 只有 warn：一行沒人保存
的 log，加上一個實際計數 `warnings.length` 的 `checksRefused` 指標——parse
問題、admission 拒絕、缺少的執行檔混成一個數字。於是設計 29 要終結的那個
失敗（VERIFY 靜靜地跑得比 PLAN 承諾的少，靠 transcript 考古診斷）仍留有
一條無聲接縫：`doctor` 的單一遙測視圖只涵蓋 agent 端的拒絕。

## 改了什麼

- **`ResolvedChecks` 增加 `refused`**——僅 admission 的拒絕、結構化，每個
  `RejectedCheck` 現在帶著被拒的 `command` 原文。parse 問題與缺少的執行檔
  留在 `warnings`：那些是計畫形狀與環境的事實，任何 allowlist 修改都答不了。
- **兩個 host 在各自的 `resolveStageChecks` 呼叫點餵 deny log**：每個被拒
  指令一筆，帶新的 `source: "check"` 欄位。缺席的 source 讀為 `"agent"`，
  所以既有的每筆記錄與每個 writer 都不變。
- **doctor 的彙總會說拒絕來自哪裡**：`DenyFinding` 增加 `fromChecks`，
  報告行渲染 `(a plan-discovered check)`／`(N of these from plan-discovered
  checks)`——操作者的心智模型是「denial 來自 agent」，而 check 拒絕正是
  那個讓 VERIFY 在一份 gate 上看起來沒問題的計畫背後挨餓的。`suggestFor`
  原樣適用：同樣的 `bashAllowlistExtra`/`bashAllowlistPrefix` 解法就能放行
  discovered 指令，因為 admission 評估同一份 effective glob。
- **`checksRefused` 誠實了**：兩個 host 的 metrics sample 現在計
  `refused.length`，hub 的 discovery 統計不再用 parse 雜訊與缺席執行檔
  灌水（那些仍在 `detail` 可見）。

## 尖銳邊角

- 只有 admission 拒絕寫入——缺少執行檔是環境事實，把它記成「denial」會讓
  操作者去改從來不是問題的 allowlist。
- deny log 寫入沿用同一個 best-effort `appendDenyEntry` 契約：遙測絕不能
  改變 admission 對指令的處置。
- `doctor fix` 連同其他記錄一起清掉 check 來源的條目——一份 log、一個
  生命週期。
