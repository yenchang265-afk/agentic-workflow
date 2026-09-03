English | [繁體中文](52-verify-pass-facts.zh-TW.md)

# 52 — REVIEW sees what VERIFY established, not only what it failed

**Status: implemented.**

## The problem

review.md's "What VERIFY established" section was fed by the verdict seam
`advance` records — `verdictFeedbackBlock`, which renders failures only. On
the common path, a clean VERIFY PASS, the block was empty, the seam was
dropped, and REVIEW got no section at all: it judged the code with no idea
which criteria VERIFY had checked, by what, or which driver-run checks were
green. And a criterion carried only `{ criterion, pass }`, so even a rendered
PASS could not say HOW criterion 3 was met.

## What changed

- **`CriterionResult.evidence?: string[]`** — short refs (a command line, a
  `path:line`) per criterion, on the `workflow_verdict` schema of both hosts
  and in the metrics sidecar's criterion schema (declared, or the next run's
  read-modify-write would strip it). Never gated: the record-level evidence
  is what `evidenceIssue` cross-checks; this is the per-criterion reading.
- **`verdictPassBlock(stage, record, checksLine)`** renders a PASS's facts:
  criteria met with their evidence, the checks the loop ran (one line,
  pre-rendered by `checksSummaryLine` — `checks.ts` imports `verdict.ts`, so
  the summary cannot be built there), the evidence the pass cited, its
  non-blocking notes, and the axes it could not assess. Empty for a record
  that establishes nothing beyond the verdict, so a bare PASS keeps clearing
  the seam exactly as before.
- **`advance` fuses it on a check stage's PASS** where a FAIL fuses the
  feedback block: same seam, same `EXEMPT_MAX` exemption, same
  `promptContext.verdicts` route — so review.md's section now renders on the
  path it was written for.
- **The contract block says so**: each criterion entry may add `evidence`,
  and REVIEW reads it as how the criterion was established.

## Sharp edges

- **A bare PASS still clears the seam.** The older test — VERIFY FAIL →
  BUILD → VERIFY PASS must not serve the stale FAIL as fact — is the reason
  the block is empty when there is nothing established, not a heading alone.
- **Work stages and FAILs are byte-identical.** The PASS branch is gated on
  `def.kind === "check"` and on the verdict; the oracle parity test covers
  the rest.
- **Per-criterion evidence is a READING, not proof.** It is not matched
  against the observed ledger; the record-level `evidence` still is.
