[English](66-installer-next-steps.md) | 繁體中文

# 66 —— 安裝程式的最後一行是第一個要輸入的指令

**狀態：已實作。**

## 問題

成功的安裝結束在使用者層級設定鍵的目錄，而唯一一行「接著執行」（獨立的 Claude 安裝程式）
指名的是 `new <idea>`——第二個動詞。搭建 `docs/tasks/` 與安全設定的 `init` 從未被指名；
OpenCode 那半只說「可用」，Qwen 那半把人送去 `status`（在新 repo 上印出空的總覽）；
最上層入口 `bootstrap.sh` 結束在「Done」。

## 改了什麼

- **`install.sh` 與 `install.ps1` 的 `next_steps` / `Write-NextSteps`**，對每個外掛目標
  最後呼叫：每個 host 如何載入外掛、然後 `init`、然後 `new <idea>`；加上管理面板指令。
  各 host 安裝程式保留「已安裝」行、去掉自己的建議。
- **獨立的 Claude 安裝程式與 `bootstrap.sh`** 以相同的兩個指令收尾，`init` 在前。
- **`scripts/install-next-steps.test.mjs`** 對原始碼 grep（`bootstrap-ado.test.mjs` 的風格）：
  兩個安裝程式都以該區塊結尾、每個 host 都被指名、`init` 在 `new` 之前、沒有安裝程式先把人
  送去 `status`。

## 尖銳邊角

- **grep 原始碼，不執行。** 安裝程式會寫入使用者的家目錄；執行它們的測試是會改變機器的測試。
