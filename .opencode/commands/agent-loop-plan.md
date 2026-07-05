---
description: Draft a backlog task by interviewing you, plan it, or approve the plan for execution by /agent-loop
argument-hint: new <idea> | task <id> | approve <id>
---

Plan authoring for the agentic loop — planning happens **here**, before the
loop; `/agent-loop` only executes approved plans.

**Argument:** `$ARGUMENTS`

Dispatch:

- **`new <idea>`** — turn a rough idea into a **planless draft** in
  `docs/tasks/draft/`. YOU (the current agent) run the interview — subagents
  cannot converse with the user:
  1. **Always** invoke the `interview-me` skill first (never silently skip):
     if the idea already states a clear goal and testable criteria, a single
     restate-and-confirm question suffices; when anything is vague, run the
     full one-question-at-a-time interview. Pin down the goal and 2–5
     testable acceptance criteria.
  2. Show the drafted task (title, priority, acceptance, body) and get an
     explicit "looks right" from the user.
  3. Invoke the **`loop-plan-author`** subagent with the confirmed details to
     write the single draft file. Drafting and planning are two steps by
     design — the human reviews the draft before plan effort is spent. The
     next step is `/agent-loop-plan task <id>`.
- **`task <id>`** — plan a task (`<id>` = filename without `.md`). The plugin
  first moves a `docs/tasks/draft/` task to `docs/tasks/in-planning/`
  (audited + committed) **before** this turn; then invoke **`loop-plan-author`**
  in `task` mode to read the task and the relevant code and write its
  `## Implementation Plan` onto that same file in place. Use this after
  reviewing a draft, for `/explore`-filed drafts, and to re-plan a task
  whose loop hit the iteration cap.
- **`approve <id>`** — the plugin handles this deterministically **before**
  this turn starts: it validates the task has an `## Implementation Plan`,
  moves it to `docs/tasks/in-progress/` (the approved queue
  `/agent-loop watch` claims from), appends an audited note, and commits.
  **Invoke nothing, write nothing** — report the toast's outcome (approved /
  no plan yet / not found) and stop.

The flow is two-step by design: `new` (interview → draft) → human reviews →
`task <id>` (plan written) → human reviews the plan → `approve <id>` → then
`/agent-loop task <id>` or `/agent-loop watch` executes it.
