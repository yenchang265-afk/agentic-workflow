[English](60-unknown-config-keys.md) | 繁體中文

# 60 —— 沒有東西讀的設定鍵會被指名，並附上它差一個字的鍵

**狀態：已實作。**

## 問題

`.agentic-workflow.json` 由 zod 解析，而 zod 會剝掉 schema 未宣告的鍵——所以拼錯的
頂層鍵（`maxIteration`）在任何程式碼看到之前就消失了，行為退回預設值，沒有任何地方
說一聲。`workflows.<kind>` 區段刻意是 `looseObject`（類型專屬的旋鈕搭便車），所以
`engineering` 下的 `"enable": true` 撐過了解析、卻沒有東西讀它；唯一會指名這個錯字的
警告（`unenabledConfiguredKinds`）只對選擇加入的類型觸發。管理面板的 Config 分頁對區段
旋鈕有近似比對的 lint；CLI host 與載入本身都沒有。

## 改了什麼

- **`config.ts` 的 `unknownConfigKeys(rawMerged)`**，從**原始**合併層判斷——與
  `retiredConfigKeys` 相同的解析前視角，理由也相同。三個範圍：頂層對照
  `ConfigSchema.shape`（排除已退役的鍵，它們有自己的警告）、`projectManagement.*` 對照
  其 schema、`workflows.<kind>.*` **只在**與已宣告區段鍵差一個字時標記
  （`workflowSectionKeys` 從 schema 讀出，不會漂移）——那裡不認識的旋鈕不是錯字的證據。
  `ado` 略過（刻意寬鬆；`deprecatedAdoKeys` 涵蓋）。
- **`isNearMiss`** 從管理面板移入 core 無 zod 的 `config-layers.ts`，兩個 lint 共用同一個
  近似比對概念。
- **`loadConfigWith` 在載入時**對每個未知鍵警告，**`effectiveConfigReport` 帶
  `unknownKeys`**（透過選填的 lint 回呼——該模組無 zod），兩種 host 的 `doctor config`
  連同建議一起渲染。
- **`$schema`** 已宣告（設計 61），編輯器的指標本身不會被回報。

## 尖銳邊角

- **原始，絕不是解析後。** `Config` 無法指名它已經沒有的鍵。
- **寬鬆區段維持寬鬆。** 把那裡每個未知旋鈕都標記，會製造管理面板 lint 所記載的那種
  「看起來壞了」的失敗；近似規則正是讓警告可信的原因。
