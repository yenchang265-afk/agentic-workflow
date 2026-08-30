# The driver, its hooks, and its tools

How a run is halted, published, and snapshotted, and the three ways a hook or a
tool kills a turn without saying anything. Each rule names the exit path that
must stay chosen deliberately, on every host.

Part of the engineering invariants indexed in [`AGENTS.md`](../../AGENTS.md)
— that index carries each rule in one line; this file carries the reasoning
behind it, which is what stops a future change from "fixing" the rule back.

## A halt needs a durable REASON, not a cleared workflow (OpenCode)

`clearWorkflow` cannot halt a drive, because the chain re-registers the session
with `setWorkflow` at **every** transition — so a `stop` landing between the
post-stage halt check and that call (a window spanning a checkpoint commit and
two audit notes) was undone: "Loop stopped." to the user, next stage fired
anyway. The halt is `haltReason`, armed **synchronously ahead of the verb's first
await** — the pass aborts the verb itself issues are only swallowed by
`runStagePasses` once `halted` says so, and arming after them turned a stop into
a "Loop error" with the crash snapshot left for `recover` to resurrect.

Three things it has to keep:

- **A reason map, not a flag.** ESC is a PAUSE (snapshot kept, `recover <id>`
  resumes at that stage); `stop` is an END (snapshot dropped). `armHalt` never
  lets `"interrupted"` overwrite `"stopped"`, because the stop's own aborts come
  back through `onInterrupt` on that very session.
- **Both boundaries, not one.** `haltIfAsked` runs before a fire as well as after
  one. The post-stage check alone still burns a whole stage, and only the
  pre-fire one covers the pre-`setWorkflow` window where `ensureIsolation` can
  run for minutes.
- **`driving.has || getWorkflow` is the busy test**, matching claim/plan/recover.
  `getWorkflow` alone made `stop` report "No active loop to stop." for a drive
  that was very much in flight.

## A transition is published to the store and the snapshot together (OpenCode)

`driveChain` publishes a transition to the session store the moment `advance`
returns, because `recordVerdict` judges a verdict against
`getWorkflow(sessionID).stage`. The **snapshot is the same fact on disk** and has
to travel with it: it is `recover`'s only oracle (`loadState` resumes at
`snap.stage`, and an ESC deliberately KEEPS it), and its only write used to be
the one at the TOP of the next iteration — behind `ensureIsolation` and
`runStageChecks`, minutes of shelling out. Through that window the file still
named the stage the loop had already left, so a resume re-entered at it: a run
that had reached REVIEW came back at VERIFY, the live REVIEW subagent's verdict
was refused as stage drift ("the loop is at verify, not review"), and the whole
stage was retried and thrown away.

Both writes stay. The one at the transition publishes the STAGE promptly; the one
at the top of the iteration is the only one carrying the POST-isolation
`git`/worktree fields. The source lint in `driver.test.ts` pins the order:
nothing awaited between `advance` and `setWorkflow`, the snapshot immediately
after.

The refusal this produced has to be ACTIONABLE too — `stageDriftRefusal`, beside
`stageDriftNote` (the audit trail) and `stageDriftAdvice` (the orchestrator).
Its reader is the refused agent, which can move the machine on neither host, so
it retried a call that can never succeed until the stage's budget was gone. It
must never invite a re-file under the stage the loop IS at: the SubagentStop nag
names that stage, and a drifted REVIEW re-filing as VERIFY turns lost coverage
into a fabricated verdict. And never relax the stage check itself to make the
retry succeed.

## An OpenCode hook that rejects or hangs kills the turn silently

opencode's `Plugin.trigger` awaits `command.execute.before` / `event` hooks
with NO try/catch of its own, and the SDK's fetch back into the server sets
`req.timeout = false` — so an await that rejects or never settles kills the
command BEFORE `Session.prompt`, with zero log output. The user's command just
vanishes and the retry "works", because the one-shot guards it died inside
(`reconciled`, `reportedAgentModels`) are now set. This class shipped twice:
first as reconcile-before-gate-move (the `gateFirst` reordering), then as the
unguarded ~60-line prologue before the dispatch try (plan 20). The closures in
`plugins/opencode/src/impl.ts`, all load-bearing:

- The ENTIRE hook body after the prefix match runs inside ONE try; the catch
  writes `failurePrompt` into the prompt — the only channel a dead command
  has — and never awaits a TUI call on the way out (the hook must still
  RESOLVE for the override to matter).
- `log` is total (never rejects, time-boxed) — it is also `deps.log`, so the
  driver inherits the guarantee. Toasts are fire-and-forget everywhere:
  `.catch()` guards a rejection, not a hang.
