[English](74-qwen-bake-drift.md) | 繁體中文

# 74 —— 過期的 Qwen 模型烘焙在 session 開始時被指名

**狀態：已實作。**

## 問題

Qwen 的 `agent` 工具沒有 `model` 參數，所以 `stageModels`/`agentModels` 在安裝時被烘焙進安裝
好的代理檔。每一句「改設定後請重跑安裝程式」都只是散文；沒有東西把設定與磁碟上的位元組比對，
改了 `stageModels` 後每個階段仍跑舊模型且什麼都不會失敗——正是模型戳記 hook 在 Claude 上要
終結的無聲綁定失敗，換了一個 host。

## 改了什麼

- **安裝程式記錄烘焙**（`agents/.agentic-workflow-baked.json`）：何時、烘焙了哪些綁定、
  以及它讀到的設定的 `modelSubtrees`——`agentModels` 加上每個 `workflows.<kind>.stageModels`，
  沒有別的，所以無關的編輯不算漂移。之後比對不需要 manifest。
- **Qwen 的 reconcile hook**（session 開始、以 `conveysSpawnModel: false` 限定 host）讀取記錄、
  以同樣方式投影**目前**的原始設定、比較 canonical JSON，並以 dialect 的安裝指令指名修法。
  失敗傾向沉默：沒有記錄、或不是 Qwen，都不算漂移。

## 尖銳邊角

- **孿生，且被釘住。** `modelSubtrees` 住在無依賴的安裝程式裡、又住在打包的 hook 裡；
  安裝程式的有測試，hook 的由 `reconcile.test.mjs` 寫入記錄與設定端到端涵蓋。
- **投影，不是解析。** 比較解析後的每代理模型需要打包的 hook 讀不到的 manifest；比較決定
  它們的輸入什麼都不需要。
