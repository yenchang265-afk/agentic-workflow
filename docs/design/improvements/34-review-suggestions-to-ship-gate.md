English | [繁體中文](34-review-suggestions-to-ship-gate.zh-TW.md)

# 34 — A passing review's suggestions reach the human

**Status: implemented.**

## The problem

`verdictFeedbackBlock` filters findings to `isBlocking` on purpose — a
suggestion must not burn a rebuild iteration — but that filter was the ONLY
route out of a check stage, so a passing REVIEW's non-blocking findings
("consider extracting this", "this fixture leaks a pattern") went nowhere a
human looks: not the task file, not the done toast, not the ship gate. Their
one durable home was the redacted metrics sidecar, which surfaces as a
cross-run aggregate in the hub's Metrics tab — a statistics view, read never
and least of all at the moment someone is deciding whether to ship this
diff. The reviewer's judgement was being paid for and discarded.

## What changed

- **`suggestionFindings`** (`workflow/verdict.ts`): the exact complement of
  the feedback filter — `suggestion`-severity findings off the record's axes,
  formatted `axis: detail (location)`, capped at 10.
- **The engine attaches them to the done ACTION** (`advance`'s done arm, check
  stages only). Deliberately the action and not the state: they matter only at
  this run's terminal, `clearState` is about to drop the snapshot anyway, and
  a persisted field would need a schema key zod would otherwise strip
  (the `GitRefSchema` lesson).
- **`runDone` writes one audit note** — `Review suggestions (N) — …` —
  flattened to one line per the audit-note contract, `redact()`ed like every
  model-authored text that lands on the task file, clamped at 800, and
  appended BEFORE the done note so that note stays the trail's newest line
  (the hub's `lastEvent` and `runDoneField` both read from the end).
- **The `TerminalReport` carries them un-flattened**: the OpenCode done toast
  counts them ("Review left 2 suggestions — noted on the task file"), and the
  Claude ship-gate descriptor gains a `suggestions` field plus a `next`
  sentence telling the orchestrator to relay them — explicitly marked
  non-blocking, so a suggestion can never read as a reason to refuse a ship.

## Sharp edges

- **The BUILD feedback seam stays clean.** Suggestions reaching the next
  iteration's prompt is the failure mode the `isBlocking` filter exists to
  prevent; the new path is human-only, and the engine test pins that a
  suggestion-bearing PASS leaves `state.feedback` empty.
- A FAIL's suggestions ride too (the stage's done can only follow an
  effective PASS, but sitter kinds route other verdicts to done) — harmless:
  the cap and the redaction hold either way.
- Metrics are untouched: the sidecar already mirrored all findings, so
  nothing double-counts.
