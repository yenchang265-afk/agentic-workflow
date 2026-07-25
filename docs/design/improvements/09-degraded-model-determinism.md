English | [繁體中文](09-degraded-model-determinism.zh-TW.md)

# 09 — Determinism under a degraded model

**Status: partially shipped.** The four contract-surface fixes below are
implemented and tested. The determinism gaps in the last section are audited,
not built — they are the backlog this plan leaves behind, alongside
[08](./08-deterministic-gate-commands.md).

## Context

The loop's trust boundary is already narrow, and deliberately so. `advance()`
(`workflow/engine.ts:117-168`) picks the next stage purely from the manifest's
transition table; iteration accounting, task moves, commits, worktrees, PRs and
every work source are code. The model holds exactly one lever on control flow:
the `workflow_verdict` tool. Even that is derived, never trusted —
`effectiveVerdict` (`verdict.ts:120-121`) can only ever *worsen* what a stage
declared.

What that design also assumes is a model that (a) calls tools reliably, (b) fills
a five-element structured payload in one call, and (c) emits exact enum strings.
`stageModels` (`config.ts:279-280`) has always let you point a stage at a small
local model — and the moment you do, all three assumptions break:

| Degraded behaviour | What the loop did | Where |
|---|---|---|
| Never calls `workflow_verdict` | one free re-fire, then a synthetic `ERROR` → `onError` → **stop for a human, on every check stage** | `driver.ts:797-891`, `server.ts:842-887` |
| Sends the five axes across two calls | both rejected **and discarded** — `axisCoverageIssue` ran before the merge with `pending` | `verdict.ts:234-239` |
| Writes `severity: "nit"` | rejected by a zod enum — and a weak model abandons a rejected call rather than repairing it | `impl.ts:456`, `server.ts:672` |
| Writes `WORKFLOW_VERIFY: PASS` in prose | parsed, logged, discarded | `verdict.ts:356-365` |

The first line is the one that matters: the loop does not degrade, it stops. And
the third is self-inflicted — the REVIEW agent is *instructed* to invoke the
`code-review-and-quality` skill (`prompts/agents/workflow-review/body.md:14`),
whose own table teaches Critical / Nit / Optional / Consider / FYI. An agent
obeying its instructions emitted severities its own tool rejected.

Nothing here is about making a weak model review well. It is about the loop
surviving a weak model's *shape*, so the verdict it does reach is acted on
instead of thrown away.

## Design

### 1. A second verdict channel, gated by a nonce

The rule `verdict.ts:7-12` protects is that **text the model did not author**
— a README, a diff hunk, a quoted transcript — must never flip control flow. A
nonce separates that case from the one we want to allow.

New `workflow/verdict-block.ts`, pure and total:

```ts
export const VERDICT_BLOCK_FENCE = "workflow_verdict"
export const VerdictPayloadSchema = z.object({ stage, verdict, reason?, criteria?, axes? })
export const verdictBlockContract = (stage: string, nonce: string): string
export const parseVerdictBlock = (text: string, stage: string, nonce: string): VerdictRecord | null
export const redactNonce = (text: string, nonce: string): string
```

Config, mirroring the `codePlatform` global+per-kind shape (`config.ts:115/130`)
rather than `stageModels`' per-stage one — the setting travels with a *kind*
whose check stages were pointed at a weak model:

```ts
verdictChannel: z.enum(["tool", "tool+block"]).default("tool")   // + workflows.<kind>.verdictChannel
```

resolved by `verdictChannelFor` / `blockChannelEnabled` next to `modelFor`.

Not shell-bearing, so `SHELL_BEARING_KEYS` (`config.ts:494`) and the repo-layer
drop are untouched. Worth stating because every previous config addition had to
justify itself against that rule.

**Four properties carry the security argument, and all four are load-bearing:**

1. the nonce must match, and it is minted **per attempt** — a re-fire cannot be
   satisfied by the previous attempt's block, still sitting in the transcript;
2. the `stage` must match, mirroring the tool's own stage check;
3. only the **last** matching block counts, so self-correction reads the way
   repeat tool calls already do;
4. the tool always wins — the block is read only when nothing was recorded.

