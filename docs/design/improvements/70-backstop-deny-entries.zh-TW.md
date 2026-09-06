[English](70-backstop-deny-entries.md) | 繁體中文

# 70 —— 寫入後盾的拒絕以它本來的身分記錄

**狀態：已實作。**

## 問題

拒絕紀錄記的是階段**允許清單**拒絕的指令，doctor 為每一筆塑造一個 `bashAllowlistExtra`
glob。寫入後盾——推送到受保護分支、PR 變更、會改動的 `find`、ADO 寫入——在兩種 host 上都會
拒絕，卻完全沒有記錄；其中一個還記**錯**了：Claude/Qwen 的 guard 把 `find` 規則摺進
`commandAllowed`，所以 `find . -delete` 以允許清單拒絕的身分進了紀錄，doctor 開出
`add "find . *" to bashAllowlistExtra`——永遠無效的建議，因為沒有 glob 碰得到那條規則。

## 改了什麼

- **`DenyEntry` 的 `source: "backstop"`**；`parseDenyLine` 接受它，`aggregateDenials` 計數
  `fromBackstop`，**全部**是後盾的發現得到 `NOT_THE_ALLOWLIST` 而不是 `suggestFor` 的 glob；
  `formatDenyFindings` 說 `(a write backstop)`。
- **Claude/Qwen**（`check-stage-guard.entry.mjs`）：`noteDeny` 多了 `source` 參數，每個後盾
  `block` 都記錄一筆——ADO 寫入與範圍拒絕（以工具名代替指令）、gh 變更、git push，以及
  真正原因是 `find` 規則的允許清單拒絕（`chainedFindMutation`，hook 的 allowlist 現在匯出
  core 的對應版本）。
- **OpenCode**（`impl.ts`）：`noteBackstop` 在四個 throw 之前各附加一筆 `source: "backstop"`。
- 兩種 CLI host 與管理面板的 doctor 文字不再把紀錄稱為「允許清單拒絕紀錄」。

## 尖銳邊角

- **後盾項目絕不能建議 glob。** 這是整件事的重點；混合情況（同一指令被兩者拒絕）保留 glob
  建議並說明幾筆來自後盾。
- **盡力而為、在拒絕之前、絕不 await。** throw 或 block 才是決定；附加失敗不改變任何事。
