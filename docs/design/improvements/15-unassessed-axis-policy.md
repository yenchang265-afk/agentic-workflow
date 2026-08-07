English | [繁體中文](15-unassessed-axis-policy.zh-TW.md)

# 15 — The unassessed-axis policy

**Status: implemented.** `axisUnassessed` / `withUnassessedGuard` and the
`effectiveVerdict` skip in `packages/core/src/workflow/verdict.ts`,
`finalizeCheckRecord` in `workflow/checks.ts`, host swaps in the OpenCode
driver and the Claude MCP server, contract text in `verdictContractBlock` and
`prompts/agents/workflow-review/body.md`; `verdict.test.ts`, `checks.test.ts`.

## Context

Two deliberately-documented intents collided. The review contract — both the
agent prompt and `axisCoverageIssue`'s own retry message — instructs: *"Use
verdict ERROR on an axis you genuinely could not assess"* (no hot path in the
diff → performance unassessable), precisely so the reviewer does not invent a
finding to fill the slot. But `effectiveVerdict` worsened the stage by every
axis, and `verdict.test.ts` pinned "any ERROR axis makes the stage ERROR" — so
one honest axis ERROR routed the whole stage to `review.onError`: a stop
blaming *"environment/infrastructure error"*, a task stranded in
`in-progress/` (the CLAIMED note makes `isClaimable` false), and a `recover`
that re-ran REVIEW into the same honest ERROR forever. The `AxisResult`
docstring had already named the intent: a per-axis ERROR is load-bearing and
collapsing it must not burn an iteration — the machine just never honored it.

## Design

- **`axisUnassessed`** — a declared ERROR carrying no blocking finding. The
  synthetic checks axis can never read as unassessed: a broken runner records
  ERROR *with* critical findings (`checkAxis`), which preserves its
  missing-runner → `onError` routing through ERROR-outranks-FAIL.
- **`effectiveVerdict` skips unassessed axes** — a minority "could not assess"
  is neutral: it satisfies coverage (`axisCoverageIssue` counts presence, not
  verdict), does not worsen the stage, and rides into the next prompt via a
  new non-blocking "Unassessed review axes" section of `verdictFeedbackBlock`
  (which also means a PASS carrying one produces a non-empty seam, so the
  in-review human sees "performance was never assessed" in the artifact).
- **`withUnassessedGuard`** — the boundary case must not ship: a declared
  PASS whose *every* axis is unassessed is worsened to ERROR with an
  explanatory reason (the same "broken review, not a FAIL" reasoning as
  `withCoverageGap`). It runs at finalization on the accumulated record —
  bundled with `withCheckFloor` into the single **`finalizeCheckRecord`**
  export both hosts call, so neither can apply the floor and forget the
  guard. Order is load-bearing: a red check adds the (assessed) checks axis
  first, so only a green-check, assessed-nothing PASS trips it.
- **Declared FAIL/ERROR pass through unchanged** — FAIL stays FAIL
  (`rejectedFallback`'s rule), and a FAIL whose every axis is a finding-less
  ERROR is now *rejected at admission* (`blockingFindingsIssue` sees an
  effective FAIL naming nothing to fix) instead of slipping through as
  effective-ERROR.
- **Contract text** — all three `verdictContractBlock` axis branches and the
  review agent prompt now say the ERROR escape hatch is non-blocking, and the
  single-pass branch adds: a PASS in which every axis is ERROR is refused —
  if the whole review could not run, declare the *overall* verdict ERROR.

## Why not

- **The guard inside `effectiveVerdict`** — on the OpenCode driver
  `effectiveVerdict` is evaluated per fan-out pass (`combineRecords`), where a
  single-axis pass whose one axis is unassessable is exactly the legitimate
  minority case; an inline guard would re-create the bug for every
  `fanout: "axis"` stage.
- **Collapsing an unassessed axis to FAIL** — the documented anti-goal: it
  burns a rebuild iteration on work that was never wrong, and invites the
  reviewer to invent findings instead.
- **Screening ERROR-with-findings down to FAIL** ("never let ERROR outrank a
  FAIL") — `checkAxis` relies on ERROR outranking FAIL to route a missing
  runner to `onError` while a red suite goes to `onFail`; forcing FAIL would
  silently break that mechanism.
