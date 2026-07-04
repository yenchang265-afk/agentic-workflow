---
description: Drive an engineering goal through the agentic loop (plan → build → verify → review) with a human plan gate
argument-hint: <goal> | next | status | ship <id> | recover <id>
---

You are about to drive the **agentic loop**. Read the `loop-orchestration` skill
now — it is the authoritative protocol for how you (the main agent) drive the
stages, where the human gate is, and how verdicts terminate the loop. Then act on
the argument below.

**Argument:** `$ARGUMENTS`

Dispatch:

- **empty / a `<goal>`** — start a loop. If the goal is underspecified, run the
  `interview-me` skill first to sharpen it. Then call
  `mcp__agentic-loop__loop_start` and follow the `loop-orchestration` protocol:
  spawn `loop-plan` (Task tool) with the returned prompt, show the plan and
  **pause for the human at the gate**, then on approval call `loop_approve` and
  drive BUILD → VERIFY → REVIEW, calling `loop_stage`/`loop_advance` between
  stages and spawning `loop-build` / `loop-verify` / `loop-review` for each.
- **`next`** — call `mcp__agentic-loop__loop_next`; if it returns a task, start
  the loop on it via `loop_start({taskId})`.
- **`status`** — call `mcp__agentic-loop__loop_status` and report the active loop
  plus the backlog roll-up.
- **`ship <id>`** — call `mcp__agentic-loop__loop_ship({id})` to move a reviewed
  task from `in-review/` to `completed/`.
- **`recover <id>`** — call `mcp__agentic-loop__loop_recover({id})` and resume
  driving from the action it returns.

Do not invent your own control flow — the `loop-orchestration` skill defines the
exact sequence of tool calls and Task spawns. The MCP tools own the state
machine, git isolation, verdicts, backlog moves, snapshots, and metrics; you own
spawning the stage subagents and pausing for the human at the plan gate.
