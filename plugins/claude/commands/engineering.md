---
description: The engineering loop — author tasks, gate them, and drive them through plan → build → verify → review
argument-hint: new <idea> | retask <id> [note] | approve [id] | replan [id] [reason] | abandon <id> [reason] | remove <id> --force | plan <id> | claim | recover <id> | kinds | doctor [fix] | stop | status
---

You are about to work the **engineering agentic loop** (typed as
`/agentic-workflow:engineering`) — one command for task authoring, the human
gates, and execution over the task queues. The loop plans a queued task on
demand via `plan <id>` (and parks the plan for the human gate); `claim` builds
plan-approved tasks only. Act on the argument below. (The PR sitter has its own
command: `/agentic-workflow:pr-sitter`.)

**Argument:** `$ARGUMENTS`

**Read the verb from the FIRST whitespace-delimited token of the argument;
everything after it is that verb's literal payload.** Match only that first
token against the verb list below. A verb-like word (`plan`, `status`,
`approve`, `replan`, `claim`, `doctor`, `retask`, `new`, …) appearing *inside*
the payload is part of the idea/note/reason, never the verb — e.g.
`new add a status dashboard` is the `new` verb with idea "add a status
dashboard", not `status`.

The **procedure** for the invoked verb is injected into this turn by the
plugin's `UserPromptSubmit` hook, as a block headed **VERB INSTRUCTIONS**.
That block is authoritative — follow it, and ignore any other verb's
description. The index below exists only so you can tell which verb you are
on and who does the work; it is deliberately not a procedure.

- **`approve [id]`** / **`replan [id] [reason]`** / **`remove <id>`** — the gate
  verbs: forward gate, reject back to `queued/`, hard-delete (destructive).
  **All three are the hook's, done before your turn.**
- **`retask <id> [note]`** — reshape a planless draft. The move is the hook's;
  the interview is **yours**.
- **`new <idea>`** — interview into planless draft(s); **`plan <id>`** — run
  PLAN on one approved task and park the plan; **`claim`** — drive the next
  task (BUILD → VERIFY → REVIEW, else one to plan); **`recover <id>`** — resume
  a run that stopped early; **`stop`** (alias `abort`) — abort the active loop;
  **`status`** (or bare) — loop + backlog roll-up; **`kinds`** — enabled
  workflow kinds; **`doctor [fix]`** — audit (with `fix`, repair) the backlog.
  **All yours.**
- **anything else** (including a free-text goal) — do not run it. Show this usage instead.

**If no VERB INSTRUCTIONS block reached you — or it names a different verb —
the plugin's hooks are not running.** Do NOT improvise the procedure and do
NOT touch the backlog: say the hooks are inactive, name the fix (run
`plugins/claude/install.sh`, restart the session, then check `/hooks`), and stop.

**Verify before you report a gate.** A gate verb reaching you means the gate
hook failed open — run the MCP fallback tool (unavailable ⇒ the MCP server is
not built). Either way, report the gate as done only after observing the task
file in its **target** folder (glob `docs/tasks/*/<id>*`); still in the old
folder ⇒ nothing moved — say the plugin isn't built/running (same fix as
above) and never claim the approval happened.

Do not invent your own control flow — the `workflow-orchestration` skill defines
the exact sequence of tool calls and Task spawns. The MCP tools own the state
machine, git isolation, verdicts, backlog moves, snapshots, and metrics; you
own spawning the stage subagents — always with the Task tool, and always passing
the response's `model` field as the Task tool's `model` when present.

Never touch `docs/tasks/**` directly — no Bash `mv`/`mkdir`/`rm`/redirects
into it, no Write/Edit of files in status folders (a PreToolUse hook blocks
these; the gate hook and the MCP tools own every backlog move). The folder a
task file lives in IS its state. If the backlog looks damaged, run `doctor`.
