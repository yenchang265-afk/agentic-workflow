English | [繁體中文](20-total-command-hooks.zh-TW.md)

# 20 — Total hooks on the OpenCode host

**Status: implemented.** `withTimeout` + the total `log`, the widened
command-hook `try`, `reconcileTimely`, the guarded `event` hook, the
flag-first `warnIgnoredUserConfigOnce`, and the fire-and-forget toasts, all in
`plugins/opencode/src/impl.ts`; `impl.test.ts` (the hanging-config,
rejecting-logger, and event-containment tests).

## Context

Every first invocation of an engineering verb in the OpenCode TUI vanished:
no turn, no toast, no error, no log line — and the retry seconds later worked.
Five swallowed invocations were visible in one day's opencode log as a
`command=agentic-workflow:engineering` line followed by *nothing*.

The mechanism is structural. opencode's `Plugin.trigger` awaits every
`command.execute.before` hook sequentially, wrapped in `Effect.promise`, with
**no try/catch**; the call site only reaches `Session.prompt` after the
trigger resolves. So a hook that rejects — or never settles — kills the whole
command *before the model turn exists*, and nothing reports it. Two
aggravators made the plugin's hook exactly that hook:

- The SDK's own fetch back into the opencode server sets `req.timeout =
  false`. Any `client.*` call awaited on the hook path — the per-command
  config re-read above all — can hang forever if the server stalls.
- The hook's `try` started at the dispatch, ~60 lines in. Everything before
  it — `refreshConfig()`, the kind check, the slice, the draft note — was
  unguarded, and the error paths *inside* that prologue awaited `log(...)`,
  i.e. reported over the same channel that had just failed.

The "twice" shape came from the one-shot guards: `reportAgentModelsOnce` and
`reconcileOnce` set their flags *before* their unguarded awaits, so the first
invocation died inside them and the second skipped them entirely. This is the
second shipping of the class — the `gateFirst` reordering fixed the same
"works after a few tries" symptom for the gate verbs only (see the comment it
left behind), and the variant survived everywhere else.

## Design

One principle: **a hook the host will not catch must be total** — it never
rejects, and every await on it that can hang is time-boxed.

- **One `try` around everything after the prefix match.** The catch writes
  `failurePrompt` into the prompt — the only channel a dead command has — and
  never awaits a TUI call on the way out: the hook must still *resolve* for
  the override to matter.
- **`log` is total.** `client.app.log` is `.catch`-swallowed and time-boxed
  (`LOG_TIMEOUT_MS`). It is also `deps.log`, so the driver's every `await
  log(...)` inherits the guarantee.
- **The config read is time-boxed** (`CONFIG_READ_TIMEOUT_MS`); a timeout
  lands in the existing misconfig arm — last-good config, working command.
- **`reconcileTimely`** contains the startup sweep: time-boxed
  (`RECONCILE_TIMEOUT_MS`) and caught, degrading to a toast — a failed sweep
  must not discard a gate move that already succeeded. The abandoned sweep
  finishing in the background is safe: `reconciled` is already set, and
  `releaseOrphanedClaims` re-judges staleness atomically
  (`releaseMarkerIfStale`), so a claim the verb places while the sweep drains
  survives it.
- **The `event` hook is guarded** — same trigger mechanics, so an escaped
  rejection there is an unhandled one.
- **Toasts are fire-and-forget** everywhere. `.catch()` guards rejection, not
  a hang.
- **One-shot guards set their flag first and own no unguarded awaits after
  it** (`warnIgnoredUserConfigOnce` joins `reportAgentModelsOnce`'s shape).

`withTimeout` never cancels: the abandoned promise keeps its handlers (no
late unhandled rejection) and each call site tolerates late completion.

## Deliberately not done

- **No timeout on `handleCommand`.** Interrupting a real gate move
  mid-flight is worse than waiting; the dispatch is already inside the
  widened try.
- **The `tidy()` fixpoint in `command-slice.ts` is still roughly cubic** — a
  very large pasted `new <idea>` can CPU-stall the hook, the one mechanism
  try/catch and timeouts do not touch. Separate follow-up.
