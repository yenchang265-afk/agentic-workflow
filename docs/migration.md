English | [繁體中文](migration.zh-TW.md)

# Migrating between layouts

## To opt-in sitters — every sitter kind is now experimental

- **`pr-sitter` and `review-sitter` no longer run by default.** All four
  sitters (`pr-sitter`, `review-sitter`, `dep-sitter`, `main-sitter`) are
  experimental, so each one now needs `"enabled": true` under its
  `workflows.<kind>` section, exactly like `dep-sitter` and `main-sitter`
  already did. `engineering` is unchanged — still on unless disabled.
- **This is a silent break**: a config that only carried knobs (e.g.
  `"pr-sitter": { "query": "is:open author:@me" }`) still parses, but the kind
  is now off and simply stops claiming. Add `"enabled": true` to the same
  section to restore the old behavior:

  ```json
  { "workflows": { "pr-sitter": { "enabled": true, "query": "is:open author:@me" } } }
  ```

- **`"enabled": false` on a sitter is no longer a config error.** It used to be
  rejected at load ("always enabled and cannot be disabled"); it now parses and
  keeps the kind off — which is also the default. If you removed the key to get
  past that error, nothing needs undoing.
- **`codePlatform: "ado"` is experimental too** — no config change, but treat
  the `ado` section's keys as still-moving.

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

## Back to REST-only for Azure DevOps (`ado.access` removed)

- **Azure DevOps is reached only through its REST API again** — `curl` + a PAT
  in the stage prompts, `fetch` + PAT in the driver's poll sources and ship
  gate. The `ado.access` knob (which briefly offered `"az"` / `"rest"` /
  `"mcp"`) is **gone**, and so is the az-CLI transport. There is nothing to
  install: ADO needs only `curl` and `AZURE_DEVOPS_EXT_PAT`.
- **If your config sets `ado.access`**: remove it. A stale `access` key parses
  and is **ignored** — the loop keeps running over REST — but hosts print a
  one-line warning naming `ado.access` so it doesn't read as a working setting.
  If you were on `"az"` or `"mcp"`, make sure `AZURE_DEVOPS_EXT_PAT` (Code read +
  Pull Request contribute scopes) is exported — REST always needs it.
- **`ado.customHeaders` / `ado.insecureSkipTlsVerify` are back in force**: they
  apply to every ADO REST call the driver makes, as they did before the
  multi-access experiment. See
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
