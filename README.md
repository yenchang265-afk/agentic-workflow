# agentic-loop

Runs long-lived goals as supervised state machines instead of a chat
back-and-forth. The repo is a **multi-kind loop framework**: each loop kind is
a declarative manifest in [`packages/core/loops/<kind>/`](packages/core/loops/README.md) — stages,
transitions, and a work source — interpreted by a shared engine and fed by a
common scheduler. Ships as two parallel plugins — one for **OpenCode**, one
for **Claude Code** ([`plugins/claude/`](plugins/claude/README.md)) — both built
on one core package ([`packages/core`](packages/core)) and sharing the human
gates, git isolation, trusted verdicts, and audit trail.

Two loop kinds ship today:

- **engineering** (default-on) — a goal through PLAN → BUILD → VERIFY → REVIEW
  over the `docs/tasks/` backlog, with human task and plan gates.
- **pr-sitter** (opt-in) — sits on your open PRs (GitHub, or Azure DevOps via
  config `codePlatform: "ado"` for its REST API, PAT auth): triages review
  comments, failing checks, and merge conflicts; fixes; verifies; pushes and
  replies. Never merges.

Authoring a new kind is a `loop.json` + stage prompts away — see
[`packages/core/loops/README.md`](packages/core/loops/README.md).

## The engineering loop

Authoring, gates, and execution are one command. **`/agentic-loop:engineering`** interviews
you into a draft task (`new <idea>` — always, so the goal and testable
acceptance criteria come from you, not a guess; a **heavy idea is split into
sibling drafts**, one vertical slice each plus a `type: epic` tracker, so no
one task overruns a single build context), and `retask <id>` reshapes a draft
you're not happy with. **`approve [id]`** is the single gate verb, driven by
the folder the task sits in: it queues a reviewed draft (the task gate),
releases a parked plan into the build queue (the plan gate), or ships a
finished review after you've read the diff — a task lives in exactly one
folder, so the move is never ambiguous, and id-less `approve` advances the
one task waiting at a loop gate (never a draft). **`replan [id] [reason]`**
is the sole rejection verb: a parked plan (or a cap-tripped task, by id) goes
back to `queued/` for re-planning. The loop plans a queued task **right
before execution** — so plans don't rot while tasks sit parked (`plan <id>`
plans one now and parks it) — and `claim`/`watch` build plan-approved ones:

| Stage | Does | Pauses? |
|-------|------|---------|
| PLAN | Writes the `## Implementation Plan` onto the claimed queued task, then **parks it in `plan-review/` and exits** | parks — `approve` / `replan` is the gate, the loop never blocks |
| BUILD | Implements the approved plan test-first, on its own `feature/<id>` branch | no |
| VERIFY | Runs tests; FAIL re-builds with the failure | no |
| REVIEW | Checks the branch diff; FAIL re-builds with feedback | no |

Execution is isolated on a `feature/<id>` git branch, verdicts are only trusted
through a plugin tool, every transition is audited, and the engineering loop
never pushes or opens a PR itself — you review and `/agentic-loop:engineering approve`. Full
execution model (watch mode, iteration caps, recovery):
[docs/opencode.md](docs/opencode.md).

## The PR sitter

Opt in via `.agentic-loop.json`:

```json
{ "loops": { "pr-sitter": { "enabled": true, "query": "is:open author:@me" } } }
```

The sitter has its own command: `/agentic-loop:pr-sitter watch` (OpenCode
worker mode) or `/agentic-loop:pr-sitter claim` (one-shot pull, both hosts)
walks your open PRs and claims any that need attention — failing checks,
changes requested, unanswered comments, or a merge conflict:

| Stage | Does |
|-------|------|
| TRIAGE | Read-only `gh` inspection; structured findings; FAIL verdict = nothing to do |
| FIX | Worktree on the PR's **existing** branch; local commits only |
| VERIFY | Runs tests + checks the findings were covered; FAIL re-fires FIX (shared cap) |
| PUBLISH | `git push origin <branch>` + a `gh pr comment` reply per addressed finding |

A per-PR dedup ledger stops the sitter from reacting to its own pushes and
replies; PR comments and diffs are treated as untrusted input; merging,
closing, and approving stay human calls. Security posture:
[docs/design/threat-model.md](docs/design/threat-model.md).

## Install

The steps below assume the system prerequisites are already present (Node ≥ 20,
git, `gh`, `curl`, and — for browser work — Chrome). Azure DevOps needs only
`curl` plus a PAT in `AZURE_DEVOPS_EXT_PAT`. For a fresh machine, `./bootstrap.sh`
verifies/installs those, registers the `chrome-devtools` MCP server, and then
runs `./install.sh` for you:

```bash
./bootstrap.sh                 # everything; or --no-ado / --no-browser / --check-only
```

Manual path (deps already installed):

```bash
git clone <this-repo>
cd agentic-loop
npm install             # npm workspaces — also builds @agentic-loop/core (prepare)
./install.sh            # both plugins; or: ./install.sh opencode | claude
```

- `npm install` at the repo root installs all workspaces (the OpenCode plugin,
  `packages/core`, `plugins/claude/mcp-server`) and builds the core package via
  the `prepare` script — both plugins consume core's built `dist/`.
