---
description: The engineering loop — author tasks, gate them, and drive them through plan → build → verify → review
argument-hint: new <idea> | retask <id> [note] | approve [id] | replan [id] [reason] | remove <id> | plan <id> | claim | recover <id> | kinds | doctor [fix] | stop | status
---

You are about to work the **engineering agentic loop** (typed as
`/agentic-workflow:engineering`) — one command for task authoring, the human
gates, and execution over the task queues. The loop plans a queued task on
demand via `plan <id>` (and parks the plan for the human gate); `claim` builds
plan-approved tasks only. Read the `workflow-orchestration` skill now — it is the
authoritative protocol for how you (the main agent) drive the stages and how
verdicts terminate the loop. Then act on the argument below. (The PR sitter
has its own command: `/agentic-workflow:pr-sitter`.)

**Argument:** `$ARGUMENTS`

**Read the verb from the FIRST whitespace-delimited token of the argument;
everything after it is that verb's literal payload.** Match only that first
token against the verb list below. A verb-like word (`plan`, `status`,
`approve`, `replan`, `claim`, `doctor`, `retask`, `new`, …) appearing *inside*
the payload is part of the idea/note/reason, never the verb — e.g.
`new add a status dashboard` is the `new` verb with idea "add a status
dashboard", not `status`.

Dispatch:

## Authoring (you run the interview)

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
  4. Spawn the **`workflow-plan-author`** subagent (Task tool) once with the
     confirmed set to write the draft file(s) — one draft, or N child drafts
     plus one epic tracking file. No plan is written now — the loop's PLAN
     stage plans each task right before execution, so plans don't rot while it
     sits parked. The next step is the task gate (step 5 below), asked inline
     per child.
     - **The epic file is a tracking draft only** (frontmatter `type: epic`,
       body listing the children in order). **Never approve it** — an
       un-approved draft is inert, so the loop never claims it. Close it by
       hand with `mcp__agentic-workflow__workflow_move` (to `abandoned/` or
       `completed/`) once every child has shipped.
  5. **Task gate — ask, don't require a command.** For each non-epic drafted
     child (skip the epic tracking file — never approve it), ask with
     **AskUserQuestion**: "Approve `<id>` now?"
     - **Approve** → call `mcp__agentic-workflow__workflow_approve({id})` directly
       (task gate: `draft/` → `queued/`) — the user does not need to type
       `/agentic-workflow:engineering approve <id>`. Then ask a second
       **AskUserQuestion**: "Plan it now?"
       - **Yes** → follow the `plan <id>` procedure below: `workflow_start({id})`,
         spawn `workflow-plan-author` (task mode) with the returned prompt, then
         `workflow_advance` — the task parks in `plan-review/` and the plan gate
         goes live (offer Approve / Replan / Park, per the
         `workflow-orchestration` skill).
       - **No** → stop; `/agentic-workflow:engineering plan <id>` plans it later
         (`claim` never auto-plans a queued task).
     - **Not yet** → leave it in `draft/`; `/agentic-workflow:engineering approve
       <id>` (or `retask <id>`) resumes it later.
  - **Project-management pairing** — when `.agentic-workflow.json` has a
    `projectManagement` section, pre-fill the draft's `tracker` block so the
    task is ready to pair with the team's tracker: set `tracker.system` to the
    configured `system` (jira / azure-devops) and `type` to `defaultType`, and
    ask the user for the Jira issue key / ADO work item id to put in
    `tracker.key`. Pairing is optional — if they don't have one, leave
    `tracker` off; the task queues and runs unpaired.
- **`retask <id> [note]`** — reshape a planless task when the drafted goal or
  acceptance came out wrong: one still in `draft/`, or one already approved
  into `queued/` but not yet planned. YOU (the main agent) run the interview,
  same as `new`:
  1. The plugin has already run the deterministic half before your turn: a
     `queued/` task was moved **back to `draft/`** (its approval withdrawn — the
     reshaped goal has to be re-approved), and a task from `plan-review/` onward
     was refused outright. So resolve `<id>` in `docs/tasks/draft/` **only**. If
     it isn't there, the id is wrong — say so and stop. (Fallback when the hook
     didn't run: `mcp__agentic-workflow__workflow_retask({id})` first.)
  2. Read the existing draft and show its current title, priority, acceptance,
     body (and any `tracker` block) to the user.
  3. **Always** invoke the `interview-me` skill to reshape it, seeding it with
     the optional `note` and the current draft. Re-confirm the goal and 2–5
     testable acceptance criteria, then get an explicit "looks right".
  4. Spawn the **`workflow-plan-author`** subagent (Task tool) in **`retask` mode**
     with the id and the confirmed title/priority/acceptance/body (carry
     forward the `tracker` block if the draft had one) to rewrite
     `docs/tasks/draft/<id>.md` **in place** — the id/filename never changes.
     Still no plan. The next step is the same task-gate ask as `new` step 5
     above (approve inline, then ask to plan immediately).

## Human gates (deterministic — handled by the plugin's hook before your turn)

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
- **`replan [id] [reason]`** — the sole rejection verb: send a parked plan
  (or a cap-tripped `in-progress/` task, by id) back to `queued/` for
  re-planning. **Handled by the same hook**; the reason is recorded in the
  audit note. (Fallback: `mcp__agentic-workflow__workflow_reject({id, reason})`, id
  optional.)
