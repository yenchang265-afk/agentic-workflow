<!-- SOURCE of the per-verb halves of /agentic-workflow:engineering, shared by
     every prompt-injecting host. Rendered by scripts/gen-prompts.mjs into
     plugins/claude/verbs/ and plugins/qwen/verbs/ — edit THIS file, never the
     generated ones; CI fails on drift.
     Each host's commands/engineering.md is the router the model always
     receives; the block for the invoked verb is injected from the generated
     copy by that host's UserPromptSubmit hook (gate-command.mjs via
     verb-slice.mjs).
     Everything in this file MUST sit inside an "aw:verb <names>" marker pair.
     Unmarked prose here is silently dropped, never injected — shared prose
     belongs in the router instead. Note HTML comments do not nest, so never
     write a literal marker inside this header.
     One block may serve several verbs: "aw:verb stop|abort".
     Host-specific WORDS use the inline tokens listed in gen-prompts.mjs
     (spawnTool, askTool, modelClause) rather than whole-block host
     conditionals, so one sentence serves every host. -->

<!-- aw:verb new -->
- **`new <idea>`** — turn a rough idea into one or more **planless drafts** in
  `docs/tasks/draft/`. YOU (the main agent) run the interview — subagents
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
     If the interview settled **what** the user wants but not **how big** it
     should be, invoke the `idea-refine` skill before splitting — it generates
     scoped variants against the now-explicit intent, so you judge slices
     against a shape the user picked instead of one you assumed.
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
  4. Spawn the **`workflow-task-author`** subagent ({{spawnTool}}) once with the
     confirmed set to write the draft file(s) — one draft, or N child drafts
     plus one epic tracking file. No plan is written now — the loop's PLAN
     stage plans each task right before execution, so plans don't rot while it
     sits parked. The next step is the task gate (step 5 below), asked inline
     per child.
     - **The epic file is a tracking draft only** (frontmatter `type: epic`,
       body listing the children in order). **Never approve it** — an
       un-approved draft is inert, so the loop never claims it. Close it by
       hand with `abandon <id>` (or `workflow_move` to
       `completed/`) once every child has shipped.
  5. **Task gate — ask, don't require a command.** For each non-epic drafted
     child (skip the epic tracking file — never approve it), ask with
     **{{askTool}}**: "Approve `<id>` now?"
     - **Approve** → call `mcp__agentic-workflow__workflow_approve({id})` directly
       (task gate: `draft/` → `queued/`) — the user does not need to type
       `/agentic-workflow:engineering approve <id>`. Then ask a second
       **{{askTool}}**: "Plan it now?"
       - **Yes** → follow the `plan <id>` procedure below: `workflow_start({id})`,
         spawn `workflow-plan-author` ({{spawnTool}}) with the
         returned prompt{{modelClause}}, then
         `workflow_advance` — the task parks in `plan-review/` and the plan gate
         goes live (offer Approve / Replan / Park, per the
         `workflow-orchestration` skill).
       - **No** → stop; `/agentic-workflow:engineering plan <id>` plans it later,
         as does the next `claim` with no build-ready work left.
     - **Not yet** → leave it in `draft/`; `/agentic-workflow:engineering approve
       <id>` (or `retask <id>`) resumes it later.
  - **Project-management pairing** — when `.agentic-workflow.json` has a
    `projectManagement` section, pre-fill the draft's `tracker` block so the
    task is ready to pair with the team's tracker: set `tracker.system` to the
    configured `system` (jira / azure-devops) and `type` to `defaultType`, and
    ask the user for the Jira issue key / ADO work item id to put in
    `tracker.key`. Pairing is optional — if they don't have one, leave
    `tracker` off; the task queues and runs unpaired.
<!-- /aw:verb new -->
<!-- aw:verb retask -->
- **`retask <id> [note]`** — reshape a planless task when the drafted goal or
  acceptance came out wrong: one still in `draft/`, or one already approved
  into `queued/` but not yet planned. YOU (the main agent) run the interview,
  same as `new`:
  1. The plugin has already run the deterministic half before your turn: a
     `queued/` task was moved **back to `draft/`** (its approval withdrawn — the
     reshaped goal has to be re-approved), and a task from `plan-review/` onward
     was refused outright. So resolve `<id>` in `docs/tasks/draft/` **only**. If
     it isn't there, the id is wrong — say so and stop. (Fallback when the hook
     didn't run: `mcp__agentic-workflow__workflow_retask({id, reason})` first.)
     The `[note]` is also written onto that audit note, so why the goal was
     wrong survives in the task file, not just in this turn's context.
  2. Read the existing draft and show its current title, priority, acceptance,
     body (and any `tracker` block) to the user.
  3. **Always** invoke the `interview-me` skill to reshape it, seeding it with
     the optional `note` and the current draft. Re-confirm the goal and 2–5
     testable acceptance criteria, then get an explicit "looks right".
  4. Spawn the **`workflow-task-author`** subagent ({{spawnTool}}) in **`retask` mode**
     with the id and the confirmed title/priority/acceptance/body (carry
     forward the `tracker` block if the draft had one) to rewrite
     `docs/tasks/draft/<id>.md` **in place** — the id/filename never changes.
     Still no plan. The next step is the same task-gate ask as `new` step 5
     above (approve inline, then ask to plan immediately).
