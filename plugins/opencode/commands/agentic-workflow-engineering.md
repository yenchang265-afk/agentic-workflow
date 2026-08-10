---
name: agentic-workflow:engineering
description: The engineering loop — author tasks, gate them, and drive them through plan → build → verify → review
argument-hint: new <idea> | retask <id> [note] | approve [id] | replan [id] [reason] | abandon <id> [reason] | remove <id> --force | plan <id> | claim | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | recover <id> | waive <id> <why> | kinds | doctor [fix] | stop | status
---

The engineering agentic loop — one command for authoring, the human gates,
and execution, scoped to the engineering kind. The plugin intercepts this
command; the first argument token selects the verb. Everything except `new` and `retask`
is deterministic plugin work: **invoke nothing, write nothing** on those
verbs — report the toast's outcome and stop. `new` is entirely yours;
`retask` is split — the plugin has already placed the task (or refused) before
your turn, and the interview + rewrite are yours. (The PR sitter has its own
command: `/agentic-workflow:pr-sitter`.)

Verb: `$1` — empty means `status`. Match only this token against the dispatch
list below; a verb-like word (`plan`, `status`, `approve`, `replan`, …) inside
the payload is part of the idea/note/reason, never the verb.
Payload after the verb (whitespace-collapsed, quotes stripped): $2
Raw argument line — the authoritative payload for free-text verbs (`new`
ideas, `retask` notes, `replan` reasons); quoting and line breaks survive
only here:

**$ARGUMENTS**

Dispatch:

## Authoring (you run the interview)

<!-- aw:verb new -->
- **`new <idea>`** — turn a rough idea into one or more **planless drafts** in
  `docs/tasks/draft/`. YOU (the current agent) run the interview — subagents
  cannot converse with the user:
  1. **Always** invoke the `interview-me` skill first (never silently skip):
     if the idea already states a clear goal and testable criteria, a single
     restate-and-confirm question suffices; when anything is vague, run the
     full one-question-at-a-time interview. Pin down the goal and 2–5
     testable acceptance criteria. Ask through the **`question`** tool — one
     question per call, your guess as the first option, `custom: true` so free
     text stays open — per the skill's Step 2 *Delivery* rules.
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
  4. Invoke the **`workflow-task-author`** subagent once with the confirmed set to
     write the draft file(s) — one draft, or N child drafts plus one epic
     tracking file. No plan is written now — the loop's PLAN stage plans each
     task right before execution, so plans don't rot while it sits parked. The
     next step is the task gate (step 5 below), asked inline per child.
     - **The epic file is a tracking draft only** (frontmatter `type: epic`,
       body listing the children in order). **Never approve it** — an
       un-approved draft is inert, so the loop never claims it. Close it by
       hand once every child has shipped: `abandon <id>` retires the tracking
       draft.
  5. **Task gate — ask, don't require a command.** For each non-epic drafted
     child (skip the epic tracking file — never approve it), ask with the
     **`question`** tool: "Approve `<id>` now?"
     - **Approve** → call the **`workflow_gate`** tool with that id (task gate:
       `draft/` → `queued/`) — the user does not need to type
       `/agentic-workflow:engineering approve <id>`. Then ask a second
       **`question`**: "Plan it now?"
       - **Yes** → call the **`workflow_plan`** tool with that id. The PLAN
         stage runs and parks the plan in `plan-review/` for the human's gate.
         Never call it without asking first — it refuses until the question has
         been put, because planning hands this session to the PLAN stage and
         nothing can ask the user anything until that finishes.
       - **No** → stop; `/agentic-workflow:engineering plan <id>` plans it
         later, as does the next `claim` with no build-ready work left.
     - **Not yet** → leave it in `draft/`; `/agentic-workflow:engineering
       approve <id>` (or `retask <id>`) resumes it later.
     These two tools are the ONLY backlog moves you may make, and only on an
     answer the user just gave you — everything else under `docs/tasks/` stays
     the plugin's.