- `./install.sh opencode` symlinks agents/commands/skills/references into
  `~/.config/opencode/` (or `$OPENCODE_CONFIG_DIR`) and registers the plugin —
  details and flags (`--copy`, custom dir) in [docs/opencode.md](docs/opencode.md).
- `./install.sh claude` builds the bundled MCP server and links the shared
  skills/references, then prints the load options (`claude --plugin-dir` or
  marketplace) — details in [`plugins/claude/README.md`](plugins/claude/README.md).
- After installing, an interactive terminal gets a short **config wizard** that
  seeds `.agentic-loop.json` — see [docs/configuration.md](docs/configuration.md).

Idempotent — re-run after `git pull` for updates.

## Commands

- `/agentic-loop:engineering new <idea>` · `retask <id> [note]` — interview → planless
  draft(s) in `docs/tasks/draft/`; `retask` re-interviews and reshapes a
  draft in place
- `/agentic-loop:engineering approve [id]` — the one folder-driven gate: draft → queued
  (task gate), plan-review → in-progress (plan gate), in-review → completed
  (ship, after you review the branch diff). Id-less `approve` advances the
  single task at a loop wait-gate — never a draft
- `/agentic-loop:engineering replan [id] [reason]` — the rejection verb: a parked plan (or
  a cap-tripped task, by id) back to `queued/` for re-planning
- `/agentic-loop:engineering plan <id>` · `claim` · `watch [interval]` (OpenCode) ·
  `unwatch` · `recover <id>` · `stop` · `status` · `doctor [fix]` · `kinds` —
  `plan` runs PLAN on one queued task and parks it; `claim` pulls the next
  engineering item (build-ready beats planless); `watch` is a standing worker
  scoped to the engineering kind
- `/agentic-loop:pr-sitter claim` · `watch [interval]` (OpenCode) · `unwatch` ·
  `stop` · `status` — the same claim/watch semantics, scoped to the PR sitter

Full command reference: [docs/opencode.md](docs/opencode.md) (OpenCode) ·
[`plugins/claude/README.md`](plugins/claude/README.md) (Claude Code — no
standing `watch`; `claim` is the pull). Ad-hoc, outside-the-loop requests map
to the bundled skills library via [AGENTS.md](AGENTS.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) — the framework (core package,
  manifest engine, scheduler, work sources), the two shipped loop kinds, and
  how the Claude Code variant differs
- [packages/core/loops/README.md](packages/core/loops/README.md) — how to author a new loop kind
  (manifest schema, prompt templates, hooks, work sources)
- [docs/opencode.md](docs/opencode.md) — OpenCode execution model, commands,
  install detail
- [`plugins/claude/README.md`](plugins/claude/README.md) — Claude Code install,
  commands, known limitations
- [docs/configuration.md](docs/configuration.md) — `.agentic-loop.json`
  reference, per-kind `loops` sections, and optional hardening (worktrees,
  review lenses, redaction)
- [docs/templates/AGENTS.md](docs/templates/AGENTS.md) — starter
  `AGENTS.md`/`CLAUDE.md` (Karpathy rules + loop workflow) to copy into
  projects driven by agentic-loop
- [docs/migration.md](docs/migration.md) — migrating from earlier layouts
  (the single `/agent-loop` command, `/agent-loop-plan`, `in-planning/`, the
  blocking PLAN gate)
- [docs/design/](docs/design/) — threat model, hardening design records
  (including [07 — multi-loop scheduler](docs/design/improvements/07-multi-loop-scheduler.md))

Each topic is canonical in one file — config/wizard in
[docs/configuration.md](docs/configuration.md), OpenCode/Claude install +
commands in their plugin docs, architecture in
[docs/architecture.md](docs/architecture.md). Update the canonical file and
link to it; don't copy.

## Layout

- `packages/core/` — `@agentic-loop/core`: the pure loop engine, manifest
  layer, work sources + scheduler, task store, git isolation, snapshots,
  verdicts, metrics, config — everything both plugins share
- `packages/core/loops/` — the declarative loop kinds (`engineering/`, `pr-sitter/`): a
  `loop.json` manifest + `stages/*.md` prompt templates per kind
- `plugins/opencode/src/` — the OpenCode plugin: host
  wiring, the driver that runs the engine on `session.idle`, config extensions
- `plugins/opencode/agents/`, `plugins/opencode/commands/` — the agent + command definitions (symlinked from `.opencode/` for repo dogfooding)
  behind each stage and slash command; `.opencode/skills` symlinks to `skills/`
- `plugins/claude/` — the Claude Code plugin: commands, agents, hooks, and the
  bundled MCP server that drives the loop (its host shims live in
  `mcp-server/src/shim.ts`)
- `skills/`, `references/` — the workflow library the stage agents and ad-hoc
  requests pull from (shared by both plugins)
- `docs/tasks/` — the filesystem task backlog the `/agentic-loop:engineering` verbs
  read from
- `install.sh` — installs either or both plugins

## Develop

```bash
npm install && npm run typecheck:all && npm run test:all
```

`typecheck:all` / `test:all` cover every workspace: the core package
(`packages/core` — engine, manifest, scheduler, sources, store), the OpenCode
plugin (`src/**/*.test.ts`), and the Claude Code MCP server
(`plugins/claude/mcp-server`). Plain `npm run typecheck` / `npm test` run just
the OpenCode plugin's suite.

## License

MIT
