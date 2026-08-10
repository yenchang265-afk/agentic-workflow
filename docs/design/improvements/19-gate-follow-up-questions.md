English | [繁體中文](19-gate-follow-up-questions.zh-TW.md)

# 19 — The gate asks what comes next

**Status: implemented.** `data.gate`/`data.id` on the approve family in
`packages/core/src/workflow/gate.ts`, `askTool` on both dialect tables
(`plugins/claude/mcp-server/src/server.ts`, `plugins/claude/hooks/src/dialect.mjs`),
the new `plugins/claude/hooks/gate-ask.mjs` with `continueOnGate` in
`gate-parse.mjs` and the conditional arm in `gate-command.mjs`, `okGate` on the
three approve tools, the rewritten `approve` block + `approve|plan` marker in
`prompts/verbs/engineering.md`, and `workflow_gate`/`workflow_plan` +
`refuseIfDriven` in `plugins/opencode/src/workflow/driver.ts`, and — after the
prose alone proved skippable — `armTaskGateAsk`/`askUnanswered`/`noteQuestionEvent`
plus `onIdle`'s question guard there, with the question events and the detached
drive wired in `plugins/opencode/src/impl.ts`; `gate.test.ts`,
`gate-ask.test.mjs`, `gate-result.test.mjs`, `gate-parse.test.mjs`,
`gate-command.test.mjs`, `dialect.test.mjs`, `verb-slice.test.mjs`,
`driver.test.ts`, `impl.test.ts`.

## Context

Three points in the lifecycle are natural questions: a draft has just been
written (approve it?), a task has just been queued (plan it now?), a plan has
just parked (approve / replan / park?). Whether the human was *asked* — rather
than left to type the next command — depended on which path they took, and the
split was invisible from the outside:

- Ask #1 and #3 lived in the verb prose and fired on the interactive `new`
  flow, on Claude Code and Qwen Code.
- **Ask #2 could not fire on the standalone `approve` verb at all.** The gate
  hook runs the move before the model and then emits `decision: "block"`; a
  blocked turn has no model in it, so there was nowhere for a question to come
  from. The `approve` block even instructed "spawn nothing — report the
  outcome".
- OpenCode had none of the three: its hand-authored command still ended `new`
  with "the next step is `approve <id>` per child".

A latent Qwen bug sat in the same code. `HostDialect` carried no ask tool, so
the MCP server's plan- and ship-gate `next:` strings hardcoded
`AskUserQuestion` and shipped it to Qwen, whose tool is `ask_user_question`.
Naming the wrong question tool does not fail loudly — the window simply never
opens — which is the same failure `gen-prompts.mjs`'s `{{askTool}}` token was
introduced to end.

## Design

- **`GateResult.data` carries the gate.** The approve family now reports
  `gate: "task" | "plan" | "ship"` and `id` on every success arm, the
  `alreadyDone` retries included. `approveAny` is a pure dispatcher, so which
  gate a folder-driven verb crossed is only knowable from its result — and a
  host must never re-derive it from `message`, which is prose that gets
  reworded. The vocabulary matches the `gate: {kind, id}` descriptor the MCP
  server already emits at its plan and ship gates.
- **`approve` becomes a CONDITIONAL hybrid.** `retask`/`replan` were already
  hybrids (`continueTurn`), but a blanket flag is wrong here: it would hand the
  turn back on refusals and on the terminal ship gate, which is the double-move
  the block exists to prevent. So `gate-parse.mjs` declares the *asking* gates
  (`continueOnGate`, sourced from `gate-ask.mjs`'s `ASK_GATES` so the two lists
  cannot drift), `gate-result.mjs` surfaces the CLI's `data`, and
  `gate-command.mjs` continues the turn only when the two agree.
- **The imperative is emitted by the harness, not asked for in prose.**
  `gate-ask.mjs` builds a `GATE FOLLOW-UP` block with the id and the host's
  tool name already substituted, appended *after* the verb context so it is the
  most recent thing the model reads. Same reason `stageModels` is bound by a
  hook rather than requested in a prompt: the orchestrator is precisely the
  thing that does not reliably follow prose.
- **Fail-safe by construction.** The continue path requires `ok`, a recognised
  `data.gate`, and a string `data.id`. An older `mcp-server/dist` supplies none
  of them, so every uncertainty degrades to the previous behaviour — a block.
  A false block costs one typed command; a false continue re-opens the
  double-move.
- **Both paths agree.** Nothing intercepts a *tool call*, so `okGate` folds the
  same ask into `workflow_task_approve` / `workflow_plan_approve` /
  `workflow_approve`'s `next`. Otherwise the same move asks on one path and
  stays silent on the other, and which path a run takes is not a human choice.
  The ask prose stays out of core: `gate.ts`'s `next` strings are host-neutral
  by design and also reach the OpenCode toast and the hub.
