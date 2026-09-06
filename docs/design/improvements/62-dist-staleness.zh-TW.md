[English](62-dist-staleness.md) | 繁體中文

# 62 —— 過期的建置在 session 開始時就被指名，兩種 host 都是

**狀態：已實作。**

## 問題

打包的 hook、MCP 伺服器與 OpenCode 外掛都透過 `packages/core/dist` 解析 core——它被
gitignore、只有 `pnpm install` 會重建。碰到 core 的 `git pull` 讓每個使用者跑著**舊的**
core，什麼都不會失敗，直到把關點中途冒出契約不符（一個沒有 `data.gate` 的把關結果，
在某一種 host 上事後才診斷出來——「代價最高的沉默接縫」）。session 開始的 reconciler
只檢查 `mcp-server/dist/server.js` **存在**，從不看 core；OpenCode 只抓得到硬性的
載入失敗。

## 改了什麼

- **`distStaleness(pkgDir)`**（`dist-staleness.ts`，只用 `node:fs`）比較最新的非測試
  `src/**/*.ts` mtime 與最新的 `dist/**/*.js`；`staleDistWarning` 是兩種 host 共同印出的
  那一行。`src/` 或 `dist/` 不存在是「無法判斷」（null），絕不是過期——裝在 monorepo 之外
  的外掛旁邊沒有原始碼。
- **Claude/Qwen 的 reconciler** 在存在性檢查之後探測 `mcp-server` 與
  `../../packages/core`，有預算（`maxFiles`，回報 `partial`），因為被 host 在期限殺掉的
  hook 會丟掉整份報告。
- **OpenCode 的 `reconcileOnce`** 以同樣方式探測 core，並記錄附重建指令的警告。

## 尖銳邊角

- **最新對最新，不是逐檔。** `tsc` 會重寫每個輸出，逐檔配對會把未變的模組誤讀為過期。
- **測試檔排除在原始碼端之外。** 編輯 `*.test.ts` 不會改變 dist，不該讀成過期。