<!-- /aw:verb new -->
<!-- aw:verb retask -->
- **`retask <id> [note]`** — reshape a planless task when the drafted goal or
  acceptance came out wrong: one still in `draft/`, or one already approved
  into `queued/` but not yet planned. YOU (the current agent) run the
  interview, same as `new`:
  1. The plugin has already run the deterministic half before your turn: a
     `queued/` task was moved **back to `draft/`** (its approval withdrawn — the
     reshaped goal has to be re-approved, and the toast says so). A refusal
     (a planned task pointed at `replan`, an unknown id, a live loop, a held
     claim marker) is report-and-stop — its outcome REPLACES this text, so
     reading this means placement succeeded. Still resolve `<id>` in
     `docs/tasks/draft/` **only**; if it isn't there, the plugin did not run
     (not loaded, or its `@agentic-workflow/core` build is stale) — report that,
     with the fix (`npm install` at the agentic-workflow repo root, then
     restart opencode), and stop. The `[note]` is also written onto that audit
     note, so why the goal was wrong survives in the task file, not just in
     this turn's context.
  2. Read the existing draft and show its current title, priority, acceptance,
     body (and any `tracker` block) to the user.
  3. **Always** invoke the `interview-me` skill to reshape it, seeding it with
     the optional `note` and the current draft. Re-confirm the goal and 2–5
     testable acceptance criteria, then get an explicit "looks right". Ask
     through the **`question`** tool, on the same terms as `new` step 1.
  4. Invoke the **`workflow-task-author`** subagent in **`retask` mode** with the
     id and the confirmed title/priority/acceptance/body (carry forward the
     `tracker` block if the draft had one) to rewrite `docs/tasks/draft/<id>.md`
     **in place** — the id/filename never changes. Still no plan. Then run the
     task gate inline, exactly as `new` step 5 does: ask with **`question`**
     "Approve `<id>` now?" (approval is required again when the task came back
     from `queued/`), call **`workflow_gate`** on yes, then ask "Plan it now?"
     and call **`workflow_plan`** on yes. Never make the user type the command
     for a gate you are sitting at.
<!-- /aw:verb retask -->

## Human gates (deterministic — the plugin moves the file before your turn)

<!-- aw:verb approve -->
- **`approve [id]`** — THE gate verb, unified and folder-driven. With an
  explicit `<id>` it advances that task by the gate its folder implies:
  - a reviewed `draft/` → `queued/` (task gate, no plan needed — the loop
    plans on claim);
  - a parked `plan-review/` plan → `in-progress/` (plan gate,
    `## Implementation Plan` required);
  - a finished `in-review/` task → `completed/` (ship — do this only after
    reviewing the branch diff).
  A task lives in exactly one folder, so the gate is never ambiguous; the
  toast names which move happened. After a TASK gate the plugin's result
  carries a **`NEXT STEP`** line asking you to put the "plan it now?" question
  to the user — follow it (`question`, then `workflow_plan` on yes) and stop.
  Skipping the question is not an option: `workflow_plan` refuses a task whose
  gate asked for one until it has actually been put.
  The move itself is already done and is never yours to repeat. Without an id it advances the single task
  at a loop wait-gate (`plan-review/` or `in-review/`), falling back to a lone
  `draft/` task only when neither has anything waiting — loop gates outrank the
  authoring gate, and never-approved epic tracking drafts are skipped, so the
  loop never guesses. Fully deterministic plugin work whose outcome normally
  REPLACES this text — so if you are reading this, the plugin did not run
  (not loaded, or its `@agentic-workflow/core` build is stale). Glob
  `docs/tasks/*/<id>*`: the task will still sit in its old folder. Report
  that the gate did NOT happen, with the fix (`npm install` at the
  agentic-workflow repo root, then restart opencode) — never claim it did.
<!-- /aw:verb approve -->
<!-- aw:verb replan -->
- **`replan [id] [reason]`** — the sole rejection verb, and it chains the
  re-plan: the plugin rejects the parked plan (or a cap-tripped
  `in-progress/` task, by id), records the reason in the audit note, re-queues
  the task marked plan-next, and immediately starts a PLAN pass on it in this
  session — the revised plan parks back in `plan-review/` for the gate (a busy
  session or a claim race falls back to plan-next, which the next
  `claim`/`watch` honours first). Fully deterministic plugin work whose
  outcome normally REPLACES this text — so if you are reading this, the plugin
  did not run (not loaded, or its `@agentic-workflow/core` build is stale).
  Glob `docs/tasks/*/<id>*`: the task will still sit in its old folder. Report
  that the gate did NOT happen, with the fix (`npm install` at the
  agentic-workflow repo root, then restart opencode) — never claim it did.
