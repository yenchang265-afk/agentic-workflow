# The host protocol: spawns, asks, gates, models

How the three hosts drive the loop, and the seams where an orchestrating MODEL
can step out of the protocol. The recurring rule: behaviour that must be
reliable is bound by a mechanism, never asked for in prose — the orchestrator
is precisely the thing that is already not following prose.

Part of the engineering invariants indexed in [`AGENTS.md`](../../AGENTS.md)
— that index carries each rule in one line; this file carries the reasoning
behind it, which is what stops a future change from "fixing" the rule back.

## Per-verb command slicing

The engineering command's body is **not** sent whole. A model asked for
`new <idea>` used to receive all ~230 lines — every other verb, plus
deterministic plugin work described in the imperative — which is both wasted
context and a live source of confusion about which half is its job. So each
verb's prose sits inside an `<!-- aw:verb <names> -->` … `<!-- /aw:verb <names> -->`
block (`|`-separated for aliases and shared subsets, e.g. `stop|abort`), and
only the invoked verb's blocks reach the model. The hosts differ because their capabilities do:

- **OpenCode** slices the *rendered* prompt in `command.execute.before`
  (`plugins/opencode/src/command-slice.ts`). Text **outside** every marker is
  always kept, so prose added later is shared by default and can never be
  silently dropped from a verb.
- **Claude Code and Qwen Code** cannot rewrite a prompt — a `UserPromptSubmit`
  hook may only prepend context or block the turn. So the split is physical:
  `commands/engineering.md` is a router that is always sent, and the invoked
  verb's block is injected from `verbs/engineering.md` by
  `hooks/verb-slice.mjs`. Nothing unmarked belongs in that file — it would be
  dropped, not shared. Shared prose goes in the router. Both hosts' copies are
  **generated** from `prompts/verbs/engineering.md`, so edit that, not them.

Adding or renaming a verb means updating its marker block **and** the
`argument-hint` on every host; the coverage tests
(`command-slice.test.ts`, `verb-slice.test.mjs`) fail otherwise. They have to:
a verb that loses its block does not error, it silently falls back to the whole
body (OpenCode) or to no instructions at all (Claude). Markers must own their
whole line — that is what stops a marker pasted into `$ARGUMENTS` from
truncating the prompt — and HTML comments do not nest, so never write a literal
marker inside a comment.

The OpenCode entry commands render their verb from positional placeholders,
and opencode makes the **highest-numbered** placeholder greedy — it receives
every remaining argument joined by spaces. `$2` is what pins `$1` to the verb
token, so never delete it as unused (`command-slice.test.ts` guards all five
files). `$ARGUMENTS` stays the authoritative payload for free-text verbs
because positional tokens are whitespace-collapsed and quote-stripped — and
the plugin's own dispatch (`src/verb.ts`) reads the verb token quote-aware for
the same reason: it must agree with what `$1` renders. Never write a literal
dollar-digit sequence in command prose — substitution has no escape.

## On the model-driven hosts, the spawn is the protocol's weakest link

