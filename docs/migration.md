# Migrating between layouts

## To layered configuration (user scope + repo scope)

- Config is now resolved from **two layers**: an optional user-scope
  `~/.agentic-loop.json` (all repos) merged under the repo's
  `.agentic-loop.json`, repo winning field by field — see
  [configuration.md](configuration.md#layers--precedence). Nothing to migrate:
  a repo-only setup behaves exactly as before.
- **Heads-up**: a stray `~/.agentic-loop.json` left over from experimentation
  is now picked up and layered in. Delete it, or set
  `AGENTIC_LOOP_USER_CONFIG=""` to disable the layer.
- Recommended split for multi-repo ADO users: move `ado.organization`,
  `ado.selfLogin`, and `ado.pat` to the user file; keep `codePlatform`,
  `ado.project`/`repository`, and `loops` in each repo.

## To the per-kind commands (`/agentic-loop:engineering`, `/agentic-loop:pr-sitter`)

- **The umbrella `/agent-loop` command is gone** — each loop kind now has its
  own plugin-namespaced command. Engineering: `/agentic-loop:engineering`
  (`new <idea>` · `retask <id> [note]` · `approve [id]` — the unified
  folder-driven gate, behavior unchanged · `replan [id] [reason]` — the sole
  rejection verb, previously `reject` · `plan <id>` · `claim` ·
  `watch [interval]` / `unwatch` (OpenCode) · `recover <id>` · `kinds` ·
  `doctor [fix]` · `stop` · `status`). The PR sitter:
  `/agentic-loop:pr-sitter` (`claim` · `watch [interval]` / `unwatch`
  (OpenCode) · `stop` · `status`).
- **Dropped with the umbrella**: the `ok`/`go` approve aliases; `reject` and
  its `redo` alias (use `replan`); the explicit `approve-plan <id>` form (the
  unified `approve <id>` covers the plan gate); `task <id>`, its `run` alias,
  and the bare-id shorthand (use `plan <id>` to plan one task, `claim` to
  build the next); and `ship <id>` (the unified `approve <id>` ships from
  `in-review/`).
- **Scoping**: `claim [kind]` / `watch [interval] [kind]` no longer take a
  kind filter — the command is the filter. Restart old `/agent-loop watch`
  sessions as `/agentic-loop:engineering watch` (plus
  `/agentic-loop:pr-sitter watch` where the sitter is enabled).
- Re-run `./install.sh` after updating; a previously installed
  `commands/agent-loop.md` symlink now dangles — delete it if it lingers.

## To the single `/agent-loop` command and same-layer plugins

- **`/agent-loop-task` is gone** — all its verbs live on `/agent-loop`:
  `new <idea>` · `retask <id> [note]` · `approve [id]` (aliases `ok`, `go`;
  with an explicit id it now also queues a reviewed draft — the unified,
  folder-driven gate) · `reject [id] [reason]` (aliases `redo`, `replan`) ·
  `approve-plan <id>` (the explicit plan-gate form survives). New verbs:
  `claim [kind]` (both hosts — the one-shot pull), `kinds`, the `run` alias
  for `task`, a bare-id shorthand (`/agent-loop <id>` runs a startable task),
  and `watch [interval] [kind]` (OpenCode) accepts a loop-kind filter.
- **Repo layout is same-layer now**: the OpenCode plugin lives in
  `plugins/opencode/` (was the repo root + `.opencode/`), the Claude Code
  plugin in `plugins/claude/` (was `claude-plugin/`), and the loop-kind
  manifests ship inside core (`packages/core/loops/`, was `loops/`).
  - OpenCode: re-run `./install.sh opencode` — it regenerates the config-dir
    plugin shim and re-points the symlinks.
  - Claude Code: re-add the marketplace once (`/plugin marketplace add
    <repo>`; the plugin source moved to `./plugins/claude`), then reinstall.
- **Agent prompts are generated** from `prompts/agents/` (`npm run
  gen:prompts`); the Claude guard hook is bundled from
  `plugins/claude/hooks/src/` (`npm run build:hooks`). Edit the sources,
  never the outputs — CI enforces both.

## To the backlog guard, watch lease, and inline gates

- **Raw backlog edits are now blocked.** Bash `mv`/`mkdir`/`rm`/redirects
  against `<tasksDir>/` and direct Write/Edit of files in status folders are
  rejected on both substrates (PreToolUse hook / `tool.execute.before`);
  only `draft/*.md` authoring and the live PLAN stage's own `queued/` task
  stay writable. Use the MCP verbs / the `/agent-loop` gate verbs; repair damage with
  `loop_doctor` / `/agent-loop doctor [fix]`.
- **New gitignored dir `docs/tasks/runs/.watch-lease/`** — the single-watcher
  lease. A second `/agent-loop watch` process on the same clone is refused;
  run extra watchers in their own clones/worktrees. Nothing to migrate;
  delete the dir if a crashed watcher's lease ever wedges (or just wait —
  stale leases are taken over automatically).