- **Every awaited `client.*` call on a hook, event or DRIVE path is either
  time-boxed or `void`ed with a `.catch` sink.** Scoping this to "hook paths"
  is what let seven `await toast(…)` sites be written into `driveChain`/
  `tryClaim` — inside `onIdle`'s try, ahead of the `finally` that releases
  `driving`/`executingDirs` — after plan 20, in the file that documents the
  rule; and it is why `load-failure.ts` awaited two reports ahead of the
  prompt override, reproducing plan 20's bug on the fail-LOUD path. The drive
  path is worse than the hook path, not better: a hook at least dies with the
  turn, while a hung toast at the end of a SUCCESSFUL run strands the session,
  the shared tree and the stage marker for the life of the process. Pinned by
  a source lint (`driver.test.ts`), because the prose form was violated seven
  times in one file.
- Client calls on a hook path are `withTimeout`-boxed (config read,
  reconcile). NOT `handleCommand` — interrupting a real gate move is worse
  than waiting.
- A one-shot guard sets its flag FIRST and owns no unguarded await after it.

## A hook's last line is where its fail direction is CHOSEN

The Claude/Qwen twin of the rule above, and the same failure wearing the other
host's clothes. An un-caught throw exits 1, which Claude Code treats as a
non-blocking error: the turn PROCEEDS. So a bare `main()` is not "no direction"
— it is fail-OPEN, silently, including in `gate-command.mjs`, whose entire
reason to exist is refusing the double-move (design 42's ETIMEDOUT arm BLOCKS
precisely because "the move may or may not have landed"). Two of eight entry
points ended `main().catch(() => allow())`; six ended bare, and nothing failed.

- Every entry ends `main().catch(<direction>)`, pinned by
  `hook-fail-direction.test.mjs` — which also fails on a `hooks.json` command
  it does not list, so a new hook cannot be added past the rule.
- The enforcement hooks fail OPEN (`failOpen`, `hooks/src/crash.mjs`): a false
  deny stalls a run with no way out, a false allow only restores the behaviour
  that predates the control. `gate-command` is the one non-flat choice — its
  matcher is `""`, so it sees every prompt in the session: a crash BEFORE the
  dispatch passes through (nothing moved), a crash after it blocks.
- A silent fail-open is half a rule. There was no crash channel at all — the
  deny log records allowlist refusals only — so a hook throwing on every call
  looked exactly like a hook with nothing to say. `failOpen` writes one line
  first, and its exit is BOUNDED: `exitAfterWrite`'s wait-for-the-flush rule
  would re-enter the very hang it guards if stderr never drains.

## A plugin TOOL that hangs is the same failure with no way out

The rule above is about hooks; the tools are worse, because a hook at least dies
with the turn. OpenCode imposes NO deadline on a tool's `execute`, so one that
never settles leaves the call `running` forever with the model's turn behind it
— the only exit is ESC or killing opencode. `workflow_gate` did exactly that on
an approved draft: the task file had already moved, so the visible state was a
spinner over work that was DONE. Hence three standing rules.

- **Every model-callable tool answers.** The gate tools return a sentence the
  model can act on (`withinDeadline` → a message); the verdict tools THROW,
  because a string reads as success and an unrecorded verdict must retry. The
  gate message may invite a retry only because `approveTask`'s `alreadyDone` arm
  makes a repeat approve a no-op — never invite one where the call claims a task
  (`workflow_plan` starts a drive on the human's own session).
- **A gate verb's `$` is bounded** (`boundedShell`, wired in `gateCtx` only).
  Exit 124 is the contract `host.ts` already specifies, and core reads it as an
  ordinary failed command, so the move still reports and only its best-effort
  bookkeeping is skipped — a timeout that THREW would turn a skipped `git add`
  into a failed approval. Not `deps.$`: checkpoint commits, worktree setup and
  `runChecks` legitimately run long and carry their own regime. **A new surface
  that makes gate moves gets this bound before it ships** — OpenCode, then the
  model hosts, then the hub is the same lesson three times, and the hub was the
  worst of them: the moves run inside an HTTP request, so the hang was a
  spinner over work that was done, with a mouse instead of a model.
- **A `$` template may never contain a literal `*`.** Interpolations are escaped
  by both hosts (Bun's `$` by construction, the Claude shim via `esc()`), so a
  `*` in the template's own text is the ONLY way a real glob — the only
  unbounded primitive a shell call has — reaches a command. One shipped
  (`rm -f <stamp> <stamp>.tmp-*`, `claim-marker.ts`) and it is what stalled the
  gate above on a WSL `/mnt/c` tree. A pattern that genuinely needs one is passed
  as an escaped interpolation and matched by the tool
  (`find … -maxdepth 1 -name ${pat} -delete`).
  `scripts/shell-glob.test.mjs` parses every shipped source and fails on a
  literal one.
