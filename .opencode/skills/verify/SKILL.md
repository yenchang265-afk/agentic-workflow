---
name: verify
description: Reference for the VERIFY stage of the agentic engineering loop. Use after a build to check it against the plan's acceptance criteria and emit a PASS/FAIL verdict that drives the loop's finish-or-retry decision.
---

# VERIFY stage

The fourth stage of the agentic engineering loop:

```
explore → plan → build → VERIFY
   ▲                        │
   └────────  loop  ────────┘
```

VERIFY closes the loop. It runs the tests, checks the build against the plan's
acceptance criteria, and emits a machine-readable verdict the driver uses to
decide: finish (PASS) or re-plan with the failure feedback (FAIL, within the
iteration cap).

## When to run it

- After BUILD, on every loop iteration.
- Standalone, to check whether a change meets stated criteria.

## Inputs & outputs

- **Input:** a goal + the plan's acceptance criteria + the build summary.
- **Output:** a per-criterion checklist with evidence, the test output summary,
  and a final verdict line — exactly `LOOP_VERIFY: PASS` or `LOOP_VERIFY: FAIL`.

## The verdict contract

The loop driver greps the last assistant message for `LOOP_VERIFY: PASS` or
`LOOP_VERIFY: FAIL`. So the verify agent must:

- Emit **exactly one** verdict line, spelled exactly as above.
- PASS only when **every** acceptance criterion is met and tests are green.
- On FAIL, list concrete gaps so the next PLAN iteration can target them.

## How to run it

- **`/verify <goal + acceptance criteria>`** — enters the stage and delegates.
- **`verify` subagent** — runs commands (tests) but cannot edit; it reports only.

## Anti-patterns

- **Fixing during verify** — verify checks; the next build iteration fixes.
- **Unobserved PASS** — never claim a pass you did not run; can't-run is a FAIL.
- **Missing/garbled verdict** — without the exact verdict line the loop stalls.
