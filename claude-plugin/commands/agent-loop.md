---
description: Drive backlog tasks through the agentic loop (plan → build → verify → review)
argument-hint: task <id> | claim | status | ship <id> | recover <id> | doctor [fix] | stop
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
  plan gate goes live: ask the user inline (AskUserQuestion — Approve /
  Replan / Park for later, per the `loop-orchestration` skill) instead of
  only telling them which command to run. An `in-progress/` task starts at
  BUILD on `feature/<id>`;
  follow the `loop-orchestration` protocol: `loop_stage` before spawning
  each stage subagent (`loop-build` / `loop-verify` / `loop-review` via the
  Task tool) and `loop_advance` after each returns, until a terminal action.
- **`claim`** — call `mcp__agentic-loop__loop_claim` to pick up the next
  item and drive it the same way. It polls **all enabled loop kinds** in
  claim-priority order: the engineering backlog first (build-ready
  `in-progress/` tasks win over planless `queued/` ones; within each pool,
  lowest priority number first), then kinds enabled in `.agentic-loop.json`
  (e.g. pr-sitter PRs — driven per that kind's manifest, see the
  `loop-orchestration` skill's "Loop kinds" section).
  This is the pull equivalent of the OpenCode plugin's `/agent-loop watch` —
  there is no standing watch mode on this substrate.
- **`status`** — call `mcp__agentic-loop__loop_status` and report the active
  loop plus the backlog roll-up. When a `projectManagement` tracker is
  configured, the result also carries a `pairing` block (tracker system,
  paired count, unpaired task ids) — surface which active tasks still need to
  be paired to a Jira/ADO item.
- **`ship <id>`** — call `mcp__agentic-loop__loop_ship({id})` to move a
  reviewed task from `in-review/` to `completed/`. Do this only after the
  human has reviewed the branch diff.
- **`recover <id>`** — call `mcp__agentic-loop__loop_recover({id})` and
  resume driving from the action it returns.
- **`doctor [fix]`** — call `mcp__agentic-loop__loop_doctor({fix})` to audit
  the backlog for structural damage (stray folders, task files outside every
  status folder, duplicate ids, held claim markers); with `fix` it applies
  the unambiguous repairs. Never repair the backlog by hand.
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

Never touch `docs/tasks/**` directly — no Bash `mv`/`mkdir`/`rm`/redirects
into it, no Write/Edit of files in status folders (a PreToolUse hook blocks
these). The folder a task file lives in IS its state; only the MCP tools may
change it. If the backlog looks damaged, run `doctor`.