**The one new residual is nonce leakage.** A nonce is a bearer token, so it must
not reach anything a later stage can read: `redactNonce` scrubs it from the run
log and from the stage artifact threaded into the next prompt, and both hosts
clear it when the stage ends. Any *new* durable sink of stage output has to be
pinned against this — it is the failure mode that would quietly convert a
later stage into a forger for an earlier one.

**Prompt surface.** `promptContext` emits `verdict: { nonce }` from a new
optional `WorkflowState.verdictNonce`, and `composeStagePrompt` appends
`verdictBlockContract(...)` after the tool contract — only when a nonce is
present, so an unarmed loop's prompt is **byte-identical** to before. The engine
stays pure; the nonce is minted host-side (`randomUUID`), on the same purity
boundary `git.ts`/`isolate.ts` sit across.

**Fire path.** The nonce must be armed where the stage is fired, not where
`advance()` composed eagerly:

- **Claude** — one `firePrompt(loaded, state, stage)` helper arms and composes;
  all four fire sites route through it. `workflow_compose` deliberately does
  **not**: it is an idempotent read and must reuse the armed nonce, never mint
  one the loop will then refuse. A source-level test pins that only
  `firePrompt`'s own body and `workflow_compose` may call `composePrompt`.
- **OpenCode** — `advance()` already built `args` eagerly and a lens pass has
  augmented it, so the contract is appended at the fire boundary instead of
  recomposed. The text is identical to what `composeStagePrompt` produces.

### 2. Axis coverage accumulates across calls

`admitVerdict` checked coverage on `incoming`, then merged with `pending`.
Inverted: merge first, judge the merged record.

The rejected axes have to survive, and where they survive is the whole design.
They must **not** go into `pending` — that is the admitted record, and a rejected
call was never admitted (the property pinned at `driver.test.ts:1514-1521`). So
the rejection branch carries them out instead:

```ts
| { readonly ok: false; readonly message: string; readonly partialAxes: readonly AxisResult[] }
```

and hosts hold them in a slot beside `pending` (`partialAxes` map / module-level
`pendingPartialAxes`), threading them back in as `admitVerdict`'s fourth
argument. Default `[]` keeps every existing call site behaving exactly as before.

**Only the axes are carried, never the rejected call's verdict** — and this is
the non-obvious part. Carrying the verdict deadlocks: a FAIL rejected for naming
no blocking finding would be merged worst-wins into every later call, so the
model could never recover by recording a clean PASS. Axes alone lose nothing,
because `effectiveVerdict` already derives FAIL from any critical/important
finding regardless of what was declared. `blockingFindingsIssue` rejections
therefore carry the *previous* partials forward, not the merged ones.

Unconditional, not behind a knob: it is strictly better on every model, and
worst-wins merging means it cannot launder a FAIL into a PASS.

### 3. Severity is normalized, not rejected

`normalizeSeverity` in `verdict.ts` maps the synonyms a model actually emits —
including the ones the `code-review-and-quality` skill teaches — onto the
enforced three, case-, space- and punctuation-insensitively. `normalizeRecord`
applies it across a record; `admitVerdict` calls it, so a host cannot forget.
Both tool schemas loosen `severity` from `z.enum` to `z.string()`, keeping the
canonical three in `.describe()`.

**An unrecognized word becomes `important`, not `suggestion`** — fail closed. A
severity nobody planned for is likelier a real objection than a nit, and the cost
of being wrong is one build iteration rather than a shipped defect.

The skill's own table now carries a **Machine severity** column, so the two
vocabularies stop contradicting each other at the source rather than only being
patched up at the boundary.

### 4. The retry budget is configurable

Both hosts hardcoded exactly one free re-fire (`driver.ts:801` `attempt < 2`;
`server.ts:135` a boolean). Now `verdictRetries` (default `1` — today's
behavior exactly, max `5`, `0` to stop on first silence). These re-fires still
consume no loop iteration, and a work stage never burns one.

## Edge cases

- **Every knob unset** → no nonce, no block paragraph, `verdictRetries: 1`,
  `partialAxes: []` → behavior and composed prompts identical to before. This is
  the hard backward-compatibility requirement from [README](./README.md), and it
  has a byte-identical-prompt test per stage.
- **An empty-string nonce** is treated as unarmed, not as a nonce nothing can
  match — otherwise a bug that blanked it would silently disable the channel
  while the prompt still advertised it.
