# engineering

The engineering workflow: PLAN (park at the human plan gate) then BUILD → VERIFY → REVIEW over the docs/tasks backlog.

## Enable

No configuration needed — the engineering loop runs by default. To disable it:

```jsonc
{
  "loops": {
    "engineering": { "enabled": false }
  }
}
```

## Commands

**OpenCode**

```
/agentic-loop:engineering new <idea> | retask <id> [note] | approve [id] | replan [id] [reason] | plan <id> | claim | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | recover <id> | kinds | doctor [fix] | stop | status
```

**Claude Code (MCP)**

```
/agentic-loop:engineering new <idea> | retask <id> [note] | approve [id] | replan [id] [reason] | plan <id> | claim | recover <id> | kinds | doctor [fix] | stop | status
```

(Claude Code has no standing watcher; `claim` is the one-shot pull verb.)

## Example: Draft, approve, plan, and execute

This walkthrough shows the full happy path from interview through delivery.

1. **Author a task**
   ```
   /agentic-loop:engineering new Implement dark mode toggle
   ```
   The command interviews you: what's the goal, acceptance criteria, any open questions? It creates a planless draft in `docs/tasks/draft/` with an auto-generated id (e.g., `my-dashboard-dark-mode`). The draft waits in draft/ for you to confirm it's ready to queue.

2. **Approve it into the backlog**
   ```
   /agentic-loop:engineering approve my-dashboard-dark-mode
   ```
   Moves the task from `draft/` to `queued/` — now it's eligible for execution.

3. **Plan the first task**
   ```
   /agentic-loop:engineering plan my-dashboard-dark-mode
   ```
   Enters the PLAN stage: the agent reads the task and writes a detailed implementation plan (## Implementation Plan heading in the task file). PLAN parks at a human gate (`plan-review/`) and exits — you review the plan, maybe reshape it, then approve it.

4. **Approve the plan**
   ```
   /agentic-loop:engineering approve my-dashboard-dark-mode
   ```
   Moves the task from `plan-review/` to `in-progress` — ready for BUILD.

5. **Execute the loop**
   ```
   /agentic-loop:engineering watch 30s
   ```
   Starts a standing watcher that polls every 30 seconds. When it finds a task in `in-progress`, it runs BUILD (code changes) → VERIFY (tests pass?) → REVIEW (code review) unattended. If all stages PASS, the task lands in `in-review/` (human review before merge). If any stage FAIL, it retries BUILD up to 3 times, then stops. `watch` turns *this* session into the worker — to run the next step, use a separate terminal/session, or press ESC (pauses, keeps the run recoverable) or `unwatch` (stops watching, lets any in-flight loop finish) first.

6. **Approve the finished work**
   ```
   /agentic-loop:engineering approve my-dashboard-dark-mode
   ```
   BUILD/VERIFY/REVIEW never push or open a PR themselves — this is the step that ships it: it pushes the `feature/my-dashboard-dark-mode` branch and opens (or reuses) a draft PR, then moves the task from `in-review/` to `completed/`.

## Example: Recover a stalled task

If a build crashes or you interrupt it (ESC), the task stalls in `in-progress`. Recover it:

1. **Check status**
   ```
   /agentic-loop:engineering status
   ```
   Shows the current loop + backlog summary. See which task is stalled.

2. **Recover and resume**
   ```
   /agentic-loop:engineering recover my-dashboard-dark-mode
   ```
   Resumes immediately, this turn — re-claims the task and re-enters the exact stage its state snapshot stopped at (re-reading the task file first, in case you edited it while stalled), then continues BUILD → VERIFY → REVIEW.

## Learn more

- Full pipeline, gates, and config: [`docs/architecture.md`](../architecture.md), [`docs/opencode.md`](../opencode.md)
- Sitters and their pipelines: [`docs/sitters.md`](../sitters.md)
- Command reference & troubleshooting: [`docs/opencode.md`](../opencode.md) (OpenCode-specific), [`plugins/claude/README.md`](../../plugins/claude/README.md) (Claude Code)
- Author a new loop kind: [`packages/core/loops/README.md`](../../packages/core/loops/README.md)