OpenCode has a driver, so its loop cannot get out of step with itself. Claude Code
and Qwen have none: an orchestrating MODEL calls `workflow_stage` → spawn →
`workflow_advance` for every stage AND every fan-out pass, and `workflow_stage`
and the spawn are routinely emitted as two tool_use blocks in one turn. Skip one
call and the machine sits at VERIFY while a REVIEW subagent runs — and the only
thing that noticed was `workflow_verdict` refusing the finished review ("the loop
is at verify, not review"): a whole stage paid for and discarded, then a
no-verdict retry, then an ERROR stop. `stageOrderError` cannot catch it, because
it only fires if `workflow_stage` is called at all.

So the enforcement is a PreToolUse DENY on the SPAWN
(`hooks/src/check-spawn-stage.entry.mjs`): a stage agent of the active kind may
only be spawned while the live marker has armed it. Three things it depends on:
the marker carries `kindAgents` (a hook cannot read a manifest — same reason it
carries `bashAllowlist` and `stageAgentModels`), it shares the model stamp's
matcher but never emits an `updatedInput` envelope (two PreToolUse hooks
rewriting one call is undocumented), and it fails OPEN on every uncertainty
— no marker, an expired one, an older marker without `kindAgents`, an unknown
host. That asymmetry is deliberate: a false allow only restores the old
behavior, a false deny stalls a run with no way out.

Never relax `workflow_verdict`'s stage check to "fix" this. That check is what
stops a BUILD agent grading its own work, and a verdict from an un-armed stage ran
under the previous stage's bash allowlist and evidence ledger. And never express
the rule as prose in a stage prompt — the orchestrator is precisely the thing that
is already not following prose, the same reason `stageModels` is BOUND by a hook
rather than asked for. For the same reason the SubagentStop nag names the marker's
stage: it must tell a subagent that is not that stage to record NOTHING, or a
drifted REVIEW files its findings as the VERIFY verdict.

## A blocked turn cannot ask anything

The gate hook runs `approve`'s move before the model and then blocks, which is
right for a move nothing follows and wrong for the task gate — the obvious next
question ("plan it now?") then has nowhere to come from. So `approve` is a
CONDITIONAL hybrid: `gate-parse.mjs` declares the ASKING gates (`continueOnGate`,
sourced from `gate-ask.mjs`'s `ASK_GATES` so the two cannot drift), and
`gate-command.mjs` hands the turn back only when the CLI's `data.gate` agrees.
Four things must not be "simplified":

- **Never widen it to a blanket `continueTurn: true`.** That continues on
  refusals generally and on the terminal ship gate — the double-move the block
  exists to prevent.
- **The continue path requires `ok` + a known `data.gate` + a string
  `data.id`.** Every uncertainty (an older `mcp-server/dist` emitting no `data`)
  falls through to the block. A false block costs one typed command; a false
  continue re-opens the double-move.
- **The one refusal that may continue is the id-less AMBIGUITY, and only because
  NOTHING MOVED.** `resolveGateTask` merely lists, so a bare `approve` over
  several candidates never reached `approveTask`/`approvePlan`/`shipTask`; there
  is no move to double, and the follow-up asks for a FIRST approve on an id the
  human picks. It is therefore pinned to `continueOnAmbiguity`
  (`ASK_AMBIGUITY_VERBS`, the same single-source arrangement as `ASK_GATES`)
  rather than expressed as "continue on a refusal" — wrong-folder and not-found
  have nothing to choose between, and continuing there is the old bug back.
- **The follow-up is emitted by the harness, never asked for in prose** — same
  reason `stageModels` is bound by a hook. Prose may describe the ask; the
  imperative with the id and the host's `askTool` already substituted is what
  carries it. It rides the approve tools' `next` (`okGate`) too, because nothing
  intercepts a tool CALL and a gate that asks on the typed path but not the tool
  path is a coin flip the human never made.

Which gate a folder-driven verb crossed is knowable only from `GateResult.data`
(`gate`, `id` — set on every success arm, `alreadyDone` retries included). Never
re-derive it from `message`: that is prose, and it gets reworded.

**OpenCode's plugin cannot originate a question.** The SDK's Question API
(list/reply/reject) is not on `PluginInput["client"]`, and the read-only
`tui.question(sessionID)` view belongs to the TUI plugin surface a normal plugin
does not get (`tui?: never`) — the `question` tool call and the `question.*`
events only observe. So an ask exists only where a model turn does: the
command-prompt override after a handled verb, never the background
`session.idle` drive where PLAN parks. And an ask whose answer the model cannot
execute is worse than no ask — that host has no MCP tools and guards
`docs/tasks/**`, which is why `workflow_gate`/`workflow_plan` exist. Both refuse
a call from a session a loop is driving (`findDrivingWorkflow`, failing CLOSED):
a plugin tool is offered to EVERY session, stage subagents included, and without
that a BUILD agent can approve its own task.

That leaves the ask itself carried by prose — a `NEXT STEP` line in
`workflow_gate`'s result — which is exactly what an orchestrator skips.
`workflow_plan` is the point of no return: the drive it queues runs its stages as
`session.command` calls on the DRIVING session (concurrency 1), after which
`refuseIfDriven` and the absence of a free model turn mean **nothing can ask the
human anything** until the chain unwinds. So the prose has a mechanism behind it,
in two halves:

- **`planFromAgent` refuses until the question was actually put** (`askUnanswered`,
  against the one-shot `askArmed` a task gate sets).
- **`onIdle` returns while a question is open**, before `pending.delete`, so the
  work stays queued for the idle after the answer instead of the drive burying
  the window.

Both fail **OPEN**, gated on `questionsObservable`: a session where no question
was ever seen is never refused, so against a host that shows no window the rules
go inert rather than stranding an approved task no verb can plan. That is the
opposite asymmetry to `refuseIfDriven` above, deliberately — there a false allow
ships unreviewed work, here a false refusal wedges the backlog while a false
allow only restores the old behaviour. Both exits **log**, because "the human
said yes" and "we could not tell" otherwise produce the same outcome and the same
empty transcript.

**The signal is the `question` TOOL CALL, not the event name.** The SDK carries
the same window under two event families (`question.*` and `question.v2.*`), and
a wrong guess there makes every rule above silently inert — fail-open, invisible,
indistinguishable from working. The primary source is
`tool.execute.before`/`.after` (`noteQuestionToolCall`/`noteQuestionToolSettled`),
a seam this plugin owns; `noteQuestionEvent` is an additive second source that
normalises `question.v2.*` down to the legacy `question.asked`/`replied`/`rejected`
names. They converge rather than
double-count because the asked event carries `tool.callID`, so windows are keyed
by that token and never by a per-session flag — one message can open two windows,
and a flag is cleared by the first settlement while the second is still up.

The stage-ask deny (next section) runs **before** the recorder: a refused stage
ask never reached the human, so recording it would both satisfy an armed gate ask
nobody saw and hold `onIdle` off a session with no window in it.

**A token nobody removes is worse than no token at all**, because `onIdle`
returns on it for the life of the process — stranding the queued drive *and* the
on-disk claim it already placed, after which every gate verb refuses the task as
"a loop is driving this NOW". There is deliberately **no timeout**: a window the
human has not reached is legitimately open for hours. What bounds it is that
every way a window dies without settling clears it — ESC (`onInterrupt`, for the
interrupted id *and* the resolved driving one), the `stop`/`abort` verb, and any
other tool starting in that session, since a question blocks the turn and a
different tool call proves the window is down (`noteOtherToolCall`, the valve
against a `tool.execute.after` that never fires).

**`armTaskGateAsk` returning `""` is a silent seam.** `data.gate`/`data.id` live
in core, which resolves to `packages/core/dist` — gitignored, rebuilt only by
`pnpm install`, while the installed plugin points at the working tree. A new
plugin against an old core dist lands with `r.ok` true and no gate on it, which
is both halves of the bug at once: no `NEXT STEP` to follow, and nothing armed
for `askUnanswered` to enforce. It warns, naming `pnpm install`.

And **never `await` the drive inside the `event` hook.** `onIdle` is the entry to
the whole build → verify → review chain, so awaiting it parks that handler for
hours — including the ESC path, which lives in the same hook and is the one event
that must get through while a loop runs. `void` it with an error sink. That is
safe only because `onIdle` reaches `driving.add` with no intervening `await`;
anything added to that prologue must keep it synchronous, or two idle events both
start a drive.

## The plan gate asks in a turn of its own

The park is the gate with no turn to ask in. On OpenCode `plan <id>` returns
*before* its drive starts (the stage runs on a later `session.idle`), so when the
plan finally lands in `plan-review/` the turn that asked for it is long over — the
host announced it with a toast and left the human to type `approve`. The plugin
still cannot originate a QUESTION, but it can originate the TURN a model asks one
in: `onIdle` fires `promptPlanGateAsk` (a bare `session.prompt`) after a park.
Three constraints hold it up, and none is cosmetic:

- **It fires AFTER the `finally`, not from the park arm.** The session has to be
  free of the drive first (`clearWorkflow` at the terminal, `driving` released in
  the `finally`), or `refuseIfDriven` and the stage-agent `question` deny refuse
  the plugin's own ask. And it is never `await`ed — the turn contains a question
  that blocks for as long as the human takes, and `onIdle` runs from the event
  hook (previous section).
- **Only a human-requested plan asks**, and the flag rides the `start-plan`
  `Pending` (`askOnPark`, set in `claimForPlan`) rather than a module map: a map
  would need clearing on every path a drive can die on — ESC, stop, error, a
  dropped pending — and the one forgotten would open a dialog in a `watch` worker
  session with nobody at the terminal. `drive()`'s own outcome answers "did it
  park?", so no bookkeeping is needed at all.
- **Every option names a tool that exists here.** `workflow_gate` crossed the
  gate; Replan had nothing, which is why `workflow_replan` was added — an ask
  whose answer the model cannot execute is worse than no ask, and this host has no
  MCP server and guards `docs/tasks/**`.

Claude Code and Qwen park inside a `workflow_advance` result that already carries
the same ask as its `next` string — prose inside DATA, which is the thing the
orchestrator skips. So `plan-gate-ask.mjs` (PostToolUse, matched on
`workflow_advance`) re-emits it as harness context, sharing one writer with the
task gate's follow-up (`gate-ask.mjs`). It fails OPEN on every uncertainty and
adds only context — never a `decision` — because a false silence costs the
reminder while a false reminder gates a task that never parked. **Never reach it
by adding `"plan"` to `ASK_GATES`**: that list is `continueOnGate`, i.e. which
gate VERB crossings hand the turn back, and the park is not a verb.

## A stage subagent must not be able to ask

The mirror of the section above: the plugin cannot originate a question, and no
stage may either. A drive is unattended between the plan gate and the ship gate,
so a question dialog opened mid-VERIFY stalls the run on someone who may not be
at the terminal — on a `watch` worker, on nobody at all. A stage's uncertainty
has channels that keep the loop's control flow: a FAIL/ERROR verdict, a
criterion marked not met, `workflow_blocked`.

The hole is a HOST ASYMMETRY, invisible from any single file. Claude Code and
Qwen agents declare an explicit `tools:` enumeration, so they exclude the ask
tool by construction; **OpenCode agents declare only `permission:`, and inherit
every tool the host ships unless they say otherwise** — which is how `question`
(`@opencode-ai/plugin` 1.18.5) reached all 18 stage agents at once, unannounced,
with nothing failing. A new agent added under `prompts/agents/` inherits it the
same way, so the guard is a test over the GENERATED files
(`scripts/agent-ask-deny.test.mjs`), not a convention.

Three layers, and each one exists because the layer above it can fail silently:
`tools: {question: false}` removes the tool, `permission: {question: deny}`
refuses it if that map is bypassed or the key renamed, and the plugin's
`tool.execute.before` refuses any `question` from a session `findDrivingWorkflow`
attributes to a loop — the only layer that does not depend on a host config key
behaving as documented, and the only one covering a user-added kind's agent.
Never write this as stage-prompt prose: the refusal message names the
alternative at the moment the model errs, which is worth more than a line
carried in every stage's context forever.

**That third layer is host-agnostic too, and Claude/Qwen went without it.** Their
`tools:` enumeration is a property of the agent files THIS repo ships, checked by
a test that runs only here — an agent added to a consuming repo's own workflow
kind, omitting `tools:`, inherits every tool the host offers, and no PreToolUse
matcher could see the ask tool at all. `check-stage-ask.entry.mjs` is the twin:
marker-gated (an ordinary session asks freely), and its own hook rather than a
branch in `check-stage-guard` because that guard fails CLOSED on an unknown host,
which here would refuse a HUMAN's question over a typo'd env var. The same
asymmetry one seam over: the MCP gate tools had no caller-identity check at all,
so `refuseDuringStage` (`stageDeadline !== null` — process-local, so a human's
separate session is untouched) is the server-side twin of `refuseIfDriven`.

This does not starve the gate mechanism above, and the reason is timing: every
gate ask happens in a model turn where no loop owns the session — the task gate
before any drive exists, the plan and ship gates after `clearWorkflow` ran on
the park or the done. `askArmed`/`questionsObservable` therefore still see the
question they are waiting on. A gate ask that ever needed to fire *during* a
drive would be the thing to rethink, not this guard: mid-drive there is no free
model turn to put it in.

## Model selection is a mechanism, never prose

Never express `stageModels` / `agentModels` as an instruction for a model to
follow ("spawn it with `model` set to …"). It was written that way once, and the
setting was quietly ignored: every stage ran the host default while the config
said otherwise, and nothing failed. Each host now BINDS it — Claude Code rewrites
the spawn call's `model` from a `PreToolUse` hook
(`plugins/claude/hooks/src/stamp-spawn-model.entry.mjs`), OpenCode sets
`agent.<name>.model` from its `config` hook, Qwen bakes `model:` into the
installed agent file. Prompt text may **state** which model was bound (that is
the only way a hook regression shows up in a transcript), but must never be the
thing that carries it.

Two traps behind that, both load-bearing:

- **Claude Code's spawn tool takes an alias enum** (`sonnet|opus|haiku|fable`), and
  a value outside it errors the whole spawn rather than falling back. Normalize
  with `spawnAlias`, never `bareModel`, and leave an unmappable value unbound.
- **A bundled hook cannot read the manifests** — `manifest/dir.ts` resolves from
  `import.meta.url` and `build-hooks.mjs` inlines core, so that walk lands in the
  hook's own directory. Anything manifest-derived must be resolved server-side and
  parked on the stage marker, keyed by AGENT (a stage-keyed field goes stale the
  moment `workflow_advance` fires the next stage without rewriting the marker).
