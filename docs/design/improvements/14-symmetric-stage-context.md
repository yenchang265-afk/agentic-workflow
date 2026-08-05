English | [繁體中文](14-symmetric-stage-context.zh-TW.md)

# 14 — Symmetric stage context

**Status: implemented.** The `verdicts` context key in
`packages/core/src/workflow/engine.ts`, sections and fences in
`packages/core/workflows/engineering/stages/build.md` / `verify.md` /
`review.md` / `plan.md`, oracle mirrors and pinning tests in `engine.test.ts`.

## Context

Plans 09–11 taught BUILD and VERIFY their history — the attempts ledger, the
iteration budget, the structured failure ahead of the prose — but each addition
landed on the one stage whose defect prompted it, leaving the others
asymmetric. Verified against the templates as of plan 13:

- REVIEW had no iteration context at all: at the cap, its FAIL text is what
  the replan gate reads (the exact fact `verify.md` was taught in plan 11),
  and it was never told so.
- REVIEW was told "VERIFY has already checked these" while being shown no
  evidence VERIFY ran — and its `bashAllowlist` has no test runners, so it
  could neither see the verdict nor re-derive it.
- VERIFY had no attempts ledger, so it could not tell a fresh failure from the
  third recurrence of the same one — recurrence is exactly the signal a
  final-iteration FAIL should carry to the replan gate.
- BUILD got the diff scope (`git.diffCmd`) computed for it at
  `promptContextWithStats` but never rendered: a re-build could not see what
  its previous iterations changed, because `artifacts.build` is overwritten
  each iteration and the ledger keeps one line per attempt.
- The untrusted-data fences were asymmetric too: `plan.md` fences the replan
  reason and `verify.md` fences check output, but BUILD inlined
  VERIFY/REVIEW prose — and REVIEW the builder's summary — bare, directly
  above their instructions.
- `plan.md` carried a `{{#worktree}}` section that can never render in a real
  run (plan's `isolation` is `"none"`).

## Design

- **`verdicts.<stage>` context key** — each artifact's structured verdict head
  on its own: the seam `withArtifact` already records in `state.feedback`,
  clamped under the same `EXEMPT_MAX` ceiling as the in-artifact copy, elision
  counted into `promptElided`. `review.md`'s "What VERIFY established" section
  renders it — the recorded verdict, never the transcript — so REVIEW can take
  VERIFY's result as given instead of trusting an unsupported assertion.
  Undefined when no seam exists (work stages, record-less advance, pre-seam
  snapshots), so those prompts stay byte-identical.
- **`review.md`** additionally gains the `{{#iterations.final}}` warning
  (plan 11's wording, adapted: be precise about which findings block, your
  failure text is what the replan gate reads).
- **`verify.md`** gains the `{{#attempts}}` ledger with a recurrence framing:
  a failure that recurs across attempts is signal — name the recurrence
  instead of reporting it as fresh.
- **`build.md`** gains a prior-work section nested
  `{{#attempts}}{{#git}}…{{/git}}{{/attempts}}`: the commits on the loop
  branch since base are the previous iterations' work; `git.diffCmd` shows
  exactly what they changed. Gated on the ledger so a first fire stays
  byte-identical, and on git context so a state with no isolation renders
  nothing.
- **Fences**: BUILD's two check-feedback sections and REVIEW's build-summary
  section each carry one data-not-instructions line, completing the framing
  `plan.md` and `verify.md` already had. REVIEW's own prior findings stay
  unfenced — self-authored, and the section is already directive.
- **`plan.md`** drops its dead worktree section; the frozen oracle mirrors
  the deletion (worktree paragraph skipped for `plan`) as a deliberate
  post-freeze change, like the fences.
- The parity `strip()` gains `PRIOR_WORK_SECTION` / `VERDICTS_SECTION`
  alongside the attempts/iterations regexes; each new section has its own
  pinning test, and the unset pins hold — every addition is gated on state an
  old run cannot have.

## Why not

- **Inlining `artifacts.verify` whole into REVIEW** — the transcript is the
  unbounded part (plan 09's defect), and REVIEW re-litigating VERIFY's run is
  the failure mode, not the goal; the seam is bounded by construction and is
  the part machine-recorded through `workflow_verdict`.
- **A files-touched field on `AttemptRecord`** — considered and dropped as
  redundant: the prior-work section hands the re-build the exact cumulative
  diff deterministically, with no new state, no persist migration, and no
  per-host plumbing of `activity.files`.
- **An attempts ledger for REVIEW too** — the ledger records check-stage
  FAIL reasons, which REVIEW already receives in fuller form as its own prior
  findings (`artifacts.review` survives a review-FAIL bounce by design);
  rendering both would say the same thing twice.
- **Keeping the sections always-on** — same reason as plan 11: an ungated
  section burns the byte-identical guarantee and the parity oracle for a
  message with no content on a first fire.
