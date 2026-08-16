[English](30-auto-plan.md) | 繁體中文

# 30 — `--auto-plan` 按任務削薄計畫閘門

**狀態：已實作。**

## 問題

每個任務都要付三道人工閘門——任務、計畫、出貨——而對雜務等級的工作，
計畫審查就是橡皮圖章：人讀著自己剛寫的任務的一步計畫，再打一次
`approve`。閘門疲勞是真的，但所有粗暴的解法都更糟：repo 全域的「跳過
計畫閘門」開關會連高風險任務的閘門一起削薄；用 prose 叫 orchestrator
「瑣碎就繼續」則是把控制流決策交給模型當下的感覺。

## 改了什麼

- **選擇性加值是按任務、明確、在任務閘門做出的**：
  `approve <id> --auto-plan`（每個 host 的 typed verb；`workflow_approve`
  的 `autoPlan` 引數，說明文字寫明「只在使用者明確要求時」）。
  `parseGateOptions` 擁有這個旗標；`approveTask` 把 `autoPlan: true` 寫進
  任務的 frontmatter——放進 `TaskFrontmatterSchema`，因為 off-schema 鍵在
  zod 的未知鍵剝除下是破壞性的（與 `epic` 同理）。重寫前先用
  `unknownFrontmatterKeys` 篩檢，失敗降級為警告：MOVE 才是人要求的。
- **在停泊時消費，以「檔案」為準**：PLAN drive 停泊的任務，其
  plan-review 檔案帶著旗標時，計畫閘門被「確定性地」跨越——絕不是
  orchestrator 可能跳過的 prose。OpenCode：driver 的
  `autoAdvanceParkedPlan` 在兩個停泊點（`plan <id>`/鏈式 drive 與 watch
  認領）之後執行，經共用閘門核准，並用 `claim <id>` 同一條 `start-task`
  pending 排入 BUILD drive；跨越閘門時同時抑制計畫閘門的詢問（沒有可問
  的了）。Claude/Qwen：`runPark` 在伺服器端核准並從描述子省略 `gate`，
  讓 plan-gate-ask hook 與閘門 prose 保持沉默；`next` 指示
  `workflow_start`——被跳過只損失閒置時間（任務已建置就緒，下一次
  claim 會建置它）。
- **每次拒絕或重新表態都撤回加值**：`replanTask` 清除旗標（拒絕過一份
  計畫的人想親眼看修訂版）；對仍帶旗標的草稿做普通 `approve` 也清除——
  核准對「這一次要求了什麼」有最終決定權，所以 retask → 重新核准的循環
  不會繼承過期的加值。出貨閘門在任何路徑上都永不自動化。

## 銳利邊緣

- 停泊「拒絕」（計畫契約）不受影響：任務回到 `queued/` plan-next，下一
  輪重新停泊——然後再次自動核准。這是刻意的：契約拒絕是機械性的，不是
  人的判斷，無人值守的重試正是這個加值買到的東西。
- 設計 24 的停泊時檢查預報（「N 條獲准進 VERIFY」）隨閘門一起被跳過——
  帶旗標的任務即使計畫發現零條可准入檢查也照樣前進。點火時的來源記錄
  （稽核註記 + metrics）仍會記下；人在任務閘門接受了這個交換。
- 核准失敗的分支在兩個 host 都退回普通人工閘門（帶 `gate` 的描述子、
  警告 toast）——auto-plan 永遠不可把能用的閘門變成卡死的任務。
- OpenCode 的 `workflow_gate` 插件工具尚未攜帶這個旗標——typed verb 與
  MCP 工具有；若真有流程需要，agent 驅動的分支可以後補。
