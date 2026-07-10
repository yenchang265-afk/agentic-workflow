---
description: The agentic loop — author tasks, gate them, and drive them through plan → build → verify → review
argument-hint: new <idea> | retask <id> [note] | approve [id] | reject [id] [reason] | task <id> | claim [kind] | watch [interval] [kind] | unwatch | recover <id> | ship [id] | kinds | doctor [fix] | stop | status
---

Agentic loop control — one command for authoring, the human gates, and
execution. The plugin intercepts this command; `$ARGUMENTS` selects the verb.
Everything except `new` and `retask` is deterministic plugin work: **invoke
nothing, write nothing** on those verbs — report the toast's outcome and stop.

**$ARGUMENTS**

Dispatch:

## Authoring (you run the interview)

- **`new <idea>`** — turn a rough idea into one or more **planless drafts** in
  `docs/tasks/draft/`. YOU (the current agent) run the interview — subagents
  cannot converse with the user:
  1. **Always** invoke the `interview-me` skill first (never silently skip):
     if the idea already states a clear goal and testable criteria, a single
     restate-and-confirm question suffices; when anything is vague, run the
     full one-question-at-a-time interview. Pin down the goal and 2–5
     testable acceptance criteria.
  2. **Judge scope — one draft, or a slice set?** A single task is built,
     verified, and reviewed by **one agent in one worktree context** (often a
     cheaper/degraded model), so a heavy idea won't fit in a working context
     and should be split into sibling drafts, each a **vertical, independently
     shippable slice**. Split when the idea shows any of: **more than one
     independent deliverable**, **more than ~5 acceptance criteria**, or it
     **touches more than one subsystem/layer**. Otherwise keep it as one draft.
     There is no token metering — "fits the context window" is a scope
     judgement (one reviewable slice), not a measured limit.
  3. Show what you'll write and get an explicit "looks right" from the user:
     - **One draft** — title, priority, acceptance, body.
     - **A slice set** — the epic (parent) title, and the ordered children,
       each with its own acceptance subset. Prefer **independent** slices;
       when slices must stack (a child builds on another's merged code), order
       them by `priority` (0, 1, 2 …). A worktree branches from `origin/main`
       and can't see an unmerged sibling's code, so the human approves and
       ships stacked children one at a time in that order — `priority` orders
       claims but does **not** block, so this human sequencing is the
       dependency gate.
  4. Invoke the **`loop-plan-author`** subagent once with the confirmed set to
     write the draft file(s) — one draft, or N child drafts plus one epic
     tracking file. No plan is written now — the loop's PLAN stage plans each
     task right before execution, so plans don't rot while it sits parked. The
     next step is `/agent-loop approve <id>` per child.
     - **The epic file is a tracking draft only** (frontmatter `type: epic`,
       body listing the children in order). **Never approve it** — an
       un-approved draft is inert, so the loop never claims it. Close it by
       hand with the loop move tool (to `abandoned/` or `completed/`) once
       every child has shipped.
- **`retask <id> [note]`** — reshape a `draft/` task before you approve it,
  when the drafted goal or acceptance came out wrong. YOU (the current agent)
  run the interview, same as `new`:
  1. Resolve `<id>` in `docs/tasks/draft/` **only**. If it isn't there (it's
     already queued/planned, or missing), refuse: "only drafts can be
     re-tasked — a parked plan uses `/agent-loop reject <id>`" and stop.
  2. Read the existing draft and show its current title, priority, acceptance,
     body (and any `tracker` block) to the user.
  3. **Always** invoke the `interview-me` skill to reshape it, seeding it with
     the optional `note` and the current draft. Re-confirm the goal and 2–5
     testable acceptance criteria, then get an explicit "looks right".
  4. Invoke the **`loop-plan-author`** subagent in **`retask` mode** with the
     id and the confirmed title/priority/acceptance/body (carry forward the
     `tracker` block if the draft had one) to rewrite `docs/tasks/draft/<id>.md`
     **in place** — the id/filename never changes. Still no plan. The next step
     is unchanged: `/agent-loop approve <id>`.

## Human gates (deterministic — the plugin moves the file before your turn)

- **`approve [id]`** (aliases: `ok`, `go`) — the unified, folder-driven gate.
  With an explicit `<id>` it advances that task by the gate its folder
  implies: a reviewed `draft/` → `queued/` (task gate, no plan needed — the
  loop plans on claim), a parked `plan-review/` plan → `in-progress/` (plan
  gate, `## Implementation Plan` required), or a finished `in-review/` task →
  `completed/` (ship). Without an id it advances the single task at a loop
  wait-gate (`plan-review/` or `in-review/`); drafts always need the explicit
  id (they accumulate — including never-approved epic tracking drafts — so
  the loop never guesses one). `approve-plan <id>` survives as the explicit
  plan-gate form.
- **`reject [id] [reason]`** (aliases: `redo`, `replan`) — send a parked plan
  (or a cap-tripped `in-progress/` task, by id) back to `queued/` for
  re-planning; the reason is recorded in the audit note and the next PLAN
  pass must address it.
