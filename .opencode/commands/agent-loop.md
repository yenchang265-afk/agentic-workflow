---
description: Drive approved tasks through the agentic loop (plan → build → verify → review) — on demand or by watching the queues
---

Agentic loop control. The plugin intercepts this command to drive the loop;
`$ARGUMENTS` selects the mode. Task authoring and the human gates live in
`/agent-loop-task` (`new <idea>` interviews you into a draft; `approve <id>`
parks it planless in `docs/tasks/queued/`; `approve-plan <id>` releases a
parked plan into `docs/tasks/in-progress/`, the build-ready queue). The loop
plans right before execution: a claimed `queued/` task runs the PLAN stage,
which writes the `## Implementation Plan` onto the task file and **parks it
in `plan-review/` for your gate — the loop exits rather than blocking on
you**.

- **`/agent-loop task <id>`** — run one task now (the `<id>` is the task
  filename without `.md`). A `queued/` task enters at PLAN (plans, parks in
  `plan-review/`, exits); an `in-progress/` task enters at BUILD with its
  approved plan.
- **`/agent-loop watch [interval]`** — put **this** session into worker mode.
  Each tick polls **all enabled loop kinds** in claim-priority order: the
  engineering backlog first — one build-ready `in-progress/` task to drive
  BUILD → VERIFY → REVIEW, falling back to a `queued/` task to plan-and-park
  when no build work exists (build work always beats plan work, so tasks in
  flight finish first) — then any other kinds enabled in `.agentic-loop.json`
  (e.g. pr-sitter PRs). It tries an immediate first pull, then keeps two triggers:
  every idle tick, plus a polling timer at `interval` — `30s`, `5m`, `2h`, or
  a bare number of minutes (default: the `watchIntervalMinutes` config, 5m;
  floor: 10s). The timer only claims work while the session is actually idle,
  so a task approved elsewhere gets picked up even if this session generates
  no events. A tick that claims nothing always logs why (empty queue, tasks
  already started, claim marker held); actionable reasons are toasted once. A
  claim marker orphaned by a crashed run auto-releases after 15 minutes.
  **One watcher process per clone:** watch takes an on-disk lease
  (`<tasksDir>/runs/.watch-lease/`, heartbeat every tick); a second opencode
  process watching the same clone is refused — run it in its own
  clone/worktree, or unwatch the first. A dead watcher's lease is taken over
  automatically once its heartbeat goes stale.
- **`/agent-loop unwatch`** — take this session out of watch mode and stop its
  polling timer (a build already in progress still finishes).
- **`/agent-loop recover <id>`** — resume an in-progress task whose run died
  mid-build (crash/restart): re-claims it and resumes from its state snapshot
  at the exact stage it reached (or, with no valid snapshot, re-enters at
  BUILD from the persisted plan). Check `git status`/`git diff` first.
- **`/agent-loop ship <id>`** — move a reviewed task from `in-review/` to
  `completed/`, appending an audited "Shipped" note and committing the move.
  The final-gate action (raw `mv` against the backlog is blocked — the
  command is the only path).
- **`/agent-loop stop`** (alias: `abort`) — abort the loop and exit watch mode
  (timer included), in this session.
- **`/agent-loop status`** — print the current loop (stage, iteration, watch state
  and cadence) plus a whole-backlog roll-up: counts per folder and the
  actionable flags (awaiting approval, claimable, claim-held, interrupted,
  awaiting review). A watching session with nothing claimed shows the reason
  its last tick skipped. Bare `/agent-loop` (no arguments) does the same.
- **`/agent-loop doctor [fix]`** — audit the backlog for structural damage
  (stray folders like `run/`, task files outside every status folder,
  duplicate ids, held claim markers). With `fix`, applies the unambiguous
  repairs: rescues strays to `draft/`, removes emptied stray folders, and
  releases stale claim markers. Duplicates are always left for you. Never
  repair the backlog by hand — the folder a task lives in IS its state, and
  the plugin blocks raw `mv`/`mkdir`/`rm`/writes against `docs/tasks/`.

There is no free-text goal mode, and the loop never blocks on a human —
author tasks with `/agent-loop-task new <idea>`, approve them with
`/agent-loop-task approve <id>`, gate their plans with
`/agent-loop-task approve-plan <id>`, and execute here.

**$ARGUMENTS**

## The pipeline

A queued task enters at PLAN — it writes the plan onto the task file in the
main tree (no branch, no worktree) and parks. An approved-plan task enters at
BUILD with the plan persisted on the task file (`## Implementation Plan`).
Build execution is isolated on a `loop/<id>` git branch with a commit
checkpoint per build iteration. On a VERIFY FAIL within the
iteration cap it **re-builds** with the failure feedback; on a REVIEW FAIL
within the cap it re-builds with the review's feedback; on a VERIFY/REVIEW
ERROR (the check itself couldn't run) it stops for a human instead of
iterating. If the iteration cap trips, the plan itself is suspect — send it back with
`/agent-loop-task replan <id> <why>` and the next PLAN pass addresses the
failure. On a REVIEW PASS the loop is
done and the task parks in `in-review/` — it never pushes or opens a PR
itself; review the branch diff yourself, push/open the PR, then run
`/agent-loop ship <id>` to move the task to `completed/`. That is the final human
gate.

When `worktreesDir` is configured, execution runs in a per-task `git
worktree` instead of the shared checkout — the stage prompts carry a
`Worktree:` line pinning all reads/edits/tests there. When `reviewLenses` is
configured, REVIEW runs once per lens and the loop takes the worst verdict.

## Authoring and execution are separate commands

Authoring and the gates are `/agent-loop-task` — interactive, with you in the
loop: it drafts the task, `approve` queues it, and `approve-plan`/`replan`
are your explicit plan gate. Execution is `/agent-loop` — unattended: `task
<id>` for one task now, `watch` for a standing worker. The loop plans, but
never approves its own plans: PLAN parks its output in `plan-review/` and
exits, so both gates always happen in `/agent-loop-task`, and a watcher can
plan a whole queue overnight for you to batch-review in the morning.
