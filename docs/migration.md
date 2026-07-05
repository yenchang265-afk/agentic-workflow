# Migrating between layouts

## To the in-loop PLAN stage (`/agent-loop-task`, `queued/`, `plan-review/`)

Planning moved **into** the loop: the plan is now written right before
execution (PLAN stage) and parked in `plan-review/` for a human gate,
instead of being authored up front by a planning command.

- **Command rename** — `/agent-loop-plan` is gone; task authoring and both
  human gates live in `/agent-loop-task` (`new <idea>` · `approve <id>` ·
  `approve-plan <id>` · `replan <id> [reason]`). Re-run `./install.sh` after
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
  (a rejected plan, a cap-tripped task) run `/agent-loop-task replan <id>
  <why>` — it re-queues the task and the next PLAN pass addresses the
  audited reason. This also fixes the old dead end where a cap-tripped
  `in-progress/` task could not be re-planned at all.
- **Snapshots** — `*.state.json` snapshots at stage `plan` are invalidated
  by design (the PLAN stage never snapshots); `/agent-loop recover <id>` falls
  back to the plan persisted on the task file.

## From the pre-`/agent-loop-plan` versions

- The `/task` command was renamed (via `/agent-loop-plan`, now
  `/agent-loop-task`) and its agent to `loop-plan-author`; delete dangling
  `commands/task.md` symlinks.
- `gateBeforeBuild` and `interviewBeforePlan` in `.agentic-loop.json` are
  ignored (the gates are `/agent-loop-task approve` and `approve-plan`;
  interviewing lives in `/agent-loop-task new`).
- `new` never writes a plan — it interviews you into a planless draft in
  `draft/`.
