[English](02-state-persistence.md) | 繁體中文

# 02 — 讓 WorkflowState 跨重啟持久化

## Context

迴圈狀態（loop state）目前只存在於記憶體中（`src/loop/state.ts:261`，一個以
sessionID 為鍵的 `Map`；README 將這列為已知限制）。唯一持久化的產出物是計畫
（`## Implementation Plan`，在把關點附加到任務檔案中）。若在 VERIFY 執行到
一半時當機或 opencode 重啟，階段、疊代次數和所有產出物（artifacts）都會
遺失——`/agent-loop recover <id>` 只能從已持久化的計畫在 BUILD 重新進入
（`resumeAtBuild`，`driver.ts:508-513`），捨棄已完成的工作內容，並把 token
浪費在重做已經跑過的階段上。

修法：每次狀態轉換（transition）後都把 `WorkflowState` 快照（snapshot）寫入
磁碟；`/agent-loop recover` 便能在完整保留產出物的情況下，精確地從中斷的
那個階段恢復。

## Design

`WorkflowState` 已經可以序列化為 JSON——每個欄位都是純粹的唯讀資料（`goal`、
`stage`、`iteration`、`paused`、`artifacts` 記錄，以及可選的 `task` / `git`
參照）。不需要變更結構描述（schema）。

### 新模組：`src/loop/persist.ts`（不純；`state.ts` 保持純函式）

```ts
/** Snapshot path: <directory>/<tasksDir>/runs/<id>.state.json */
export const statePath = (directory: string, tasksDir: string, id: string): string  // pure

export const saveState = async ($: Shell, directory: string, tasksDir: string, id: string, state: WorkflowState): Promise<void>
// mkdir -p runs/; write JSON.stringify(state, null, 2) — best-effort
// (warn, never fail the drive over a snapshot write)

export const loadState = async (client: Client, directory: string, tasksDir: string, id: string): Promise<WorkflowState | null>
// read + JSON.parse + zod-validate (schema below); null on absent/invalid
// (an invalid snapshot must degrade to the plan-based recovery, never throw)

export const clearState = async ($: Shell, directory: string, tasksDir: string, id: string): Promise<void>
// rm -f — best-effort
```

Zod 結構描述會完全鏡射 `WorkflowState`（階段列舉取自 `STAGES`，`artifacts` 為
`Partial<Record<Stage, string>>`，可選的 `task`/`git` 子物件——一旦計畫 01
落地，還會包含 `git.worktree`）。驗證就是信任邊界：快照存放在儲存庫的工作
目錄中，因此一份遭竄改或損毀的檔案必須直接失敗關閉（null → 回退到以計畫為
基礎的復原），而不是注入任意狀態。

### Driver hooks（`src/loop/driver.ts`）

- 在 `drive()` 的 fire 迴圈中，緊接在 `setLoop(sessionID, step.state)`
  （第 287 行）之後：`await saveState(..., loopId(step.state), step.state)`。
  階段後的 `advanceOnIdle` 結果在進入下一輪迴圈前也要做同樣的事。每次狀態
  轉換一份快照，以 `loopId`（任務 id 或 slug）為鍵。
- 在 `gate`（第 338 行）：同樣要做快照——目前若在暫停於執行中重新規劃
  把關點（iteration > 0）時重啟，會遺失所有東西。
- 在 `done` / `stop` / `onIdle` 的 catch：在既有的清理動作之後執行
  `clearState(...)`——終端狀態不需要快照；`done` 之後留下過期快照，會
  錯誤地宣稱該任務仍在執行中。
- 只有在 `state.task` 已設定時才做快照。暫存前的自由文字迴圈沒有持久化
  身分；它們目前在重啟時本來就會遺失狀態，而且計畫把關點終究會把它們
  暫存成一個任務。

### `/agent-loop recover <id>` 升級（`driver.ts:672-705`）

目前的流程會透過 `resumeAtBuild` 從 BUILD 重新進入。新流程：

