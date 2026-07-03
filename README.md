# agentic-loop

OpenCode plugin. Runs a goal through a full engineering lifecycle as one
supervised state machine instead of a chat back-and-forth.

## What it does

`/loop <goal>` moves a goal through six stages, pausing only where a human
decision actually matters:

| Stage | Does | Pauses? |
|-------|------|---------|
| DEFINE | Turns the goal into a spec | no |
| PLAN | Breaks the spec into tasks | **yes — approve the plan** |
| BUILD | Implements task-driven, test-first | no |
| VERIFY | Runs tests; FAIL re-plans with the failure | no |
| REVIEW | Checks the diff; FAIL re-builds with feedback | no |
| SHIP | Drafts PR description + rollback plan | **yes — approve before push** |

Re-plan/re-build loops are capped by `maxIterations` in config — the loop
gives up and reports rather than spinning forever. SHIP never pushes or opens
a PR itself; you always do that last step.

## Commands

- `/loop <goal>` — start; runs DEFINE + PLAN, then pauses
- `/loop next` — start on the top task in `docs/tasks/in-planning/`
- `/loop task <id>` — start on a specific in-planning task
- `/loop go` — approve the current gate, continue
- `/loop stop` — abort, clear state
- `/loop status` — print stage, iteration count, pause state

Outside `/loop`, one-off requests are handled ad hoc: see [AGENTS.md](AGENTS.md)
for the intent-to-skill mapping — the plugin bundles a `skills/` library
(spec-driven-development, test-driven-development, code-review-and-quality,
and 20+ others) that both the loop's stage agents and ad-hoc requests invoke
by name via the `skill` tool.

## Install

```bash
git clone <this-repo>
cd agentic-loop
npm install
```

Point OpenCode at the plugin directory per your OpenCode plugin loading
convention.

## Layout

- `src/index.ts`, `src/loop/`, `src/task/`, `src/config.ts` — the state
  machine, driver, verdict handling, and task-backlog IO
- `.opencode/agents/`, `.opencode/commands/` — the agent + command definitions
  behind each stage and slash command; `.opencode/skills` symlinks to `skills/`
- `skills/`, `references/` — the workflow library the stage agents and ad-hoc
  requests pull from
- `docs/tasks/` — the filesystem task backlog `/loop next` and `/loop task`
  read from

## Develop

```bash
npm install && npm run typecheck && npm test
```

`typecheck` is `tsc --noEmit`; `test` runs the `src/**/*.test.ts` suite
covering the loop state machine and task store.

## License

MIT
