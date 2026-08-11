English | [繁體中文](24-plan-gate-check-preview.zh-TW.md)

# 24 — The plan gates see what the plan actually buys

**Status: implemented.**

## The problem

Plan 18 made PLAN discover the project's check commands into an
`agentic-checks` fence, admitted at VERIFY fire time against the consuming
stage's own bash allowlist. The admission worked; its *visibility* did not. A
plan whose fence was malformed JSON, used the wrong info string, or listed
commands off the allowlist parked cleanly, was approved by a human who had no
way to know, and VERIFY then silently ran **zero checks** — the refusals went
to a `log("warn")` line nobody watches, and nothing in the task file, the run
log, or the metrics recorded that the plan's declared checks never ran. On
disk, "the plan promised checks that were all refused" was indistinguishable
from "the plan never declared any".

Three smaller gaps compounded it: `approvePlan` checked only `hasPlan`, so a
plan hand-edited in `plan-review/` (or moved there by `workflow_move`) entered
BUILD with no `### Verification` at all and nothing said so; and the
plan-author persona's section vocabulary (**Non-goals**, a freestanding
**Acceptance criteria**) collided with the composed contract's
(`### Verification`, `### Out of Scope`), leaving section naming to a per-plan
coin flip.

## What changed

- **A park-time forecast** (`previewDiscoveredChecks`,
  `packages/core/src/workflow/discovered-checks.ts`): a PURE preview of what
  `resolveStageChecks` will decide at fire time — same admission arguments,
  kept textually adjacent so the two cannot drift — computed in `runPark`
  (`workflow/terminal.ts`) and suffixed onto both the
  `Plan written — parked for plan review` audit note and the park message the
  hosts surface. The human reading the gate sees
  `discovered checks: N admitted for VERIFY`, `NONE admitted (…reasons…)`, or
  `no agentic-checks block`. Deliberately **no binary probe**: park runs in
  the main tree, VERIFY in a not-yet-created worktree, so a probe here would
  lie about the consumer's environment; and a park must never slow or fail on
  shell probes. `hasChecksFence` exists because the parser returns the same
  empty result for "no fence" and "valid empty block", and those mean opposite
  things to the human. Forecast only, never a veto — design 18's "no park-time
  enforcement; a plan without a block is valid" stands.
- **Fire-time ground truth** (both hosts' `runStageChecks`): the
  `ChecksSource` that `resolveStageChecks` always computed — and both hosts
  destructured away — now lands on the stage's metrics samples
  (`checksSource`, `checksRefused`; additive-v1 schema fields in
  `metrics-file.ts`), and, once per run, ONLY when the outcome would otherwise
  be silent (fence present but `source !== "discovered"`, or refusals), an
  audit note: `Discovered checks at VERIFY: N ran; …`. This is the record the
  preview forecasts — it includes the binary-probe drops the preview skips.
- **`approvePlan` re-checks the contract, warn-only** (`workflow/gate.ts`):
  missing `### Verification` and stacked `## Implementation Plan` headings ride
  the success message as `Note: …` and `data.caveats`. Warn, never refuse: the
  gate is kind-agnostic (`GateCtx` carries no manifest, so it cannot know
  whether the parked kind demands a contract), and a refusal would strand the
  task with no verb better than the `replan` the human just decided against.
- **One section vocabulary** (`prompts/agents/workflow-plan-author/body.md`,
  `skills/planning-and-task-breakdown/SKILL.md`): the persona and the skill
  now name `### Verification` / `### Out of Scope` verbatim — the contract's
  own words — instead of "Non-goals"/"Acceptance criteria" synonyms.

## What was deliberately not done

- No park-time *enforcement* of the fence, and no hardening of the tolerant
  `hasVerificationSection` regex — both are owned tradeoffs (18 and 12); the
  strict failure mode is a livelock burning one PLAN run per poll tick.
- No `resolvableChecks` probe in the preview (wrong environment, impure).
- No veto on stacked headings at park — `runPark`'s own comment explains the
  veto strands the task; the approve-gate caveat surfaces it instead.

## Where it lives

`previewDiscoveredChecks`/`hasChecksFence`/`discoveringStage` (moved here from
`engine.ts`, which re-exports it) in
`packages/core/src/workflow/discovered-checks.ts`; the forecast suffix in
`runPark` (`workflow/terminal.ts`); caveats in `approvePlan`
(`workflow/gate.ts`); `checksSource`/`checksRefused` on `StageSample`
(`workflow/metrics.ts`) + `MetricsSampleSchema` (`workflow/metrics-file.ts`);
host provenance in `plugins/opencode/src/workflow/driver.ts`
(`stageChecksInfo`) and `plugins/claude/mcp-server/src/server.ts`
(`checksInfo`). Tests: `discovered-checks.test.ts`, `terminal.test.ts`,
`gate.test.ts`, `metrics-file.test.ts`.