- **`remove <id>`** — hard-delete a task from the backlog entirely. Unlike
  replan/retask this does **not** move the task to another folder: the file is
  deleted and the removal committed, so the task is gone from the backlog for
  good (git history retains it if the backlog is tracked). Works from **any**
  status folder — a stale draft, a rejected plan, a finished task. **Handled by
  the same hook** as approve/replan; an id is required (a bare `remove` never
  guesses which task to delete). Core refuses a task a live loop is driving or
  one holding a claim marker, and releases any worktree the task owned.
  (Fallback: `mcp__agentic-workflow__workflow_remove({id})`.) **Destructive and
  cannot be undone from the working tree** — only run it when the user
  explicitly wants the task gone; confirm the id first.

**Verify before you report a gate.** A gate verb reaching you means the hook
failed open — run the MCP fallback tool; if it is unavailable, the plugin's
MCP server is not built. Either way, only report the gate as done after
observing the task file in its **target** folder (glob `docs/tasks/*/<id>*`).
File still in its old folder ⇒ nothing moved — report that the plugin isn't
built/running (fix: run `plugins/claude/install.sh`, restart the session) and
never claim the approval happened.

## Execution

- **`plan <id>`** — plan one approved task now. Call
  `mcp__agentic-workflow__workflow_start({id})` on the `queued/` task — it starts at
  PLAN (no git isolation): spawn `workflow-plan-author` in task mode with the
  returned prompt, then `workflow_advance` — the task parks in `plan-review/` and
  the plan gate goes live: ask the user inline (AskUserQuestion — Approve /
  Replan / Park for later, per the `workflow-orchestration` skill) instead of
  only telling them which command to run. If the id is already build-ready
  (`in-progress/`), don't start it here — `claim` builds it.
- **`claim`** — call `mcp__agentic-workflow__workflow_claim` to pick up the next
  engineering item and drive it: build-ready `in-progress/` tasks only,
  lowest priority number first — planless `queued/` tasks are never
  auto-planned (use `plan <id>`). An `in-progress/`
  task starts at BUILD on `feature/<id>`; follow the `workflow-orchestration`
  protocol: `workflow_stage` before spawning each stage subagent (`workflow-build` /
  `workflow-verify` / `workflow-review` via the Task tool, passing the response's
  `model` as the Task tool's `model` when present) and `workflow_advance` after
  each returns, until a terminal action. This is the pull equivalent of the
  OpenCode plugin's `watch` — there is no standing watch mode on this
  substrate.
- **`recover <id>`** — call `mcp__agentic-workflow__workflow_recover({id})` and
  resume driving from the action it returns.
- **`stop`** (alias: `abort`) — call `mcp__agentic-workflow__workflow_stop` to abort
  the active loop (partial work stays committed on the loop branch).

## Introspection

- **`status`** (or bare) — call `mcp__agentic-workflow__workflow_status` and report
  the active loop plus the backlog roll-up and the workflow kinds. When a
  `projectManagement` tracker is configured, the result also carries a
  `pairing` block (tracker system, paired count, unpaired task ids) —
  surface which active tasks still need to be paired to a Jira/ADO item.
- **`kinds`** — report the workflow kinds from `workflow_status`'s `kinds` block
  (enabled/disabled per `workflows.<kind>.enabled` in `.agentic-workflow.json`; each
  enabled kind has its own `/agentic-workflow:<kind>` command).
- **`doctor [fix]`** — call `mcp__agentic-workflow__workflow_doctor({fix})` to audit
  the backlog for structural damage (stray folders, task files outside every
  status folder, duplicate ids, held claim markers); with `fix` it applies
  the unambiguous repairs. Never repair the backlog by hand.
- **anything else** (including a free-text goal) — do not run it. Show this
  usage instead.

The flow: `new` (interview → draft) → human reviews the draft (reshape with
`retask <id>` if it's off) → approve queues it (asked inline right after
drafting, or `approve <id>` later) → plan it (asked inline in the same
breath, or `plan <id>` later) and parks the plan in `plan-review/` →
human reviews the plan → approve (asked inline, or `replan <why>`) → build it
(asked inline as a separate question, or `claim` later) → `in-review/` →
`approve` ships it.

On a VERIFY or REVIEW FAIL the loop re-**builds** with the feedback threaded
in, within the iteration cap; when the cap trips, the plan itself is suspect
— a human sends it back with `/agentic-workflow:engineering replan <id> <why>`
and the next PLAN pass addresses the failure.

When a loop you are driving hits a gate live (a draft just written, a plan
just parked, or a build just finished), offer the gate choices inline via
AskUserQuestion instead of making the user type a command — see `new` step 5
above for the task gate, and the `workflow-orchestration` skill for the plan and
ship gates. The command verbs above are the deferred path for gates hit
while you were away.

Do not invent your own control flow — the `workflow-orchestration` skill defines
the exact sequence of tool calls and Task spawns. The MCP tools own the state
machine, git isolation, verdicts, backlog moves, snapshots, and metrics; you
own spawning the stage subagents.

Never touch `docs/tasks/**` directly — no Bash `mv`/`mkdir`/`rm`/redirects
into it, no Write/Edit of files in status folders (a PreToolUse hook blocks
these; the gate hook and the MCP tools own every backlog move). The folder a
task file lives in IS its state. If the backlog looks damaged, run `doctor`.
