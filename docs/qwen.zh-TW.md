[English](qwen.md) | 繁體中文

# Qwen Code 外掛

**實驗性**——此宿主的介面與行為仍可能變動。

Qwen Code 版本如何執行、它的指令面，以及安裝細節。共用的流水線全貌見
[architecture.md](architecture.zh-TW.md)；另外兩個宿主見
[opencode.md](opencode.zh-TW.md) 與
[`plugins/claude/README.md`](../plugins/claude/README.zh-TW.md)。

## 執行模型

共用的 engineering 流水線（把關、PLAN 停park、BUILD/VERIFY/REVIEW、
`maxIterations`、出貨）只在
[`docs/workflows/engineering.md`](workflows/engineering.zh-TW.md) 記錄一次——
本節只涵蓋在 Qwen Code 上執行時特有的部分。

Qwen Code 驅動迴圈的方式和 Claude Code 相同，理由也相同：它沒有自主的背景驅動器，
所以**主代理就是驅動者**。它對每一個決定性操作（claim、isolate、compose、advance、
verdict、gate）呼叫內建的 `agentic-workflow` MCP 伺服器，並用 **`agent` 工具**自己
啟動每個階段，把回應的 `agent` 欄位當作 `subagent_type` 傳入，並帶
`run_in_background: false`。

因此**沒有 `watch` 模式**——`/agentic-workflow:engineering claim` 是對應的拉取式做法。
在同一個回合內，BUILD → VERIFY → REVIEW 仍然會自行推進，不需要額外的人類回合。

人類把關是**互動式**的，同樣和 Claude Code 一樣：park 或 done 會回傳一個 `gate`
欄位，驅動中的代理用 `ask_user_question` 當場詢問，而不是要你再打下一個指令。
資料夾驅動的 `approve` / `replan` 指令仍然有效，也是非互動 session 會用的方式。

## 指令面

與 Claude Code 版本完全相同——Qwen 的子目錄命名空間會把
`commands/agentic-workflow/engineering.md` 呈現為 `/agentic-workflow:engineering`：

| 指令 | 作用 |
|---|---|
| `/agentic-workflow:engineering` | engineering 迴圈：`new`、`retask`、`approve`、`replan`、`remove`、`plan`、`claim [id]`、`recover`、`kinds`、`doctor`、`stop`、`status` |
| `/agentic-workflow:pr-sitter` | PR sitter：`claim [<pr>]`、`status`、`stop` |
| `/agentic-workflow:review-sitter` | review sitter |
| `/agentic-workflow:dep-sitter` | 相依套件 sitter（實驗性） |
| `/agentic-workflow:main-sitter` | 預設分支 CI sitter（實驗性） |
| `/agentic-workflow:plan` | 臨時、唯讀的規劃——不屬於迴圈 |

和 Claude Code 一樣，被呼叫的 verb 的程序是由 `UserPromptSubmit` hook 注入這個回合的。
如果你看到迴圈說 **「no VERB INSTRUCTIONS block reached you」**，代表 hooks 沒有在跑
——重跑安裝腳本並重啟 session。

## 安裝

```bash
./install.sh qwen
```

這會建置共用的 MCP 伺服器、把指令／skills／references 以符號連結放進
`$QWEN_CONFIG_DIR`（預設 `~/.qwen`）、產生階段 agent，並把 hooks 與 MCP 伺服器項目
併入 `settings.json`。隨時可以重跑；它是冪等的。用 `./uninstall.sh qwen` 反向移除。

不帶參數執行 `./install.sh` 會偵測已安裝的宿主，並把 Qwen Code 與其他宿主一起列出。

**為什麼用安裝腳本而不是 `qwen extensions install`。** Qwen extension 無法攜帶 hooks
——`qwen-extension.json` 沒有 `hooks` 欄位——而那些防護 hook **就是**安全基座：
待辦清單變更防護、check 階段的 bash 白名單、worktree 釘選，以及可信裁決的提醒
全都在那裡。extension 安裝還會複製外掛目錄，讓它指向共用 MCP 伺服器的路徑立刻失效。
所以這個 repo 刻意不提供 extension manifest。

## 安裝腳本會寫入什麼

| 路徑 | 型態 | 原因 |
|---|---|---|
| `$QWEN_CONFIG_DIR/commands/agentic-workflow/*.md` | 符號連結 | 命名空間目錄正是產生 `/agentic-workflow:<name>` 的關鍵 |
| `$QWEN_CONFIG_DIR/skills/*` | 符號連結 | 共用的 skill 庫，加上 `workflow-orchestration` 的 Qwen 版本 |
| `$QWEN_CONFIG_DIR/references/*.md` | 符號連結 | 共用檢查清單 |
| `$QWEN_CONFIG_DIR/agents/*.md` | **複製** | 每一份都烘焙了 `model:`——見下文 |
| `$QWEN_CONFIG_DIR/settings.json` | **合併** | hooks 加上 `agentic-workflow` MCP 伺服器 |

`settings.json` 是你的檔案。安裝腳本只會取代 `agentic-workflow` 這個 MCP 伺服器鍵，
以及 `name` 以 `agentic-workflow` 開頭的 hooks，而 `./uninstall.sh qwen` 也只移除那些
——你自己加在同一個事件上的 hook 在安裝與解除安裝時都會保留。

## 這個宿主上的每階段模型是靜態的

這是與另外兩個宿主唯一的行為差異，在設定 `stageModels` 之前值得先知道。

OpenCode 在啟動時傳入設定的模型；Claude Code 把它傳給 Task 工具。
**Qwen 的 `agent` 工具根本沒有 model 參數。** 但 Qwen 的子代理確實支援頂層的
`model:` frontmatter 欄位，所以這個綁定從執行期移到了安裝期：`./install.sh qwen`
會解析 `workflows.<kind>.stageModels` 與 `agentModels`，把 `model:` 寫進每一份
產生的 agent 檔案。

後果是：**改動 `stageModels` 或 `agentModels` 會在下一次安裝時生效，而不是下一次
claim。** 編輯之後請重跑 `./install.sh qwen`。

還有一個值得說明的後果：如果某個 agent 在兩種 kind 裡支撐的階段被設定了**不同的**
模型，靜態綁定就無法表達——今天 `workflow-verify` 就在四種 kind 裡支撐階段。
安裝腳本會回報這個衝突，並讓該 agent 的模型保持未設定，而不是靜默採用最後載入的那份
manifest。

## 已知缺口

- **Azure DevOps 需要手動註冊其 MCP 伺服器**（若你略過 `./bootstrap.sh`）。
  註冊名稱必須剛好是 `azure-devops`——各階段提示詞以
  `mcp__azure-devops__<tool>` 的形式指名工具，換成別的名稱會讓每一次 ADO
  階段呼叫都指向一個不存在的工具。PAT 注入的缺口已不復存在：driver 會把
  憑證交給它自己啟動的伺服器，而階段 agent 使用的是你註冊的那一個。
- **沒有 `watch` 模式**，如上所述——這是宿主的特性，不是外掛的限制。

## 設定

與其他宿主相同：`.agentic-workflow.json` 疊在可選的使用者層
`~/.config/agentic-workflow/agentic-workflow.json` 之上。每個欄位都記錄在
[configuration.md](configuration.zh-TW.md)。
