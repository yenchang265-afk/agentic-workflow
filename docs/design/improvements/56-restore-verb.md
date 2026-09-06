English | [繁體中文](56-restore-verb.zh-TW.md)

# 56 — `restore <id>`: the reversal `abandon` always promised

**Status: implemented.**

## The problem

`abandon` has been documented from the start as the REVERSIBLE cancellation:
"the file is kept, so it can be moved back". Nothing could move it back.
`canTransition` is terminal on `abandoned/` — correctly, for the lifecycle —
so `workflow_move`, the hub's buttons and every gate verb refused, and the
documented reversal was a `mv` by hand that left no audit note, no commit,
and a plan request `moveTask` had deliberately revoked on the way out.

## What changed

- **`restoreAbandoned($, task)`** in `task/store.ts`: `abandoned/` → `draft/`,
  bypassing `canTransition` the way `rescueStray` does — a repair into the
  human-review inbox, not a lifecycle move, so `moveTask` stays strict. The
  same guards: duplicate destination refused, `mv -n`, landed check.
- **`restoreTask(ctx, id, reason?)`** in `workflow/gate.ts`: resolves like
  every verb, refuses a task not in `abandoned/` (naming its folder; "already
  a draft" is informational), writes the `TASK_RESTORED_MARKER` note, moves
  through `noteThenMove` (which gained an optional mover so the note is
  corrected on a failed move, exactly as for a lifecycle move) and commits.
- **`ABANDONED_MARKER` + `extractAbandonOrigin`**: the abandon note is now
  built from a constant and parsed by the stamped-line rules, so `show` can
  report where a task was abandoned from. Display data only.
- **Every surface**: `restore <id> [reason]` on both hosts, `workflow_restore`,
  the hub's Restore button on the abandoned column (`GateAction: "restore"`).

## Sharp edges

- **Always `draft/`, never the origin.** A restore to `queued/` or beyond
  would carry a task-gate approval nobody re-made; the next `approve` is the
  human's decision, and crossing it retires the strike tally
  (`TASK_APPROVED_MARKER`) as for any draft. The plan sections and the
  rejection, if any, survive — the next PLAN pass sees them as `priorPlan`
  and a pending reason, which is right for a task that was parked, not wrong.
- **The claim/live-loop guards are vacuous here** — abandoning released both —
  so they are not repeated; the refusals are the folder and a duplicate id.
- **`canTransition` is untouched.** Widening it to `abandoned → draft` would
  let `workflow_move` and any future caller make the same move without the
  note; the bypass is explicit and single-purpose.
