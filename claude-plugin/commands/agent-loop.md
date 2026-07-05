---
description: Drive backlog tasks through the agentic loop (plan → build → verify → review)
argument-hint: task <id> | claim | status | ship <id> | recover <id> | stop
---

You are about to drive the **agentic loop** over the task queues. Task
authoring and both human gates live in `/agent-loop-task`; the loop plans a
queued task right before execution (and parks the plan for the human gate)
or builds a plan-approved task. Read the `loop-orchestration` skill now — it
is the authoritative protocol for how you (the main agent) drive the stages
and how verdicts terminate the loop. Then act on the argument below.

**Argument:** `$ARGUMENTS`

Dispatch:

- **`task <id>`** — run one task now. Call
  `mcp__agentic-loop__loop_start({id})`. A `queued/` task starts at PLAN (no
  git isolation): spawn `loop-plan-author` in task mode with the returned
  prompt, then `loop_advance` — the task parks in `plan-review/` and the
  loop ends there. An `in-progress/` task starts at BUILD on `loop/<id>`;
  follow the `loop-orchestration` protocol: `loop_stage` before spawning
  each stage subagent (`loop-build` / `loop-verify` / `loop-review` via the
  Task tool) and `loop_advance` after each returns, until a terminal action.
- **`claim`** — call `mcp__agentic-loop__loop_claim` to pick up the next
  task and drive it the same way. Build-ready `in-progress/` tasks win over
  planless `queued/` ones; within each pool, lowest priority number first.
  This is the pull equivalent of the OpenCode plugin's `/agent-loop watch` —
  there is no standing watch mode on this substrate.
- **`status`** — call `mcp__agentic-loop__loop_status` and report the active
  loop plus the backlog roll-up.
- **`ship <id>`** — call `mcp__agentic-loop__loop_ship({id})` to move a
  reviewed task from `in-review/` to `completed/`. Do this only after the
  human has reviewed the branch diff.
- **`recover <id>`** — call `mcp__agentic-loop__loop_recover({id})` and
  resume driving from the action it returns.
- **`stop`** — call `mcp__agentic-loop__loop_stop` to abort the active loop
  (partial work stays committed on the loop branch).
- **anything else** (including a free-text goal) — do not run it. Explain
  that task authoring moved to `/agent-loop-task new <idea>` and show this
  usage.

On a VERIFY or REVIEW FAIL the loop re-**builds** with the feedback threaded
in, within the iteration cap; when the cap trips, the plan itself is suspect
— a human sends it back with `/agent-loop-task replan <id> <why>` and the
next PLAN pass addresses the failure.

Do not invent your own control flow — the `loop-orchestration` skill defines
the exact sequence of tool calls and Task spawns. The MCP tools own the state
machine, git isolation, verdicts, backlog moves, snapshots, and metrics; you
own spawning the stage subagents.
