English | [繁體中文](README.zh-TW.md)

# Agentic loop — engineering workflow improvement plans

**Every plan here — 01–09 — is implemented and tested**, living in the shared
`@agentic-workflow/core` package (`packages/core/`) consumed by both the
OpenCode plugin and the Claude MCP server. They are kept as the design record
for those features, not as a pending backlog. Plan 08 was the last one
outstanding and shipped on 2026-07-29.

Sourced from: the current code (all cited paths and function names verified
against source at time of writing), the residual risks in
[`../threat-model.md`](../threat-model.md), and the documented limitations in
`README.md` / `skills/workflow-orchestration/SKILL.md`.

## The plans (all shipped)

| # | Plan | What it bought | Where it lives now |
|---|------|----------------|--------------------|
| 01 | [Worktree isolation](./01-worktree-isolation.md) | Human's checkout never touched; safe concurrent watch sessions in one instance | `packages/core/src/workflow/git.ts`, `ensureIsolation` in `packages/core/src/workflow/isolate.ts`, edit-guard in `plugins/opencode/src/index.ts`; `git.test.ts` |
| 02 | [State persistence](./02-state-persistence.md) | Crash/restart resumes at the exact stage with artifacts, not a re-plan | `packages/core/src/workflow/persist.ts`; `persist.test.ts` |
| 03 | [Ship + status commands](./03-ship-and-status-commands.md) | Audited `in-review → completed` move; backlog dashboard | `/agent-loop ship` + status in `plugins/opencode/src/workflow/driver.ts`, `summarizeBacklog` in `packages/core/src/task/store.ts`; `store.test.ts` |
| 04 | [Verdict quality](./04-verdict-quality.md) | Structured failure reasons feed re-builds; optional multi-lens review | `packages/core/src/workflow/verdict.ts`; `verdict.test.ts` |
| 05 | [Secret redaction](./05-secret-redaction.md) | Secrets scrubbed from durable artifacts before write | `packages/core/src/task/redact.ts`, wired in `packages/core/src/task/store.ts`; `redact.test.ts` |
| 06 | [Run metrics](./06-run-metrics.md) | Per-run stage timings + verdict history in the run log | `packages/core/src/workflow/metrics.ts`; `metrics.test.ts` |
| 07 | [Multi-workflow kinds on a common scheduler](./07-multi-workflow-scheduler.md) | One scheduler drives many workflow kinds (engineering + PR sitter); `@agentic-workflow/core` extracted so both plugins share one implementation | `packages/core/src/manifest/` (schema, registry, template), `packages/core/src/scheduler/` (scheduler, lease), `packages/core/src/source/` (backlog, github-pr, ado-pr, ledger); `workflows/engineering/`, `workflows/pr-sitter/` |
| 08 | [Deterministic check commands](./08-deterministic-gate-commands.md) | Declared test/typecheck/lint commands run driver-side; their exit codes are established fact for the check stage and floor its verdict, replacing the self-reported "tests are green" | `packages/core/src/workflow/checks.ts`, `checks` on `StageDefSchema` in `manifest/schema.ts`, `stageChecks`/`checksFor`/`unknownStageCheckKeys` in `config.ts` (and `SHELL_BEARING_WORKFLOW_KEYS`), `withCheckResults` in `workflow/engine.ts`, the fire-boundary run + finalization floor in both hosts; `checks.test.ts` |
| 09 | [Context budgets for stage prompts](./09-context-management.md) | Prompts stop growing monotonically across iterations: the plan artifact no longer accretes audit notes (nor serves a stale plan after a replan), per-stage character ceilings clamp what a stage reads while never trimming the structured verdict block or the stage contract, a bounded attempts ledger stops a weak model re-trying a fix that already failed, and prompt size is visible per stage in the hub | `packages/core/src/workflow/budget.ts`, `contextFor`/`unknownStageContextKeys` in `config.ts`, `extractPlan` in `task/store.ts`, the seam + ledger in `workflow/engine.ts`, `promptSize` in `packages/hub/src/server/metrics/prompt.ts`; `budget.test.ts` |

Residuals still open: cross-process `index.lock` races and redaction knobs. (Two
entries this list used to carry have since shipped — bash worktree pinning in
`packages/core/src/workflow/worktree-guard.ts`, and metrics export in
`workflow/metrics-file.ts` plus `packages/hub/src/server/metrics/`.) Plan 09 left
persona/skill weight, model-call summarization, and token-accurate budgets
explicitly out of scope. See [`../threat-model.md`](../threat-model.md) for the
current residual risks.

## Conventions every plan follows

- **TDD**: each plan lists the failing tests to write first. The suite must
  stay green with all new config knobs unset (backward compatibility is a
  hard requirement — every feature here is opt-in or purely additive).
- **Purity boundary**: `packages/core/src/workflow/state.ts` and the predicate
  helpers in `packages/core/src/task/store.ts` stay pure. Anything that
  touches the shell, clock, or filesystem lives in `driver.ts`, `git.ts`,
  `store.ts`'s IO half, or a new impure module.
- **Docs are part of done**: each plan ends with the exact docs to update
  (`README.md`, `.opencode/commands/agent-loop.md`,
  `skills/workflow-orchestration/SKILL.md`,
  `skills/task-backlog-management/SKILL.md`, `docs/design/threat-model.md`)
  so the earlier `in-review`-style doc drift doesn't repeat.