1. 針對該 id 執行 `loadState(...)`。
2. 找到快照且 `snapshot.task?.id === id`：直接從快照恢復——
   `pending.set(sessionID, { kind: "recover-state", state: snapshot })`；
   當快照的階段原本正在執行中時，`onIdle` 處理常式會用 `firstStep(snapshot)`
   來驅動；若原本是暫停在把關點，則用 `resume(snapshot)`。從快照本身的
   產出物重新觸發該 `stage`（被中斷的那個階段會重跑；已完成的階段不會）。
   - 在恢復之前，從實際檔案系統重新讀取 `task.path`（自快照以來，檔案
     可能已被人為移動過）。
   - 搭配計畫 01：`snapshot.git.worktree` 會與 `ensureIsolation` 的重用
     路徑配對——復原會回到同一個 worktree 和分支。
3. 沒有快照或快照無效：維持今日的行為原樣（從已持久化的計畫執行
   `resumeAtBuild`）。既有的 `isRecoverable` / `wasInterrupted` 守衛，以及
   「檢查 git status/diff」的警告都保持不變。

### 啟動時的核對（`src/index.ts:49-60`）

除了中斷任務的警告之外，列出 `<tasksDir>/runs/` 中孤立的 `*.state.json`
檔案，並將它們納入記錄行——一份沒有對應存活迴圈的快照，是「這個任務在
執行中死掉了，請執行 /agent-loop recover」最強的訊號，比 BUILD 附註的
啟發式判斷還要可靠。

### Gitignore

把 `<tasksDir>/runs/*.state.json` 加入 `.gitignore`。快照是短暫的機器狀態
（不同於做為持久稽核紀錄的 `runs/*.md` 記錄檔）——提交快照會讓每次 drive
都產生大量無謂的異動，並把產出物洩漏進歷史紀錄中，而執行記錄檔本來就已經
刻意捕捉了這些內容。

## Edge cases

| Case | Behavior |
|---|---|
| 快照寫入失敗（磁碟、權限） | 發出警告並繼續——drive 不應該因為遙測（telemetry）寫入而失敗 |
| 快照是無效的 JSON / 未通過 zod 驗證 | `loadState` → null → 回退到以計畫為基礎的復原；並發出警告 |
| 快照建立後任務檔案被移動（人為將它移回 in-planning） | 路徑重新整理步驟；若任務已不在 `in-progress/` 中，復原會拒絕執行（與今日的 `findByIdIn` 守衛相同） |
| 快照存在，但有一個存活的迴圈正在驅動該任務 | 既有的 `findSessionDriving` 守衛會先觸發——行為不變 |
| 在階段執行到一半時重啟（該階段從未完成） | 快照保存的是該階段*觸發前（pre-fire）*的狀態 → 該階段會從自己的輸入重新執行；其未完成的部分輸出本來就不會被捕捉，這是正確的行為 |
| `done`/`stop` 之後留下的過期快照 | 會在終端事件時被清除；核對機制會標記出任何在清理過程中當機而倖存下來的快照 |

## Test plan（TDD）

新增 `src/loop/persist.test.ts`：
- `statePath` 的形狀（純函式）。
- 往返測試（round-trip）：`saveState` → `loadState` 應回傳與原始
  `WorkflowState` 深度相等的物件（使用暫存目錄 fixture）。
- `loadState` 在下列情況應回傳 null：檔案不存在、JSON 無效、違反結構描述
  （例如未知的階段、`iteration: "2"`）。
- `clearState` 會移除快照；在檔案不存在時是冪等的。

擴充 `src/loop/driver.test.ts`（或其測試工具）：有快照的復原會在保留產出物
的情況下，從快照的階段恢復（斷言被觸發的階段 + 組成的參數）；沒有快照的
復原則回退到 `resumeAtBuild`。

所有既有測試都不受影響（快照是附加性的；自由文字迴圈和沒有任務身分的
狀態永遠不會被快照）。

## Docs to update

- `README.md` — 軟化「僅存在於記憶體中」這條已知限制：對於任務驅動的
  迴圈，狀態現在能在重啟後存活；復原會從精確的階段恢復。
- `skills/workflow-orchestration/SKILL.md` — 復原章節：快照優先，計畫回退。
- `skills/task-backlog-management/SKILL.md` — 「識別中斷的迴圈」：
  `.state.json` 的存在訊號會加入 BUILD 附註的啟發式判斷之列。
- `docs/design/threat-model.md` — 註明快照在讀取時會經過 zod 驗證（屬於
  儲存庫內的檔案，失敗時會關閉/fail-closed）。