- **A block whose JSON is malformed, whose payload fails the schema, or whose
  fence is ` ```json `** → ignored, never a throw. `parseVerdictBlock` is total.
- **`workflow_compose` called twice** → same prompt, same nonce; it never re-arms.
- **Multi-lens REVIEW** → each lens pass is its own attempt and gets its own
  nonce. Lens mode still suppresses per-pass axis enforcement, so accumulation
  is inert there.
- **A gate-less kind (every sitter)** → no `requiredAxes`, so accumulation is a
  no-op and only the severity normalization applies.

## What shipped where

| Change | Core | Hosts |
|---|---|---|
| Nonce-fenced block channel | `workflow/verdict-block.ts`, `engine.ts`, `state.ts`, `config.ts` | `driver.ts` fire loop; `server.ts` `firePrompt` + `workflow_advance` |
| Axis accumulation | `verdict.ts` `admitVerdict` / `VerdictAdmission` | `partialAxes` map; `pendingPartialAxes` |
| Severity normalization | `verdict.ts` `normalizeSeverity` / `normalizeRecord` | loosened tool schemas in `impl.ts`, `server.ts` |
| Configurable retries | `config.ts` `verdictRetries` | both retry loops |

Tests: `verdict.test.ts`, `verdict-block.test.ts` (new), `engine.test.ts`,
`config.test.ts`, `driver.test.ts`, `server.test.ts`.
Docs: `docs/configuration.md` (*Running check stages on a weaker model*),
`skills/workflow-orchestration/SKILL.md`, `docs/design/threat-model.md` (T1),
`skills/code-review-and-quality/SKILL.md`, and the two regenerated agent bodies.

## What this deliberately does not buy

A weak model still has to *do* the review. These changes stop the loop stalling
on a broken verdict channel; they do not make a shallow verdict deep. Five empty
PASS axes satisfy the check on any model — `requiredAxes` was always a
completeness check, not an honesty check (`verdict.ts:55-59`), and nothing here
changes that.

## Follow-ups this plan leaves open

Audited in the same pass, each independent of the above and of
[08](./08-deterministic-gate-commands.md). They share one theme: **the loop asks
a model for facts it either already holds or could compute.** Every one of them
is a place where a degraded model's answer is worse than no question at all.

1. **VERIFY self-reports whether the tests passed.** The largest remaining gap,
   and exactly what [08](./08-deterministic-gate-commands.md) proposes: declare
   the gate commands, run them driver-side, and let their exit codes bind the
   verdict. Until then a weak model both picks the commands (from an 88-glob
   allowlist, `workflows/engineering/workflow.json:54-143`) and reports the
   result.
2. **Sitter check stages re-decide what the work source already computed.**
   `attentionTriggers` (`source/ledger.ts:104-128`) and `upgradeCandidates`
   (`source/dependency-scan.ts:131-162`) *gate* the claim, so by the time
   `pr-sitter/stages/triage.md:7` asks "PASS when there is actionable work", the
   answer is true by construction. Prompt-only fix: narrow the question from
   *whether* there is work to *whether a listed fact has gone stale*.
3. **Undefined thresholds gate control flow.** `review-sitter/stages/fetch.md`
   measures `gh pr diff <n> | wc -l` and never compares it to anything — the
   FAIL condition is the adjective "unreviewably large". Declare the number.
4. **Prompts delegate to skills by name and hope.** `workflow-build/body.md:11`,
   `workflow-review/body.md:14`, `workflow-verify/body.md:35` name skills the
   model must choose to invoke; nothing detects a skip. A manifest `skills: []`
   field rendered into the composed prompt would make it deterministic.
5. **`workflow-plan-author` routes itself between three modes** in one 251-line
   prompt (`new` / `retask` / `task`, different write targets each). Mode
   selection is a caller fact, so it should be code — three prompts, or one
   selected by the manifest — not inference.
6. **Sitters must re-derive commands they were never told.** dep-sitter infers
   the ecosystem (`npm ls` vs `mvn dependency:tree` vs `./gradlew
   dependencyInsight`); main-sitter re-derives "the failing workflow's command"
   in VERIFY that `diagnose` already found. Carry it as a structured artifact.
7. **No degraded-model test harness.** The unit suites stub the transport, not a
   model, and both e2e scripts make real LLM calls. A scripted fake model that
   never calls tools / sends partial axes / uses skill vocabulary would pin every
   behavior above end-to-end instead of per-unit.
