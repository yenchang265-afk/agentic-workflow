English | [繁體中文](README.zh-TW.md)

# Agentic loop — engineering workflow improvement plans

**Every plan here — 01–14 — is implemented and tested**, living in the shared
`@agentic-workflow/core` package (`packages/core/`) consumed by both the
OpenCode plugin and the Claude MCP server. They are kept as the design record
for those features, not as a pending backlog. Plans 10–13 shipped on
2026-08-02; plan 14 on 2026-08-03.

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
| 10 | [Replan-reason threading](./10-replan-reason-threading.md) | The plan gate's rejection reason reaches the next PLAN pass as a structured prompt section (parsed back off the audit note, retired automatically once a newer plan lands) instead of "dig through the audit notes"; multi-line reasons flattened to the single-line audit shape | `PLAN_REJECTED_MARKER`/`extractReplanReason` in `packages/core/src/task/store.ts`, `oneLineReason` in `workflow/gate.ts`, `replan` on `WorkflowState`, threading in `workflow/orchestrate.ts` + `workflow/engine.ts`, section in `workflows/engineering/stages/plan.md`; `store.test.ts`, `gate.test.ts`, `orchestrate.test.ts`, `engine.test.ts` |
| 11 | [Iteration budget in the stage prompts](./11-iteration-budget-prompts.md) | A re-fired BUILD is told "iteration N of M" and the final iteration is warned that a check failure now stops the loop for human re-planning; VERIFY's last pass is told its FAIL text is what the replan gate reads. `iterationCap` is the single resolution both the stop decision and the prompt use, so the two can never drift | `iterationCap` + the `iterations` context key in `packages/core/src/workflow/engine.ts`, sections in `workflows/engineering/stages/build.md`/`verify.md`; `engine.test.ts` |
| 12 | [The plan contract](./12-plan-contract.md) | PLAN's prompt mechanically carries the plan-structure contract (steps naming files, `### Verification` mapping each acceptance criterion to its proof, `### Out of Scope`), and the park gate refuses a plan with no Verification subsection — tolerant heading match, claim released, task stays queued | `planContract` on `StageDefSchema` (`manifest/schema.ts`), `planContractBlock`/`hasVerificationSection` in `workflow/verdict.ts`, compose branch in `workflow/engine.ts`, park veto in `workflow/terminal.ts`; `schema.test.ts`, `engine.test.ts`, `terminal.test.ts` |
| 13 | [Opt-in plan visualization](./13-plan-visualization.md) | With `workflows.<kind>.planVisualization: true`, PLAN's prompt asks for mermaid diagram(s) in the plan when the change's shape warrants it (state/lifecycle, cross-package flow, concurrency, data-shape) — agent-judged, never gate-enforced — and the hub's plan-review view renders the fence as a diagram in a sandboxed iframe, still commentable per block | `planVisualization` on `StageDefSchema` (`manifest/schema.ts`), `planVisualizationBlock` in `workflow/verdict.ts`, `planVisualizationFor` + config knob in `config.ts`, compose tail in `workflow/engine.ts`, `MermaidBlock.tsx`/`mermaid-embed.ts` in `packages/hub`; `schema.test.ts`, `config.test.ts`, `verdict.test.ts`, `engine.test.ts`, `mermaid-embed.test.ts` |
| 14 | [Symmetric stage context](./14-symmetric-stage-context.md) | The context plans 09–11 gave one stage now reaches its siblings: REVIEW sees what VERIFY established (the recorded verdict seam via the new `verdicts.<stage>` key, never the transcript) and gets the final-iteration warning; VERIFY sees the attempts ledger so a recurring failure reads as recurrence; a re-fired BUILD is pointed at its prior iterations' cumulative diff; the inlined check feedback and build summary carry data-not-instructions fences; plan.md drops its unrenderable worktree section | The `verdicts` context key in `packages/core/src/workflow/engine.ts`, sections + fences in `workflows/engineering/stages/*.md`, oracle mirrors + `PRIOR_WORK_SECTION`/`VERDICTS_SECTION` strips; `engine.test.ts` |

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
