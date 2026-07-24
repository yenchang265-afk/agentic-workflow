English | [繁體中文](migration.zh-TW.md)

# Migrating between layouts

## To `workflows` — the internal rename from `loop` to `workflow`

- **The config key is now `workflows`, not `loops`.** Rename the top-level
  `"loops": { ... }` section of your `.agentic-workflow.json` to
  `"workflows": { ... }` (same per-kind shape: `enabled`, `codePlatform`,
  `trigger`, `stageModels`). **This is a silent break, not a loud one**: the
  schema field is optional and defaults to `{}`, so an un-migrated file with
  a `loops` key parses successfully but is read as "no kinds configured" —
  every sitter you thought you'd enabled silently stops claiming. There is
  no compatibility shim; rename the key before upgrading.
- **Manifest and doc paths moved to match**: `packages/core/loops/<kind>/loop.json`
  is now `packages/core/workflows/<kind>/workflow.json`, and
  `docs/loops/<kind>.md` is now `docs/workflows/<kind>.md`. Only relevant if
  you authored a custom kind or link directly to these paths.
- **Internal agent identifiers changed** (`loop-build` → `workflow-build`,
  `loop-verify` → `workflow-verify`, etc., across all 17 stage agents) and
  the `loop-orchestration` skill is now `workflow-orchestration`. Transparent
  for normal use; relevant only if you hand-authored a custom stage or skill
  referencing one of the old names.
- **Claude-plugin MCP tool names changed** (`loop_start` → `workflow_start`,
  `loop_verdict` → `workflow_verdict`, etc., across all 21 tools; the
  fully-qualified form is now `mcp__agentic-workflow__workflow_verdict`).
  Transparent for normal use; relevant only if you scripted against the MCP
  server or hand-authored a stage that names a tool in its bash allowlist.
- The default worktree-isolation directory changed from `.loop-worktrees` to
  `.workflow-worktrees` (`worktreesDir` config default). If you'd set
  `worktreesDir` explicitly, no change needed; if you relied on the default
  and have it `.gitignore`d by name, update the ignored path.

## To an untracked backlog by default (`ignoreBacklog`)

- **Behavior change for existing repos**: the task backlog (`tasksDir`,
  `"docs/tasks"` by default) is no longer committed automatically. A new
  `ignoreBacklog` field defaults to **`true`**: instead of committing every
  task move (approve, plan, ship, park, done, stop) as an audit trail, the
  loop registers `tasksDir` in `<git-common-dir>/info/exclude` — a per-clone,
  untracked list, the same mechanism `worktreesDir` uses — and leaves the move
  as an uncommitted working-tree change.
- **To keep the old behavior**, set `"ignoreBacklog": false` — every task move
  goes back to being committed exactly as before.
