English | [繁體中文](README.zh-TW.md)

# agentic-workflow — Claude Code plugin

Drives backlog tasks through **PLAN / BUILD → VERIFY → REVIEW** as a
supervised, main-agent-driven loop, with git isolation, a trusted verdict
channel, a filesystem task backlog, and an audit trail. Tasks are authored
and gated in `/agentic-workflow:engineering`: a mandatory interview (`new <idea>`) turns your idea into a
draft and `approve <id>` queues it; the loop plans it **right before
execution** (so plans don't rot while tasks sit parked) and parks the plan in
`plan-review/` for the plan gate — the same `approve` verb releases it — and
never blocks on you.

This is the Claude Code port of the OpenCode `agentic-workflow` plugin. Because
Claude Code has no autonomous background-driver primitive, the loop is
**driven by the main agent**: `/agentic-workflow:engineering plan <id>` / `claim` make the agent spawn each
stage as a subagent (via the Task tool) while a bundled **MCP (Model Context
Protocol) server** owns the state machine, git isolation, verdicts, backlog
moves, snapshots, and metrics. See `skills/workflow-orchestration/SKILL.md` for
the exact protocol.

## Install

```bash
# from the repo root
./install.sh claude     # builds the MCP server + links the shared skills/references
# equivalent: cd plugins/claude && ./install.sh
```

On native Windows (no WSL/git-bash), use the PowerShell ports instead:

```powershell
# from the repo root
.\install.ps1 claude     # builds the MCP server + links the shared skills/references
# equivalent: plugins\claude\install.ps1
```

Then load the plugin:

```bash
claude --plugin-dir /abs/path/to/plugins/claude
```

or add the repo as a marketplace and install:

```
/plugin marketplace add /abs/path/to/repo
/plugin install agentic-workflow
```

`install.sh` runs `pnpm install` + `pnpm --filter agentic-workflow-mcp run build` (the `.mcp.json`
runs the built `mcp-server/dist/server.js`) and creates relative symlinks for the
platform-agnostic skills and the reference checklists.

Run from the repo root, `./install.sh claude` finishes with the interactive
**config wizard** that seeds `.agentic-workflow.json` (see
[`../../docs/configuration.md`](../../docs/configuration.md)). The
`cd plugins/claude && ./install.sh` shortcut runs only the Claude half and
does not include the wizard.

To uninstall, run `./uninstall.sh claude` (`.\uninstall.ps1 claude` on Windows)
from the repo root — it removes the
built `mcp-server/dist`; detach the plugin itself with
`/plugin uninstall agentic-workflow` (or drop `--plugin-dir`). The in-repo
skill/reference symlinks are git-tracked and stay. To clear a project's local
loop state, use `./scripts/clean.sh` (ephemeral `runs/` state by default;
`--backlog` / `--config` / `--purge` go further — see its `--help`; no Windows
port — run it under WSL or git-bash).

## Commands

Authoring + gates (`/agentic-workflow:engineering`):

- `/agentic-workflow:engineering new <idea>` — the main agent **always interviews you** (at
  minimum a restate-and-confirm) to pin down the goal and testable acceptance
  criteria, then writes a **planless draft** into `docs/tasks/draft/`. Each
  question comes through `AskUserQuestion`, one at a time, with the agent's
  guess as the first choice and "Other" still open for a free-text answer.
- `/agentic-workflow:engineering retask <id> [note]` — reshape a task whose goal came
  out wrong, before it is built: the main agent re-interviews you (seeded by the
  optional note) and rewrites the task in place — same id, no plan. Takes a
  `draft/` task, or a `queued/` one (its approval is withdrawn and it moves back
  to `draft/` first; a superseded plan an earlier `replan` left behind is
  removed, since it was written against the goal you are rewriting). Once a plan
  is under a gate or a build — `plan-review/` onward — `replan` is the verb
  instead.
- `/agentic-workflow:engineering approve [id]` — THE gate verb, unified and folder-driven
  (handled deterministically by a hook before the agent's turn). Which move
  happens depends on which folder the task is in (draft → queued, plan-review
  → in-progress, in-review → completed) — see the gate lifecycle diagram in
  the root [`AGENTS.md`](../../AGENTS.md#gate-lifecycle) for the full state
  machine, including the `replan` rejection edges. `in-review/` → `completed/`
  (ship) only after you review the branch diff, and only what `shipPublish`
  says leaves your machine — `approve <id> --pr`/`--push`/`--local` overrides
  it per ship. The PR targets the branch the run was cut from; `prBase` and
  `approve <id> --base=<branch>` override that. Each move is audited +
  committed; a task lives in exactly one folder, so the gate is never
  ambiguous. Without an id it advances the single task at a loop wait-gate
  (`plan-review/` or `in-review/`), falling back to a lone `draft/` task only
  when neither has anything waiting.
  (Also exposed as the `workflow_approve` MCP tool.)
- `/agentic-workflow:engineering replan [id] [reason]` — the sole rejection verb: send a
  parked plan (or a cap-tripped `in-progress/` task, by id) back to
  `queued/`, with the reason audited. (Also exposed as the `workflow_reject` MCP
  tool.)
- `/agentic-workflow:engineering abandon <id> [reason]` — cancel a task: it moves to
  `abandoned/`, the terminal folder for work that will not be done, with the
  reason audited. Works from any non-terminal folder (a shipped `completed/`
  task is refused). The file is kept, so the move is reversible — this is the
  cancellation to reach for, and the way to close a tracking epic once every
  child has shipped. (Also `workflow_abandon`.)
- `/agentic-workflow:engineering remove <id> --force` — hard-delete a task: unlike every
  other verb the file is deleted rather than moved. A bare `remove <id>`
  deletes nothing and reports which task the id resolved to; `--force` is the
  confirmation, which matters because ids are prefix-resolvable and a typo'd
  short handle can name a different real task. Git retains the file only when
  the backlog is tracked, and `ignoreBacklog` defaults to `true`, so a forced
  remove is usually permanent — prefer `abandon`. (Also `workflow_remove`,
  which takes the same `force`.)

The loop (`/agentic-workflow:engineering`):

- `/agentic-workflow:engineering plan <id>` — run the PLAN stage on one approved `queued/`
  task now: it writes the plan, parks the task in `plan-review/`, and the
  loop ends there (the driving agent then offers the gate inline via
  AskUserQuestion). Building is not reachable from `plan` — `claim <id>`
  builds one now; bare `claim` drives builds by priority.
- `/agentic-workflow:engineering claim [id]` — one-shot pull. Bare, it claims the
  next item (lowest priority number first): build-ready `in-progress/` work,
  then an approved `queued/` task to plan when no build work is left. With a
  task id it runs exactly that task now via `workflow_start({id})` — BUILD if
  build-ready, else its PLAN pass — the pull
  equivalent of the OpenCode `/agentic-workflow:engineering watch`; there is no
  standing watch on this host.
- `/agentic-workflow:engineering status` — the active loop plus a whole-backlog roll-up
  (bare `/agentic-workflow:engineering` does the same).
- `/agentic-workflow:engineering kinds` — list the workflow kinds and their enabled state.
- `/agentic-workflow:engineering recover <id>` — resume an interrupted loop from its state snapshot.
- `/agentic-workflow:engineering doctor [fix]` — audit the backlog for structural damage (stray
  folders, task files outside every status folder, duplicate ids, held claim
  markers); with `fix` it applies the unambiguous repairs.
- `/agentic-workflow:engineering stop` (alias `abort`) — abort the active loop (partial work
  stays on the loop branch).

The sitters (**all four are experimental** — their manifests and config keys
may still change, so each is opt-in; `engineering` is the one default-on
kind).
**What each one does is documented once in
[`../../docs/sitters.md`](../../docs/sitters.md)** — on this host every
sitter has the same command surface: `claim [<pr>]` (maps to
`workflow_claim({kind: "<kind>"})`; no standing watch here, so `claim` is the
pull — the PR sitters also take an optional PR number/URL to force a specific
one) and `status` · `stop` (report / abort the active loop; bare
`/agentic-workflow:<kind>` = status):

- `/agentic-workflow:pr-sitter` — opt-in via `workflows.pr-sitter.enabled`.
- `/agentic-workflow:review-sitter` — opt-in via `workflows.review-sitter.enabled`.
- `/agentic-workflow:dep-sitter` — opt-in via `workflows.dep-sitter.enabled`.
- `/agentic-workflow:main-sitter` — opt-in via `workflows.main-sitter.enabled`.

Each sitter needs its `"enabled": true` before anything reaches it. A bare
`workflow_claim()` polls every enabled kind in claim-priority order, so it
reaches an enabled sitter once nothing earlier is claimable; `workflow_claim({kind})` restricts the pull to one, and
`workflow_claim({kind: "pr-sitter", target: 42})` forces a specific PR — fetched
directly and driven even with no outstanding signal (fork PRs still refused).

Ancillary:

- `/plan <goal>` — ad-hoc read-only plan, relayed as chat, nothing persisted.

The old umbrella `/agent-loop` command is gone — its free-text mode and its
`task <id>`, `ship <id>`, `approve-plan <id>`, and `reject` verbs with it.
The whole engineering lifecycle lives on `/agentic-workflow:engineering` (`new`,
`retask`, `approve`, `replan`, `plan`, `claim`), and the PR sitter on
`/agentic-workflow:pr-sitter`.

## What's inside

- `agents/` — `workflow-task-author` (writes the confirmed draft),
  `workflow-plan-author` (the loop's PLAN stage — writes the implementation plan
  onto a queued task), `workflow-plan` (standalone read-only planner), the three build-phase stage subagents
  `workflow-build` / `workflow-verify` / `workflow-review`, the pr-sitter stage
  subagents `workflow-pr-triage` / `workflow-pr-fix` / `workflow-pr-publish`, and the
  sitter stage subagents for the remaining kinds: review-sitter's
  `workflow-review-fetch` / `workflow-review-assess` / `workflow-review-publish`,
  dep-sitter's `workflow-dep-scan` / `workflow-dep-upgrade` / `workflow-dep-publish`, and
  main-sitter's `workflow-main-diagnose` / `workflow-main-remedy` / `workflow-main-publish`
  (the shared `workflow-verify` is reused as the VERIFY stage by several of these).
- `skills/` — `workflow-orchestration` (Claude-specific driving protocol), plus
  the shared workflow-skill library (symlinked, including
  `task-backlog-management`).
- `commands/` — the slash commands. `engineering.md` is a **router**: it carries
  the preamble, a one-line index of the verbs, and the standing prohibitions,
  but no verb's procedure.
- `verbs/engineering.md` — those procedures, one `<!-- aw:verb … -->` block per
  verb. The block for the verb you invoked is injected into the turn; the rest
  never reaches the model. A `UserPromptSubmit` hook cannot rewrite a prompt, so
  splitting the file is the only way to stop `new <idea>` from paying for
  `claim`, `doctor`, and every gate verb it will not run.
- `hooks/` — a PreToolUse guard enforcing the read-only bash allowlist during
  VERIFY/REVIEW, worktree pinning, the stage deadline, and the Azure DevOps
  write backstop; UserPromptSubmit hooks (`gate-command`/`gate-parse`) that
  handle the deterministic `approve` gate before the agent's turn and inject the
  invoked verb's instructions (`verb-slice`); and a SessionStart hook
  (`reconcile`) that reconciles interrupted loops. Azure DevOps is reached only
  through the Azure DevOps MCP server — the PAT goes straight to that server's
  own spawn env, never into the agent's session env.
- `mcp-server/` — the `agentic-workflow` MCP server (`mcp__agentic-workflow__workflow_*`
  tools), reusing the original pure state machine and porting its
  git/backlog/persistence IO.

## Configuration

Optional `.agentic-workflow.json` at the repo root, layered over a user-scope
`~/.config/agentic-workflow/agentic-workflow.json` — honoring `$XDG_CONFIG_HOME`,
with the legacy `~/.agentic-workflow.json` still read as a fallback (repo wins
field by field; all fields default) — full
field reference in [`docs/configuration.md`](../../docs/configuration.md). The
schema is now **identical** to the OpenCode plugin's — that host's last field of
its own, `watchIntervalMinutes`, has been retired, and it adds only a
cron-syntax check it alone can act on. `workflows.<kind>.trigger` parses but is
a no-op on this pull-only host (`workflow_claim` stays the manual trigger); the
removed `gateBeforeBuild`/`interviewBeforePlan` keys are silently ignored.
`workflows.<kind>.stageModels` and `agentModels` both bind here, and neither
depends on the orchestrating model cooperating: a `PreToolUse` hook
(`hooks/stamp-spawn-model.mjs`) rewrites the spawn call's `model` before the tool
runs. Stage models ride the stage marker the MCP server already writes, keyed by
agent so a re-fired stage stays bound; `agentModels` covers the spawns with no
stage behind them (drafting in `new`/`retask`, and the ad-hoc
`/agentic-workflow:plan`) and is read straight from the config layers.

One host limit worth knowing: **Claude Code's spawn tool accepts only the model
aliases `sonnet`, `opus`, `haiku`, `fable`.** A configured id in one of those
families is mapped for you (`anthropic/claude-sonnet-4-5` → `sonnet`); anything
else is left unbound with a warning, because the tool rejects an unknown `model`
by failing the whole spawn rather than falling back.

## Known limitations

- **No standing `watch` (either command)** — watch needs an autonomous driver
  firing stages on idle events and timers; in this port the main agent is the
  driver and the MCP server cannot spawn subagents. `/agentic-workflow:engineering claim` /
  `/agentic-workflow:pr-sitter claim` are the pull equivalents:
  one human trigger claims and drives the next item. Within a turn,
  BUILD → VERIFY → REVIEW still advance without human input.
- **The interview runs in the main agent** — Task subagents cannot converse
  with you, so `/agentic-workflow:engineering new`'s mandatory interview happens in the main
  conversation before the author subagent writes the file.
- Skill/reference symlinks resolve on Unix/WSL, and on native Windows when
  `install.ps1`/`plugins/claude/install.ps1` can create symlinks
  (Administrator, or Developer Mode on Windows 10/11); without either, the
  installer falls back to copies automatically (re-run after `git pull` to
  refresh them).
