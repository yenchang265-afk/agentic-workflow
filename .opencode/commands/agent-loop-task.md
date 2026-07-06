---
description: Author a backlog task by interviewing you, approve it into the queue, gate its plan, or send it back for re-planning
argument-hint: new <idea> | approve <id> | approve-plan <id> | replan <id> [reason]
---

Task authoring and the human gates for the agentic loop — the loop itself
(`/agent-loop`) plans a queued task right before execution and parks the plan
here for your review.

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
     write the single draft file. No plan is written now — the loop's PLAN
     stage plans the task right before execution, so plans don't rot while
     the task sits parked. The next step is `/agent-loop-task approve <id>`.
- **`approve <id>`** — the task gate. The plugin handles this
  deterministically **before** this turn starts: it moves the reviewed draft
  to `docs/tasks/queued/` (audited note + commit). No plan is required — the
  loop plans it on claim. **Invoke nothing, write nothing** — report the
  toast's outcome and stop.
- **`approve-plan <id>`** — the plan gate. Handled deterministically before
  this turn: validates the `plan-review/` task has an
  `## Implementation Plan`, moves it to `docs/tasks/in-progress/` (the
  build-ready queue `/agent-loop watch` claims from), appends an audited note,
  and commits. **Invoke nothing, write nothing** — report the outcome and stop.
- **`replan <id> [reason]`** — reject a parked plan (or send a cap-tripped
  `in-progress/` task back). Handled deterministically before this turn: the
  task moves back to `queued/` with an audited rejection note carrying your
  reason; the next PLAN pass must address it. **Invoke nothing, write
  nothing** — report the outcome and stop.

The flow: `new` (interview → draft) → human reviews the draft → `approve
<id>` parks it in the queue → `/agent-loop` (task or watch) plans it and parks
the plan in `plan-review/` → human reviews the plan → `approve-plan <id>`
(or `replan <id> <why>`) → `/agent-loop` builds it.

Never move, create, or delete files under `docs/tasks/` yourself — no bash
`mv`/`mkdir`/`rm`, no direct writes into status folders (the plugin blocks
them). The folder a task lives in IS its state; these verbs and the loop own
every move. If the backlog looks damaged, run `/agent-loop doctor`.
