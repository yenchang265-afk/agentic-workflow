# Agentic loop — engineering workflow improvement plans

**Status: all six plans below are implemented and tested** in the OpenCode
plugin (`src/`). They are kept as the design record for those features, not
as a pending backlog. The forward roadmap now lives in
[`../enterprise-adoption.md`](../enterprise-adoption.md) — the enterprise
gap analysis and phased improvement plan.

Sourced from: the current code (all cited paths and function names verified
against source at time of writing), the residual risks in
[`../threat-model.md`](../threat-model.md), and the documented limitations in
`README.md` / `skills/loop-orchestration/SKILL.md`.

## The plans (all shipped)

| # | Plan | What it bought | Where it lives now |
|---|------|----------------|--------------------|
| 01 | [Worktree isolation](./01-worktree-isolation.md) | Human's checkout never touched; safe concurrent watch sessions in one instance | `src/loop/git.ts`, `ensureIsolation` in `src/loop/driver.ts`, edit-guard in `src/index.ts`; `git.test.ts` |
| 02 | [State persistence](./02-state-persistence.md) | Crash/restart resumes at the exact stage with artifacts, not a re-plan | `src/loop/persist.ts`; `persist.test.ts` |
| 03 | [Ship + status commands](./03-ship-and-status-commands.md) | Audited `in-review → completed` move; backlog dashboard | `/agent-loop ship` + status in `src/loop/driver.ts`, `summarizeBacklog` in `src/task/store.ts`; `store.test.ts` |
| 04 | [Verdict quality](./04-verdict-quality.md) | Structured failure reasons feed re-builds; optional multi-lens review | `src/loop/verdict.ts`, `runStageWithLenses` in `src/loop/driver.ts`; `verdict.test.ts` |
| 05 | [Secret redaction](./05-secret-redaction.md) | Secrets scrubbed from durable artifacts before write | `src/loop/redact.ts`, wired in `src/task/store.ts`; `redact.test.ts` |
| 06 | [Run metrics](./06-run-metrics.md) | Per-run stage timings + verdict history in the run log | `src/loop/metrics.ts`; `metrics.test.ts` |

Residuals each plan explicitly deferred (bash worktree pinning, cross-process
`index.lock` races, metrics export, redaction knobs) are carried forward as
phase-3 items in [`../enterprise-adoption.md`](../enterprise-adoption.md).

## Conventions every plan follows

- **TDD**: each plan lists the failing tests to write first. The suite must
  stay green with all new config knobs unset (backward compatibility is a
  hard requirement — every feature here is opt-in or purely additive).
- **Purity boundary**: `src/loop/state.ts` and the predicate helpers in
  `src/task/store.ts` stay pure. Anything that touches the shell, clock, or
  filesystem lives in `driver.ts`, `git.ts`, `store.ts`'s IO half, or a new
  impure module.
- **Docs are part of done**: each plan ends with the exact docs to update
  (`README.md`, `.opencode/commands/agent-loop.md`,
  `skills/loop-orchestration/SKILL.md`,
  `skills/task-backlog-management/SKILL.md`, `docs/design/threat-model.md`)
  so the earlier `in-review`-style doc drift doesn't repeat.
