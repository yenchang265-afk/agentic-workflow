English | [繁體中文](22-plan-gate-ask.zh-TW.md)

# 22 — The plan gate asks, on every host

**Status: implemented.** `askOnPark` on the `start-plan` `Pending`,
`planParkNextStep`/`promptPlanGateAsk`, and `replanAndChain`/`replanFromAgent` in
`plugins/opencode/src/workflow/driver.ts`; the `workflow_replan` tool in
`plugins/opencode/src/impl.ts`; `planParkAsk` in
`plugins/claude/hooks/gate-ask.mjs` and the PostToolUse hook
`plugins/claude/hooks/plan-gate-ask.mjs`, registered in both hosts' `hooks.json`
and generated for Qwen by `scripts/build-hooks.mjs`; `driver.test.ts`,
`plan-gate-ask.test.mjs`, `gate-ask.test.mjs`.

## Context

Improvement [19](./19-gate-follow-up-questions.md) gave the **task** gate a
follow-up question: approve a draft and the harness itself asks "plan it now?".
The **plan** gate — the one where a human actually has to read something before
saying yes — never got one. A plan parked in `plan-review/` and the user was told
to type `/agentic-workflow:engineering approve <id>`.

The two hosts failed differently, which is why one fix does not cover both.

**OpenCode has no turn to ask in.** `plan <id>` claims the task, queues the work,
and returns; the PLAN stage runs on a later `session.idle`, so by the time the
plan exists the turn that asked for it has ended. The park handler could only
toast. This is the same structural gap plan 19 documented for the gate hook ("a
blocked turn cannot ask anything"), one stage later.

**Claude Code and Qwen ask only in prose.** `workflow_advance`'s park arm returns
a `next` string spelling out the Approve/Replan/Park question, and
`prompts/verbs/engineering.md` says it too. Both are prose the orchestrating model
reads as data — the exact failure mode that made plan 19 emit its follow-up from
the harness instead of the command body, and that `stampSpawnModel` exists for.

## Design

**OpenCode: originate the TURN, since the plugin cannot originate the QUESTION.**
After a park, `onIdle` sends one bare `session.prompt` to the session that planned
(`promptPlanGateAsk`), carrying a `NEXT STEP` block: summarize the plan, ask with
the `question` tool, and act on the answer with `workflow_gate` (approve) or
`workflow_replan` (reject). Three constraints:

- **It fires after the `finally`, never from the park arm.** The session must be
  free of the drive first — `clearWorkflow` at the terminal, `driving` released in
  the `finally` — or `refuseIfDriven` and the stage-agent `question` deny refuse
  the plugin's own ask. It is never awaited: the turn contains a question that
  blocks for as long as the human takes, and `onIdle` runs from the `event` hook.
- **Only a human-requested plan asks.** The flag rides the work item
  (`askOnPark` on the `start-plan` `Pending`, set in `claimForPlan`), not a module
  map. `claimForPlan`'s only callers are `plan <id>`, `workflow_plan` and the
  `replan` chain; the watcher's claim walk never passes through it. A map would
  have needed clearing on every path a drive can die on — ESC, stop, error, a
  dropped pending — and the one forgotten would open a dialog in a `watch` worker
  with nobody at the terminal. `drive()`'s own return value answers "did it park?",
  so there is no bookkeeping at all.
- **Replan needed a tool.** This host has no MCP server and guards writes under
  `docs/tasks/`, so an option the model can only *describe* is the ask made
  pointless (plan 19's own rule). `workflow_replan` wraps the same
  `replanAndChain` the verb uses — rejection, then the chained PLAN pass whose
  revised plan parks and asks again — behind `refuseIfDriven`, and invites no
  retry on timeout, because a repeat is not a no-op.

**Claude Code and Qwen: repeat the ask as harness context.** A PostToolUse hook
matched on `workflow_advance` (`plan-gate-ask.mjs`) parses the result, and on a
`gate: {kind: "plan"}` descriptor emits `hookSpecificOutput.additionalContext`
with the same block. Both hosts support the event and the field. The text lives
next to the task gate's in `gate-ask.mjs` — one writer, two triggers — and
`ASK_GATES` is deliberately untouched: that list is `gate-parse.mjs`'s
`continueOnGate`, i.e. which gate VERB crossings hand the turn back, and a park is
not a verb. Adding `"plan"` there would change what `approve` does at the plan
gate instead.

The hook **fails open on everything**: an unknown envelope shape, a non-JSON
result, no descriptor (an `mcp-server/dist` predating the gate contract), a host
with no question tool. It adds context and never a `decision`. A false silence
costs the reminder; a false reminder would tell the model to gate a task that
never parked.

## Deliberately not done

- **No enforcement layer.** `workflow_plan` is refusable
  (`askUnanswered`) because it is a point of no return for the human's session.
  Nothing dangerous follows a park — the model simply stops — so there is no call
  to refuse, and the degradation is exactly the previous behaviour: a toast, or
  the `next` string, and a verb the human can type.
- **The server's `next` string stays.** The hook re-frames the same move rather
  than replacing it, so a host or plugin version where the hook never runs keeps
  working unchanged.
- **The park toast is unchanged.** It is the only signal a watcher's park has,
  and it is still the right one there.
- **No workflow-kind filter in the hook.** Core's `runPark` returns `park-free`
  for a task-less state and no sitter work item is task-backed, so the plan-gate
  descriptor is only ever emitted for an engineering park. A filter would guard a
  hole that does not exist.
