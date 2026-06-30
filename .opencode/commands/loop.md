---
description: Drive the full agentic loop (explore → plan → build → verify) toward a goal, with a human gate before any code is written
---

Agentic loop control. The plugin intercepts this command to drive the loop;
`$ARGUMENTS` selects the mode:

- **`/loop <goal>`** — start a new loop for `<goal>`. Runs EXPLORE, then PLAN
  automatically, then **pauses** for you to review the plan.
- **`/loop go`** — approve the pending plan and let the loop run BUILD → VERIFY.
- **`/loop stop`** — abort the loop and clear its state.
- **`/loop status`** — print the current stage, iteration, and pause state.

**$ARGUMENTS**

The loop auto-advances explore → plan, gates before build (you review the plan),
and finishes when VERIFY emits `LOOP_VERIFY: PASS` or after the iteration cap.
On a verify FAIL within the cap it re-plans with the failure feedback. When it
finishes, review the diff and open a PR yourself — that is the final human gate.
