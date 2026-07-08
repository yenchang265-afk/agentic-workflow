---
description: Author a backlog task by interviewing the user, reshape a draft, approve it into the queue, gate its plan, or send it back for re-planning
argument-hint: new <idea> | retask <id> [note] | approve <id> | approve-plan <id> | replan <id> [reason]
---

Task authoring and the human gates for the agentic loop — the loop itself
(`/agent-loop`) plans a queued task right before execution and parks the plan
here for review.

**Argument:** `$ARGUMENTS`

Dispatch:

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
  4. Spawn the **`loop-plan-author`** subagent (Task tool) once with the
     confirmed set to write the draft file(s) — one draft, or N child drafts
     plus one epic tracking file. No plan is written now — the loop's PLAN
     stage plans each task right before execution, so plans don't rot while it
     sits parked. The next step is `/agent-loop-task approve <id>` per child.
     - **The epic file is a tracking draft only** (frontmatter `type: epic`,
       body listing the children in order). **Never approve it** — an
       un-approved draft is inert, so the loop never claims it. Close it by
       hand with `mcp__agentic-loop__loop_move` (to `abandoned/` or
       `completed/`) once every child has shipped.
  - **Project-management pairing** — when `.agentic-loop.json` has a
    `projectManagement` section, pre-fill the draft's `tracker` block so the
    task is ready to pair with the team's tracker: set `tracker.system` to the
    configured `system` (jira / azure-devops) and `type` to `defaultType`, and
    ask the user for the Jira issue key / ADO work item id to put in
    `tracker.key`. Pairing is optional — if they don't have one, leave
    `tracker` off; the task queues and runs unpaired.
- **`retask <id> [note]`** — reshape a `draft/` task before you approve it,
  when the drafted goal or acceptance came out wrong. YOU (the main agent) run
  the interview, same as `new` — subagents cannot converse with the user:
  1. Resolve `<id>` in `docs/tasks/draft/` **only**. If it isn't there (it's
     already queued/planned, or missing), refuse: "only drafts can be
     re-tasked — a parked plan uses `/agent-loop-task replan <id>`" and stop.
  2. Read the existing draft and show its current title, priority, acceptance,
     body (and any `tracker` block) to the user.
  3. **Always** invoke the `interview-me` skill to reshape it, seeding it with
     the optional `note` and the current draft. Re-confirm the goal and 2–5
     testable acceptance criteria, then get an explicit "looks right".
  4. Spawn the **`loop-plan-author`** subagent (Task tool) in **`retask` mode**
     with the id and the confirmed title/priority/acceptance/body (carry
     forward the `tracker` block if the draft had one) to rewrite
     `docs/tasks/draft/<id>.md` **in place** — the id/filename never changes.
     Still no plan. The next step is unchanged: `/agent-loop-task approve <id>`.
- **`approve <id>`** — the task gate. **Handled deterministically by the
  plugin's `UserPromptSubmit` hook before this turn starts** — it moves the
  reviewed draft to `docs/tasks/queued/` (audited note + commit) and blocks the
  turn, so you normally never see this command. No plan is required — the loop
  plans it on claim. **Spawn nothing and write nothing** — just report the
  outcome and stop. (Fallback: if the hook is unavailable, call
  `mcp__agentic-loop__loop_task_approve({id})`, which performs the same move.)
- **`approve-plan <id>`** — the plan gate. **Handled deterministically by the
  hook before this turn** — it validates the `plan-review/` task has an
  `## Implementation Plan`, moves it to `docs/tasks/in-progress/` (the
  build-ready queue), appends an audited note, and commits. **Spawn nothing and
  write nothing** — report the outcome and stop. (Fallback:
  `mcp__agentic-loop__loop_plan_approve({id})`.)
- **`replan <id> [reason]`** — reject a parked plan, or send a cap-tripped
  `in-progress/` task back. **Handled deterministically by the hook before this
  turn** — the task moves back to `queued/` with an audited rejection note; the
  next PLAN pass must address it. **Spawn nothing and write nothing** — report
  the outcome and stop. (Fallback: `mcp__agentic-loop__loop_replan({id, reason})`.)

The flow: `new` (interview → draft) → human reviews the draft (reshape it with
`retask <id>` if it's off) → `approve <id>` queues it → `/agent-loop task <id>`
(or `claim`) plans it and parks the plan in `plan-review/` → human reviews the
plan → `approve-plan <id>` (or `replan <id> <why>`) → `/agent-loop` builds it.

These verbs are the **deferred** path — approving a task that parked earlier.
When a loop you are driving hits a gate live (a plan just parked, or a build
just finished), the `loop-orchestration` skill has you offer the same choices
inline via AskUserQuestion instead of making the user type a command.

Never move, create, or delete files under `docs/tasks/` yourself — no Bash
`mv`/`mkdir`/`rm`, no direct writes into status folders (a PreToolUse hook
blocks them). The gate hook and the MCP tools own every backlog move.
