# 04 — Verdict quality: structured reasons + multi-lens review

Two independent features; implement in order (A is small and B builds on
nothing from A, but A sharpens the feedback loop B exercises harder).

## A. Structured verdict reasons

### Context

`loop_verdict` (`src/index.ts:95-111`) records only
`stage + PASS/FAIL/ERROR`. The *reasons* live in the stage's free text,
which `composeArgs` (`state.ts:122`) threads into the next iteration as a
raw prose blob (`Verify failure to address:` / `Review feedback to
address:`). The re-planning agent has to re-parse prose to find what
actually failed, and the audit note (`driver.ts:324-331`) records only the
verdict letter — a FAIL in the audit trail says nothing about *which*
acceptance criterion failed.

### Design

Extend the tool schema (`src/index.ts`) with optional structured fields:

```ts
args: {
  stage: tool.schema.enum(["verify", "review"]),
  verdict: tool.schema.enum(["PASS", "FAIL", "ERROR"]),
  reason: tool.schema.string().max(500).optional()
    .describe("One-sentence summary of why — required in spirit for FAIL/ERROR."),
  criteria: tool.schema.array(tool.schema.object({
    criterion: tool.schema.string(),
    pass: tool.schema.boolean(),
  })).optional()
    .describe("Per-acceptance-criterion results, mirroring the criteria threaded into the stage prompt."),
}
```

Carry them through:

- `recordVerdict` / `recordedVerdicts` (`driver.ts:141-157`): store
  `{ stage, verdict, reason?, criteria? }`; `takeVerdict` returns the full
  record. Type it as `VerdictRecord` in `verdict.ts` (pure home for the
  type).
- Audit note (`driver.ts:326-330`): append reason + failed-criteria count —
  `VERIFY verdict: FAIL — 2/4 criteria unmet: "returns 429 over limit", … (iteration 2)`.
  Keep it on one line (the note format is grep-matched by suffix, per
  `auditNote`'s contract — text first, timestamp suffix last).
- Threading: `LoopState.artifacts` stays `string` (keep the state machine
  simple). Instead, the driver prepends a structured block to the check
  stage's output *before* `advanceOnIdle` stores it as the artifact:

  ```
  FAILED CRITERIA (from loop_verdict):
  - returns 429 over the limit
  - limit configurable per route

  <stage's free text>
  ```

  `composeArgs` needs no change; the re-plan/re-build prompt now leads with
  the machine-recorded failures instead of burying them in prose. (Driver
  change only — `state.ts` untouched, purity preserved.)

Trust note: `reason`/`criteria` come through the same authoritative tool
call as the verdict itself — same trust level, no new channel. They steer
*prompt content* for the next iteration, not control flow; control flow
remains `verdict` alone.

- Update `.opencode/agents/verify.md` / `review.md` verdict-contract
  sections: pass `criteria` mirroring the acceptance criteria you were
  given; always pass `reason` on FAIL/ERROR.

### Tests

- Tool-arg validation (zod accepts/rejects shapes) — extend the existing
  tool tests if present, else driver harness.
- `recordVerdict` stores + `takeVerdict` returns the full record; wrong
  stage/session still ignored.
- Driver: FAIL with criteria → next stage's composed args contain the
  `FAILED CRITERIA` block; PASS → no block.
- Audit note renders reason + counts, suffix format intact
  (`auditNote` greps still match).

## B. Multi-lens review

### Context

REVIEW is one agent, one pass. Threat model T1's residual: repo-content
prompt injection persuading *that one agent* to call `loop_verdict` PASS.
The current backstops are the iteration cap and the human diff gate. N
independent review passes with distinct lenses make a single injection much
less likely to flip the outcome — diverse perspectives also catch different
real defect classes (the reason `references/orchestration-patterns.md`
recommends perspective-diverse verification).

### Design

- Config (`src/config.ts` + `Config` in `state.ts`):

  ```ts
  /** Extra review lenses; each runs REVIEW once more with that focus. Unset/[] → single review (today). */
  reviewLenses: z.array(z.string().min(1)).max(5).default([]),
  ```

  Suggested doc example: `["correctness", "security", "test-adequacy"]`.

- Driver (`drive()`, inside the fire loop where `stage === "review"`): when
  lenses are configured, run the review stage **N times sequentially** in
  the same session (parallel sessions are ruled out by the same SDK finding
  as plan 01 — the verdict tool lives in this instance):

  1. Pass k appends to the composed args:
     `Review lens ${k}/${N}: focus exclusively on ${lens}. Other lenses are covered by separate passes.`
  2. After each pass, `takeVerdict(sessionID, "review")`; clear
     `recordedVerdicts` between passes (the existing per-stage clear at
     `driver.ts:291` moves into the per-pass loop).
  3. **Combined verdict = worst of N** (`ERROR` > `FAIL` > `PASS`
     precedence: any ERROR stops the loop; else any FAIL fails; else PASS).
     Missing verdict on any pass = FAIL for that pass, as today.
  4. Audit note per pass (`REVIEW verdict (lens: security): PASS …`) plus a
     combined note; run log gets each pass's output (the existing
     `appendRunLog` call runs per pass with the lens in the header).
  5. The stored review artifact = concatenation of failing passes' outputs
     (structured-reasons block from feature A included), so the re-build
     prompt sees every lens's objections.

- Cost is explicit and documented: N× review tokens/wall-clock per
  iteration. The stage timeout applies **per pass** (each pass is one
  `runStage` call — no timeout math changes).

- Keep `state.ts` untouched: lenses are a driver-level expansion of one
  logical review stage. `advanceOnIdle` still sees a single review
  completion with the combined verdict. This keeps the pure state machine's
  contract ("review completed with verdict V") intact.

### Edge cases

- A lens pass times out → that pass throws, the loop errors (same as a
  review timeout today). Simpler and safer than partial-lens verdicts.
- `/loop stop` between passes → the existing `!getLoop(sessionID)` check
  (`driver.ts:304`) runs per pass; add it to the lens loop.
- `reviewLenses` set but `maxIterations` reached — unchanged interaction;
  lenses change verdict quality, not iteration accounting.

### Tests

- Pure combined-verdict function (`worstOf(verdicts: (Verdict|null)[])`) —
  put it in `verdict.ts`, table-driven tests: any ERROR → ERROR, else any
  FAIL/null → FAIL, all PASS → PASS.
- Driver harness: 3 lenses → 3 review fires with lens lines in args; mixed
  verdicts → combined FAIL and re-build fired; all PASS → done; empty
  config → exactly one review fire (regression guard on today's behavior).

## Docs to update

- `README.md` + `.opencode/commands/loop.md` — `reviewLenses` knob, cost
  note; verdict tool's richer args.
- `skills/loop-orchestration/SKILL.md` — verdict contract section
  (reason/criteria), multi-lens review description.
- `.opencode/agents/{verify,review}.md` — verdict-contract updates (A) and
  lens-focus behavior (B).
- `docs/design/threat-model.md` — T1: multi-lens review added as a
  mitigation; residual shrinks to "N simultaneous persuasions".
