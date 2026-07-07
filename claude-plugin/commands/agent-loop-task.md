---
description: Author a backlog task by interviewing the user, approve it into the queue, gate its plan, or send it back for re-planning
argument-hint: new <idea> | approve <id> | approve-plan <id> | replan <id> [reason]
---

Task authoring and the human gates for the agentic loop — the loop itself
(`/agent-loop`) plans a queued task right before execution and parks the plan
here for review.

**Argument:** `$ARGUMENTS`

Dispatch:

- **`new <idea>`** — turn a rough idea into a **planless draft** in
  `docs/tasks/draft/`. YOU (the main agent) run the interview — subagents
  cannot converse with the user:
  1. **Always** invoke the `interview-me` skill first (never silently skip):
     if the idea already states a clear goal and testable criteria, a single
     restate-and-confirm question suffices; when anything is vague, run the
     full one-question-at-a-time interview. Pin down the goal and 2–5
     testable acceptance criteria.
  2. Show the drafted task (title, priority, acceptance, body) and get an
     explicit "looks right" from the user.
  3. Spawn the **`loop-plan-author`** subagent (Task tool) with the
     confirmed details to write the single draft file. No plan is written
     now — the loop's PLAN stage plans the task right before execution, so
     plans don't rot while the task sits parked. The next step is
     `/agent-loop-task approve <id>`.
  - **Project-management pairing** — when `.agentic-loop.json` has a
    `projectManagement` section, pre-fill the draft's `tracker` block so the
    task is ready to pair with the team's tracker: set `tracker.system` to the
    configured `system` (jira / azure-devops) and `type` to `defaultType`, and
    ask the user for the Jira issue key / ADO work item id to put in
    `tracker.key`. Pairing is optional — if they don't have one, leave
    `tracker` off; the task queues and runs unpaired.
- **`approve <id>`** — the task gate. Call
  `mcp__agentic-loop__loop_task_approve({id})` — it moves the reviewed draft
  to `docs/tasks/queued/` (audited note + commit). No plan is required — the
  loop plans it on claim. **Spawn nothing and write nothing** — report the
  tool's outcome and stop.
- **`approve-plan <id>`** — the plan gate. Call
  `mcp__agentic-loop__loop_plan_approve({id})` — it validates the
  `plan-review/` task has an `## Implementation Plan`, moves it to
  `docs/tasks/in-progress/` (the build-ready queue), appends an audited
  note, and commits. **Spawn nothing and write nothing** — report the
  outcome and stop.
- **`replan <id> [reason]`** — reject a parked plan, or send a cap-tripped
  `in-progress/` task back. Call
  `mcp__agentic-loop__loop_replan({id, reason})` — the task moves back to
  `queued/` with an audited rejection note; the next PLAN pass must address
  it. **Spawn nothing and write nothing** — report the outcome and stop.

The flow: `new` (interview → draft) → human reviews the draft → `approve
<id>` queues it → `/agent-loop task <id>` (or `claim`) plans it and parks the
plan in `plan-review/` → human reviews the plan → `approve-plan <id>` (or
`replan <id> <why>`) → `/agent-loop` builds it.

These verbs are the **deferred** path — approving a task that parked earlier.
When a loop you are driving hits a gate live (a plan just parked, or a build
just finished), the `loop-orchestration` skill has you offer the same choices
inline via AskUserQuestion instead of making the user type a command.

Never move, create, or delete files under `docs/tasks/` yourself — no Bash
`mv`/`mkdir`/`rm`, no direct writes into status folders (a PreToolUse hook
blocks them). The MCP tools own every backlog move.
