English | [繁體中文](README.zh-TW.md)

# agentic-loop — Claude Code plugin

Drives backlog tasks through **PLAN / BUILD → VERIFY → REVIEW** as a
supervised, main-agent-driven loop, with git isolation, a trusted verdict
channel, a filesystem task backlog, and an audit trail. Tasks are authored
and gated in `/agentic-loop:engineering`: a mandatory interview (`new <idea>`) turns your idea into a
draft and `approve <id>` queues it; the loop plans it **right before
execution** (so plans don't rot while tasks sit parked) and parks the plan in
`plan-review/` for the plan gate — the same `approve` verb releases it — and
never blocks on you.

This is the Claude Code port of the OpenCode `agentic-loop` plugin. Because
Claude Code has no autonomous background-driver primitive, the loop is
**driven by the main agent**: `/agentic-loop:engineering plan <id>` / `claim` make the agent spawn each
stage as a subagent (via the Task tool) while a bundled **MCP server** owns
the state machine, git isolation, verdicts, backlog moves, snapshots, and
metrics. See `skills/loop-orchestration/SKILL.md` for the exact protocol.

## Install

```bash
# from the repo root
./install.sh claude     # builds the MCP server + links the shared skills/references
# equivalent: cd plugins/claude && ./install.sh
```

Then load the plugin:

```bash
claude --plugin-dir /abs/path/to/plugins/claude
```

or add the repo as a marketplace and install:

```
/plugin marketplace add /abs/path/to/repo
/plugin install agentic-loop
```

`install.sh` runs `npm install` + `npm run build` in `mcp-server/` (the `.mcp.json`
runs the built `mcp-server/dist/server.js`) and creates relative symlinks for the
platform-agnostic skills and the reference checklists.

Run from the repo root, `./install.sh claude` finishes with the interactive
**config wizard** that seeds `.agentic-loop.json` (see
[`../../docs/configuration.md`](../../docs/configuration.md)). The
`cd plugins/claude && ./install.sh` shortcut runs only the Claude half and
does not include the wizard.

To uninstall, run `./uninstall.sh claude` from the repo root — it removes the
built `mcp-server/dist`; detach the plugin itself with
`/plugin uninstall agentic-loop` (or drop `--plugin-dir`). The in-repo
skill/reference symlinks are git-tracked and stay. To clear a project's local
loop state, use `./scripts/clean.sh` (ephemeral `runs/` state by default;
`--backlog` / `--config` / `--purge` go further — see its `--help`).

## Commands

Authoring + gates (`/agentic-loop:engineering`):

- `/agentic-loop:engineering new <idea>` — the main agent **always interviews you** (at
  minimum a restate-and-confirm) to pin down the goal and testable acceptance
  criteria, then writes a **planless draft** into `docs/tasks/draft/`.
- `/agentic-loop:engineering retask <id> [note]` — reshape a `draft/` task before you
  approve it: the main agent re-interviews you (seeded by the optional note)
  and rewrites the same draft in place — same id, no plan. Drafts only.
- `/agentic-loop:engineering approve [id]` — THE gate verb, unified and folder-driven
  (handled deterministically by a hook before the agent's turn). With an
  explicit `<id>`: a reviewed `draft/` → `queued/` (the task gate — no plan
  yet, by design), a parked `plan-review/` plan → `in-progress/` (the plan
  gate, `## Implementation Plan` required), or a finished `in-review/` task →
  `completed/` (ship — only after you review the branch diff). Each move is
  audited + committed; a task lives in exactly one folder, so the gate is
  never ambiguous. Without an id it advances the single task at a loop
  wait-gate (`plan-review/` or `in-review/`) — drafts always need the
  explicit id. (Also exposed as the `loop_approve` MCP tool.)
- `/agentic-loop:engineering replan [id] [reason]` — the sole rejection verb: send a
  parked plan (or a cap-tripped `in-progress/` task, by id) back to
  `queued/`, with the reason audited. (Also exposed as the `loop_reject` MCP
  tool.)

The loop (`/agentic-loop:engineering`):

- `/agentic-loop:engineering plan <id>` — run the PLAN stage on one approved `queued/`
  task now: it writes the plan, parks the task in `plan-review/`, and the
  loop ends there (the driving agent then offers the gate inline via
  AskUserQuestion). Building is not reachable from `plan` — `claim` drives
  builds.
- `/agentic-loop:engineering claim` — one-shot pull of the next build-ready
  `in-progress/` task (lowest priority number first; planless `queued/` tasks
  are never auto-planned — use `plan <id>`) — the pull
  equivalent of the OpenCode `/agentic-loop:engineering watch`; there is no
  standing watch on this host.
- `/agentic-loop:engineering status` — the active loop plus a whole-backlog roll-up
  (bare `/agentic-loop:engineering` does the same).
- `/agentic-loop:engineering kinds` — list the loop kinds and their enabled state.
- `/agentic-loop:engineering recover <id>` — resume an interrupted loop from its state snapshot.
- `/agentic-loop:engineering doctor [fix]` — audit the backlog for structural damage (stray
  folders, task files outside every status folder, duplicate ids, held claim
  markers); with `fix` it applies the unambiguous repairs.
- `/agentic-loop:engineering stop` (alias `abort`) — abort the active loop (partial work
  stays on the loop branch).

The sitters (**experimental** — the four commands below, their manifests, and
their config keys may still change; `engineering` is the stable, default-on
kind). **What each one does is documented once in
[`../../docs/sitters.md`](../../docs/sitters.md)** — on this host every
sitter has the same command surface: `claim` (maps to
`loop_claim({kind: "<kind>"})`; no standing watch here, so `claim` is the
pull) and `status` · `stop` (report / abort the active loop; bare
`/agentic-loop:<kind>` = status):

- `/agentic-loop:pr-sitter` — opt-in via `loops.pr-sitter`.
- `/agentic-loop:review-sitter` — opt-in via `loops.review-sitter.enabled`.
- `/agentic-loop:dep-sitter` — opt-in via `loops.dep-sitter.enabled`.
- `/agentic-loop:main-sitter` — opt-in via `loops.main-sitter.enabled`.

Ancillary:

- `/plan <goal>` — ad-hoc read-only plan, relayed as chat, nothing persisted.

The old umbrella `/agent-loop` command is gone — its free-text mode and its
`task <id>`, `ship <id>`, `approve-plan <id>`, and `reject` verbs with it.
The whole engineering lifecycle lives on `/agentic-loop:engineering` (`new`,
`retask`, `approve`, `replan`, `plan`, `claim`), and the PR sitter on
`/agentic-loop:pr-sitter`.

## What's inside

- `agents/` — `loop-plan-author` (writes the confirmed draft; runs the
  loop's PLAN stage in task mode), `loop-plan` (standalone read-only
  planner), the three build-phase stage subagents
  `loop-build` / `loop-verify` / `loop-review`, the pr-sitter stage
  subagents `loop-pr-triage` / `loop-pr-fix` / `loop-pr-publish`, and the
  sitter stage subagents for the opt-in kinds: review-sitter's
  `loop-review-fetch` / `loop-review-assess` / `loop-review-publish`,
  dep-sitter's `loop-dep-scan` / `loop-dep-upgrade` / `loop-dep-publish`, and
  main-sitter's `loop-main-diagnose` / `loop-main-remedy` / `loop-main-publish`
  (the shared `loop-verify` is reused as the VERIFY stage by several of these).
- `skills/` — `loop-orchestration` (Claude-specific driving protocol), plus
  the shared workflow-skill library (symlinked, including
  `task-backlog-management`).
- `hooks/` — a PreToolUse guard enforcing the read-only bash allowlist during
  VERIFY/REVIEW, worktree pinning, the stage deadline, and the Azure DevOps
  write backstop; UserPromptSubmit hooks (`gate-command`/`gate-parse`) that
  handle the deterministic `approve` gate before the agent's turn; and
  SessionStart hooks that reconcile interrupted loops and export config
  `ado.pat` into the session env for the sitter's ADO stages.
- `mcp-server/` — the `agentic-loop` MCP server (`mcp__agentic-loop__loop_*`
  tools), reusing the original pure state machine and porting its
  git/backlog/persistence IO.

## Configuration

Optional `.agentic-loop.json` at the repo root, layered over a user-scope
`~/.agentic-loop.json` (repo wins field by field; all fields default) — full
field reference in [`docs/configuration.md`](../../docs/configuration.md). Same
schema as the OpenCode plugin **minus** `watchIntervalMinutes` (no watch mode
here — see below); `loops.<kind>.trigger` parses but is a no-op on this
pull-only host (`loop_claim` stays the manual trigger); the removed
`gateBeforeBuild`/`interviewBeforePlan` keys are silently ignored.
`loops.<kind>.stageModels` works here: the MCP server's fire payloads carry a
`model` field the orchestration skill passes to the Task tool (a `provider/`
prefix from an OpenCode-style value is stripped automatically).

## Known limitations

- **No standing `watch` (either command)** — watch needs an autonomous driver
  firing stages on idle events and timers; in this port the main agent is the
  driver and the MCP server cannot spawn subagents. `/agentic-loop:engineering claim` /
  `/agentic-loop:pr-sitter claim` are the pull equivalents:
  one human trigger claims and drives the next item. Within a turn,
  BUILD → VERIFY → REVIEW still advance without human input.
- **The interview runs in the main agent** — Task subagents cannot converse
  with you, so `/agentic-loop:engineering new`'s mandatory interview happens in the main
  conversation before the author subagent writes the file.
- Skill/reference symlinks resolve on Unix/WSL; on Windows without symlink
  support, copy them instead.
