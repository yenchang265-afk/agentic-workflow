---
description: Execute approved plans through the agentic loop (build → verify → review) — on demand or by watching the approved queue
---

Agentic loop control. The plugin intercepts this command to drive the loop;
`$ARGUMENTS` selects the mode. The loop is a **pure executor** — planning and
approval happen first, in `/agent-loop-plan` (`new <idea>` / `task <id>` author the
plan; `approve <id>` parks the task in `docs/tasks/in-progress/`, the
approved queue).

- **`/agent-loop task <id>`** — execute one approved task from
  `docs/tasks/in-progress/` (the `<id>` is the task filename without `.md`).
  Claims it and enters the loop directly at BUILD with the approved plan.
- **`/agent-loop watch [interval]`** — put **this** session into execution-worker
  mode: it looks for one approved, unstarted task and builds it through
  VERIFY → REVIEW. It tries an immediate first pull, then keeps two triggers:
  every idle tick, plus a polling timer at `interval` — `30s`, `5m`, `2h`, or
  a bare number of minutes (default: the `watchIntervalMinutes` config, 5m;
  floor: 10s). The timer only claims work while the session is actually idle,
  so a task approved elsewhere gets picked up even if this session generates
  no events. A tick that claims nothing always logs why (empty queue, tasks
  already started, claim marker held); actionable reasons are toasted once. A
  claim marker orphaned by a crashed run auto-releases after 15 minutes.
- **`/agent-loop unwatch`** — take this session out of watch mode and stop its
  polling timer (a build already in progress still finishes).
- **`/agent-loop recover <id>`** — resume an in-progress task whose run died
  mid-build (crash/restart): re-claims it and resumes from its state snapshot
  at the exact stage it reached (or, with no valid snapshot, re-enters at
  BUILD from the persisted plan). Check `git status`/`git diff` first.
- **`/agent-loop ship <id>`** — move a reviewed task from `in-review/` to
  `completed/`, appending an audited "Shipped" note and committing the move.
  The recommended final-gate action (a raw `mv` still works but isn't audited).
- **`/agent-loop stop`** (alias: `abort`) — abort the loop and exit watch mode
  (timer included), in this session.
- **`/agent-loop status`** — print the current loop (stage, iteration, watch state
  and cadence) plus a whole-backlog roll-up: counts per folder and the
  actionable flags (awaiting approval, claimable, claim-held, interrupted,
  awaiting review). A watching session with nothing claimed shows the reason
  its last tick skipped. Bare `/agent-loop` (no arguments) does the same.

There is no free-text goal mode and no in-loop plan gate anymore — author
plans with `/agent-loop-plan new <idea>`, approve them with `/agent-loop-plan approve
<id>`, then execute here.

**$ARGUMENTS**

## The pipeline

The loop enters at BUILD with the plan persisted on the task file
(`## Implementation Plan`). Execution is isolated on a `loop/<id>` git branch
with a commit checkpoint per build iteration. On a VERIFY FAIL within the
iteration cap it **re-builds** with the failure feedback; on a REVIEW FAIL
within the cap it re-builds with the review's feedback; on a VERIFY/REVIEW
ERROR (the check itself couldn't run) it stops for a human instead of
iterating. If the iteration cap trips, the plan itself is suspect — re-plan
with `/agent-loop-plan task <id>` and approve again. On a REVIEW PASS the loop is
done and the task parks in `in-review/` — it never pushes or opens a PR
itself; review the branch diff yourself, push/open the PR, then run
`/agent-loop ship <id>` to move the task to `completed/`. That is the final human
gate.

When `worktreesDir` is configured, execution runs in a per-task `git
worktree` instead of the shared checkout — the stage prompts carry a
`Worktree:` line pinning all reads/edits/tests there. When `reviewLenses` is
configured, REVIEW runs once per lens and the loop takes the worst verdict.

## Planning and execution are separate commands

Planning is `/agent-loop-plan` — interactive, with you in the loop: it authors the
task, produces the plan, and `approve` is your explicit gate. Execution is
`/agent-loop` — unattended: `task <id>` for one task now, `watch` for a standing
worker. A single session can do both jobs (plan and approve, then `/agent-loop
watch` here too), but they are separate commands, and approval always happens
before execution starts.