<!-- /aw:verb retask -->
<!-- aw:verb approve -->
- **`approve [id]`** — THE gate verb, unified and folder-driven. **Handled
  deterministically by the plugin's `UserPromptSubmit` hook before this turn**
  — it advances the task by the gate its folder implies and blocks the turn,
  so you normally never see it. With an explicit `<id>`: a reviewed `draft/`
  → `queued/` (task gate), a parked `plan-review/` plan → `in-progress/`
  (plan gate, `## Implementation Plan` required), or a finished `in-review/`
  task → `completed/` (ship — only after the human reviewed the branch
  diff). A task lives in exactly one folder, so the gate is never ambiguous.
  Without an id it advances the single task at a loop wait-gate
  (`plan-review/` or `in-review/`), falling back to a lone `draft/` task only
  when neither has anything waiting (tracking epics are never candidates).
  **Spawn nothing** — report the outcome. (Fallback:
  `mcp__agentic-workflow__workflow_approve({id})`, id optional.) Within an
  interactive `new`/`retask` turn, call `mcp__agentic-workflow__workflow_approve({id})`
  directly instead of routing through this hook — see `new` step 5, which
  asks inline and follows up with a "plan it now?" question.
<!-- /aw:verb approve -->
<!-- aw:verb replan -->
- **`replan [id] [reason]`** — the sole rejection verb: send a parked plan
  (or a cap-tripped `in-progress/` task, by id) back to `queued/` for
  re-planning. **Handled by the same hook**; the reason is recorded in the
  audit note. (Fallback: `mcp__agentic-workflow__workflow_reject({id, reason})`, id
  optional.)