- **Slicing.** The `approve` slice's yes-branch needs the PLAN procedure, and a
  slice only ever contains its own blocks — so the plan block is now shared as
  `approve|plan`, and `approve` joins the two shared blocks carrying the
  `workflow-orchestration` pointer and the "offer gate choices inline" rule.
  Two cross-references that already dangled under slicing ("the `plan <id>`
  procedure **below**", never included in the `new` slice) are spelled out.

### OpenCode

Prose alone would have been worse than nothing: this host has no MCP server and
guards every write under `docs/tasks/`, so a turn that asked "approve this
draft?" could not honour a yes. The two moves an interactive authoring turn
needs are therefore model-callable tools beside `workflow_verdict` —
`workflow_gate` (core's `approveAny`) and `workflow_plan` (the `plan <id>`
handler, which already owns the busy/liveness/claim-race guards). A task-gate
outcome carries a `NEXT STEP` line, and the command-prompt override — which said
"report the result and stop" — now exempts it, since suppressing that line is
exactly what "and stop" did.

**Both tools refuse a call from inside a running loop.** A tool in the plugin's
map is offered to every session, stage subagents included, so an unguarded one
would let a BUILD or REVIEW agent approve the task it is driving — the
self-grading hole `workflow_verdict`'s stage check exists to close. The walk
goes through `findDrivingWorkflow`, so a stage running as a subtask is caught by
its driving ancestor, and it fails **closed**: a false refusal costs one typed
command, a false allow ships unreviewed work. That is the opposite asymmetry to
the Claude spawn guard's, and deliberately so.

### The ask needed a mechanism, not just prose asking for it

Shipping the `NEXT STEP` line was not enough, and the gap showed up in use: the
window never opened, and the TUI sat running something the user had not asked
for. An orchestrator that reads the line and goes straight to `workflow_plan`
loses the question **permanently** — that call claims the task, and the drive it
queues runs its stages as `session.command` calls on the driving session, after
which `refuseIfDriven` and the lack of a free model turn leave no channel to ask
anything until the chain unwinds. Same class as `stageModels`: the orchestrator is
exactly the thing that does not reliably follow prose, so the prose gets a
mechanism behind it.

- **`askArmed` / `askUnanswered` (`driver.ts`).** A task gate arms a one-shot ask
  keyed to the id it moved; `planFromAgent` refuses that id until a question has
  actually been opened, restating the exact call that unblocks it. Arming and the
  `NEXT STEP` text are one function (`armTaskGateAsk`) so the two can never
  disagree about which gates ask.
- **The signal is the `question.asked` / `question.replied` / `question.rejected`
  events** (`noteQuestionEvent`, wired into the plugin's `event` hook). The plugin
  still cannot originate a question — it can only watch one open.
- **`onIdle` returns while a question is open**, before `pending.delete`, so the
  queued drive waits for the idle *after* the answer. Without it a `watch`/`claim`
  session takes itself over on top of a window that is already up.
- **Both fail OPEN**, gated on `questionsObservable`: a session where no question
  has ever been seen is never refused, so against a host that does not emit those
  events the rules go inert instead of stranding an approved task no verb can
  plan. The opposite asymmetry to `refuseIfDriven`, for the opposite reason — a
  false refusal there costs one typed command, here it wedges the backlog.
- **The `event` hook no longer awaits the drive.** `onIdle` is the entry to the
  whole build → verify → review chain, so awaiting it parked that handler — and
  the ESC path shares it — for as long as the chain ran.

## What is deliberately not done

- **Ask #3 on OpenCode.** The PLAN pass finishes inside the background
  `session.idle` driver, after the turn has ended, so no model turn exists to
  host a question — and a plugin cannot originate one: the SDK's Question API is
  not on `PluginInput["client"]`, and the read-only `tui.question` view belongs
  to the TUI plugin surface a normal plugin does not get. It can only *observe*
  one, through the `question.*` events. `client.session.prompt` could fire
  a fresh turn from `onIdle`, but that re-enters the very event the watch/claim
  loop keys off — a recursion hazard in the driver's trigger. The plan gate
  stays a toast there, and the command now says why.
- **"Build it now?" after a plan gate.** `ASK_GATES` lists `task` only.
  Building on one word is a much larger commitment than planning on one, and
  `workflow-orchestration` requires a separate explicit answer before a build,
  so that arm stays with the interactive flow that can honour it. Adding it is
  one entry in `ASK_GATES` plus its branch in `gateAsk`.
- **Ask #1 stays prose-driven on every host.** The draft is written by the
  `workflow-task-author` subagent inside the model's own turn, and no hook fires
  on that write — there is no deterministic event to hang an injected
  instruction on.
