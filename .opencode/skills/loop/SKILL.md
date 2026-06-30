---
name: loop
description: Reference for the automatic agentic engineering loop (explore → plan → build → verify). Use to understand how /loop drives the stages, where the human gate is, the verify verdict contract, and how the loop terminates.
---

# The agentic loop

```
        ┌──────────────────────────────────────────────┐
        ▼                                                │
  /loop <goal> ─▶ EXPLORE ─auto─▶ PLAN ─GATE─▶ BUILD ─auto─▶ VERIFY
                                    ▲   (/loop go)              │
                                    └──── FAIL (re-plan) ───────┤
                                                                ▼
                                                    PASS → done (review diff, open PR)
```

The loop turns the engineering workflow into a driven pipeline. A single
`/loop <goal>` starts it; the plugin advances stages on `session.idle`.

## Stages

| Stage | Writes code? | Role |
|-------|--------------|------|
| explore | no | map the code, find reusable patterns |
| plan | no | ordered, review-sized plan + testable acceptance criteria |
| build | **yes** | implement the approved plan test-first |
| verify | no | run tests, check criteria, emit a verdict |

## Control commands

- `/loop <goal>` — start; runs explore then plan, then pauses.
- `/loop go` — approve the plan gate; runs build then verify.
- `/loop stop` — abort and clear state.
- `/loop status` — show stage, iteration, paused.

## The human gate

The loop auto-advances **explore → plan** unattended. It then **pauses before
build** — the only stage that edits files — so a human reviews the plan and runs
`/loop go`. This keeps autonomy high while a human signs off before any code is
written. The verify-pass hand-off is the final gate: you review the diff and open
the PR yourself.

## The verify verdict contract

VERIFY must end its output with exactly one line:

```
LOOP_VERIFY: PASS    # every acceptance criterion met, tests green
LOOP_VERIFY: FAIL    # otherwise; lists concrete gaps for the re-plan
```

The driver greps this to decide finish-or-retry. A missing/garbled verdict stalls
the loop.

## Termination

- **PASS** → loop finishes; review the diff and open a PR.
- **FAIL** and `iteration + 1 < maxIterations` → re-plan with the failure
  feedback, re-gate, build, verify again.
- **FAIL** and the cap is reached → stop and report. Default `maxIterations` is 3
  (configurable in `.agentic-loop.json`).

## Notes & limits

- Only sessions started with `/loop` are driven; other idle sessions are untouched.
- Loop state is in-memory — it does not survive an opencode restart.
- No automated PR creation; the human opens the PR after a PASS.
