[English](53-recovery-ux.md) | 繁體中文

# 53 —— 復原看得見每一種崩潰，只有一個時不需要 id

**狀態：已實作。**

## 問題

`status` 的 `interrupted:` 清單——以及它渲染的 `recover <id>` 提示——來自
`wasInterrupted`，它讀任務 body 的 BUILD 標記：有 `> BUILD started` 而沒有對應的
`> BUILD finished`。那只見證 BUILD 的崩潰。死在 VERIFY 或 REVIEW 的執行留下的是
完整的 BUILD 配對，於是讀作「未中斷」：任務停在 `in-progress/`，磁碟上有階段快照
——`recover` 恢復所依據的精確階段 oracle（設計 02）——而兩種 host 上都沒有任何東
西點名它。而 `recover` 在兩種 host 上都要求 id，即使只有一個任務可復原。

## 改了什麼

- **快照是第二個中斷 oracle。** `summarizeBacklog` 接受 `snapshotIds`
  （`listSnapshotIds`，即 `runs/<id>.state.json` 檔案），當 body 這麼說**或**快照
  點名它時，把 in-progress 任務列為中斷——排除仍可認領的 body，那裡的快照是過期
  殘留，`recover` 會拒絕。兩種 host 的 status 與管理面板的 backlog 路由都傳入它。
- **`soleInterrupted(summary)`** 是無 id 的 `recover` 唯一可能指的任務。兩種 host
  都接受無 id 形式（`workflow_recover` 的 `id` 可省略；OpenCode 動詞的用法寫
  `recover [id]`）：恰好一個中斷任務就恢復；多個則附清單拒絕；沒有則顯示用法。
  每處參數提示與文件都改為 `[id]`。

## 尖銳邊角

- **可認領 body 旁的快照不是中斷。** 那是過期執行留下的，`recover` 會拒絕從未開
  始的任務——列出它等於點名一個做不了事的動詞。
- **可選參數，呼叫端不變。** `summarizeBacklog` 的第三個參數預設 `[]`，早於它的
  呼叫端逐位元組相同。
- **歧義被拒絕，從不猜測**——與無 id 的 `approve` 同一條規則。
