English | [繁體中文](48-plan-defect-arm.zh-TW.md)

# 48 — A check stage can say the plan is wrong

**Status: implemented.**

## The problem

Only BUILD could report that the approved plan cannot be implemented
(`workflow_blocked`, routed through the work stage's `onError` arm) — and
`workflow_blocked` refuses a check stage on purpose, so neither channel can
stand in for the other. But VERIFY and REVIEW are where a wrong plan is most
often DISCOVERED: a criterion no implementation of the plan can satisfy, a
step that names an API the SDK does not have. All they could do was FAIL, and
a FAIL re-fires BUILD, so the run rebuilt against a plan that could not pass
until the iteration cap tripped — and only then did the cap message suggest
`replan`. The stall rule (design 46) catches the identical-failure case; this
is the case where the stage already KNOWS, on the first pass.

## What changed

- **`planDefect?: boolean` on `VerdictRecord`**, and a `planDefect` argument
  on `workflow_verdict` on both hosts. `admitVerdict` pins it
  (`planDefectIssue`): it must ride a FAIL — a PASS whose plan is defective is
  a contradiction, an ERROR is the environment's fault — and it must carry a
  `reason`, because the reason is what the replan's PLAN pass reads. A merge
  keeps the flag once any pass raised it.
- **`onPlanDefect` on a check stage's transitions**, validated like every
  other arm. `advance` takes it on a FAIL whose record carries the flag, and a
  kind that declares none routes the FAIL through `onFail` exactly as before.
  Engineering points it at a `stop` naming `replan <id>` on both VERIFY and
  REVIEW; no iteration is spent.
- **The stop is a failed attempt on the ledger.** `runStop` writes the stop
  context note from `state.attempts`, and `replanTask` fuses that note into
  the rejection reason — so the defect the stage named reaches the next PLAN
  pass without the human retyping it.
- **The contract block says when.** `verdictContractBlock` carries a
  PLAN DEFECT paragraph (the SSOT for the verdict payload, per AGENTS.md):
  never for a defect the build can fix, never with PASS, never to escape a
  hard task.

## Sharp edges

- **Never relax `workflow_blocked`'s check-stage refusal to "fix" this.** The
  two channels stay distinct: a work stage may not record a verdict on its own
  work, and a check stage's "cannot do the work" IS a verdict — a FAIL with a
  named cause — which is why it rides `workflow_verdict`.
- **The flag alone is not enough** — a bare `planDefect: true` is rejected.
  A stop that tells the next planner nothing is worse than a rebuild.
- **A wrong flag costs the human a replan they did not need**, which the
  contract says in as many words. The asymmetry is accepted: a needless
  replan is one gate; a needless three-iteration burn is three stages.
