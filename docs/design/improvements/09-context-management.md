English | [繁體中文](09-context-management.zh-TW.md)

# 09 — Context budgets for stage prompts

**Status: implemented.** A design record of shipped work, like plans 01–07; only
08 remains a backlog item.

Two things landed differently from the design below, both found while verifying
its anchors against the source:

1. **`extractPlan` had a second bug.** It used `body.indexOf(PLAN_HEADING)` — the
   *first* heading — and `rejectPlan` only appends a note while `appendPlan`
   appends a second `## Implementation Plan` at EOF, so a replanned task fed BUILD
   the **stale** plan on top of the audit tail. Same three-line function, fixed with
   the same change: read the last heading via `lastMarkerIndex`, stop at the first
   audit-note line. The note pattern requires `auditNote`'s bracketed stamp rather
   than matching any `> …` line, so a plan quoting a requirement as a blockquote is
   not truncated.
2. **The structured block had to move into core.** Both hosts fused
   `verdictFeedbackBlock` onto the prose *before* `advance` saw either string, so
   "only the prose is clamped" was unreachable by clamping `artifacts[stage]`.
   `advance` now takes the `VerdictRecord` and owns the fusion (byte-identical
   output), recording the seam in `WorkflowState.feedback`; `promptContext` clamps
   only the suffix. The exemption is an exact `startsWith` against that seam — not
   an embedded sentinel, which an agent's own prose could forge — and is itself
   capped at `EXEMPT_MAX` so it cannot swallow the budget. A seam that no longer
   matches clamps the artifact whole: lossy, never unbounded.

Also worth recording: applying the budget at render required threading `config`
through `composePrompt`/`fireAt`/`firstStep` (a trailing optional, so unset still
means unbounded) — the design assumed `promptContext` could resolve it locally,
but it receives only the state. And both `feedback` and `attempts` had to be
declared in `persist.ts`'s snapshot schema, which strips undeclared fields, or
`recover` would silently drop them.

## Context

Nothing in the system bounds what a stage prompt contains. There is no
truncation, no budget, and no summarization anywhere in `packages/core/src`, and
no config knob that limits context — `config.ts` carries `maxIterations` (:64),
`stageTimeoutMinutes` (:78), `worktreesDir` (:87) and `reviewLenses` (:95), and
nothing else that touches prompt size.

The stage prompt *templates* are tiny — 11 to 15 lines each
(`workflows/engineering/stages/*.md`). Everything of consequence is injected by
`promptContext` (`workflow/engine.ts:32-65`) out of `WorkflowState.artifacts`, a
`Record<string, string>` holding each completed stage's **entire captured
prose** (`state.ts:69`, written by `withArtifact` at `engine.ts:16-19`). That
prose is a full agent transcript: the driver joins every text part of the pass
(`driver.ts:681-685`) and threads it forward whole.

This was survivable while every stage ran on a frontier model. It stops being
survivable now that `StageDef.model` (`manifest/schema.ts:69`) and
`config.workflows.<kind>.stageModels` (`config.ts:119`, resolved by `modelFor`
at :279-280) explicitly invite pointing a stage at a smaller model. A
small-context model has less room, markedly worse long-context attention, and —
the part that matters for this design — cannot be trusted to curate its own
input. So every control proposed here is **driver-side and deterministic**.
"Instruct the agent to be concise" is not a control.

### What is actually wrong

