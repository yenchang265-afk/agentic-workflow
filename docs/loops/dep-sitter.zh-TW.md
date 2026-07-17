[English](dep-sitter.md) | 繁體中文

# dep-sitter

監看有漏洞和過時的相依套件：確認公告（advisory）、在分支上套用 patch/minor
升級、修復連帶問題、驗證測試套件是否綠燈，然後開啟一個 draft PR。**major
版本升級絕不會自動修復，合併也永遠是人類的決定。**

SCAN → UPGRADE → VERIFY → PUBLISH（最多 2 次疊代）

## 啟用

加進 `.agentic-loop.json`：

```jsonc
{
  "loops": {
    "dep-sitter": {
      "enabled": true,
      "severityFloor": "high"
    }
  }
}
```

`severityFloor` 篩選哪些公告會觸發修復（例如 `high`、`critical`）。所有設定項見
[`docs/sitters.md`](../sitters.md)。

## 指令

**OpenCode**

```
/agentic-loop:dep-sitter claim | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | stop | status
```

**Claude Code (MCP)**

```
/agentic-loop:dep-sitter claim | status | stop
```

（Claude Code 沒有常駐的 watcher；再次呼叫 `claim` 以拉取下一個相依套件。）

## 架構

橫跨三個生態系統，監看有漏洞或過時的相依套件：**npm**（原生的
`npm audit`/`npm outdated`），以及 **Maven**/**Gradle**——透過
[OSV-Scanner](https://google.github.io/osv-scanner/) 查詢 OSV.dev 資料庫
（JVM 生態系統需要在 watcher 主機上安裝 `osv-scanner` 執行檔——缺少它會是一次
可處理的跳過，npm 沒有它仍可正常運作；Gradle 另外還需要一份已提交的
`gradle.lockfile` 或 `gradle/verification-metadata.xml`，因為 osv-scanner
本身無法解析 `build.gradle`）。**scan**（檢查）→ **upgrade**（worktree，
在 `dep-sitter/*` 分支上：調升清單版本、更新 lockfile、修復連帶問題）→
**verify**（執行測試套件）→ **publish** 開啟一個 **draft PR**。**major
版本升級絕不會自動修復**——會被記錄下來留給人類處理，合併也永遠是人類的
決定。有漏洞的 JVM 傳遞相依（transitive，未宣告在建置檔案中）只會被記錄，
絕不會被認領——釘選（pin）一個版本是人類的決定，這與 npm 只處理直接相依的
規則一致。

- **`loops.dep-sitter.enabled`** —— 預設關閉。
- **`loops.dep-sitter.ecosystem`** —— `auto`（預設：偵測儲存庫宣告的每個
  生態系統，並依嚴重程度優先合併候選項目）| `npm` | `maven` | `gradle`。
- **`loops.dep-sitter.severityFloor`** —— 可認領公告的最低嚴重程度：
  `low` | `moderate` | `high`（預設）| `critical`。
- **`loops.dep-sitter.includeOutdated`** —— 預設 `false`；在 patch/minor
  政策範圍內，也認領沒有漏洞但已過時的直接相依套件。**僅限 npm**——對
  maven/gradle 會被忽略（並記錄一行日誌）。

## 範例：一次性掃描與升級

手動檢查有漏洞的相依套件並修復其中一個：

1. **認領一個相依套件**
   ```
   /agentic-loop:dep-sitter claim
   ```
   輪詢相依套件報告（npm 的 `audit`/`outdated`，Maven/Gradle 透過
   OSV-Scanner）以找出下一個可修復的公告。執行 SCAN（確認公告）、
   UPGRADE（套用 patch/minor 升級）、VERIFY（執行測試套件），然後
   PUBLISH（開啟帶有已升級 lockfile 的 draft PR）。由你手動審查並合併。

2. **檢查狀態**
   ```
   /agentic-loop:dep-sitter status
   ```
   顯示目前正在升級哪個相依套件，若沒有待處理項目則顯示「idle」。

## 範例：每週排程掃描

設定一個 cron 工作，於每週一上午 9 點掃描並修復相依套件：

1. **啟動 cron 觸發的 watcher**
   ```
   /agentic-loop:dep-sitter watch cron "0 9 * * 1"
   ```
   （僅限 OpenCode。）`watch` 會把這個 session 變成 worker；它依 cron
   排程觸發，每次認領一個相依套件。適合用於定期的安全維護。

2. **停止 watcher**
   ```
   /agentic-loop:dep-sitter stop
   ```
   從另一個 session/終端機執行（正在 watch 的 session 已被佔用），或先
   按 ESC/執行 `unwatch`。

## 延伸閱讀

- 四個 sitter 的共同點，以及威脅模型：[`docs/sitters.md`](../sitters.md)、[`docs/design/threat-model.md`](../design/threat-model.md)
- 指令參考：[`docs/opencode.md`](../opencode.md)（OpenCode）、[`plugins/claude/README.md`](../../plugins/claude/README.md)（Claude Code）
- 框架內部細節：[`docs/architecture.md`](../architecture.md)
