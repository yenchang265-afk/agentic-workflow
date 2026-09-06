English | [繁體中文](54-local-loop-observability.zh-TW.md)

# 54 — The loop reports its own clock and budget

**Status: implemented.**

## The problem

Design 44 made `status` see loops driven by OTHER processes — stage,
deadline, host — and left its own loop reported as `stage · iteration N`:
no cap, no deadline, though this process holds both. `notifyEvents` covered
the four terminal events only, so a human wired to a chat webhook heard
nothing between "plan approved" and "review passed" — an hour or more of
silence on a three-iteration run. A stage that ran into its wall-clock cap
ERRORed the run with no warning first. And OpenCode's `deferIdle` — the
arm that queues a typed `plan`/`claim` behind a busy tree — was silent, so
the command looked swallowed.

## What changed

- **`status` reports its own loop's budget and clock.** Both hosts render
  `iteration N/cap` (`iterationCap`, the same resolution `advance` stops on)
  and the stage deadline: OpenCode from this process's own live stage marker
  (the oracle it already read for other processes), the Claude host from its
  `stageDeadline`.
- **`notifyEvents` gains `"stage"`** — opt-in. `notifyLoopEvent` is the
  notifier `notifyTerminal` always was, exported, and both hosts call it on
  every stage fire with `AW_MESSAGE` naming the stage and iteration. Unset
  `notifyEvents` still means the terminal events only: a notifier wired for
  "the gate is waiting" must not start buzzing per stage unasked.
- **A near-deadline warning.** OpenCode's `runStage` fires a callback at
  `NEAR_DEADLINE_FRACTION` (80%) of the cap while the stage still runs, and
  the driver logs how long it has been running and when it times out. The
  Claude host has no timer of its own — its deadline is judged at
  `workflow_advance` — so it gets none.
- **`deferIdle` logs** that the tree is busy and the queued work waits.

## Sharp edges

- **`stage` is opt-in for the same reason the terminal events are not.**
  The default set is what design 31 promised; widening it would change every
  existing notifier's cadence.
- **The warning is a log line, not a stop.** Bounded, never awaited, cleared
  in the same `finally` as the timeout — a slow log must not hold the stage.
- **Own-loop deadline comes from the marker, not a new clock.** The marker
  is already restamped at every stage boundary; a second timestamp would be
  one more thing to keep in step.
