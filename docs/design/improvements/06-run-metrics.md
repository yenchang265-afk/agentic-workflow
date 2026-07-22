English | [繁體中文](06-run-metrics.zh-TW.md)

# 06 — Per-run metrics in the run log

## Context

The run log (`<tasksDir>/runs/<id>.md`, `appendRunLog` in
`src/task/store.ts:192`) captures each stage's *output*, but nothing
captures the run's *shape*: how many iterations a task burned, how long
each stage took, what the verdict history was. After a few weeks of use
there is no way to answer "is the loop converging on the first iteration or
routinely burning the cap?", "which stage dominates wall-clock?", or "do
VERIFY FAILs outnumber REVIEW FAILs?" — the numbers that would tune
`maxIterations`, `stageTimeoutMinutes`, and the stage prompts.

## Design

### Driver-local accumulator (keep `state.ts` pure)

`WorkflowState` stays untouched — metrics are an impure driver concern, like
`recordedVerdicts`:

```ts
// src/loop/driver.ts (or a small src/loop/metrics.ts if it grows)
interface StageSample {
  readonly stage: Stage
  readonly iteration: number
  readonly ms: number
  readonly verdict?: Verdict | "none"   // check stages only
}
const runMetrics = new Map<string, StageSample[]>()  // keyed by sessionID
```

- In `drive()`'s fire loop: `const t0 = Date.now()` before `runStage`
  (line 292), push a sample after it (and after the verdict is taken for
  check stages, so the sample carries it). With plan 04's multi-lens
  review, one sample per lens pass with a `lens?` field.
- Cleared alongside `clearLoop` on `done`/`stop`/error — after rendering.

### Render on terminal events

On `done` and `stop` (and the `onIdle` catch), before clearing, append a
summary block via the existing `appendRunLog`:

```
## Run summary · <done|stopped: reason> · 2026-07-04T10:12:03Z

| # | stage  | iter | verdict | wall-clock |
|---|--------|------|---------|------------|
| 1 | plan   | 1    | —       | 2m 41s     |
| 2 | build  | 1    | —       | 11m 05s    |
| 3 | verify | 1    | FAIL    | 3m 12s     |
| 4 | plan   | 2    | —       | 1m 58s     |
| 5 | build  | 2    | —       | 6m 44s     |
| 6 | verify | 2    | PASS    | 3m 01s     |
| 7 | review | 2    | PASS    | 4m 19s     |

iterations used: 2/3 · total: 33m 00s · outcome: done (review passed)
```

Rendering is a pure function — `renderRunSummary(samples, outcome, config)`
— trivially table-testable.

### Scope discipline

Deliberately **not** in this plan: cross-run aggregation, dashboards,
metrics files in other formats. The run log is already the durable per-task
record; a summary block per run makes it greppable
(`grep -A20 "## Run summary" docs/tasks/runs/*.md`) and that is enough to
answer the motivating questions. Aggregate tooling can come later if the
greps get old — don't build it speculatively.

## Edge cases

- Stage throws (timeout) → no sample for the aborted stage, but the summary
  still renders on the error path with what was collected; outcome names
  the error.
- `/agent-loop stop` mid-stage → same: partial samples + `stopped` outcome.
- Restart mid-run loses the accumulator (in-memory) — acceptable; if plan
  02 is in, the recovered run's summary covers the post-recovery samples
  only and says so (`outcome: done (recovered run — pre-crash stages not
  timed)`). Do not persist metrics into the state snapshot; not worth the
  coupling.
- Free-text loop with no task: `loopId()` slug already routes the run log —
  works unchanged.

## Test plan (TDD)

- `renderRunSummary` (pure): table shapes for a clean 1-iteration pass, a
  re-plan run, an ERROR stop, an empty sample list (crash before any
  stage); duration formatting (sub-minute, hour+).
- Driver harness: after a driven done, the run log received a
  `## Run summary` append; samples carry verdicts for check stages;
  accumulator cleared after render (no leak across runs in one session).

## Docs to update

- `README.md` — mention the run-summary block in the audit/observability
  paragraph.
- `skills/workflow-orchestration/SKILL.md` — run-log section: what the summary
  contains, and the tuning loop it enables (`maxIterations` /
  `stageTimeoutMinutes` from observed numbers).
