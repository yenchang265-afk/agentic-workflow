# OpenCode plugin

How the OpenCode variant executes, its full command surface, and install
details. For the shared pipeline picture see
[architecture.md](architecture.md); for the Claude Code variant see
[`plugins/claude/README.md`](../plugins/claude/README.md).

## Execution model

The shared engineering pipeline (gates, PLAN park, BUILD/VERIFY/REVIEW,
`maxIterations`, ship) is documented once in
[`docs/loops/engineering.md`](loops/engineering.md#architecture) —
this section covers only what's specific to running it on OpenCode.

Work runs either on demand (`/agentic-loop:engineering plan <id>` plans one
task, `/agentic-loop:engineering claim` pulls the next item) or in a
`/agentic-loop:engineering watch [interval]` worker session — scoped to the
engineering kind — which claims tasks on every idle tick plus a polling
timer (default 5m, e.g. `/agentic-loop:engineering watch 30s`) — build-ready
`in-progress/` tasks first, then `queued/` tasks to plan.

A run that stops early — a crash, or a user **interrupt (ESC)** mid-drive —
is resumed with `/agentic-loop:engineering recover <id>`: loop state is
snapshotted after every stage, so recovery resumes at the exact stage it
reached. ESC is a **pause** — it halts the loop after the in-flight stage
settles and stops watch mode, but keeps the snapshot (recover picks up
there); a deliberate `/agentic-loop:engineering stop` **ends** the run and
drops the snapshot, so there is nothing to recover.

Gates on this substrate are **park-only**: watch mode has no interactive
channel, so a parked plan or a finished loop always waits for
`/agentic-loop:engineering approve [id]` (or `replan [id] [reason]` to send
a plan back) — see [`plugins/claude/README.md`](../plugins/claude/README.md)
for the Claude Code variant, which offers the same choices inline instead.

All of the above (and the optional hardening: worktrees, review lenses,
secret redaction, run summaries) is configured in `.agentic-loop.json`,
layered over an optional user-scope `~/.agentic-loop.json` (repo wins) —
see [configuration.md](configuration.md).

## Commands

Authoring + gates (`/agentic-loop:engineering`):

- `/agentic-loop:engineering new <idea>` — interview you (always — at minimum a
  restate-and-confirm) into a **planless draft** in `docs/tasks/draft/`
- `/agentic-loop:engineering retask <id> [note]` — reshape a `draft/` task before you
  approve it: re-interview you (seeded by the optional note) and rewrite the
  same draft in place — same id, no plan. Drafts only (a parked plan uses
  `replan`)
- `/agentic-loop:engineering approve [id]` — THE gate verb, unified and folder-driven.
  With an explicit `<id>` it advances that task by the gate its folder
  implies: a reviewed `draft/` → `queued/` (the task gate; the loop plans it
  on claim), a parked `plan-review/` plan → `in-progress/` (the plan gate,
  `## Implementation Plan` required), or a finished `in-review/` task →
  `completed/` (ship — only after you review the branch diff). Every move is
  audited + committed, and the toast names which move happened; a task lives
  in exactly one folder, so the gate is never ambiguous. Without an id it
  advances the single task at a loop wait-gate (`plan-review/` or
  `in-review/`) — drafts always need the explicit id
- `/agentic-loop:engineering replan [id] [reason]` — the sole rejection verb: send a
  parked plan (or a cap-tripped `in-progress/` task, by id) back to `queued/`
  with the reason audited; the next PLAN pass must address it

The loop (`/agentic-loop:engineering`):

- `/agentic-loop:engineering plan <id>` — run the PLAN stage on one approved `queued/`
  task now: it writes the plan onto the task file, parks it in
  `plan-review/`, and exits. Building is not reachable from `plan` —
  `claim`/`watch` drive builds
- `/agentic-loop:engineering claim` — one-shot pull of the next build-ready
  `in-progress/` task, lowest priority number first; planless `queued/` tasks
  are never auto-planned — plan them with `plan <id>`
- `/agentic-loop:engineering watch [trigger]` — turn this session into a standing worker
  **scoped to the engineering kind**; claims build-ready work only, like `claim`. Bare
  `watch` uses `loops.engineering.trigger` (default poll); the argument is a
  per-session override: `poll [interval]` / a bare interval (`30s`, `5m`,
  `2h`, bare number = minutes; default `watchIntervalMinutes`) claims on idle
  events plus the timer, `cron <schedule>` claims only on schedule fires,
  `idle` chains a new claim on every idle. Takes the clone's **watch lease**
  (`runs/.watch-lease/`, heartbeat on a fixed 30s timer) — a second opencode
  process watching the same clone is refused; a dead watcher's lease is
  taken over once its heartbeat goes stale
- `/agentic-loop:engineering unwatch` — stop this session from claiming new work (timer
  included). Pressing **ESC** mid-drive does this too *and* interrupts the
  running loop (see `recover`); `unwatch` only clears the watch flag and leaves
  an in-flight loop to finish
- `/agentic-loop:engineering doctor [fix]` — audit the backlog for stray folders/files,
  duplicate ids, and held claim markers; `fix` applies the unambiguous
  repairs (rescue strays to `draft/`, drop emptied folders, release stale
  markers)
- `/agentic-loop:engineering recover <id>` — resume an in-progress task whose run stopped
  early — a crash/restart, or a user **interrupt (ESC)** — from its state
  snapshot (or its persisted plan), at the exact stage it reached
- `/agentic-loop:engineering kinds` — list the loop kinds this repo ships and which are
  enabled (`loops.<kind>.enabled` in `.agentic-loop.json`); each enabled kind
  has its own `/agentic-loop:<kind>` command
- `/agentic-loop:engineering stop` (alias `abort`) — abort, clear state, and exit watch
  mode; **drops the snapshot** (deliberate end — nothing to recover, unlike an
  ESC pause)
- `/agentic-loop:engineering status` — print the current loop (stage, iteration, watch cadence)
  plus a whole-backlog roll-up (counts, awaiting-approval/claimable/
  interrupted/in-review). Bare `/agentic-loop:engineering` does the same

The sitters (**experimental** — the four `/agentic-loop:<sitter>` commands
below, their manifests, and their config keys may still change; `engineering`
is the stable, default-on kind). Each has the identical command surface —
`claim` (one-shot pull), `watch [trigger]` / `unwatch` (standing worker,
same trigger/interval syntax and one-watcher-per-clone lease as
engineering's `watch`, scoped to that kind), and `stop` (alias `abort`) /
`status` (bare command = status). **What each one does is documented once in
[`docs/sitters.md`](sitters.md)** — the four commands are:
`/agentic-loop:pr-sitter` (opt-in via `loops.pr-sitter`),
`/agentic-loop:review-sitter` (`loops.review-sitter`),
`/agentic-loop:dep-sitter` (`loops.dep-sitter`), and
`/agentic-loop:main-sitter` (`loops.main-sitter`).

The old umbrella `/agent-loop` command is gone — its free-text mode and its
`task <id>`, `run`, `ship`, `approve-plan`, `reject`, and `go`/`ok` verbs with
it. The whole engineering lifecycle lives on `/agentic-loop:engineering`
(`new`, `retask`, `approve`, `replan`, `plan`, `claim`, `watch`), and the PR
sitter on `/agentic-loop:pr-sitter`.

Outside the loop, one-off requests are handled ad hoc: see
[AGENTS.md](../AGENTS.md) for the intent-to-skill mapping — the plugin
bundles a `skills/` library (spec-driven-development,
test-driven-development, code-review-and-quality, and 20+ others) that both
the loop's stage agents and ad-hoc requests invoke by name via the `skill`
tool.

## Install

```bash
git clone <this-repo>
cd agentic-loop
npm install
./install.sh opencode
```

`./install.sh opencode` symlinks the agents, commands, skills, and references
into `~/.config/opencode/` (or `$OPENCODE_CONFIG_DIR`) and registers the
plugin as a local plugin file, so the `/agentic-loop:*` commands and the bundled skills work in
every OpenCode session. It's idempotent — re-run after `git pull` for
updates. Use `--copy` instead of symlinks, or pass a directory to install
somewhere other than the default OpenCode config dir. Bare `./install.sh`
installs the Claude Code plugin too.

On an interactive terminal the install ends with a short **config wizard** that
seeds `.agentic-loop.json` — it first asks whether to write repo scope (the
project the loop drives) or user scope (shared across every repo); `--user` /
`--repo` force the choice. See [configuration.md](configuration.md).

On Windows, symlinks need WSL or symlink-capable Windows (Developer Mode);
without that, use `--copy` (no live updates — re-run after `git pull`).

## Uninstall & clean

`./uninstall.sh opencode [dir]` reverses the install — it removes the
agents/commands/skills/references entries and the local plugin file that point
back into this repo from `$OPENCODE_CONFIG_DIR` (add `--copy` to also remove
copies a `--copy` install left). Foreign entries and your OpenCode config file
are left untouched.

`./scripts/clean.sh` clears the loop's local state for the project it drives
(`$AGENTIC_LOOP_DIR` or `$PWD`): by default only the ephemeral
`<tasksDir>/runs/` machine state (snapshots, metrics, stage marker, watch
lease, claim markers, per-kind ledgers), which is regenerated on the next run.
`--backlog` also deletes the status-folder task files, `--config` the
`.agentic-loop.json`, `--purge` all three; destructive tiers confirm first
(`-y` to skip, `--dry-run` to preview).
