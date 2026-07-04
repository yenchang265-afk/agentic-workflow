# agentic-loop — Claude Code plugin

Executes approved backlog tasks through **BUILD → VERIFY → REVIEW** as a
supervised, main-agent-driven loop, with git isolation, a trusted verdict
channel, a filesystem task backlog, and an audit trail. Planning happens
**before** the loop in `/loop-plan`: a mandatory interview turns your idea
into a draft, the plan is written as a separate reviewed step, and an explicit
approval parks the task in the executable queue.

This is the Claude Code port of the OpenCode `agentic-loop` plugin. Because
Claude Code has no autonomous background-driver primitive, the loop is
**driven by the main agent**: `/loop task <id>` makes the agent spawn each
stage as a subagent (via the Task tool) while a bundled **MCP server** owns
the state machine, git isolation, verdicts, backlog moves, snapshots, and
metrics. See `skills/loop-orchestration/SKILL.md` for the exact protocol.

## Install

```bash
# from the repo root
cd claude-plugin
./install.sh            # builds the MCP server + links the shared skills/references
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

Planning (`/loop-plan`):

- `/loop-plan new <idea>` — the main agent **always interviews you** (at
  minimum a restate-and-confirm) to pin down the goal and testable acceptance
  criteria, then writes a **planless draft** into `docs/tasks/draft/`.
- `/loop-plan task <id>` — plan a draft: the MCP server moves it to
  `docs/tasks/in-planning/` (audited + committed), then the plan is written
  onto the file in place. Also how you re-plan after an iteration-cap stop.
- `/loop-plan approve <id>` — validate the plan and park the task in
  `docs/tasks/in-progress/` (the approved queue), audited + committed.

Execution (`/loop`):

- `/loop task <id>` — execute one approved task now, entering at BUILD.
- `/loop claim` — claim the next approved task (lowest priority number
  first) and execute it — the pull equivalent of the OpenCode `/loop watch`.
- `/loop status` — the active loop plus a whole-backlog roll-up.
- `/loop ship <id>` — move a reviewed task from `in-review/` to `completed/` (audited).
- `/loop recover <id>` — resume an interrupted loop from its state snapshot.
- `/loop stop` — abort the active loop (partial work stays on the loop branch).

Ancillary:

- `/plan <goal>` — ad-hoc read-only plan, relayed as chat, nothing persisted.
- `/explore` — file up to 5 improvement drafts (via the `loop-explore` subagent).

The old `/loop <goal>` free-text mode, `/loop next`, and `/task new` are gone —
planning always goes through `/loop-plan`.

## What's inside

- `agents/` — `loop-plan-author` (writes the confirmed draft / the plan),
  `loop-plan` (standalone read-only planner), `loop-explore`, and the three
  stage subagents `loop-build` / `loop-verify` / `loop-review`.
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
`worktreeSetup`, `reviewLenses`. Same schema as the OpenCode plugin **minus**
`watchIntervalMinutes` (no watch mode here — see below). The removed
`gateBeforeBuild`/`interviewBeforePlan` keys are silently ignored.

## Known limitations

- **No `/loop watch`** — watch needs an autonomous driver firing stages on
  idle events and timers; in this port the main agent is the driver and the
  MCP server cannot spawn subagents. `/loop claim` is the pull equivalent:
  one human trigger claims and drives the next approved task. Within a turn,
  BUILD → VERIFY → REVIEW still advance without human input.
- **The interview runs in the main agent** — Task subagents cannot converse
  with you, so `/loop-plan new`'s mandatory interview happens in the main
  conversation before the author subagent writes the file.
- Skill/reference symlinks resolve on Unix/WSL; on Windows without symlink
  support, copy them instead.
