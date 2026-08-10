English | [繁體中文](21-bounded-gate-shell.zh-TW.md)

# 21 — A gate move that cannot hang forever

**Status: implemented.** `sweepStampTemps` in
`packages/core/src/claim-marker.ts`, `boundedShell` in
`plugins/opencode/src/bounded-shell.ts` wired through `gateCtx`,
`withinDeadline` around the four model-callable tools in
`plugins/opencode/src/impl.ts`, fire-and-forget toasts plus phase logging on
the gate paths in `plugins/opencode/src/workflow/driver.ts`;
`bounded-shell.test.ts`, `claim-marker.test.ts`, `driver.test.ts`,
`scripts/shell-glob.test.mjs`.

## Context

Answering the task gate's "Approve?" question in the OpenCode TUI made the
model call `workflow_gate`, and the tool never returned. The TUI spun until the
user killed opencode.

The stored session state and the working tree agree on where it stopped. The
tool call sits at `status:"running"` with a start time and no end. The task file
had ALREADY moved `draft/` → `queued/` with its audit note, 200 ms in — and then
nothing else was written, anywhere, ever. The same tool had done this the
previous day too: 105 seconds, ended `"Tool execution aborted"` when the human
pressed ESC, and the retry seconds later completed in **116 ms** because it took
`approveTask`'s `alreadyDone` arm. That retry is what rules the tail of the
function out: it awaits the same toast and the same `armTaskGateAsk` the hung
call would have reached. What it does not run is the move's own shell work.

The prime suspect there was a glob — the only one in the repo:

```ts
await $`rm -f ${stampPath(markerDir)} ${stampPath(markerDir)}.tmp-*`.quiet().nothrow()
```

Both hosts escape interpolations, and neither escapes the template's own text,
so that token is a quoted prefix welded to an unquoted `*`, pointing at a
`.claims/<id>/` directory that usually does not exist. Expanding it is the only
unbounded work any `$` call in this codebase can do, and the tree it expanded on
was a WSL `/mnt/c` (DrvFs) mount. Every bounded sibling in the same call —
`test`, `mkdir`, `mv`, `printf` — had succeeded milliseconds earlier.

The glob is the instance. The class is that **a gate move had no deadline
anywhere**: not on the shell, not on the tool. OpenCode imposes none of its own,
so "the plugin waits" and "the user's session is dead" were the same state.

## Design

Three layers, so the class dies even if the instance was misdiagnosed.

- **No literal globs.** `releaseMarker` sweeps its stamp temporaries with
  `find <dir> -maxdepth 1 -name ${pattern} -delete`. The pattern rides in as an
  escaped interpolation — no shell expands it, `find` matches it, and
  `-maxdepth 1` bounds the walk to the marker directory.
  `scripts/shell-glob.test.mjs` parses every shipped source with TypeScript's
  own parser (this repo's prose is full of `` `$` `` and backticked example
  commands, so a text-level scan is all false positives) and fails on a literal
  `*` in any `$` template.
- **A bounded `$` for gate verbs** (`boundedShell`, 60 s per command, wired in
  `gateCtx` only). On expiry the call resolves exit **124** — the `timeout(1)`
  convention `host.ts` already specifies for the optional
  `ShellPromise.timeout` Bun's `$` does not implement — and logs a warning
  naming the command. Core's callers all run `.nothrow()` and branch on the exit
  code, so a timeout degrades exactly like a command that failed: the gate move
  still reports, only its best-effort bookkeeping is skipped.
- **A deadline on every model-callable tool.** The gate tools answer in words
  the model can act on; the verdict tools throw, because a returned string reads
  as success and an unrecorded verdict must be retried. `workflow_gate`'s
  message invites a retry — safe only because `alreadyDone` makes a repeat
  approve a no-op — and `workflow_plan`'s explicitly does not, since that call
  claims the task and hands the human's session to a PLAN drive.

Two smaller things the investigation forced: `report()` and `gateFromAgent` now
fire their toasts instead of awaiting them (`.catch()` guards a rejection, not a
hang — and `report` runs on the command-hook path, where an await that never
settles kills the turn silently), and `gateFromAgent` brackets `approveAny` with
log lines. The frame this stalled in had to be reconstructed from file mtimes
and a 5 GB session database; the next one names itself.

## Deliberately not done

- **`deps.$` is NOT bounded.** Checkpoint commits, worktree setup and
  `runChecks` legitimately run long and carry their own regime; a blanket cap
  chosen for file moves would cut them.
- **Nothing is cancelled.** Bun's `$` hands back no way to kill the child, the
  same residual `runChecks`' fallback documents. A timed-out command may still
  be running; the warning says so.
- **The hub's gate context is untouched.** `packages/hub/src/server/gatectx.ts`
  passes its own `sh`, and a stalled request there fails an HTTP call rather
  than wedging a session. Worth the same treatment, not on this change.
- **The exact stalling command is still unproven.** The glob is the only
  unbounded candidate on the path, but `revokePlanRequestAt`'s `rm` and
  `ensureExcluded`'s `git rev-parse`/`grep`/`mkdir`/`printf` were not excluded
  by the evidence. That is precisely what the 124 warning is for: the next
  occurrence, if any, arrives with the command in the log.