<!-- /aw:verb replan -->
<!-- aw:verb abandon -->
- **`abandon <id> [reason]`** — cancel a task: it moves to `abandoned/`, the
  terminal folder for work that will not be done. Works from **any**
  non-terminal status folder (a shipped `completed/` task is refused —
  shipped work isn't cancellable). The file survives, so this is the verb to
  reach for when the user wants a task out of the way; `remove` is for when
  they want it *gone*. The plugin refuses a task a live loop is driving or one
  holding a claim marker, and releases any worktree the task owned. An id is
  required. This is also how an epic tracking draft is closed once every child
  has shipped. Fully deterministic plugin work whose outcome normally
  REPLACES this text — so if you are reading this, the plugin did not run
  (not loaded, or its `@agentic-workflow/core` build is stale). Glob
  `docs/tasks/*/<id>*`: the task will still sit in its old folder. Report
  that nothing was abandoned, with the fix (`npm install` at the
  agentic-workflow repo root, then restart opencode) — never claim it was.
<!-- /aw:verb abandon -->
<!-- aw:verb remove -->
- **`remove <id> --force`** — hard-delete a task from the backlog entirely.
  Unlike replan/retask/abandon this does **not** move the task: the file is
  deleted and the removal committed. Works from **any** status folder. The
  plugin refuses a task a live loop is driving or one holding a claim marker,
  and releases any worktree the task owned.
  - **A bare `remove <id>` deletes nothing.** It reports which task the id
    resolved to and stops; `--force` is the confirmation. Ids are
    prefix-resolvable, so this is what stops a typo'd short handle deleting a
    different real task — report the dry run and let the user decide.
  - **Recoverable only if the backlog is tracked, which is NOT the default.**
    `ignoreBacklog` defaults to `true`, keeping `docs/tasks/` out of git
    entirely, so a forced remove is usually permanent. Prefer `abandon` unless
    the user has said they want the file gone.
  - Fully deterministic plugin work whose outcome normally REPLACES this
    text — so if you are reading this, the plugin did not run (not loaded, or
    its `@agentic-workflow/core` build is stale). Nothing was deleted or
    dry-run. Report that, with the fix (`npm install` at the agentic-workflow
    repo root, then restart opencode) — never claim the remove or its dry run
    happened.
<!-- /aw:verb remove -->

## Execution

<!-- aw:verb plan -->
- **`plan <id>`** — plan one approved task now: claims the `queued/` task and
  runs the PLAN stage (writes the `## Implementation Plan` onto the task
  file, parks it in `plan-review/` for your gate, exits). Building is not
  reachable from here — `claim`/`watch` drive builds. The plan gate itself is
  announced by a toast, not by a question: the PLAN pass finishes in the
  background driver, after your turn has ended, and this host's plugin can
  only observe questions the model asked — it cannot open one of its own.
<!-- /aw:verb plan -->
<!-- aw:verb claim -->
- **`claim`** — one-shot pull: claim the next task (lowest priority number
  first, unless a `queued/` task holds a plan request — the hub's Plan
  button — which claims that one first) and drive it once this turn
  settles — build-ready `in-progress/` work, then an approved `queued/` task
  to plan when no build work is left.
<!-- /aw:verb claim -->
<!-- aw:verb watch -->
- **`watch [trigger]`** — put **this** session into engineering worker mode.
  Each tick polls the backlog for one build-ready `in-progress/` task to drive
  BUILD → VERIFY → REVIEW, falling back to an approved `queued/` task to plan
  and park. Bare `watch` uses the kind's configured trigger
  (`workflows.engineering.trigger`, default poll); an argument overrides it for
  this session only: `poll [interval]` / a bare interval (`30s`, `5m`, `2h`,
  or a bare number of minutes; default `watchIntervalMinutes`, 5m; floor:
  10s) claims on idle events plus the timer, `cron <schedule>` claims only
  when the 5-field schedule fires, `idle` chains a new loop the moment the
  session goes idle. The poll timer only claims work
  while the session is actually idle, so a task approved elsewhere gets
  picked up even if this session generates no events. A tick that claims
  nothing always logs why (empty queue, tasks awaiting a plan, tasks already
  started, claim marker held); actionable reasons are toasted once. An
  `in-progress/` claim marker orphaned by a crashed run auto-releases after 15
  minutes; a stale `queued/` marker (a crashed `plan <id>`) is released by
  `doctor fix`.
  **One watcher process per clone:** watch takes an on-disk lease
  (`<tasksDir>/runs/.watch-lease/`, heartbeat every tick); a second opencode
  process watching the same clone is refused — run it in its own
  clone/worktree, or unwatch the first. A dead watcher's lease is taken over
  automatically once its heartbeat goes stale.
<!-- /aw:verb watch -->
<!-- aw:verb unwatch -->
- **`unwatch`** — take this session out of watch mode and stop its polling
  timer (a build already in progress still finishes). Pressing **ESC**
  mid-drive also unwatches *and* interrupts the running loop (see `recover`).
<!-- /aw:verb unwatch -->
<!-- aw:verb recover -->
- **`recover <id>`** — resume an in-progress task whose run stopped early — a
  crash/restart, or a user **interrupt (ESC)** mid-drive: re-claims it and
  resumes from its state snapshot at the exact stage it reached (or, with no
  valid snapshot, re-enters at BUILD from the persisted plan). ESC is a pause
  — it halts after the in-flight stage settles and keeps the snapshot; `stop`
  ends the run and drops it. Check `git status`/`git diff` first.
<!-- /aw:verb recover -->
<!-- aw:verb waive -->
- **`waive <id> <why>`** — carry on past a CHECK stage that cannot run in this
  environment at all (a browser suite with no display, a service the sandbox
  has no network for). Takes that stage's pass arm — VERIFY waived continues at
  REVIEW — **without recording a pass**: the waiver and your reason replace the
  stage's verdict in the next stage's prompt and are audited on the task file,
  so the reviewer is told the checks are ABSENT rather than satisfied. Only for
  a run that has already stopped, and not for a check that merely failed —
  that is a rebuild, or `replan` if the plan itself asked for something this
  environment cannot provide.
<!-- /aw:verb waive -->
<!-- aw:verb stop|abort -->
- **`stop`** (alias: `abort`) — abort the loop and exit watch mode (timer
  included), in this session. Keeps the run's snapshot, so `recover <id>` picks
  the run back up at the stage it stopped in rather than restarting at BUILD.
<!-- /aw:verb stop|abort -->

## Introspection

<!-- aw:verb status -->
- **`status`** — print the current loop (stage, iteration, watch state and
  cadence) plus a whole-backlog roll-up: counts per folder and the actionable
  flags (awaiting approval, claimable, claim-held, interrupted, awaiting
  review). Bare `/agentic-workflow:engineering` (no arguments) does the same.
<!-- /aw:verb status -->
<!-- aw:verb kinds -->
- **`kinds`** — list the workflow kinds this repo ships (`packages/core/workflows/<kind>/`) and
  which are enabled. Toggle them via `workflows.<kind>.enabled` in
  `.agentic-workflow.json`; each enabled kind has its own
  `/agentic-workflow:<kind>` command.
<!-- /aw:verb kinds -->
<!-- aw:verb doctor -->
- **`doctor [fix]`** — audit the backlog for structural damage (stray folders
  like `run/`, task files outside every status folder, duplicate ids, held
  claim markers, stray plan-request markers). With `fix`, applies the
  unambiguous repairs: rescues strays to `draft/`, removes emptied stray
  folders, releases stale claim markers, and drops stray plan requests.
  Duplicates are always left for you. Never repair the backlog by
  hand — the folder a task lives in IS its state, and the plugin blocks raw
  `mv`/`mkdir`/`rm`/writes against `docs/tasks/`.
<!-- /aw:verb doctor -->

## The pipeline

<!-- aw:verb plan|claim|watch|recover -->
A queued task enters at PLAN — it writes the plan onto the task file in the
main tree (no branch, no worktree) and parks. An approved-plan task enters at
BUILD with the plan persisted on the task file (`## Implementation Plan`).
Build execution is isolated on a `feature/<id>` git branch with a commit
checkpoint per build iteration. On a VERIFY FAIL within the
iteration cap it **re-builds** with the failure feedback; on a REVIEW FAIL
within the cap it re-builds with the review's feedback; on a VERIFY/REVIEW
ERROR (the check itself couldn't run) it stops for a human instead of
iterating. If the iteration cap trips, the plan itself is suspect — send it
back with `replan <id> <why>` and the next PLAN pass addresses the failure.
On a REVIEW PASS the loop is done and the task parks in `in-review/` — the
loop itself never pushes or opens a PR. Review the branch diff yourself, then
`approve <id>` to complete it: **that ship step is what pushes the branch and
opens (or reuses) the draft PR**, so it is the one gate with an effect visible
outside this machine. That is the final human gate.

When `worktreesDir` is configured, execution runs in a per-task `git
worktree` instead of the shared checkout — the stage prompts carry a
`Worktree:` line pinning all reads/edits/tests there. When `reviewLenses` is
configured, REVIEW runs once per lens and the loop takes the worst verdict.

<!-- /aw:verb plan|claim|watch|recover -->
The flow: `new` (interview → draft) → human reviews the draft (reshape with
`retask <id>` if it's off) → `approve <id>` queues it → the loop (plan,
claim, or watch) plans it and parks the plan in `plan-review/` → human
reviews the plan → `approve` (or `replan <why>`) → the loop builds it →
`in-review/` → `approve` ships it. The loop plans, but never approves its
own plans, so a watcher can plan a whole queue overnight for you to
batch-review in the morning.

Never move, create, or delete files under `docs/tasks/` yourself — no bash
`mv`/`mkdir`/`rm`, no direct writes into status folders (the plugin blocks
them). The folder a task lives in IS its state; these verbs and the loop own
every move. If the backlog looks damaged, run
`/agentic-workflow:engineering doctor`.
