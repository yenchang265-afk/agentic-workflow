---
description: Execute approved backlog tasks through the agentic loop (build → verify → review)
argument-hint: task <id> | claim | status | ship <id> | recover <id> | stop
---

You are about to drive the **agentic loop** — a pure executor over the
approved queue (`docs/tasks/in-progress/`). Planning and approval happen in
`/agent-loop-plan`, before the loop; there is no free-text goal mode and no in-loop
plan gate. Read the `loop-orchestration` skill now — it is the authoritative
protocol for how you (the main agent) drive the stages and how verdicts
terminate the loop. Then act on the argument below.

**Argument:** `$ARGUMENTS`

Dispatch:

- **`task <id>`** — execute one approved task now. Call
  `mcp__agentic-loop__loop_start({id})` (it claims the task, isolates
  execution on `loop/<id>`, and returns the BUILD prompt), then follow the
  `loop-orchestration` protocol: call `loop_stage` before spawning each
  stage subagent (`loop-build` / `loop-verify` / `loop-review` via the Task
  tool) and `loop_advance` after each returns, until a terminal action.
- **`claim`** — call `mcp__agentic-loop__loop_claim` to pick up the next
  approved task (lowest priority number first) and drive it the same way.
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
  that planning moved to `/agent-loop-plan new <idea>` and show this usage.

On a VERIFY or REVIEW FAIL the loop re-**builds** with the feedback threaded
in, within the iteration cap; when the cap trips, the plan itself is suspect
— a human re-plans with `/agent-loop-plan task <id>` and re-approves.

Do not invent your own control flow — the `loop-orchestration` skill defines
the exact sequence of tool calls and Task spawns. The MCP tools own the state
machine, git isolation, verdicts, backlog moves, snapshots, and metrics; you
own spawning the stage subagents.
