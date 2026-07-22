English | [繁體中文](02-state-persistence.zh-TW.md)

# 02 — Persist LoopState across restarts

## Context

Loop state is in-memory only (`src/loop/state.ts:261`, a `Map` keyed by
sessionID; README lists this as a known limitation). The only durable
artifact is the plan (`## Implementation Plan` appended to the task file at
the gate). A crash or opencode restart mid-VERIFY loses the stage, iteration
count, and all artifacts — `/agent-loop recover <id>` can only re-enter at BUILD
from the persisted plan (`resumeAtBuild`, `driver.ts:508-513`), discarding
completed work context and burning tokens re-doing stages that already ran.

Fix: snapshot the `LoopState` to disk after every transition; `/agent-loop
recover` resumes at the exact stage with artifacts intact.

## Design

`LoopState` is already JSON-serializable — every field is plain readonly
data (`goal`, `stage`, `iteration`, `paused`, `artifacts` record,
optional `task` / `git` refs). No schema changes needed.

### New module: `src/loop/persist.ts` (impure; `state.ts` stays pure)

```ts
/** Snapshot path: <directory>/<tasksDir>/runs/<id>.state.json */
export const statePath = (directory: string, tasksDir: string, id: string): string  // pure

export const saveState = async ($: Shell, directory: string, tasksDir: string, id: string, state: LoopState): Promise<void>
// mkdir -p runs/; write JSON.stringify(state, null, 2) — best-effort
// (warn, never fail the drive over a snapshot write)

export const loadState = async (client: Client, directory: string, tasksDir: string, id: string): Promise<LoopState | null>
// read + JSON.parse + zod-validate (schema below); null on absent/invalid
// (an invalid snapshot must degrade to the plan-based recovery, never throw)

export const clearState = async ($: Shell, directory: string, tasksDir: string, id: string): Promise<void>
// rm -f — best-effort
```

Zod schema mirrors `LoopState` exactly (stages enum from `STAGES`,
`artifacts` as `Partial<Record<Stage, string>>`, optional `task`/`git`
sub-objects — including `git.worktree` once plan 01 lands). Validation is
the trust boundary: the snapshot lives in the repo working tree, so a
tampered/garbled file must fail closed (null → plan-based recovery), not
inject arbitrary state.

### Driver hooks (`src/loop/driver.ts`)

- In `drive()`'s fire loop, right after `setLoop(sessionID, step.state)`
  (line 287): `await saveState(..., loopId(step.state), step.state)`. Also
  after the post-stage `advanceOnIdle` result before looping. One snapshot
  per transition, keyed by `loopId` (task id or slug).
- On `gate` (line 338): snapshot too — a restart while paused at a
  mid-execution re-plan gate (iteration > 0) currently loses everything.
- On `done` / `stop` / the `onIdle` catch: `clearState(...)` after the
  existing cleanup — terminal states don't need snapshots; a stale snapshot
  after `done` would wrongly claim the task is mid-flight.
- Only snapshot when `state.task` is set. Free-text loops before parking
  have no durable identity; they already lose state on restart today and
  the plan gate parks them into a task anyway.

### `/agent-loop recover <id>` upgrade (`driver.ts:672-705`)

Current flow re-enters at BUILD via `resumeAtBuild`. New flow:

1. `loadState(...)` for the id.
2. Snapshot found and `snapshot.task?.id === id`: resume from it directly —
   `pending.set(sessionID, { kind: "recover-state", state: snapshot })`; the
   `onIdle` handler drives it with `firstStep(snapshot)` when the snapshot's
   stage was mid-fire, or `resume(snapshot)` when it was paused at a gate.
   Re-fire the snapshot's `stage` from its own artifacts (the stage that was
   interrupted re-runs; completed stages don't).
   - Refresh `task.path` from the live filesystem before resuming (the file
     may have been moved by a human since the snapshot).
   - With plan 01: `snapshot.git.worktree` pairs with `ensureIsolation`'s
     reuse path — recovery lands back in the same worktree and branch.
3. No/invalid snapshot: today's behavior verbatim (`resumeAtBuild` from the
   persisted plan). The existing `isRecoverable` / `wasInterrupted` guards
   and the "check git status/diff" warning stay as-is.

### Startup reconciliation (`src/index.ts:49-60`)

Alongside the interrupted-task warning, list orphaned `*.state.json` files
in `<tasksDir>/runs/` and include them in the log line — a snapshot with no
live loop is the strongest "this task died mid-flight, run /agent-loop recover"
signal, stronger than the BUILD-note heuristic.

### Gitignore

Add `<tasksDir>/runs/*.state.json` to `.gitignore`. Snapshots are ephemeral
machine state (unlike `runs/*.md` logs, which are the durable audit
record) — committing them would churn every drive and leak artifacts into
history that the run log already captures deliberately.

## Edge cases

| Case | Behavior |
|---|---|
| Snapshot write fails (disk, perms) | Warn and continue — the drive must not fail over telemetry |
| Snapshot invalid JSON / fails zod | `loadState` → null → plan-based recovery; warn |
| Task file moved after snapshot (human moved it back to in-planning) | Path refresh step; if the task is no longer in `in-progress/`, recovery refuses (same as today's `findByIdIn` guard) |
| Snapshot exists but a live loop is driving the task | Existing `findSessionDriving` guard fires first — unchanged |
| Restart mid-stage (stage never finished) | Snapshot has the *pre-fire* state for that stage → the stage re-runs from its inputs; its partial output was never captured, which is correct |
| Stale snapshot after `done`/`stop` | Cleared at terminal events; reconciliation flags any that survive a crash-during-cleanup |

## Test plan (TDD)

New `src/loop/persist.test.ts`:
- `statePath` shape (pure).
- Round-trip: `saveState` → `loadState` returns a deep-equal `LoopState`
  (temp dir fixture).
- `loadState` returns null on: missing file, invalid JSON, schema violation
  (e.g. unknown stage, `iteration: "2"`).
- `clearState` removes; idempotent on absent file.

Extend `src/loop/driver.test.ts` (or its harness): recover-with-snapshot
resumes at the snapshot's stage with artifacts (assert the fired stage +
composed args); recover-without-snapshot falls back to `resumeAtBuild`.

All existing tests unaffected (snapshots are additive; free-text loops and
task-less states never snapshot).

## Docs to update

- `README.md` — soften the "in-memory only" known limitation: state now
  survives restarts for task-driven loops; recovery resumes at the exact
  stage.
- `skills/workflow-orchestration/SKILL.md` — recovery section: snapshot-first,
  plan-fallback.
- `skills/task-backlog-management/SKILL.md` — "Identifying an interrupted
  loop": the `.state.json` presence signal joins the BUILD-note heuristics.
- `docs/design/threat-model.md` — note the snapshot is zod-validated on
  load (repo-resident file, fail-closed).
