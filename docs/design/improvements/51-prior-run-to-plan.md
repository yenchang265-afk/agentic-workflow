English | [繁體中文](51-prior-run-to-plan.zh-TW.md)

# 51 — The replan's PLAN pass sees what the last run left behind

**Status: implemented.**

## The problem

A run that stops at the iteration cap (or is sent back by `replan` from
`in-progress/`) leaves two things the next PLAN pass needs and was never
told about. Its commits are still on `feature/<id>` — the branch survives
`closeIsolation`, and the next BUILD is cut from it — but nothing on the task
said so, so the replan planned as if the tree were clean and the builder
discovered the old work by surprise. And the discovered checks that
admission REFUSED were recorded only in the deny log and in a checks-
provenance audit note the goal render strips, so the next plan re-authored
the same denied commands and VERIFY ran no checks again behind one warning
line. Design 25 threaded the attempts digest into the replan reason; these
two facts had no channel at all.

## What changed

- **`runStop` writes a `> Prior work` note** on a non-transient stop of an
  isolated run — branch, base, and a validated `git diff --shortstat` — in
  the done note's field shape and BEFORE the attempts note, so that note
  stays the last `> Run stopped` line `extractStopContext` reads.
- **`priorRunFor(task)`** parses, at a PLAN claim, the last such note AND
  the last checks-provenance note's `discovered check "…" refused: …`
  entries, both retired by the same anchors as the stop context (a new plan
  heading, a `Plan written` park, a reshape). Every field is validated to
  the shape it will be interpolated as — a branch reaches a git command.
- **`WorkflowState.priorRun`** rides the PLAN-entry state on both claim
  paths (`backlog.ts` and `planEntryState`), never persisted (like `replan`,
  a plan-stage snapshot is invalid by design), and plan.md renders it as a
  section: the branch with its diffstat and diff command, the instruction to
  DECIDE whether to build on or discard that work, and the refused commands
  with the instruction to name admissible ones instead.

## Sharp edges

- **The attempts note stays last.** Two `> Run stopped`-family notes would
  have let the newer one shadow the digest; the prior-work note has its own
  marker and is written first.
- **Retired by the same anchors as the stop context.** A section that
  described a branch a newer plan already decided about would send the
  planner after stale facts; the trio of anchors is shared through one
  helper so the parsers cannot drift.
- **Refusals are best-effort.** The provenance note's detail is clamped at
  write, so a long list may end mid-entry; what survives is still what the
  next planner must not write again.
