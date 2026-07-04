# agentic-loop

OpenCode plugin. Runs a goal through a full engineering lifecycle as one
supervised state machine instead of a chat back-and-forth.

> **Using Claude Code instead of OpenCode?** A parallel Claude Code plugin lives
> in [`claude-plugin/`](claude-plugin/README.md) — same PLAN → BUILD → VERIFY →
> REVIEW pipeline, human plan gate, git isolation, trusted verdicts, backlog, and
> audit trail, re-expressed as a main-agent-driven loop backed by a bundled MCP
> server (Claude Code has no autonomous background driver). Install:
> `cd claude-plugin && ./install.sh`.

## What it does

`/loop <goal>` moves a goal through four stages across **two sessions**,
pausing only where a human decision actually matters. An underspecified goal
is interviewed (`interview-me`) before PLAN even starts; a clear goal
skips straight through:

| Stage | Does | Pauses? |
|-------|------|---------|
| PLAN | Turns the goal into a spec-bounded, ordered plan | **yes — approve & park the plan** |
| BUILD | Implements task-driven, test-first, on its own `loop/<id>` branch | no (runs in a `/loop watch` session) |
| VERIFY | Runs tests; FAIL re-plans with the failure | no |
| REVIEW | Checks the branch diff; FAIL re-builds with feedback | no |

Approving the plan **parks** it as a task instead of building it in the same
session — run `/loop watch` in another session (or the same one, later) to
claim and build it. Execution is isolated on a `loop/<id>` git branch with a
commit checkpoint per build iteration; VERIFY/REVIEW record their verdicts
through a `loop_verdict` plugin tool (free-text verdicts are ignored), and
every gate approval, verdict, and build run is appended to the task file as
a timestamped, attributed audit note. Re-plan/re-build loops are capped by
`maxIterations`; a stage that outlives `stageTimeoutMinutes` fails the loop
instead of hanging it. On a REVIEW PASS the task parks in `in-review/` — the
loop never pushes or opens a PR itself; you review the branch diff, then run
`/loop ship <id>` to move it to `completed/`. A run that dies mid-build is
resumed with `/loop recover <id>` — loop state is snapshotted after every
stage, so recovery resumes at the exact stage it reached rather than
re-planning. See `docs/design/threat-model.md` for the security posture, and
`docs/design/improvements/` for the design of the hardening features below.

### Optional hardening (config in `.agentic-loop.json`)

- **`worktreesDir`** — run each loop in its own `git worktree` instead of
  switching branches in the shared checkout. The human's tree is never
  touched and multiple `/loop watch` sessions can build concurrently in one
  instance. Off by default (a fresh worktree has no installed deps — pair it
  with `worktreeSetup`, e.g. `"npm ci"`). Audit notes and task moves stay in
  the main tree and are committed there per terminal event.
- **`reviewLenses`** — run REVIEW once per lens (e.g.
  `["correctness", "security", "test-adequacy"]`) and take the worst verdict,
  so a single prompt-injected reviewer can't wave a change through. Costs ~N×
  review time; off by default.
- Secrets echoed into audit notes, plans, or run logs are **shape-redacted**
  (`AKIA…`, `sk-…`, tokens, PEM blocks, `key/secret/token: …` assignments)
  before they are written and committed.
- On a terminal event the run log gets a **`## Run summary`** table — per-stage
  wall-clock, verdict history, and iterations used.

## Commands

- `/loop <goal>` — clarify if needed, then start; runs PLAN, then pauses
- `/loop next` — start on the top task in `docs/tasks/in-planning/`
- `/loop task <id>` — start on a specific in-planning task
- `/loop go` — approve the current gate (first approval parks it for execution)
- `/loop watch` — turn this session into an execution worker: claims and
  builds parked, approved tasks on idle
- `/loop unwatch` — stop this session from claiming new work
- `/loop recover <id>` — resume an in-progress task whose run died mid-build
  (crash, restart), from its state snapshot (or its persisted plan)
- `/loop ship <id>` — move a reviewed `in-review/` task to `completed/`, audited
- `/loop stop` — abort, clear state, and exit watch mode
- `/loop status` — print the current loop (stage, iteration, pause/watch state)
  plus a whole-backlog roll-up (counts, gated/claimable/interrupted/in-review)

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