| # | Defect | Evidence |
|---|--------|----------|
| 1 | **`extractPlan` leaks the whole audit tail.** It slices from `## Implementation Plan` to end-of-body — but `appendNote` appends audit blockquotes to end-of-file, and `appendPlan` puts the plan there too. Every `> CLAIMED`, `> BUILD started`, `> VERIFY verdict`, `> REVIEW verdict` note therefore lands *inside* the plan, and `artifacts.plan` accretes them across every iteration **and every prior run**. The plan block in the BUILD/VERIFY/REVIEW prompt grows monotonically and never resets. | `task/store.ts:114-118` vs `:726-732` and `:773-777` |
| 2 | **Multi-lens REVIEW multiplies its own artifact.** With `reviewLenses` set the stage fires once per lens and the artifact is `outputs.join("\n\n")` over all of them — up to five full review transcripts (`reviewLenses` is `.max(5)`), plus another pass whenever a verdict retry fires. All of it enters the next BUILD prompt. | `driver.ts:786`, `:824-825`, `:892`; `config.ts:95` |
| 3 | **The compact channel is drowned by the verbose one.** `verdictFeedbackBlock` already renders precisely what a re-build needs — verdict reason, failed criteria, blocking axis findings with `file:line` — in a handful of lines. The driver prepends it and then appends the entire transcript behind it. | `verdict.ts:261-280`; `driver.ts:1132-1133` |
| 4 | **No iteration memory.** On iteration *N* BUILD receives the plan and the *latest* check failure. It never receives what iteration *N−1* already tried: `build.md` does not reference `{{artifacts.build}}`, and `withArtifact` overwrites that key each pass anyway. Nothing prevents a model oscillating between two wrong fixes until the cap trips. | `workflows/engineering/stages/build.md`; `engine.ts:16-19` |
| 5 | **Prompt size is unobserved.** The sidecar already persists per-stage `input`/`output`/`reasoning`/`cacheRead`/`cacheWrite`, and the hub already computes a token-weighted cache-hit ratio per stage. Nothing records the size of the prompt the driver composed, so none of the growth above is visible in the Metrics tab. | `metrics.ts:34-52`, `metrics-file.ts:33-46`, `packages/hub/src/server/metrics/cache.ts` |

Defects 1 and 2 compound: they are both *monotone* in iteration count, so the
prompt is largest exactly when the loop is struggling and the model has the least
headroom to recover.

### Nothing is lost by trimming

The full text of every pass is already written verbatim to the durable run log
before it ever becomes an artifact (`appendRunLog`, `driver.ts:824`). The
artifact is a *prompt-assembly* copy, not the record of what happened. Clamping
it costs no evidence — the run log and `runs/<id>.metrics.json` remain complete.

This is also why the repo's own doctrine already condemns the current behavior:
`skills/context-engineering/SKILL.md:258` sets a target of "<2,000 lines of
focused context per task", and `:111` names pasting whole test output as the
wasteful case. No engineering stage agent invokes that skill — it is referenced
only from `spec-driven-development` and `using-agent-skills`.

## Design

### A pure clamp primitive

New `packages/core/src/workflow/budget.ts`. Pure, no deps — the purity boundary
[`README.md`](./README.md) states (`state.ts` and the `store.ts` predicates stay
pure; anything touching shell/clock/fs lives in the driver).

```ts
/** Marker left in place of elided text. Deliberately unmistakable: a clamped
 *  artifact must never read as a complete one to a model that will act on it. */
export const ELISION = (n: number): string => `\n\n[… ${n} characters elided by the stage context budget …]\n\n`

/**
 * Clamp `text` to roughly `limit` characters, preserving both head and tail.
 * `Infinity` (the default when nothing is configured) is the identity.
 *
 * Head AND tail, not a head truncate: a check stage opens with its verdict
 * rationale and closes with the concrete failing assertions, and a re-build
 * needs both ends. A plain head-slice reliably throws away the half that names
 * the failing file and line.
 */
export const clamp = (text: string, limit: number): string
```

Character-based, not token-based, and deliberately so: the core has no
tokenizer, tokenization is model-specific, and a byte budget is exact, testable,
and pure. The doc should say the ratio (~3.5–4 chars/token for English prose and
code) so operators can convert.

### Two layers, mirroring `model` / `stageModels`

`StageDef.model` already layers under `config.workflows.<kind>.stageModels.<stage>`.
Budgets take the identical shape — the symmetry is the argument for this over one
global knob, because the whole point is that stages differ.

**Manifest** — an optional field on `StageDefSchema` (`manifest/schema.ts:44-82`,
alongside `requiredAxes` at :77):

```ts
/**
 * Per-artifact character ceilings for this stage's composed prompt, keyed by
 * artifact name (`plan`, `build`, `verify`, `review`). Unset ⇒ unbounded.
 * A budget is a property of the CONSUMING stage — see "Apply at render".
 */
context: z.record(z.string(), z.number().int().positive()).optional(),
```

