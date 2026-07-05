# agentic-loop

Runs a goal through a full engineering lifecycle as one supervised state
machine instead of a chat back-and-forth. Ships as two parallel plugins —
one for **OpenCode**, one for **Claude Code** ([`claude-plugin/`](claude-plugin/README.md)) —
sharing the same PLAN → BUILD → VERIFY → REVIEW pipeline, human plan gate,
git isolation, trusted verdicts, backlog, and audit trail.

## What it does

Authoring and execution are two commands. **`/agent-loop-task`** interviews
you into a draft task (`new <idea>` — always, so the goal and testable
acceptance criteria come from you, not a guess), `approve <id>` queues the
reviewed draft, and `approve-plan <id>` / `replan <id>` are the plan gate.
**`/agent-loop`** plans a queued task **right before execution** — so plans
don't rot while tasks sit parked — and builds plan-approved ones:

| Stage | Does | Pauses? |
|-------|------|---------|
| PLAN | Writes the `## Implementation Plan` onto the claimed queued task, then **parks it in `plan-review/` and exits** | parks — `approve-plan` / `replan` is the gate, the loop never blocks |
| BUILD | Implements the approved plan test-first, on its own `loop/<id>` branch | no |
| VERIFY | Runs tests; FAIL re-builds with the failure | no |
| REVIEW | Checks the branch diff; FAIL re-builds with feedback | no |

Execution is isolated on a `loop/<id>` git branch, verdicts are only trusted
through a plugin tool, every transition is audited, and the loop never pushes
or opens a PR itself — you review and `/agent-loop ship`. Full execution model
(watch mode, iteration caps, recovery): [docs/opencode.md](docs/opencode.md).

## Install

```bash
git clone <this-repo>
cd agentic-loop
npm install
./install.sh            # both plugins; or: ./install.sh opencode | claude
```

- `./install.sh opencode` symlinks agents/commands/skills/references into
  `~/.config/opencode/` (or `$OPENCODE_CONFIG_DIR`) and registers the plugin —
  details and flags (`--copy`, custom dir) in [docs/opencode.md](docs/opencode.md).
- `./install.sh claude` builds the bundled MCP server and links the shared
  skills/references, then prints the load options (`claude --plugin-dir` or
  marketplace) — details in [`claude-plugin/README.md`](claude-plugin/README.md).

Idempotent — re-run after `git pull` for updates.

## Commands

- `/agent-loop-task new <idea>` · `approve <id>` · `approve-plan <id>` ·
  `replan <id> [why]` — interview → draft → task gate → (the loop plans) →
  plan gate
- `/agent-loop task <id>` · `watch` · `ship <id>` · `recover <id>` · `stop` · `status` —
  plan the queue and execute the plan-approved tasks

Full command reference: [docs/opencode.md](docs/opencode.md) (OpenCode) ·
[`claude-plugin/README.md`](claude-plugin/README.md) (Claude Code — `/agent-loop claim`
instead of `watch`). Ad-hoc, outside-the-loop requests map to the bundled
skills library via [AGENTS.md](AGENTS.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) — the state machine, who does
  what, and how the Claude Code variant differs
- [docs/opencode.md](docs/opencode.md) — OpenCode execution model, commands,
  install detail
- [`claude-plugin/README.md`](claude-plugin/README.md) — Claude Code install,
  commands, known limitations
- [docs/configuration.md](docs/configuration.md) — `.agentic-loop.json`
  reference and optional hardening (worktrees, review lenses, redaction)
- [docs/migration.md](docs/migration.md) — migrating from earlier layouts
  (`/agent-loop-plan`, `in-planning/`, the blocking PLAN gate)
- [docs/design/](docs/design/) — threat model, hardening design record,
  enterprise gap analysis

## Layout

- `src/index.ts`, `src/loop/`, `src/task/`, `src/config.ts` — the state
  machine, driver, verdict handling, and task-backlog IO (OpenCode plugin)
- `.opencode/agents/`, `.opencode/commands/` — the agent + command definitions
  behind each stage and slash command; `.opencode/skills` symlinks to `skills/`
- `claude-plugin/` — the Claude Code plugin: commands, agents, hooks, and the
  bundled MCP server that drives the loop
- `skills/`, `references/` — the workflow library the stage agents and ad-hoc
  requests pull from (shared by both plugins)
- `docs/tasks/` — the filesystem task backlog `/agent-loop-task` and `/agent-loop task`
  read from
- `install.sh` — installs either or both plugins

## Develop

```bash
npm install && npm run typecheck && npm test
```

`typecheck` is `tsc --noEmit`; `test` runs the `src/**/*.test.ts` suite
covering the loop state machine and task store. The Claude Code MCP server
has its own suite: `cd claude-plugin/mcp-server && npm install && npm test`.

## License

MIT
