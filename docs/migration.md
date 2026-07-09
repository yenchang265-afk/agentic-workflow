# Migrating between layouts

## To the backlog guard, watch lease, and inline gates

- **Raw backlog edits are now blocked.** Bash `mv`/`mkdir`/`rm`/redirects
  against `<tasksDir>/` and direct Write/Edit of files in status folders are
  rejected on both substrates (PreToolUse hook / `tool.execute.before`);
  only `draft/*.md` authoring and the live PLAN stage's own `queued/` task
  stay writable. Use the MCP verbs / `/agent-loop-task`; repair damage with
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
  (AskUserQuestion). The `/agent-loop-task approve-plan` and
  `/agent-loop ship` verbs are unchanged and remain the deferred path (now also
  reachable via the shorter `/agent-loop approve` / `/agent-loop reject` shortcuts).

## To the in-loop PLAN stage (`/agent-loop-task`, `queued/`, `plan-review/`)

Planning moved **into** the loop: the plan is now written right before
execution (PLAN stage) and parked in `plan-review/` for a human gate,
instead of being authored up front by a planning command.

- **Command rename** — `/agent-loop-plan` is gone; task authoring and both
  human gates live in `/agent-loop-task` (`new <idea>` · `retask <id> [note]` ·
  `approve <id>` · `approve-plan <id>` · `replan <id> [reason]`). Re-run
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