**Config** — `workflows.<kind>.stageContext.<stage>` overrides it, resolved by a
`contextFor(config, kind, def)` that mirrors `modelFor` (`config.ts:279-280`)
exactly, with an `unknownStageContextKeys` warning mirroring
`unknownStageModelKeys` (:289-290) so a typo'd stage name does not silently
resolve to "unbounded".

**Unset ⇒ unbounded ⇒ byte-identical to today.** This is the backward-compat
requirement from [`README.md`](./README.md) ("the suite must stay green with all
new config knobs unset"), and it is what makes the change safe to land: an
operator on frontier models sees nothing change; an operator pointing VERIFY at a
small model dials VERIFY down alone.

Ship recommended values in `docs/configuration.md` as a **small-context profile**,
not as defaults:

```jsonc
"workflows": {
  "engineering": {
    "stageModels": { "verify": "…/qwen-…" },
    "stageContext": {
      "build":  { "plan": 24000, "verify": 8000, "review": 8000 },
      "verify": { "plan": 16000, "build": 8000 },
      "review": { "plan": 16000, "build": 8000 }
    }
  }
}
```

### Apply at render, not at store

Clamping belongs in `promptContext` (`engine.ts:32-65`), **not** in
`withArtifact` (:16-19). A budget is a property of the consuming stage: BUILD can
afford a large plan while REVIEW wants the build summary trimmed hard, and the
same artifact is consumed by several stages with different needs.

There is a correctness reason too, not just a modelling one. `persist.ts:52`
snapshots `artifacts` as the resume state for `recover`. Clamping at store time
would persist the clamped text, so a recovered run would resume from a lossy
copy — and the loss would compound each time it was re-clamped.

### `extractPlan` stops at the audit tail

Defect 1 is a **bug fix, ungated by config**. Unbounded growth of `artifacts.plan`
across runs is wrong on any model; it is merely fatal on a small one.

The machinery already exists. `lastMarkerIndex` (`store.ts:69-79`) finds a marker
constrained to line starts, and `lifecycleWindow` (:81-84) is the established
precedent for "read only the current lifecycle window" — built for exactly this
class of problem. `extractPlan` should end its slice at the first audit-note line
following the heading rather than running to end-of-body.

Audit notes are whole lines written as `\n> …\n` (`store.ts:726-732`), which is
what makes this reliable; the same heuristic caveat `lastMarkerIndex` documents
(a pasted full audit line is indistinguishable) applies unchanged.

### The structured channel is never trimmed

At `driver.ts:1132-1133` the ordering is already right — `verdictFeedbackBlock`
first, prose second. The change is that **only the prose is subject to the
budget**. The structured block is bounded by construction (one line per failed
criterion, one per blocking finding) and is the highest-signal content in the
prompt, so it is exempt.

The consequence worth stating plainly: under a tight budget a re-build may
receive the structured findings and only an excerpt of the prose. That is the
intended trade. The findings carry `file:line`; the prose is commentary, and the
full text is in the run log.

### Iteration memory: a bounded attempts ledger

Add to `WorkflowState` (`state.ts:58-100`) a bounded `attempts` list — one short
entry per counted iteration: stage, effective verdict, and the one-line `reason`
already captured on the `VerdictRecord`. Render it into BUILD through a new
section in `workflows/engineering/stages/build.md`:

```
{{#attempts}}Previous attempts on this task (do not repeat a fix that already failed):
{{attempts.lines}}{{/attempts}}
```

Capped to the last K (K = 5 covers any realistic `maxIterations`), and dropped
entirely when empty — `renderPrompt` already drops sections that render to
nothing (`template.ts:66-70`), so a first-iteration prompt is unchanged.

This is the one item that *adds* to the prompt, and it should be defended on
those terms: a handful of lines that stop a weak model re-trying a fix it already
tried is a far better use of the window than the transcript those lines replace.
It also gives the iteration cap a diagnosis — today a capped run says only that
three iterations failed, not that all three tried the same thing.

### Observability: prompt size in the sidecar

Add optional `promptChars` to `StageSample` (`metrics.ts:34-52`) and
`MetricsSampleSchema` (`metrics-file.ts:33-46`) — optional matters, because
`parseRunMetrics` fails closed on a schema mismatch (`metrics-file.ts:76-85`) and
a required field would silently invalidate every existing sidecar. Record both
composed size and the elided count, so "the budget is biting" is distinguishable
from "the prompt is small".

Surface it per stage in the hub Metrics tab beside the existing cache-hit ratio
(`packages/hub/src/server/metrics/cache.ts`, `metrics/aggregate.ts`). Prompt
growth across iterations of one run is the signal that matters, and the tab's
unit of analysis is already the pass, which is the right unit for it.

Without this nobody can tell whether a budget helped, and the knob becomes
folklore.

### Scope discipline

Deliberately **not** in this plan:

- **Persona and skill size.** Measured, and it is the larger number: before any
  task content, PLAN loads AGENTS.md (14,289 B) + `workflow-plan-author`
  (12,463 B) + the skills its persona mandates — `workflow-orchestration`
  (29,293 B) and `task-backlog-management` (17,727 B) — roughly 74 KB of
  instruction before the task is mentioned. Reducing it is a prompt-architecture
  change with its own blast radius across both hosts and the generated
  `plugins/*/agents/*.md`. Separate plan.

  *That separate plan has since landed, in two parts.* PR #294 removed the
  mandated skill loads from the personas — a stage now carries a distilled method
  rather than pulling `workflow-orchestration` and `task-backlog-management`
  whole — and a later writing-for-agents pass moved the AGENTS.md invariants
  behind a path-keyed index (`docs/invariants/`), taking the always-loaded half
  from ~14 KB to ~4 KB.
- **Model-call summarization.** Compressing an artifact by asking a model to
  summarize it adds a failure mode, a latency cost, and a second weak-model
  dependency squarely on the path this plan exists to protect. Deterministic
  clamping only.
- **Cross-stage session reuse.** `runStage` fires every stage against one
  `sessionID` with `subtask: true` commands (`driver.ts:659-672`); changing that
  is a driver redesign, not a context budget.
- **Token-accurate budgets.** Needs a tokenizer in the core. Characters are
  exact and pure; document the conversion ratio instead.

## Edge cases

- **Nothing configured** → every limit is `Infinity` → `clamp` is the identity →
  the composed prompt is byte-identical to today. This gets an explicit test, the
  same way 08's gate-less path does.
- **A budget smaller than the elision marker.** Degrade to the marker alone
  rather than emitting a negative slice; the stage still gets the structured
  block, which is never trimmed.
- **Every artifact clamped to nothing.** The stage still receives goal,
  acceptance criteria, the worktree instructions, the diff boundary, and the
  contract block appended by `composeStagePrompt` (`engine.ts:81-86`). A budget
  can starve the *history*, never the contract.
- **Multi-lens REVIEW.** Lens outputs are concatenated before the artifact exists
  (`driver.ts:892`), so the budget applies to the concatenation. That is correct
  — the ceiling is on what BUILD reads, not on how many lenses ran — but it means
  a five-lens review under a tight budget will be heavily elided, which is the
  strongest argument for the structured block being exempt.
- **`extractPlan` on a legacy task** whose notes predate the fix: the fix reads
  the body, not history, so an old task's plan is cleaned up on its next claim.
- **A plan that legitimately contains a `>` blockquote line.** The slice would end
  early. Match the audit-note shape (`> …` at a line start, as `lastMarkerIndex`
  does) rather than any blockquote, and note the residual heuristic honestly —
  it is the same one `lifecycleWindow` already carries.

## Test plan (TDD)

- `workflow/budget.test.ts` (new): identity under the limit; identity at
  `Infinity`; over-limit preserves head and tail and carries the marker; the
  marker reports the true elided count; a limit below the marker length degrades
  sanely; clamping is idempotent.
- `task/store.test.ts`: **regression, fails today** — a body of
  `${PLAN_HEADING}` + plan text + `> CLAIMED …` + `> BUILD started …` +
  `> VERIFY verdict: FAIL …` returns only the plan text. Plus: notes with no
  plan, a plan with no notes (the existing `:119-121` case must still pass), and
  a plan containing a legitimate blockquote.
- `workflow/engine.test.ts`: `promptContext` clamps per the resolved stage
  budget; **byte-identical `composePrompt`** for a budget-less state; the
  `attempts` section is absent on iteration 0.
- `manifest/schema.test.ts`: `context` is optional and absent on all five shipped
  manifests; a non-positive limit is rejected.
- `config.test.ts`: `stageContext` beats the manifest's `context`;
  `unknownStageContextKeys` warns on a typo'd stage name — mirroring the existing
  `stageModels` cases.
- `workflow/metrics-file.test.ts`: a sidecar written before `promptChars` still
  parses (the fail-closed pin).
- Driver: the structured `verdictFeedbackBlock` survives intact when the prose
  budget clamps to zero.

## Docs to update

- `docs/configuration.md` (+ `.zh-TW`) — the `stageContext` knob, its layering
  over the manifest's `context`, and the small-context profile above.
- `skills/workflow-orchestration/SKILL.md` — the artifact contract: what a stage
  is guaranteed to receive, what may be elided, and that the run log is the
  complete record.
- `docs/workflows/engineering.md` (+ `.zh-TW`) — that a re-build receives the
  structured findings plus a bounded excerpt, and the attempts ledger.
- `packages/core/workflows/README.md` — the manifest `context` field.
- `docs/architecture.md` (+ `.zh-TW`) — `workflow/budget.ts` in the core's module
  map.
- `README.md` — one line, since context budgets are operator-visible behavior.

## Follow-ups this plan deliberately leaves open

1. **The stage agents do not invoke `context-engineering`** — and, having looked
   at it, they should not be made to. The skill states the doctrine this plan
   mechanizes (`SKILL.md:258`, `:111`) and the personas that would most benefit
   never load it, but *invoking the skill* is the wrong remedy on three counts.
   It is a prompt-only control, which the premise above (`"cannot be trusted to
   curate its own input"`) already rules insufficient — and its benefit is
   inversely correlated with its need, since the personas most starved for room
   are the ones on small models least able to act on a procedure. It costs
   10,769 B to fight the ~74 KB in item 2, and the repo's own rule is to follow
   an invoked skill exactly rather than partially, so it is not a cheap pointer.
   And most of it is unactionable at stage time: the frontmatter triggers on
   "starting a session … or configuring rules files", and Level 1 (author a
   rules file), the Brain Dump, and the Hierarchical Summary all address someone
   who owns the session and composes the prompt — a stage agent owns neither.

   What was actionable — Level 3 (`:88`, relevant source files) and Level 4
   (`:105`–`:111`, bounded error output) — is now inlined directly into
   `prompts/agents/workflow-build/body.md` and
   `prompts/agents/workflow-plan-author/body.md` as rules rather than a skill
   invocation: read narrowly, and quote the failing span rather than pasting the
   run. Rules survive on a small model where a procedure does not, and they cost
   870 B across the two personas instead of 10,769 B loaded into each.

   Two things this deliberately does not claim. It targets a *different* defect
   than the rest of this plan: the driver-composed artifacts clamped in
   `promptContext` are not what a wide `Read` sweep consumes — that is the
   agent's own tool-side budget, which no clamp reaches. And unlike the budget
   knob it ships with no observable (`promptChars` measures the composed prompt,
   not the agent's reads), so by this plan's own standard at "Observability" it
   is unmeasured. Both are reasons to keep it to inline rules and revisit under
   item 2, not reasons to expand it.
2. **Persona and mandatory-skill weight** (~74 KB before task content), above.
   **Since shipped** (PR #231, `eddcb3a`, `52a885e`): the unconditionally
   loaded skills were replaced with distilled inline rules in the stage
   personas — `incremental-implementation` + `test-driven-development` dropped
   from BUILD, `code-review-and-quality` from REVIEW (it loaded once *per
   fan-out pass*), the backlog/planning pair from the plan author — roughly
   100 KB of skill text no longer loaded per typical run, with a script test
   pinning the inlined severity ladder to the skill's vocabulary.
3. **`reviewLenses` has no context accounting.** Turning lenses on multiplies both
   cost and artifact size with no signal in the run summary that it did; the
   metrics work in this plan is the prerequisite for reporting it.
   **Since shipped** (PR #231, `91a6128`): the hub Metrics tab buckets prompt
   sizes per lens focus and carries a check fan-out panel
   (`packages/hub/src/server/metrics/fanout.ts`).
