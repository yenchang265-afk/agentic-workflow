# agentic-loop

Runs long-lived goals as supervised state machines instead of a chat
back-and-forth. The repo is a **multi-kind loop framework**: each loop kind is
a declarative manifest in [`loops/<kind>/`](loops/README.md) — stages,
transitions, and a work source — interpreted by a shared engine and fed by a
common scheduler. Ships as two parallel plugins — one for **OpenCode**, one
for **Claude Code** ([`claude-plugin/`](claude-plugin/README.md)) — both built
on one core package ([`packages/core`](packages/core)) and sharing the human
gates, git isolation, trusted verdicts, and audit trail.

Two loop kinds ship today:

- **engineering** (default-on) — a goal through PLAN → BUILD → VERIFY → REVIEW
  over the `docs/tasks/` backlog, with human task and plan gates.
- **pr-sitter** (opt-in) — sits on your open GitHub PRs: triages review
  comments, failing checks, and merge conflicts; fixes; verifies; pushes and
  replies. Never merges.

Authoring a new kind is a `loop.json` + stage prompts away — see
[`loops/README.md`](loops/README.md).

## The engineering loop

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
through a plugin tool, every transition is audited, and the engineering loop
never pushes or opens a PR itself — you review and `/agent-loop ship`. Full
execution model (watch mode, iteration caps, recovery):
[docs/opencode.md](docs/opencode.md).

## The PR sitter

Opt in via `.agentic-loop.json`:

```json
{ "loops": { "pr-sitter": { "enabled": true, "query": "is:open author:@me" } } }
```

The same polling that drives the backlog (`/agent-loop watch` on OpenCode,
`/agent-loop claim` on Claude Code) then also walks your open PRs and claims
any that need attention — failing checks, changes requested, unanswered
comments, or a merge conflict:

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

```bash
git clone <this-repo>
cd agentic-loop
npm install             # npm workspaces — also builds @agentic-loop/core (prepare)
./install.sh            # both plugins; or: ./install.sh opencode | claude
```

- `npm install` at the repo root installs all workspaces (the OpenCode plugin,
  `packages/core`, `claude-plugin/mcp-server`) and builds the core package via
  the `prepare` script — both plugins consume core's built `dist/`.
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
  plan the queue and execute the plan-approved tasks; `watch` also polls every
  other enabled loop kind's work source (e.g. the PR sitter's)

Full command reference: [docs/opencode.md](docs/opencode.md) (OpenCode) ·
[`claude-plugin/README.md`](claude-plugin/README.md) (Claude Code — `/agent-loop claim`
instead of `watch`). Ad-hoc, outside-the-loop requests map to the bundled
skills library via [AGENTS.md](AGENTS.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) — the framework (core package,
  manifest engine, scheduler, work sources), the two shipped loop kinds, and
  how the Claude Code variant differs
- [loops/README.md](loops/README.md) — how to author a new loop kind
  (manifest schema, prompt templates, hooks, work sources)
- [docs/opencode.md](docs/opencode.md) — OpenCode execution model, commands,
  install detail
- [`claude-plugin/README.md`](claude-plugin/README.md) — Claude Code install,
  commands, known limitations
- [docs/configuration.md](docs/configuration.md) — `.agentic-loop.json`
  reference, per-kind `loops` sections, and optional hardening (worktrees,
  review lenses, redaction)
- [docs/migration.md](docs/migration.md) — migrating from earlier layouts
  (`/agent-loop-plan`, `in-planning/`, the blocking PLAN gate)
- [docs/design/](docs/design/) — threat model, hardening design records
  (including [07 — multi-loop scheduler](docs/design/improvements/07-multi-loop-scheduler.md)),
  enterprise gap analysis

## Layout

- `packages/core/` — `@agentic-loop/core`: the pure loop engine, manifest
  layer, work sources + scheduler, task store, git isolation, snapshots,
  verdicts, metrics, config — everything both plugins share
- `loops/` — the declarative loop kinds (`engineering/`, `pr-sitter/`): a
  `loop.json` manifest + `stages/*.md` prompt templates per kind
- `src/index.ts`, `src/loop/`, `src/config.ts` — the OpenCode plugin: host
  wiring, the driver that runs the engine on `session.idle`, config extensions
- `.opencode/agents/`, `.opencode/commands/` — the agent + command definitions
  behind each stage and slash command; `.opencode/skills` symlinks to `skills/`
- `claude-plugin/` — the Claude Code plugin: commands, agents, hooks, and the
  bundled MCP server that drives the loop (its host shims live in
  `mcp-server/src/shim.ts`)
- `skills/`, `references/` — the workflow library the stage agents and ad-hoc
  requests pull from (shared by both plugins)
- `docs/tasks/` — the filesystem task backlog `/agent-loop-task` and `/agent-loop task`
  read from
- `install.sh` — installs either or both plugins

## Develop

```bash
npm install && npm run typecheck:all && npm run test:all
```

`typecheck:all` / `test:all` cover every workspace: the core package
(`packages/core` — engine, manifest, scheduler, sources, store), the OpenCode
plugin (`src/**/*.test.ts`), and the Claude Code MCP server
(`claude-plugin/mcp-server`). Plain `npm run typecheck` / `npm test` run just
the OpenCode plugin's suite.

## License

MIT