- **Stage marker gained a `taskId` field** (`runs/.stage.json`). Old markers
  still parse; hooks from this version paired with an older MCP server just
  won't apply the PLAN carve-out (PLAN would be blocked from writing the
  plan — update both sides together).
- **Claude Code gates are interactive now.** A plan park / loop done returns
  a `gate` field and the driver asks Approve / Replan / Park inline
  (AskUserQuestion). The `/agent-loop approve` and
  `/agent-loop ship` verbs are unchanged and remain the deferred path (now also
  reachable via the shorter `/agent-loop approve` / `/agent-loop reject` shortcuts).

## To the in-loop PLAN stage (`queued/`, `plan-review/`)

Planning moved **into** the loop: the plan is now written right before
execution (PLAN stage) and parked in `plan-review/` for a human gate,
instead of being authored up front by a planning command.

- **Command rename** — `/agent-loop-plan` is gone; task authoring and both
  human gates live in `/agent-loop` (`new <idea>` · `retask <id> [note]` ·
  `approve [id]` · `reject [id] [reason]`; since the single-command merge, `/agent-loop-task` itself is gone). Re-run
  `./install.sh` after
  updating; a previously installed `commands/agent-loop-plan.md` symlink now
  dangles — delete it if it lingers.
- **Folder migration** — `in-planning/` was replaced by `queued/` (task
  approved, planless, awaiting the loop's PLAN stage) and `plan-review/`
  (plan written, parked for the gate). For an existing backlog:

  ```bash
  cd docs/tasks
  mkdir -p queued plan-review
  # planned tasks await the plan gate; planless ones go back to draft review
  for f in in-planning/*.md; do
    grep -q '^## Implementation Plan' "$f" && git mv "$f" plan-review/ || git mv "$f" draft/
  done
  rmdir in-planning 2>/dev/null; git add queued plan-review
  ```

  Tasks already in `in-progress/` keep working unchanged — they have
  approved plans and the loop still enters them at BUILD.
- **Re-planning** — `/agent-loop-plan task <id>` is gone; to re-plan anything
  (a rejected plan, a cap-tripped task) run `/agent-loop reject <id>
  <why>` — it re-queues the task and the next PLAN pass addresses the
  audited reason. This also fixes the old dead end where a cap-tripped
  `in-progress/` task could not be re-planned at all.
- **Snapshots** — `*.state.json` snapshots at stage `plan` are invalidated
  by design (the PLAN stage never snapshots); `/agent-loop recover <id>` falls
  back to the plan persisted on the task file.

## From the pre-`/agent-loop-plan` versions

- The `/task` command was renamed (via `/agent-loop-plan` and `/agent-loop-task`, now
  merged into `/agent-loop`) and its agent to `loop-plan-author`; delete dangling
  `commands/task.md` symlinks.
- `gateBeforeBuild` and `interviewBeforePlan` in `.agentic-loop.json` are
  ignored (the gates are `/agent-loop approve` and `approve-plan`;
  interviewing lives in `/agent-loop new`).
- `new` never writes a plan — it interviews you into a planless draft in
  `draft/`.
