# Agentic loop — engineering workflow improvement plans

**Status: all seven plans below are implemented and tested**, now living in
the shared `@agentic-loop/core` package (`packages/core/`) consumed by both
the OpenCode plugin and the Claude MCP server. They are kept as the design
record for those features, not as a pending backlog.

Sourced from: the current code (all cited paths and function names verified
against source at time of writing), the residual risks in
[`../threat-model.md`](../threat-model.md), and the documented limitations in
`README.md` / `skills/loop-orchestration/SKILL.md`.

## The plans (all shipped)

| # | Plan | What it bought | Where it lives now |
|---|------|----------------|--------------------|
| 01 | [Worktree isolation](./01-worktree-isolation.md) | Human's checkout never touched; safe concurrent watch sessions in one instance | `packages/core/src/loop/git.ts`, `ensureIsolation` in `packages/core/src/loop/isolate.ts`, edit-guard in `src/index.ts`; `git.test.ts` |
| 02 | [State persistence](./02-state-persistence.md) | Crash/restart resumes at the exact stage with artifacts, not a re-plan | `packages/core/src/loop/persist.ts`; `persist.test.ts` |
| 03 | [Ship + status commands](./03-ship-and-status-commands.md) | Audited `in-review → completed` move; backlog dashboard | `/agent-loop ship` + status in `src/loop/driver.ts`, `summarizeBacklog` in `packages/core/src/task/store.ts`; `store.test.ts` |
| 04 | [Verdict quality](./04-verdict-quality.md) | Structured failure reasons feed re-builds; optional multi-lens review | `packages/core/src/loop/verdict.ts`; `verdict.test.ts` |
| 05 | [Secret redaction](./05-secret-redaction.md) | Secrets scrubbed from durable artifacts before write | `packages/core/src/task/redact.ts`, wired in `packages/core/src/task/store.ts`; `redact.test.ts` |
| 06 | [Run metrics](./06-run-metrics.md) | Per-run stage timings + verdict history in the run log | `packages/core/src/loop/metrics.ts`; `metrics.test.ts` |
| 07 | [Multi-loop scheduler](./07-multi-loop-scheduler.md) | One scheduler drives many loop kinds (engineering + PR sitter); `@agentic-loop/core` extracted so both plugins share one implementation | `packages/core/src/manifest/` (schema, registry, template), `packages/core/src/scheduler/` (scheduler, lease), `packages/core/src/source/` (backlog, github-pr, ado-pr, ledger); `loops/engineering/`, `loops/pr-sitter/` |

Residuals each plan explicitly deferred (bash worktree pinning, cross-process
`index.lock` races, metrics export, redaction knobs) remain open — see
[`../threat-model.md`](../threat-model.md) for the current residual risks.

## Conventions every plan follows

- **TDD**: each plan lists the failing tests to write first. The suite must
  stay green with all new config knobs unset (backward compatibility is a
  hard requirement — every feature here is opt-in or purely additive).
- **Purity boundary**: `packages/core/src/loop/state.ts` and the predicate
  helpers in `packages/core/src/task/store.ts` stay pure. Anything that
  touches the shell, clock, or filesystem lives in `driver.ts`, `git.ts`,
  `store.ts`'s IO half, or a new impure module.
- **Docs are part of done**: each plan ends with the exact docs to update
  (`README.md`, `.opencode/commands/agent-loop.md`,
  `skills/loop-orchestration/SKILL.md`,
  `skills/task-backlog-management/SKILL.md`, `docs/design/threat-model.md`)
  so the earlier `in-review`-style doc drift doesn't repeat.
