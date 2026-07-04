---
description: Drive the full agentic loop (plan → build → verify → review) toward a goal, with a human gate before code is written
---

Agentic loop control. The plugin intercepts this command to drive the loop;
`$ARGUMENTS` selects the mode:

- **`/loop <goal>`** — clarify `<goal>` if needed (see below), then start a
  new loop for it. Runs PLAN, then **pauses** for you to review the plan.
- **`/loop next`** — pick the highest-priority task from `docs/tasks/in-planning/`
  and start the loop on it.
- **`/loop task <id>`** — start the loop on a specific in-planning task (the
  `<id>` is the task filename without `.md`).
- **`/loop go`** (alias: `approve`) — approve the currently gated plan. The
  **first** approval parks it as a task in `in-progress/` instead of building
  here (see "Two sessions" below); a re-plan gate reached later continues in
  this session.
- **`/loop watch`** — put **this** session into execution-worker mode: on
  every idle tick it looks for one parked, approved task and builds it
  through VERIFY → REVIEW. Run this in a separate session from the one that
  planned — see below.
- **`/loop unwatch`** — take this session out of watch mode (a build already
  in progress still finishes).
- **`/loop recover <id>`** — resume an in-progress task whose run died
  mid-build (crash/restart): re-claims it and resumes from its state snapshot
  at the exact stage it reached (or, with no valid snapshot, re-enters at
  BUILD from the persisted plan). Check `git status`/`git diff` first.
- **`/loop ship <id>`** — move a reviewed task from `in-review/` to
  `completed/`, appending an audited "Shipped" note and committing the move.
  The recommended final-gate action (a raw `mv` still works but isn't audited).
- **`/loop stop`** (alias: `abort`) — abort the loop, cancel a clarification
  in progress, and exit watch mode, all in this session.
- **`/loop status`** — print the current loop (stage, iteration, pause/watch
  state) plus a whole-backlog roll-up: counts per folder and the actionable
  flags (gated, claimable, interrupted, awaiting review). Bare `/loop` (no
  arguments) does the same.

**$ARGUMENTS**

## Clarifying a free-text goal (this turn only)

If `$ARGUMENTS` is a free-text goal (none of the modes above), the plugin has
parked it — nothing is queued yet. Handle it **in this turn, live with the
user**, before calling the `loop_begin` tool:

1. Read `interviewBeforePlan` from `.agentic-loop.json` at the repo root
   (default `true` if the file or key is absent). If it's `false`, skip
   straight to step 3.
2. Otherwise, judge the goal against the `interview-me` skill's own "When to
   Use" / "When NOT to Use" lists.
   - **Unambiguous, self-contained, or the user asked for speed** — skip
     straight to step 3, no questions asked.
   - **Missing who/why/success/constraint, or just a convention ("build me
     X", "make it faster")** — invoke the `interview-me` skill and run its
     full process with the user (hypothesis + confidence, one question at a
     time with a guess, restate, explicit yes). This is the one place in
     this whole system `interview-me` is allowed to run, precisely because
     nothing has been queued yet — it must never run inside the automatic
     PLAN/BUILD/VERIFY/REVIEW stages.
3. Call the `loop_begin` tool with the final goal text — the original
   `<goal>` if you skipped clarifying, or the confirmed restatement if you
   ran an interview. **Nothing starts until `loop_begin` is called.**

## The pipeline

The loop runs PLAN, gates before build (you review the plan). Execution is
isolated on a `loop/<id>` git branch with a commit checkpoint per build
iteration. On a VERIFY FAIL within the iteration cap it re-plans with the
failure feedback; on a REVIEW FAIL within the cap it re-builds with the
review's feedback (the plan is assumed sound); on a VERIFY/REVIEW ERROR
(the check itself couldn't run) it stops for a human instead of iterating.
On a REVIEW PASS the loop is done and the task parks in `in-review/` — it
never pushes or opens a PR itself; review the branch diff yourself,
push/open the PR, then run `/loop ship <id>` to move the task to
`completed/`. That is the final human gate.

When `worktreesDir` is configured, execution runs in a per-task `git
worktree` instead of the shared checkout — the stage prompts carry a
`Worktree:` line pinning all reads/edits/tests there. When `reviewLenses` is
configured, REVIEW runs once per lens and the loop takes the worst verdict.

## Two sessions: planning and execution

PLAN is the interactive **planning** phase, in this session. The
**first** time you `/loop go` a plan, nothing gets built here — the plan is
**parked** as a task in `docs/tasks/in-progress/` (a free-text goal is
promoted into a real task file for the first time; a backlog task's plan was
already on disk from the gate). Run `/loop watch` in **another** session to
actually build it — that's the **execution** phase: BUILD → VERIFY → REVIEW,
re-planning/re-building inline on a FAIL, exactly as above, entirely within
that watch session. A single session can still do both jobs (plan here, then
run `/loop watch` here too), but they're separate steps now, not automatic.
