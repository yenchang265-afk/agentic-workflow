English | [繁體中文](12-plan-contract.zh-TW.md)

# 12 — The plan contract

**Status: implemented.** `planContract` on `StageDefSchema`
(`packages/core/src/manifest/schema.ts`), `planContractBlock` +
`hasVerificationSection` in `workflow/verdict.ts`, the compose branch in
`workflow/engine.ts`, the park veto in `workflow/terminal.ts` (`runPark`),
`"planContract": true` on engineering's `plan` stage; tests in
`schema.test.ts`, `engine.test.ts`, `terminal.test.ts`.

## Context

Check stages carry their contract mechanically: `verdictContractBlock` is
appended at composition, so it survives a mis-bound subagent or a stripped
allowlist. PLAN carried only the scope fence. What a plan must *contain* —
steps a builder can follow, a way to verify each acceptance criterion, an
explicit boundary — lived in skills and personas, which are skippable, and the
deterministic park gate checked only that a `## Implementation Plan` heading
existed with text under it. A plan with no verification story sailed to the
human gate, and its gaps surfaced two stages later as VERIFY thrash.

## Design

- `planContract: z.boolean().default(false)` on the stage schema (the
  `requireEvidence` pattern — opt-in per stage, default keeps every existing
  kind byte-identical; a `check` stage setting it is a manifest error, it
  writes no plan). Engineering's `plan` stage opts in.
- `planContractBlock` (in `verdict.ts`, beside `workScopeBlock` — that file is
  the home of prompt-contract blocks) demands: numbered steps naming file
  paths; a `### Verification` subsection mapping each acceptance criterion to
  the command or observable that proves it; a `### Out of Scope` subsection.
  `composeStagePrompt` appends it after the scope fence when the flag is set.
- `runPark` enforces **only the Verification heading**, by extending the
  EXISTING failure arm — the one that already carries the delicate parts
  (note only when the file still exists, the *unconditional* claim release,
  metrics) — never by adding a new exit path. The check runs on
  `extractPlan`'s output, not the raw body, so it cannot disagree with
  `hasPlan` about what a plan is. The stage lookup is tolerant (no
  `stageDef` throw): a park must always reach the claim release.
- `hasVerificationSection` is deliberately loose — case-insensitive,
  whitespace-tolerant, `\b` so `### Verification & Testing` passes — and kept
  beside the contract text so demand and enforcement cannot drift. A refusal
  releases the claim and leaves the task queued, so the failure mode of
  strictness is a livelock (a PLAN run burned per tick); tolerance plus the
  named consequence in the contract block is the mitigation.

## Why not

- **Enforcing steps / Out of Scope deterministically** — prose-quality
  judgments where a regex is all false-refusal; the contract text and the
  human plan gate hold those clauses.
- **A validateBeforeTransition hook** — the veto exists, but it runs *before*
  the plan-landed check and its failure arm predates the claim-release
  lesson; the plan-landed arm is where "the plan is on disk but inadequate"
  belongs, and it already does everything a refusal must.
- **Kind-hardcoding in `composeStagePrompt`** — a manifest flag keeps the
  mechanism reusable by any future planning kind and testable in isolation.