- **Nothing on disk changes either way**: task files still move between
  status folders normally; only whether the loop commits those moves is
  affected. The shared, tracked `.gitignore` is never touched by either
  setting. See [configuration.md](configuration.md#optional-hardening).

## To az-CLI-only Azure DevOps (`ado.access` removed)

Azure DevOps is now reached **only** through the `az` CLI (the `azure-devops`
extension), end to end — stage prompts, stage bash allowlists, and the
driver's own polling / ship-gate calls. The three-way `ado.access` knob
(`az` | `rest` | `mcp`) and the two raw-fetch-only knobs it gated have been
removed. This collapses what used to be three parallel command sets per ADO
stage — which had to be kept in agreement by hand — down to one.

- **`ado.access` is gone.** It defaulted to `"az"` already, so if you never
  set it (or set `"az"`), nothing changes — delete the key. If you pinned
  `"rest"` or `"mcp"`, that path no longer exists; remove the key and use the
  az CLI. A stale `access` value is **ignored with a one-line warning**, not a
  hard error, so an in-flight loop keeps running — but it does nothing, so
  delete it.
- **`ado.customHeaders` and `ado.insecureSkipTlsVerify` are gone.** They only
  ever affected the raw-fetch transport, which the az CLI replaces. Both are
  ignored with the same warning. For a self-hosted Azure DevOps Server behind
  a self-signed / internal-CA certificate, configure the CLI's own trust
  instead — `REQUESTS_CA_BUNDLE=<ca.pem>` in the environment, or `az devops
  configure`. Custom proxy/routing headers have no az-CLI equivalent; front
  the CLI with the proxy's own environment (`HTTPS_PROXY`, etc.).
  `AGENTIC_WORKFLOW_ADO_HEADERS` is likewise no longer read.
- **Prerequisite:** the `az` CLI with the `azure-devops` extension must be
  installed and authenticated — `AZURE_DEVOPS_EXT_PAT` (the same env var as
  before; the extension honors it directly), `ado.pat`, or an interactive `az
  login`. Existing PAT setups keep working unchanged.
- **In-flight loops are unaffected**: a state snapshot claimed before this
  change loses its now-defunct access stamp on load and renders az commands,
  which match the az allowlist. See
  [configuration.md](configuration.md#code-platform-codeplatform--ado).

## To layered configuration (user scope + repo scope)

- Config is now resolved from **two layers**: an optional user-scope
  `~/.config/agentic-workflow/agentic-workflow.json` (all repos; honoring
  `$XDG_CONFIG_HOME`, with the legacy `~/.agentic-workflow.json` still read as a
  fallback) merged under the repo's `.agentic-workflow.json`, repo winning field
  by field — see
  [configuration.md](configuration.md#layers--precedence). Nothing to migrate:
  a repo-only setup behaves exactly as before.
- **Heads-up**: a stray `~/.agentic-workflow.json` left over from experimentation
  is now picked up and layered in. Delete it, or set
  `AGENTIC_WORKFLOW_USER_CONFIG=""` to disable the layer.
- Recommended split for multi-repo ADO users: move `ado.organization`,
  `ado.selfLogin`, and `ado.pat` to the user file; keep `codePlatform`,
  `ado.project`/`repository`, and `workflows` in each repo.

## To the per-kind commands (`/agentic-workflow:engineering`, `/agentic-workflow:pr-sitter`)

- **The umbrella `/agent-loop` command is gone** — each workflow kind now has its
  own plugin-namespaced command. Engineering: `/agentic-workflow:engineering`
  (`new <idea>` · `retask <id> [note]` · `approve [id]` — the unified
  folder-driven gate, behavior unchanged · `replan [id] [reason]` — the sole
  rejection verb, previously `reject` · `plan <id>` · `claim` ·
  `watch [interval]` / `unwatch` (OpenCode) · `recover <id>` · `kinds` ·
  `doctor [fix]` · `stop` · `status`). The PR sitter:
  `/agentic-workflow:pr-sitter` (`claim` · `watch [interval]` / `unwatch`
  (OpenCode) · `stop` · `status`).
- **Dropped with the umbrella**: the `ok`/`go` approve aliases; `reject` and
  its `redo` alias (use `replan`); the explicit `approve-plan <id>` form (the
  unified `approve <id>` covers the plan gate); `task <id>`, its `run` alias,
  and the bare-id shorthand (use `plan <id>` to plan one task, `claim` to
  build the next); and `ship <id>` (the unified `approve <id>` ships from
  `in-review/`).
- **Scoping**: `claim [kind]` / `watch [interval] [kind]` no longer take a
  kind filter — the command is the filter. Restart old `/agent-loop watch`
  sessions as `/agentic-workflow:engineering watch` (plus
  `/agentic-workflow:pr-sitter watch` where the sitter is enabled).
- Re-run `./install.sh` after updating; a previously installed
  `commands/agent-loop.md` symlink now dangles — delete it if it lingers.

## Early history (pre-1.0 internal iteration)

Before the current per-kind command layout, this repo went through several
rounds of consolidation in its first weeks: a `/task`/`/agent-loop-plan`
split merged into a single `/agent-loop-task`, which then merged into one
umbrella `/agent-loop` command (`new`/`retask`/`approve`/`reject`/`claim`/
`watch [kind]`/`kinds`); planning moved from an upfront command into an
in-loop PLAN stage (`in-planning/` became `queued/` + `plan-review/`); and
the backlog gained a mutation guard, a single-watcher lease
(`docs/tasks/runs/.watch-lease/`), and interactive Claude Code gates. None of
these intermediate states shipped to anyone outside active development — if
you're migrating from something this old, the per-kind command rename above
supersedes it directly. Delete any dangling `commands/agent-loop*.md` or
`commands/task.md` symlinks and re-run `./install.sh`.
