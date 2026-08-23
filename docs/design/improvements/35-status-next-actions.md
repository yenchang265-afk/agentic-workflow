English | [繁體中文](35-status-next-actions.zh-TW.md)

# 35 — Status says what to type next

**Status: implemented.**

## The problem

`summarizeBacklog` rolls the backlog into counts plus seven actionable id
lists — and the hosts rendered the counts and swallowed the verbs. OpenCode
logged hints for exactly two of the seven (interrupted → `recover`,
in-review → `approve`); a parked plan — the state the whole loop blocks on —
was a bare `1 plan-review (awaiting approve)` inside a one-line roll-up. The
Claude host rendered none at all. Worse, that host called
`summarizeBacklog(byStatus)` without the claim ids, so `claimHeld` was
always empty and every claim-held task misreported as `claimable` — status
said "ready" about work no watcher could actually pick up.

## What changed

- **`nextActions`** (`task/store.ts`): one pure renderer beside the summary
  it renders — one verb-bearing line per non-empty list, human wait-gates
  first (plan-review, in-review), then drafts, queued, build-ready,
  interrupted, claim-held. Id lists elide past 5 (`+N more`); the command
  prefix is a parameter, not baked, because each kind owns its command.
  One renderer shared by both hosts so the state→verb mapping cannot drift.
- **OpenCode** replaces its two hand-picked hints with the full set
  (interrupted and claim-held keep their `warn` level).
- **The Claude host** gains a `nextActions` array on `workflow_status`'s
  result — and now passes `listClaimIds` into `summarizeBacklog`, fixing the
  claimable/claim-held misreport (the OpenCode host had always passed them;
  this one silently didn't).

## Sharp edges

- The lines are HINTS for a human, not machine data — nothing parses them,
  and the summary's id lists remain the structured surface. Rewording a line
  breaks nothing but a memory.
- `claimHeld`'s hint routes to `doctor` (report) and `doctor fix`
  (provably-dead holders only) rather than any release verb — a held claim
  usually means a loop is DRIVING the task, and inviting a release there is
  the double-drive the claim exists to prevent.
- An empty backlog renders zero lines; both hosts omit the section entirely,
  so a quiet repo's status is unchanged.
