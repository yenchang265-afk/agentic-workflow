English | [繁體中文](opencode.zh-TW.md)

# OpenCode plugin

How the OpenCode variant executes, its full command surface, and install
details. For the shared pipeline picture see
[architecture.md](architecture.md); for the Claude Code variant see
[`plugins/claude/README.md`](../plugins/claude/README.md).

## Execution model

The shared engineering pipeline (gates, PLAN park, BUILD/VERIFY/REVIEW,
`maxIterations`, ship) is documented once in
[`docs/workflows/engineering.md`](workflows/engineering.md#architecture) —
this section covers only what's specific to running it on OpenCode.

Work runs either on demand (`/agentic-workflow:engineering plan <id>` plans one
task, `/agentic-workflow:engineering claim` pulls the next item) or in a
`/agentic-workflow:engineering watch [interval]` worker session — scoped to the
engineering kind — which claims tasks on every idle tick plus a polling
timer (default 5m, e.g. `/agentic-workflow:engineering watch 30s`) — build-ready
`in-progress/` tasks first, then `queued/` tasks to plan.

A run that stops early — a crash, or a user **interrupt (ESC)** mid-drive —
is resumed with `/agentic-workflow:engineering recover <id>`: loop state is
snapshotted after every stage, so recovery resumes at the exact stage it
reached. ESC is a **pause** — it halts the loop after the in-flight stage
settles and stops watch mode, but keeps the snapshot (recover picks up
there); a deliberate `/agentic-workflow:engineering stop` **ends** the run and
drops the snapshot, so there is nothing to recover.

Gates on this substrate are **park-only**: watch mode has no interactive
channel, so a parked plan or a finished loop always waits for
`/agentic-workflow:engineering approve [id]` (or `replan [id] [reason]` to send
a plan back) — see [`plugins/claude/README.md`](../plugins/claude/README.md)
for the Claude Code variant, which offers the same choices inline instead.

Between those gates the drive is **unattended by construction**: a stage
subagent cannot open OpenCode's `question` dialog. Every shipped agent denies
the tool in its frontmatter (`tools: question: false` plus
`permission: question: deny`), and the plugin refuses a `question` from any
session a loop is driving — including a custom kind's stage agent. A stage that
cannot resolve something on its own records it where the loop can act on it: a
FAIL/ERROR verdict from a check stage, `workflow_blocked` from a work stage.
Both surface to you at the next gate.

All of the above (and the isolation/hardening knobs: worktrees — on by
default, review lenses, secret redaction, run summaries) is configured in `.agentic-workflow.json`,
layered over an optional user-scope `~/.config/agentic-workflow/agentic-workflow.json`
(honoring `$XDG_CONFIG_HOME`, with the legacy `~/.agentic-workflow.json` still read
as a fallback; repo wins) — see [configuration.md](configuration.md). A
check stage fanned out per axis (`stageFanout`/`fanout: "axis"`) runs its passes
**concurrently**, each on its own sibling session; `reviewLenses`' lens passes
still run one at a time unless `workflows.<kind>.stageConcurrency` says
otherwise. Both are **OpenCode-only** — see the `stageConcurrency` entry under
[Workflow kinds](configuration.md#workflow-kinds-workflows) in
configuration.md.

## Commands

Authoring + gates (`/agentic-workflow:engineering`):

- `/agentic-workflow:engineering new <idea>` — interview you (always — at minimum a
  restate-and-confirm) into a **planless draft** in `docs/tasks/draft/`. Each
  interview question arrives in OpenCode's `question` dialog, one at a time,
  with the agent's guess as the first choice and free text still open
- `/agentic-workflow:engineering retask <id> [note]` — reshape a **planless** task:
  re-interview you (seeded by the optional note) and rewrite it in place — same
  id, no plan. Works on a `draft/` task, and on one already approved into
  `queued/` — that one is moved back to `draft/` first, withdrawing the
  approval, so you approve it again once reshaped. From `plan-review/` onward a
  plan exists, so `replan` is the verb instead
- `/agentic-workflow:engineering approve [id]` — THE gate verb, unified and folder-driven.
  With an explicit `<id>` it advances that task by the gate its folder
  implies: a reviewed `draft/` → `queued/` (the task gate; the loop plans it
  on claim), a parked `plan-review/` plan → `in-progress/` (the plan gate,
  `## Implementation Plan` required), or a finished `in-review/` task →
  `completed/` (ship — only after you review the branch diff, and only what
  `shipPublish` says leaves your machine (and onto the base the run was cut
from, or `--base=<branch>`): `--pr`/`--push`/`--local` on the
  command overrides it per ship). Every move is
  audited + committed, and the toast names which move happened; a task lives
  in exactly one folder, so the gate is never ambiguous. Without an id it
  advances the single task at a loop wait-gate (`plan-review/` or
  `in-review/`), falling back to a lone draft when neither has anything waiting
- `/agentic-workflow:engineering replan [id] [reason]` — the sole rejection verb: send a
  parked plan (or a cap-tripped `in-progress/` task, by id) back to `queued/`
  with the reason audited; the next PLAN pass must address it
- `/agentic-workflow:engineering abandon <id> [reason]` — cancel a task: it moves to
  `abandoned/`, the terminal folder for work that will not be done, with the
  reason audited. Works from any non-terminal folder (a shipped `completed/`
  task is refused). The file is kept, so the move is reversible — this is the
  cancellation to reach for, and the way to close a tracking epic once every
  child has shipped
- `/agentic-workflow:engineering remove <id> --force` — hard-delete a task: unlike every
  other verb the file is deleted rather than moved. A bare `remove <id>`
  deletes nothing and reports which task the id resolved to; `--force` is the
  confirmation, which matters because ids are prefix-resolvable and a typo'd
  short handle can name a different real task. Git retains the file only when
  the backlog is tracked, and `ignoreBacklog` defaults to `true`, so a forced
  remove is usually permanent — prefer `abandon`

The loop (`/agentic-workflow:engineering`):

- `/agentic-workflow:engineering plan <id>` — run the PLAN stage on one approved `queued/`
  task now: it writes the plan onto the task file, parks it in
  `plan-review/`, and exits. Building is not reachable from `plan` —
  `claim <id>` builds one now; `claim`/`watch` drive builds by priority
- `/agentic-workflow:engineering claim [id]` — one-shot pull. Bare, it claims the
  next item, lowest priority number first: build-ready `in-progress/` work,
  then an approved `queued/` task to plan when no build work is left. With a
  task id (short-hash handles resolve), it runs exactly that task now — a
  build-ready task starts at BUILD, an approved `queued/` task runs its PLAN
  pass and parks for the gate; any other folder is refused with the verb to
  use instead
- `/agentic-workflow:engineering watch [trigger]` — turn this session into a standing worker
  **scoped to the engineering kind**; claims in the same order as `claim`. Bare
  `watch` uses `workflows.engineering.trigger` (default poll); the argument is a
  per-session override: `poll [interval]` / a bare interval (`30s`, `5m`,
  `2h`, bare number = minutes; default `watchIntervalMinutes`) claims on idle
  events plus the timer, `cron <schedule>` claims only on schedule fires,
  `idle` chains a new claim on every idle. Takes the clone's **watch lease**
  (`runs/.watch-lease/`, heartbeat on a fixed 30s timer) — a second opencode
  process watching the same clone is refused; a dead watcher's lease is
  taken over once its heartbeat goes stale
- `/agentic-workflow:engineering unwatch` — stop this session from claiming new work (timer
  included). Pressing **ESC** mid-drive does this too *and* interrupts the
  running loop (see `recover`); `unwatch` only clears the watch flag and leaves
  an in-flight loop to finish
- `/agentic-workflow:engineering doctor [fix]` — audit the backlog for stray folders/files,
  duplicate ids, held claim markers, and stray plan-request markers; `fix`
  applies the unambiguous repairs (rescue strays to `draft/`, drop emptied
  folders, release stale claim markers, drop stray plan requests)
- `/agentic-workflow:engineering recover <id>` — resume an in-progress task whose run stopped
  early — a crash/restart, or a user **interrupt (ESC)** — from its state
  snapshot (or its persisted plan), at the exact stage it reached
- `/agentic-workflow:engineering kinds` — list the workflow kinds this repo ships and their
  state: `(enabled)` / `(disabled)`, with `experimental` appended for every
  sitter kind.
  Each enabled kind has its own `/agentic-workflow:<kind>` command. The toast
  also names the config files actually in effect
- `/agentic-workflow:engineering stop` (alias `abort`) — abort, clear state, and exit watch
  mode; **drops the snapshot** (deliberate end — nothing to recover, unlike an
  ESC pause)
- `/agentic-workflow:engineering status` — print the current loop (stage, iteration, watch cadence)
  plus a whole-backlog roll-up (counts, awaiting-approval/claimable/
  interrupted/in-review). Bare `/agentic-workflow:engineering` does the same

The sitters (**all four are experimental and opt-in** via
`workflows.<kind>.enabled: true` — their manifests and config keys may still
change; `engineering` is the one kind on unless disabled). Each has
the identical command surface —
`claim` (one-shot pull; the PR sitters also take an optional `<pr>` number/URL
to force a specific PR), `watch [trigger]` / `unwatch` (standing worker,
same trigger/interval syntax and one-watcher-per-clone lease as
engineering's `watch`, scoped to that kind), and `stop` (alias `abort`) /
`status` (bare command = status). **What each one does is documented once in
[`docs/sitters.md`](sitters.md)** — the four commands are:
`/agentic-workflow:pr-sitter` (opt-in via `workflows.pr-sitter.enabled`),
`/agentic-workflow:review-sitter` (likewise),
`/agentic-workflow:dep-sitter` (opt-in via `workflows.dep-sitter.enabled`), and
`/agentic-workflow:main-sitter` (opt-in via `workflows.main-sitter.enabled`).
Every verb here names its own kind, and every sitter needs its `enabled: true`
in `.agentic-workflow.json` before a claim or watch will reach it.

The old umbrella `/agent-loop` command is gone — its free-text mode and its
`task <id>`, `run`, `ship`, `approve-plan`, `reject`, and `go`/`ok` verbs with
it. The whole engineering lifecycle lives on `/agentic-workflow:engineering`
(`new`, `retask`, `approve`, `replan`, `plan`, `claim`, `watch`), and the PR
sitter on `/agentic-workflow:pr-sitter`.

Outside the loop, one-off requests are handled ad hoc: see
[AGENTS.md](../AGENTS.md) for the intent-to-skill mapping — the plugin
bundles a `skills/` library (spec-driven-development,
test-driven-development, code-review-and-quality, and 20+ others) that both
the loop's stage agents and ad-hoc requests invoke by name via the `skill`
tool.

## Install

```bash
git clone <this-repo>
cd agentic-workflow
npm install
./install.sh opencode
```

`./install.sh opencode` symlinks the agents, commands, skills, and references
into `~/.config/opencode/` (or `$OPENCODE_CONFIG_DIR`) and registers the
plugin as a local plugin file, so the `/agentic-workflow:*` commands and the bundled skills work in
every OpenCode session. It's idempotent — re-run after `git pull` for
updates. Use `--copy` instead of symlinks, or pass a directory to install
somewhere other than the default OpenCode config dir. Bare `./install.sh`
installs the Claude Code and Qwen Code plugins too.

On an interactive terminal the install ends with a short **config wizard** that
seeds `.agentic-workflow.json` — it first asks whether to write repo scope (the
project the loop drives) or user scope (shared across every repo); `--user` /
`--repo` force the choice. See [configuration.md](configuration.md).

On native Windows (no WSL/git-bash), use `.\install.ps1 opencode` instead — same
flags (`-Copy`, a custom dir, `--user`/`--repo`, `-y`). It creates real symlinks
when it can (Administrator, or Developer Mode on Windows 10/11) and falls back
to copies automatically otherwise (no live updates in that mode — re-run after
`git pull`).

## Uninstall & clean

`./uninstall.sh opencode [dir]` (`.\uninstall.ps1 opencode [dir]` on Windows)
reverses the install — it removes the
agents/commands/skills/references entries and the local plugin file that point
back into this repo from `$OPENCODE_CONFIG_DIR` (add `--copy` to also remove
copies a `--copy` install left). Foreign entries and your OpenCode config file
are left untouched.

`./scripts/clean.sh` clears the loop's local state for the project it drives
(`$AGENTIC_WORKFLOW_DIR` or `$PWD`): by default only the ephemeral
`<tasksDir>/runs/` machine state (snapshots, metrics, stage marker, watch
lease, claim markers, per-kind ledgers), which is regenerated on the next run.
`--backlog` also deletes the status-folder task files, `--config` the
`.agentic-workflow.json`, `--purge` all three; destructive tiers confirm first
(`-y` to skip, `--dry-run` to preview).
