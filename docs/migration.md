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
