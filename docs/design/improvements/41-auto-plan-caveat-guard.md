English | [繁體中文](41-auto-plan-caveat-guard.zh-TW.md)

# 41 — Auto-plan declines to cross past plan caveats

**Status: implemented.**

## The problem

`--auto-plan` (design 30) crosses the plan gate the moment the plan parks —
and both hosts' automatic crossings dropped the caveats `approvePlan`
computes for the manual gate: a missing `### Verification` subsection,
stacked plan headings, an unverified dependency. The human armed the flag
for rubber-stamp chores; a plan lands with no Verification section (so no
discovered checks will ever run) and BUILD chains anyway. That is the one
plan defect whose cost is paid a whole iteration later — and the exact case
that was NOT a rubber stamp. The caveat the manual gate shows at decision
time was seen by no one.

## What changed

- **`planCaveats` (core, `gate.ts`)** is the caveat list as an exported pure
  seam — the exact list `approvePlan` renders, factored out so an automatic
  crossing can ask "would the manual gate have warned?" before approving.
- **Both auto-cross arms judge it FIRST.** OpenCode's
  `autoAdvanceParkedPlan` and the Claude host's park arm decline the
  automatic crossing on any caveat: the plan stays parked in `plan-review/`,
  the flag stays on the file (intent isn't lost), and the outcome names the
  caveats plus the way through — a manual `approve <id>` still crosses
  anyway, `replan <id> <reason>` still rejects.
- **Fail toward human review**, mirroring the gate hook's fail-closed
  asymmetry: a false decline costs one typed approve on a plan worth
  reading; a false cross ships an unverifiable iteration.

## Sharp edges

- **`--auto-plan` means "skip the question when there is nothing to ask"**,
  never "cross whatever the plan looks like". The flag's rubber-stamp intent
  is judged per PLAN OUTPUT, not per task — the same task crosses
  automatically next time, when its revised plan is contract-clean.
- **A contract-clean plan is untouched** — the caveat guard renders the
  rubber-stamp path exactly as design 30 shipped it (test-pinned on both the
  chain and no-chain arms).
- **The decline is not a rejection.** Nothing moves, no strike counts, no
  audit note is written — the park note (design 24) already carries the
  contract preview; this only withholds the automatic approval.
