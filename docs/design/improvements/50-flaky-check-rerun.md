English | [繁體中文](50-flaky-check-rerun.zh-TW.md)

# 50 — Confirm a red check before blaming the build

**Status: implemented.**

## The problem

`runChecks` ran each discovered check exactly once, and a non-zero exit
became a `critical` finding on the checks axis that floors the stage to FAIL.
A flaky suite therefore sent the loop back to BUILD with a defect that does
not exist — and BUILD, told to fix it, changed code that was fine. One
iteration burned and a diff nobody asked for, on a signal the loop could have
checked in one more run.

## What changed

- **One rerun, on `fail` only** (`CHECK_RERUNS = 1`). `error` is never rerun
  (a missing runner does not come back) and neither is `pass`. `onCheck`
  fires per RUN, so the rerun restamps the claim under its own cap.
- **A fail-then-pass is FLAKY.** The result's `outcome` is the rerun's
  `pass` — the stage is not floored — but it carries `flaky: true`,
  `reruns: 1`, and the FIRST run's failing tail as its `output`: that is the
  evidence a human wants; the passing run printed nothing worth reading. A
  fail-then-fail keeps the second run's exit and output with `reruns: 1`.
- **The flake reaches everyone who should see it.** `checksBlock` marks the
  line `FLAKY … name it in your verdict` and renders the first-run output;
  `checkAxis` adds a `suggestion` finding for it — non-blocking, so the floor
  does not fire, but carried by `suggestionFindings` to the ship gate where
  "this suite flaked" is a fact to weigh. `persist.ts` declares both fields
  so a resumed run does not render the flake as a plain PASS.
- **`checksBudgetMs` counts the reruns.** The budget is the phase's upper
  bound and the stage-marker deadline is advertised from it; a single-run sum
  would let a rerun phase outlive its own deadline and read as a dead run.

## Sharp edges

- **Never rerun `error`.** A 127 is "the binary is not here", and a 124 is a
  hang; running either again costs a full cap for the same answer.
- **The rerun is paid by genuinely red suites too** — once. That is the
  price of not blaming the build for the harness, and one run is the floor of
  what can distinguish a flake from a failure; there is no knob because a
  suite that cannot afford one rerun cannot afford to be a gate.
- **A flake is not a PASS with nothing to say.** Dropping the first-run
  output or the suggestion would make the loop's own gate quietly
  non-deterministic, which is the defect the check stage exists to remove.
