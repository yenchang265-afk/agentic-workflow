---
description: Draft a backlog task by interviewing the user, plan it, or approve the plan for execution by /agent-loop
argument-hint: new <idea> | task <id> | approve <id>
---

Plan authoring for the agentic loop — planning happens **here**, before the
loop; `/agent-loop` only executes approved plans.

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
  2. Follow the Azure DevOps linkage protocol in the
     `task-backlog-management` skill (ask; skip gracefully if that MCP
     server is not connected).
  3. Show the drafted task (title, priority, acceptance, body) and get an
     explicit "looks right" from the user.
  4. Spawn the **`loop-plan-author`** subagent (Task tool) with the
     confirmed details to write the single draft file. Drafting and planning
     are two steps by design — the human reviews the draft before plan
     effort is spent. The next step is `/agent-loop-plan task <id>`.
- **`task <id>`** — plan a task. Call
  `mcp__agentic-loop__loop_plan_task({id})` **first** — it deterministically
  moves a `draft/` task to `docs/tasks/in-planning/` (audited + committed)
  before any planning happens. Then spawn **`loop-plan-author`** (Task tool)
  in `task` mode to read the task and the relevant code and write its
  `## Implementation Plan` onto that same file in place. Use this after
  reviewing a draft, for `/explore`-filed drafts, and to re-plan a task
  whose loop hit the iteration cap.
- **`approve <id>`** — call `mcp__agentic-loop__loop_plan_approve({id})`.
  The server validates the task has an `## Implementation Plan`, moves it to
  `docs/tasks/in-progress/` (the approved queue), appends an audited note,
  and commits. **Spawn nothing and write nothing** — report the tool's
  outcome (approved / no plan yet / not found) and stop.

The flow is two-step by design: `new` (interview → draft) → human reviews →
`task <id>` (plan written) → human reviews the plan → `approve <id>` → then
`/agent-loop task <id>` or `/agent-loop claim` executes it.