- **`ship [id]`** — move a reviewed task from `in-review/` to `completed/`,
  appending an audited "Shipped" note and committing the move. The `[id]` is
  optional — omit it to ship the single `in-review/` task (same as `approve`
  when that's the only task at a gate).

## Execution

- **`task <id>`** (alias: `run <id>`, or just **`/agent-loop <id>`**) — run
  one task now (the `<id>` is the task filename without `.md`). A `queued/`
  task enters at PLAN (plans, parks in `plan-review/`, exits); an
  `in-progress/` task enters at BUILD with its approved plan.
- **`claim [kind]`** — one-shot pull: claim the next item across **all
  enabled loop kinds** in claim-priority order (engineering backlog first,
  then kinds enabled in `.agentic-loop.json`, e.g. pr-sitter PRs) and drive
  it once this turn settles. Name a kind to restrict the pull
  (`/agent-loop claim pr-sitter`).
- **`watch [interval] [kind]`** — put **this** session into worker mode.
  Each tick polls all enabled loop kinds in claim-priority order: the
  engineering backlog first — one build-ready `in-progress/` task to drive
  BUILD → VERIFY → REVIEW, falling back to a `queued/` task to plan-and-park
  when no build work exists (build work always beats plan work, so tasks in
  flight finish first) — then any other enabled kinds. Name a kind to watch
  only it. It tries an immediate first pull, then keeps two triggers:
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
- **`unwatch`** — take this session out of watch mode and stop its polling
  timer (a build already in progress still finishes). Pressing **ESC**
  mid-drive also unwatches *and* interrupts the running loop (see `recover`).
- **`recover <id>`** — resume an in-progress task whose run stopped early — a
  crash/restart, or a user **interrupt (ESC)** mid-drive: re-claims it and
  resumes from its state snapshot at the exact stage it reached (or, with no
  valid snapshot, re-enters at BUILD from the persisted plan). ESC is a pause
  — it halts after the in-flight stage settles and keeps the snapshot;
  `/agent-loop stop` ends the run and drops it. Check `git status`/`git diff`
  first.
- **`stop`** (alias: `abort`) — abort the loop and exit watch mode (timer
  included), in this session. Drops the run's snapshot — a deliberate end,
  nothing to recover (unlike an ESC pause).

## Introspection

- **`status`** — print the current loop (stage, iteration, watch state and
  cadence) plus a whole-backlog roll-up: counts per folder and the actionable
  flags (awaiting approval, claimable, claim-held, interrupted, awaiting
  review), and the enabled loop kinds when more than one is active. Bare
  `/agent-loop` (no arguments) does the same.
- **`kinds`** — list the loop kinds this repo ships (`loops/<kind>/`) and
  which are enabled. Toggle them via `loops.<kind>.enabled` in
  `.agentic-loop.json`.
- **`doctor [fix]`** — audit the backlog for structural damage (stray folders
  like `run/`, task files outside every status folder, duplicate ids, held
  claim markers). With `fix`, applies the unambiguous repairs: rescues strays
  to `draft/`, removes emptied stray folders, and releases stale claim
  markers. Duplicates are always left for you. Never repair the backlog by
  hand — the folder a task lives in IS its state, and the plugin blocks raw
  `mv`/`mkdir`/`rm`/writes against `docs/tasks/`.

## The pipeline

A queued task enters at PLAN — it writes the plan onto the task file in the
main tree (no branch, no worktree) and parks. An approved-plan task enters at
BUILD with the plan persisted on the task file (`## Implementation Plan`).
Build execution is isolated on a `feature/<id>` git branch with a commit
checkpoint per build iteration. On a VERIFY FAIL within the
iteration cap it **re-builds** with the failure feedback; on a REVIEW FAIL
within the cap it re-builds with the review's feedback; on a VERIFY/REVIEW
ERROR (the check itself couldn't run) it stops for a human instead of
iterating. If the iteration cap trips, the plan itself is suspect — send it
back with `/agent-loop reject <id> <why>` and the next PLAN pass addresses
the failure. On a REVIEW PASS the loop is done and the task parks in
`in-review/` — it never pushes or opens a PR itself; review the branch diff
yourself, push/open the PR, then run `/agent-loop ship <id>` to move the
task to `completed/`. That is the final human gate.

When `worktreesDir` is configured, execution runs in a per-task `git
worktree` instead of the shared checkout — the stage prompts carry a
`Worktree:` line pinning all reads/edits/tests there. When `reviewLenses` is
configured, REVIEW runs once per lens and the loop takes the worst verdict.

The flow: `new` (interview → draft) → human reviews the draft (reshape with
`retask <id>` if it's off) → `approve <id>` queues it → the loop (task,
claim, or watch) plans it and parks the plan in `plan-review/` → human
reviews the plan → `approve` (or `reject <why>`) → the loop builds it →
`in-review/` → `ship`. The loop plans, but never approves its own plans, so
a watcher can plan a whole queue overnight for you to batch-review in the
morning.

Never move, create, or delete files under `docs/tasks/` yourself — no bash
`mv`/`mkdir`/`rm`, no direct writes into status folders (the plugin blocks
them). The folder a task lives in IS its state; these verbs and the loop own
every move. If the backlog looks damaged, run `/agent-loop doctor`.
