# agentic-loop — Claude Code plugin

Drives backlog tasks through **PLAN / BUILD → VERIFY → REVIEW** as a
supervised, main-agent-driven loop, with git isolation, a trusted verdict
channel, a filesystem task backlog, and an audit trail. Tasks are authored
and gated in `/agent-loop-task`: a mandatory interview turns your idea into a
draft and `approve` queues it; the loop plans it **right before execution**
(so plans don't rot while tasks sit parked) and parks the plan in
`plan-review/` for the explicit `approve-plan` gate — it never blocks on
you.

This is the Claude Code port of the OpenCode `agentic-loop` plugin. Because
Claude Code has no autonomous background-driver primitive, the loop is
**driven by the main agent**: `/agent-loop task <id>` makes the agent spawn each
stage as a subagent (via the Task tool) while a bundled **MCP server** owns
the state machine, git isolation, verdicts, backlog moves, snapshots, and
metrics. See `skills/loop-orchestration/SKILL.md` for the exact protocol.

## Install

```bash
# from the repo root
./install.sh claude     # builds the MCP server + links the shared skills/references
# equivalent: cd claude-plugin && ./install.sh
```

Then load the plugin:

```bash
claude --plugin-dir /abs/path/to/claude-plugin
```

or add the repo as a marketplace and install:

```
/plugin marketplace add /abs/path/to/repo
/plugin install agentic-loop
```

`install.sh` runs `npm install` + `npm run build` in `mcp-server/` (the `.mcp.json`
runs the built `mcp-server/dist/server.js`) and creates relative symlinks for the
platform-agnostic skills and the reference checklists.

## Commands

Authoring + gates (`/agent-loop-task`):

- `/agent-loop-task new <idea>` — the main agent **always interviews you** (at
  minimum a restate-and-confirm) to pin down the goal and testable acceptance
  criteria, then writes a **planless draft** into `docs/tasks/draft/`.
- `/agent-loop-task approve <id>` — the task gate: queue the reviewed draft
  in `docs/tasks/queued/` (audited + committed). No plan yet, by design.
- `/agent-loop-task approve-plan <id>` — the plan gate: validate the parked
  plan and move the task to `docs/tasks/in-progress/` (the build-ready
  queue), audited + committed.
- `/agent-loop-task replan <id> [reason]` — reject a parked plan or send a
  cap-tripped task back to `queued/`, with the reason audited.

The loop (`/agent-loop`):

- `/agent-loop task <id>` — run one task now: a `queued/` task enters at PLAN
  (writes the plan, parks it in `plan-review/`, and the loop ends there); an
  `in-progress/` task enters at BUILD.
- `/agent-loop claim` — claim the next task (build-ready `in-progress/` tasks
  beat planless `queued/` ones; lowest priority number first) — the pull
  equivalent of the OpenCode `/agent-loop watch`.
- `/agent-loop status` — the active loop plus a whole-backlog roll-up.
- `/agent-loop ship <id>` — move a reviewed task from `in-review/` to `completed/` (audited).
- `/agent-loop recover <id>` — resume an interrupted loop from its state snapshot.
- `/agent-loop doctor [fix]` — audit the backlog for structural damage (stray
  folders, task files outside every status folder, duplicate ids, held claim
  markers); with `fix` it applies the unambiguous repairs.
- `/agent-loop stop` — abort the active loop (partial work stays on the loop branch).

Ancillary:

- `/plan <goal>` — ad-hoc read-only plan, relayed as chat, nothing persisted.

The old `/agent-loop <goal>` free-text mode, `/agent-loop next`, and `/task new` are gone —
task authoring and both gates always go through `/agent-loop-task`.

## What's inside

- `agents/` — `loop-plan-author` (writes the confirmed draft; runs the
  loop's PLAN stage in task mode), `loop-plan` (standalone read-only
  planner), the three build-phase stage subagents
  `loop-build` / `loop-verify` / `loop-review`, and the pr-sitter stage
  subagents `loop-pr-triage` / `loop-pr-fix` / `loop-pr-publish` / `loop-pr-poll`.
- `skills/` — `loop-orchestration` (Claude-specific driving protocol), plus
  the shared workflow-skill library (symlinked, including
  `task-backlog-management`).
- `hooks/` — a PreToolUse guard enforcing the read-only bash allowlist during
  VERIFY/REVIEW, worktree pinning, and the stage deadline; and a SessionStart
  reconciliation that surfaces interrupted loops.
- `mcp-server/` — the `agentic-loop` MCP server (`mcp__agentic-loop__loop_*`
  tools), reusing the original pure state machine and porting its
  git/backlog/persistence IO.

## Configuration

Optional `.agentic-loop.json` at the repo root (all fields default):
`maxIterations`, `tasksDir`, `stageTimeoutMinutes`, `worktreesDir`,
`worktreeSetup`, `reviewLenses`, `loops`, `codePlatform`, `ado`,
`projectManagement` — field reference in
[`docs/configuration.md`](../docs/configuration.md). Same schema as the
OpenCode plugin **minus** `watchIntervalMinutes` (no watch mode here — see
below). The removed `gateBeforeBuild`/`interviewBeforePlan` keys are
silently ignored.

## Known limitations

- **No `/agent-loop watch`** — watch needs an autonomous driver firing stages on
  idle events and timers; in this port the main agent is the driver and the
  MCP server cannot spawn subagents. `/agent-loop claim` is the pull equivalent:
  one human trigger claims and drives the next approved task. Within a turn,
  BUILD → VERIFY → REVIEW still advance without human input.
- **The interview runs in the main agent** — Task subagents cannot converse
  with you, so `/agent-loop-task new`'s mandatory interview happens in the main
  conversation before the author subagent writes the file.
- Skill/reference symlinks resolve on Unix/WSL; on Windows without symlink
  support, copy them instead.
