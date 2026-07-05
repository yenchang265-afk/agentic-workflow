# Migrating from the PLAN-stage versions

- Re-run `./install.sh` after updating — the `/task` command was renamed to
  `/agent-loop-plan` (and its agent to `loop-plan-author`), so a previously
  installed `commands/task.md` symlink now dangles; delete it if it lingers.
- Tasks already in `in-planning/` without a plan: run `/agent-loop-plan task <id>`.
- Old `*.state.json` snapshots taken at the removed PLAN stage are invalidated
  by design — `/agent-loop recover <id>` falls back to the plan persisted on the
  task file.
- `gateBeforeBuild` and `interviewBeforePlan` in `.agentic-loop.json` are
  ignored now (the gate is `/agent-loop-plan approve`; interviewing lives in
  `/agent-loop-plan new`).
- `/agent-loop-plan new` no longer writes a plan — it interviews you into a
  planless draft in `draft/`; run `/agent-loop-plan task <id>` after reviewing
  the draft.
