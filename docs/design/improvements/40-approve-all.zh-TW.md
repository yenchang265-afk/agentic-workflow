[English](40-approve-all.md) | 繁體中文

# 40 — `approve --all` 批次過任務閘門，而且只有任務閘門

**狀態：已實作。**

## 問題

`new` 遇到重的想法會產生 slice set——人類一口氣審完的 N 份 sibling 草稿——
然後閘門讓他們打 N 次 approve（或答 N 次 follow-up）：多個候選下的裸
`approve` 刻意是一個 ambiguity 拒絕，沒有任何批次形式。摩擦正好落在工具
表現最好的地方。

## 改了什麼

- **`--all`** 在 `parseGateOptions` 解析（每個 host 的 parser 自動繼承——
  bundled hook 原樣轉發 dash-word，不需要任何新教學）、作為 `approveAny`
  的第一個路由檢查，落在 **`approveAllTasks`**：`draft/` 裡每一份已審閱的
  草稿、依優先序、tracking epic 除外、逐一 `approveTask`。fallback 工具
  路徑上是 `workflow_approve` 的 `all` 參數，遵守與 `--auto-plan` 相同的
  「只有使用者親自輸入」規則。
- **單一草稿的拒絕不會停止整批**：secret scan（或無法解析的檔案）只拒絕
  「它的」草稿，已核准的 sibling 保持核准，拒絕原因（截斷後）以 `warning`
  variant 搭上結果訊息——部分成功的批次是清晰可讀的，絕不無聲縮水。
- **`--auto-plan` 可以組合**（`approve --all --auto-plan` 為每個核准的
  child 上膛），因為兩個旗標都是人類打的。

## 尖銳邊角

- **只有任務閘門，從構造上保證**——它只列 `draft/`。計畫與出貨閘門永遠
  一次一個：各自需要人類真的「讀過」某個東西（一份計畫、一個 diff），
  在那裡的批次形式等於核准沒人打開過的文件。
- **`--all` 旁邊帶 id 會在解析時被拒絕**（`--all takes no task id`），
  與同時給兩個 publish 模式同一條規則：沒有可辯護的解讀。
- **不上膛任何 follow-up ask。**批次結果不帶 `gate`/`id` 鍵，這正是讓
  兩個 host 的任務閘門 follow-up 保持安靜的機制——設計 19 的 fail-safe
  arm（continue 需要已知的 gate 加上字串 id）完成這件事；ask 機制沒有
  加任何新東西。
