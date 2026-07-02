---
description: Drive the full agentic loop (define → plan → build → verify → review → ship) toward a goal, with human gates before code is written and before shipping
---

Agentic loop control. The plugin intercepts this command to drive the loop;
`$ARGUMENTS` selects the mode:

- **`/loop <goal>`** — start a new loop for `<goal>`. Runs DEFINE then PLAN,
  then **pauses** for you to review the plan.
- **`/loop next`** — pick the highest-priority task from `docs/tasks/in-planning/`
  and start the loop on it.
- **`/loop task <id>`** — start the loop on a specific in-planning task (the
  `<id>` is the task filename without `.md`).
- **`/loop go`** — approve whatever is currently gated (plan or review) and let
  the loop continue.
- **`/loop stop`** — abort the loop and clear its state.
- **`/loop status`** — print the current stage, iteration, and pause state.

**$ARGUMENTS**

The loop runs DEFINE → PLAN, gates before build (you review the plan) — when
driven from a backlog task, approving here also moves the task file
`in-planning/ → in-progress/` automatically — then runs BUILD → VERIFY →
REVIEW, gates again before ship (you review the findings and the draft PR
description), then runs SHIP. On a VERIFY FAIL within the
iteration cap it re-plans with the failure feedback; on a REVIEW FAIL within
the cap it re-builds with the review's feedback (the plan is assumed sound).
SHIP never pushes or opens a PR itself — when the loop finishes, review the
PR draft and rollback plan it prepared, then push and open the PR yourself.
That is the final human gate.
