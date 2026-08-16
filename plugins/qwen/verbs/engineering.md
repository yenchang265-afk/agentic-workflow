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
     testable acceptance criteria. Ask through **`ask_user_question`** — one question
     per call, your guess as the first option, free text left open — per the
     skill's Step 2 *Delivery* rules.
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
  3. Show what you'll write, then ask for the "looks right" with **`ask_user_question`**
     — the skill's Step 4 owns that window's shape ("Yes, that's it" first, free
     text open). Nothing is written until that answer lands:
     - **One draft** — title, priority, acceptance, body.
     - **A slice set** — the epic (parent) title, and the ordered children,
       each with its own acceptance subset. Prefer **independent** slices;
       when slices must stack (a child builds on another's merged code), order
       them by `priority` (0, 1, 2 …). A worktree branches from `origin/main`
       and can't see an unmerged sibling's code, so the human approves and
       ships stacked children one at a time in that order — `priority` orders
       claims but does **not** block, so this human sequencing is the
       dependency gate.
  4. Spawn the **`workflow-task-author`** subagent (`agent` tool) once with the
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
  5. **Task gate — ask, don't require a command.** Walk the non-epic children in
     `priority` order, ONE at a time (skip the epic tracking file — never approve
     it). After each child's answer, come back here for the next one; the
     plugin's own follow-up names it, and **that follow-up outranks this prose**
     wherever the two differ. For each child, ask with **`ask_user_question`**: "Approve
     `<id>` now?"
     - **Approve** → call `mcp__agentic-workflow__workflow_approve({id})` directly
       (task gate: `draft/` → `queued/`) — the user does not need to type
       `/agentic-workflow:engineering approve <id>`. Then ask a second
       **`ask_user_question`**: "Plan it now?"
       - **Yes** → run the PLAN pass now — `workflow_start({id})`,
         spawn `workflow-plan-author` (`agent` tool) with the
         returned prompt, then
         `workflow_advance` — the task parks in `plan-review/` and the plan gate
         goes live. That ask is not left to this prose either: the park is
         followed by a **`PLAN GATE`** block the harness emits beside the result
         — obey it.
         **The walk stops here for this turn** — planning owns the rest of it.
         Name the slices still un-approved and say a later
         `/agentic-workflow:engineering approve` offers them as a choice.
       - **No** → move straight to the next child in the walk;
         `/agentic-workflow:engineering plan <id>` plans this one later, as does
         the next `claim` with no build-ready work left.
     - **Not yet** → leave it in `draft/` and move straight to the next child;
       `/agentic-workflow:engineering approve <id>` (or `retask <id>`) resumes it
       later.
  - **Project-management pairing** — when `.agentic-workflow.json` has a
    `projectManagement` section, pre-fill the draft's `tracker` block so the
    task is ready to pair with the team's tracker: set `tracker.system` to the
    configured `system` (jira / azure-devops) and `type` to `defaultType`, and
    ask the user for the Jira issue key / ADO work item id to put in
    `tracker.key`. Pairing is optional — if they don't have one, leave
    `tracker` off; the task queues and runs unpaired.
<!-- /aw:verb new -->
<!-- aw:verb retask -->
- **`retask <id> [note]`** — reshape an unplanned task when the drafted goal or
  acceptance came out wrong: one still in `draft/`, or one already approved
  into `queued/` (including one a `replan` sent back there). YOU (the main
  agent) run the interview, same as `new`:
  1. The plugin has already run the deterministic half before your turn: a
     `queued/` task was moved **back to `draft/`** (its approval withdrawn — the
     reshaped goal has to be re-approved), and a task from `plan-review/` onward
     was refused outright. So resolve `<id>` in `docs/tasks/draft/` **only**. If
     it isn't there, the id is wrong — say so and stop. (Fallback when the hook
     didn't run: `mcp__agentic-workflow__workflow_retask({id, reason})` first.)
     The `[note]` is also written onto that audit note, so why the goal was
     wrong survives in the task file, not just in this turn's context. A
     superseded `## Implementation Plan` a prior `replan` left on the task is
     removed by the same move — it was written against the goal you are about to
     rewrite. If the outcome says it was KEPT (off-schema frontmatter blocks the
     rewrite), say so; do not delete the section yourself.
  2. Read the existing draft and show its current title, priority, acceptance,
     body (and any `tracker` block) to the user.
  3. **Always** invoke the `interview-me` skill to reshape it, seeding it with
     the optional `note` and the current draft. Re-confirm the goal and 2–5
     testable acceptance criteria, then get an explicit "looks right". Every ask
     goes through **`ask_user_question`** on the same terms as `new` steps 1 and 3 — the
     closing "looks right" included, not only the interview questions.
  4. Spawn the **`workflow-task-author`** subagent (`agent` tool) in **`retask` mode**
     with the id and the confirmed title/priority/acceptance/body (carry
     forward the `tracker` block **and the `epic:` frontmatter key** if the
     draft had them — dropping `epic:` orphans a slice from its set, and the
     gates read only that key, never the body's prose line) to rewrite
     `docs/tasks/draft/<id>.md` **in place** — the id/filename never changes.
     Still no plan. Then run the task gate inline, exactly as `new` does — ask
     with **`ask_user_question`** "Approve `<id>` now?"; on approve call
     `mcp__agentic-workflow__workflow_approve({id})` yourself and ask a second
     **`ask_user_question`** "Plan it now?", running `workflow_start({id})` → spawn
     `workflow-plan-author` (`agent` tool) → `workflow_advance`
     on yes. Never make the user type the command for a gate you are sitting at.
<!-- /aw:verb retask -->
<!-- aw:verb approve -->
- **`approve [id]`** — THE gate verb, unified and folder-driven. **Handled
  deterministically by the plugin's `UserPromptSubmit` hook before this turn**
  — it advances the task by the gate its folder implies. With an explicit
  `<id>`: a reviewed `draft/`
  → `queued/` (task gate), a parked `plan-review/` plan → `in-progress/`
  (plan gate, `## Implementation Plan` required), or a finished `in-review/`
  task → `completed/` (ship — only after the human reviewed the branch
  diff). A task lives in exactly one folder, so the gate is never ambiguous.
  Without an id it advances the single task at a loop wait-gate
  (`plan-review/` or `in-review/`), falling back to a lone `draft/` task only
  when neither has anything waiting (tracking epics are never candidates).
  **The move is already done by the time you read this — never re-run it.**
  What happens next depends on which gate fired:
  - **Task gate** (the task is now in `queued/`) — the hook hands the turn back
    with a **`GATE FOLLOW-UP`** block appended. That block is the plugin
    speaking, not prose to weigh: obey it. It has you ask, with **`ask_user_question`**,
    whether to plan the task now, and run the PLAN pass below if the answer is
    yes. A blocked turn could never ask that, which is why this one is handed
    back. When the task is a slice of a set, that block also names the next
    un-approved slice to offer — walk it exactly as written.
  - **Several tasks waiting and no id given** — the hook hands the turn back
    with a **`GATE AMBIGUITY`** block instead. **Nothing moved.** The plugin
    never guesses which task the human meant, so that block has you ask which
    one and then approve exactly what they picked — nothing else.
  - **Plan gate, ship gate, or any other refusal** — the hook blocks the turn
    and reports the outcome itself, so you never see this verb at all.
  **Spawn nothing of your own** beyond what the follow-up asks for. (Fallback,
  when no hook ran: `mcp__agentic-workflow__workflow_approve({id})`, id
  optional — then ask the same question yourself.)
  - **`--pr` / `--push` / `--local` choose what a SHIP publishes, and the hook
    parses them — not you.** `--pr` pushes the branch and opens a draft PR,
    `--push` pushes and opens nothing, `--local` leaves the branch on this
    machine. Omitted, the repo's `shipPublish` decides (default `--pr`). They
    are ignored at the task and plan gates, which publish nothing. Never add one
    the user did not write: the task completes either way, but a push cannot be
    taken back. On the fallback tool path they are the `publish` argument
    (`"pr" | "push" | "local"`) — again, only when the user chose it.
  - **`--base=<branch>` chooses what a shipped PR TARGETS** — write it with
    the `=`, never `--base <branch>`, which is refused (a spaced value would be
    read as the task id). Omitted, the gate uses the branch the run was cut
    from, which it recorded on the task; then the repo's `prBase`; then the
    platform's default branch. Never add one the user did not write: the
    recorded base is the ref REVIEW graded the diff against, so retargeting
    shows reviewers a change nobody approved. A base that is not on `origin`
    refuses the PR instead of opening it somewhere else — reship with the
    corrected `--base=` to fix it. On the fallback tool path it is the `base`
    argument.
  - A `--push` or `--local` ship can be published afterwards with
    `approve <id> --pr` — on a task already in `completed/` that re-runs **only**
    the publish step. The flag is what asks for it: a bare `approve <id>` on a
    finished task still just reports that it already moved, and pushes nothing.
<!-- /aw:verb approve -->
<!-- aw:verb replan -->
- **`replan [id] [reason]`** — the sole rejection verb, and it chains the
  re-plan: what the gate wants is a REVISED plan, not a task idling in
  `queued/`. **The rejection half is handled by the hook before your turn** —
  it records the reason in the audit note and moves the parked plan (or a
  cap-tripped `in-progress/` task, by id) to `queued/` marked plan-next — and
  the outcome message above is your cue to drive ONE PLAN pass now:
  - Take the task id from the outcome message and call
    `mcp__agentic-workflow__workflow_start({id})` — it claims the queued task and
    starts at PLAN (no git isolation); the rejection reason is threaded into
    the PLAN prompt. Spawn `workflow-plan-author` (`agent` tool) with the
    returned prompt, then `workflow_advance` — the revised plan
    parks in `plan-review/` and the plan gate goes live again: ask the user
    inline (`ask_user_question` — Approve / Replan / Park for later, per the
    `workflow-orchestration` skill).
  - **Do nothing else** — no build, no other task. If `workflow_start`
    refuses (another loop is live), report that the task is queued plan-next —
    the next `claim` re-plans it first — and stop.
  - No outcome message means the hook never ran: call
    `mcp__agentic-workflow__workflow_reject({id, reason})` (id optional) first,
    then run the same single PLAN pass.
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
<!-- aw:verb approve|plan -->
- **`plan <id>`** — plan one approved task now. Call
  `mcp__agentic-workflow__workflow_start({id})` on the `queued/` task — it starts at
  PLAN (no git isolation): spawn `workflow-plan-author` (`agent` tool)
  with the returned prompt, then
  `workflow_advance` — the task parks in `plan-review/` and
  the plan gate goes live: ask the user inline (`ask_user_question` — Approve /
  Replan / Park for later, per the `workflow-orchestration` skill) instead of
  only telling them which command to run. That ask is not left to this prose:
  the park is followed by a **`PLAN GATE`** block the harness emits beside the
  result, carrying the same question with the ids and tool names filled in —
  obey it. If the id is already build-ready
  (`in-progress/`), don't start it here — `claim` builds it.
<!-- /aw:verb approve|plan -->
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
  `agent` tool)
  and `workflow_advance` after
  each returns, until a terminal action. This is the pull equivalent of the
  OpenCode plugin's `watch` — there is no standing watch mode on this
  substrate.
<!-- /aw:verb claim -->
<!-- aw:verb recover -->
- **`recover <id>`** — call `mcp__agentic-workflow__workflow_recover({id})` and
  resume driving from the action it returns: `workflow_stage`, then spawn the
  subagent it names with the `agent` tool. If it refuses because
  the claim's holder may still be alive, report its reason as given — the wait
  is deliberate, and a second loop on one branch is what it prevents. Never
  delete a claim marker by hand; `workflow_doctor({fix: true})` is the repair.
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
<!-- aw:verb approve|new|retask|plan|claim|recover|replan -->
Read the `workflow-orchestration` skill now — it is the authoritative protocol
for how you (the main agent) drive the stages and how verdicts terminate the
loop. It is scoped to these verbs on purpose: `status`, `kinds`, `doctor`,
`stop` and the other gate verbs never drive a stage, and the skill is larger
than this whole command.

The flow: `new` (interview → draft) → human reviews the draft (reshape with
`retask <id>` if it's off) → approve queues it (asked inline right after
drafting, or `approve <id>` later) → plan it (asked inline in the same
breath, or `plan <id>` later) and parks the plan in `plan-review/` →
human reviews the plan → approve (asked inline, or `replan <why>`) → build it
(asked inline as a separate question, or `claim` later) → `in-review/` →
`approve` ships it.
<!-- /aw:verb approve|new|retask|plan|claim|recover|replan -->
<!-- aw:verb approve|new|retask|plan|claim -->
When a loop you are driving hits a gate live (a draft just written, a plan
just parked, or a build just finished), offer the gate choices inline via
`ask_user_question` instead of making the user type a command — the
`workflow-orchestration` skill covers the plan and ship gates. The command
verbs above are the deferred path for gates hit while you were away.
<!-- /aw:verb approve|new|retask|plan|claim -->
