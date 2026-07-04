# agentic-loop — Claude Code plugin

Drives an engineering goal through **PLAN → BUILD → VERIFY → REVIEW** as a
supervised, main-agent-driven loop, with a human plan gate, git isolation, a
trusted verdict channel, a filesystem task backlog, and an audit trail.

This is the Claude Code port of the OpenCode `agentic-loop` plugin. Because Claude
Code has no autonomous background-driver primitive, the loop is **driven by the
main agent**: `/loop <goal>` makes the agent spawn each stage as a subagent (via
the Task tool) while a bundled **MCP server** owns the state machine, git
isolation, verdicts, backlog moves, snapshots, and metrics. See
`skills/loop-orchestration/SKILL.md` for the exact protocol.

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
24 platform-agnostic skills and the reference checklists.

## Commands

- `/loop <goal>` — start a loop; runs PLAN, then **pauses for you to approve the
  plan**, then drives BUILD → VERIFY → REVIEW.
- `/loop next` — start on the top task in `docs/tasks/in-planning/`.
- `/loop status` — the active loop plus a whole-backlog roll-up.
- `/loop ship <id>` — move a reviewed task from `in-review/` to `completed/` (audited).
- `/loop recover <id>` — resume an interrupted loop from its state snapshot.
- `/task new <idea>` — draft a backlog task (via the `loop-task-author` subagent).
- `/explore` — file up to 5 improvement drafts (via the `loop-explore` subagent).

## What's inside

- `agents/loop-*.md` — the six stage/authoring subagents.
- `skills/` — `loop-orchestration` + `task-backlog-management` (Claude-specific),
  plus the shared workflow-skill library (symlinked).
- `hooks/` — a PreToolUse guard enforcing the read-only bash allowlist during
  VERIFY/REVIEW and worktree pinning during BUILD, and a SessionStart
  reconciliation that surfaces interrupted loops.
- `mcp-server/` — the `agentic-loop` MCP server (`mcp__agentic-loop__loop_*` tools),
  reusing the original pure state machine and porting its git/backlog/persistence IO.

## Configuration

Optional `.agentic-loop.json` at the repo root (all fields default): `maxIterations`,
`gateBeforeBuild`, `interviewBeforePlan`, `tasksDir`, `stageTimeoutMinutes`,
`worktreesDir`, `worktreeSetup`, `reviewLenses`. Same schema as the OpenCode plugin.

## Known limitations

- **No background/two-session `/loop watch` autonomy** — Claude Code has no
  equivalent to OpenCode's `session.idle` driver. The main agent drives one loop
  per session under your supervision (BUILD → VERIFY → REVIEW still advance without
  human turns *within* the agent's turn; only the plan gate pauses for you).
- Skill/reference symlinks resolve on Unix/WSL; on Windows without symlink support,
  copy them instead.
