# agentic-loop

OpenCode plugin. Runs a goal through a full engineering lifecycle as one
supervised state machine instead of a chat back-and-forth.

## What it does

`/loop <goal>` moves a goal through five stages across **two sessions**,
pausing only where a human decision actually matters. An underspecified goal
is interviewed (`interview-me`) before DEFINE even starts; a clear goal
skips straight through:

| Stage | Does | Pauses? |
|-------|------|---------|
| DEFINE | Turns the goal into a spec | no |
| PLAN | Breaks the spec into tasks | **yes — approve & park the plan** |
| BUILD | Implements task-driven, test-first | no (runs in a `/loop watch` session) |
| VERIFY | Runs tests; FAIL re-plans with the failure | no |
| REVIEW | Checks the diff; FAIL re-builds with feedback | no |

Approving the plan **parks** it as a task instead of building it in the same
session — run `/loop watch` in another session (or the same one, later) to
claim and build it. Re-plan/re-build loops are capped by `maxIterations` in
config — the loop gives up and reports rather than spinning forever. The
loop never pushes or opens a PR itself; you always do that last step after a
REVIEW PASS.

## Commands

- `/loop <goal>` — clarify if needed, then start; runs DEFINE + PLAN, then pauses
- `/loop next` — start on the top task in `docs/tasks/in-planning/`
- `/loop task <id>` — start on a specific in-planning task
- `/loop go` — approve the current gate (first approval parks it for execution)
- `/loop watch` — turn this session into an execution worker: claims and
  builds parked, approved tasks on idle
- `/loop unwatch` — stop this session from claiming new work
- `/loop stop` — abort, clear state, and exit watch mode
- `/loop status` — print stage, iteration count, pause state, watch status

Outside `/loop`, one-off requests are handled ad hoc: see [AGENTS.md](AGENTS.md)
for the intent-to-skill mapping — the plugin bundles a `skills/` library
(spec-driven-development, test-driven-development, code-review-and-quality,
and 20+ others) that both the loop's stage agents and ad-hoc requests invoke
by name via the `skill` tool.

## Install

```bash
git clone <this-repo>
cd agentic-loop
npm install
./install.sh
```

`install.sh` symlinks the agents, commands, skills, and references into
`~/.config/opencode/` (or `$OPENCODE_CONFIG_DIR`) and registers the plugin as
a local plugin file, so `/loop` and the bundled skills work in every OpenCode
session. It's idempotent — re-run after `git pull` for updates. Use
`--copy` instead of symlinks, or pass a directory to install somewhere other
than the default OpenCode config dir.

## Layout

- `src/index.ts`, `src/loop/`, `src/task/`, `src/config.ts` — the state
  machine, driver, verdict handling, and task-backlog IO
- `.opencode/agents/`, `.opencode/commands/` — the agent + command definitions
  behind each stage and slash command; `.opencode/skills` symlinks to `skills/`
- `skills/`, `references/` — the workflow library the stage agents and ad-hoc
  requests pull from
- `docs/tasks/` — the filesystem task backlog `/loop next` and `/loop task`
  read from
- `install.sh` — installs this plugin into an OpenCode config directory
  (global by default)

## Develop

```bash
npm install && npm run typecheck && npm test
```

`typecheck` is `tsc --noEmit`; `test` runs the `src/**/*.test.ts` suite
covering the loop state machine and task store.

## License

MIT