<!-- /aw:verb replan -->
<!-- aw:verb abandon -->
- **`abandon <id> [reason]`** — cancel a task: it moves to `abandoned/`, the
  terminal folder for work that will not be done. The **reversible**
  cancellation and the one to reach for — the file is kept, so it can be moved
  back. Works from **any** non-terminal status folder; a `completed/` task is
  refused (shipped work isn't cancellable). **Handled by the same hook** as
  approve/replan, so the move is already done before your turn; an id is
  required. Core refuses a task a live loop is driving or one holding a claim
  marker, and releases any worktree the task owned. (Fallback:
  `mcp__agentic-workflow__workflow_abandon({id, reason})`.) This is also how a
  tracking epic draft is closed once every child has shipped.
<!-- /aw:verb abandon -->
<!-- aw:verb remove -->
- **`remove <id> --force`** — hard-delete a task from the backlog entirely.
  Unlike replan/retask/abandon this does **not** move the task to another
  folder: the file is deleted and the removal committed. Works from **any**
  status folder — a stale draft, a rejected plan, a finished task. **Handled by
  the same hook** as approve/replan; an id is required (a bare `remove` never
  guesses which task to delete). Core refuses a task a live loop is driving or
  one holding a claim marker, and releases any worktree the task owned.
  (Fallback: `mcp__agentic-workflow__workflow_remove({id, force: true})`.)
  - **`--force` is the confirmation, and the hook parses it — not you.** This
    verb dispatches before your turn and then blocks it, so there is no point
    at which you could ask the user. A bare `remove <id>` therefore deletes
    nothing: it reports which task the id resolved to and stops. Relay that
    report and let the user re-run with `--force`. Never add `--force` to a
    command the user did not write it in.
  - **Usually permanent.** Git retains the file only when the backlog is
    tracked, and `ignoreBacklog` defaults to `true` (the backlog is kept out of
    git entirely). Prefer `abandon` unless the user has said they want the file
    gone.
<!-- /aw:verb remove -->
<!-- aw:verb plan -->
- **`plan <id>`** — plan one approved task now. Call
  `mcp__agentic-workflow__workflow_start({id})` on the `queued/` task — it starts at
  PLAN (no git isolation): spawn `workflow-plan-author` ({{spawnTool}})
  with the returned prompt{{modelClause}}, then
  `workflow_advance` — the task parks in `plan-review/` and
  the plan gate goes live: ask the user inline ({{askTool}} — Approve /
  Replan / Park for later, per the `workflow-orchestration` skill) instead of
  only telling them which command to run. If the id is already build-ready
  (`in-progress/`), don't start it here — `claim` builds it.
<!-- /aw:verb plan -->
<!-- aw:verb claim -->
- **`claim`** — call `mcp__agentic-workflow__workflow_claim` to pick up the next
  engineering item and drive it: build-ready `in-progress/` tasks first, then a
  planless `queued/` task to plan, lowest priority number first within each,
  unless a `queued/` task holds a plan request (the hub's Plan button), which
  claims first. A
  `queued/` claim enters at PLAN and parks the plan for the gate. An `in-progress/`
  task starts at BUILD on `feature/<id>`; follow the `workflow-orchestration`
  protocol: `workflow_stage` before spawning each stage subagent (`workflow-build` /
  `workflow-verify` / `workflow-review` via the
  {{spawnTool}}{{modelClause}})
  and `workflow_advance` after
  each returns, until a terminal action. This is the pull equivalent of the
  OpenCode plugin's `watch` — there is no standing watch mode on this
  substrate.
<!-- /aw:verb claim -->
<!-- aw:verb recover -->
- **`recover <id>`** — call `mcp__agentic-workflow__workflow_recover({id})` and
  resume driving from the action it returns: `workflow_stage`, then spawn the
  subagent it names with the {{spawnTool}}{{modelClause}}.
<!-- /aw:verb recover -->
<!-- aw:verb stop|abort -->
- **`stop`** (alias: `abort`) — call `mcp__agentic-workflow__workflow_stop` to abort
  the active loop (partial work stays committed on the loop branch).
<!-- /aw:verb stop|abort -->
<!-- aw:verb status -->
- **`status`** (or bare) — call `mcp__agentic-workflow__workflow_status` and report
  the active loop plus the backlog roll-up and the workflow kinds. When a
  `projectManagement` tracker is configured, the result also carries a
  `pairing` block (tracker system, paired count, unpaired task ids) —
  surface which active tasks still need to be paired to a Jira/ADO item.
<!-- /aw:verb status -->
<!-- aw:verb kinds -->
- **`kinds`** — report the workflow kinds from `workflow_status`'s `kinds` block
  (enabled/disabled per `workflows.<kind>.enabled` in `.agentic-workflow.json`; each
  enabled kind has its own `/agentic-workflow:<kind>` command).
<!-- /aw:verb kinds -->
<!-- aw:verb doctor -->
- **`doctor [fix]`** — call `mcp__agentic-workflow__workflow_doctor({fix})` to audit
  the backlog for structural damage (stray folders, task files outside every
  status folder, duplicate ids, held claim markers, stray plan-request
  markers); with `fix` it applies the unambiguous repairs. Never repair the
  backlog by hand.
<!-- /aw:verb doctor -->
<!-- aw:verb unknown -->
- **anything else** (including a free-text goal) — do not run it. Show this
  usage instead.
<!-- /aw:verb unknown -->
<!-- aw:verb new|retask|plan|claim|recover -->
Read the `workflow-orchestration` skill now — it is the authoritative protocol
for how you (the main agent) drive the stages and how verdicts terminate the
loop. It is scoped to these verbs on purpose: `status`, `kinds`, `doctor`,
`stop` and the gate verbs never drive a stage, and the skill is larger than
this whole command.

The flow: `new` (interview → draft) → human reviews the draft (reshape with
`retask <id>` if it's off) → approve queues it (asked inline right after
drafting, or `approve <id>` later) → plan it (asked inline in the same
breath, or `plan <id>` later) and parks the plan in `plan-review/` →
human reviews the plan → approve (asked inline, or `replan <why>`) → build it
(asked inline as a separate question, or `claim` later) → `in-review/` →
`approve` ships it.
<!-- /aw:verb new|retask|plan|claim|recover -->
<!-- aw:verb plan|claim|replan -->
On a VERIFY or REVIEW FAIL the loop re-**builds** with the feedback threaded
in, within the iteration cap; when the cap trips, the plan itself is suspect
— a human sends it back with `/agentic-workflow:engineering replan <id> <why>`
and the next PLAN pass addresses the failure.
<!-- /aw:verb plan|claim|replan -->
<!-- aw:verb new|retask|plan|claim -->
When a loop you are driving hits a gate live (a draft just written, a plan
just parked, or a build just finished), offer the gate choices inline via
{{askTool}} instead of making the user type a command — see `new` step 5
above for the task gate, and the `workflow-orchestration` skill for the plan and
ship gates. The command verbs above are the deferred path for gates hit
while you were away.
<!-- /aw:verb new|retask|plan|claim -->
