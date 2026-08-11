English | [繁體中文](23-cap-context-threading.zh-TW.md)

# 23 — Every replan channel carries substance

**Status: implemented.**

## The problem

Design 10 gave the plan gate's rejection reason a channel (a parseable audit
note, threaded into the next PLAN pass's `{{#replan}}` section). Three replan
paths still carried nothing:

1. **The cap trip.** A run that burned its iteration budget knew exactly what
   every attempt failed on — VERIFY's reasons, REVIEW's findings, the attempts
   ledger — and discarded all of it: `runStop` cleared the snapshot, the
   capMessage note was not the `planRejectedNote` shape, and plan.md has no
   `{{#attempts}}`. The next PLAN pass re-planned blind, with the human's
   typed reason as the only carrier — the archaeology-instead-of-channel
   pattern design 10 eliminated, back again for the costliest replans.
2. **The bare replan.** `replan <id>` with no reason rendered `{{#replan}}` as
   NOTHING — the planner got its prior plan labeled "superseded" with zero
   indication it was rejected at all, and the likeliest outcome was the same
   plan resubmitted.
3. **The claim-held replan.** `replanQueued` refusing (a planner holds the
   file right now) silently DROPPED the typed reason — the human's one copy of
   it died with the toast.

Also unbounded: no writer bounded the reason's length, so a long hub-composed
review became one enormous audit line.

## What changed

- **The stop digest** (`stopContextNote`/`extractStopContext`,
  `packages/core/src/task/store.ts`; `attemptsDigest` in
  `workflow/terminal.ts`): a non-transient stop with attempts on its ledger
  appends `Run stopped — attempts: iteration N STAGE VERDICT: reason; …`
  (clamped 800 chars) to the task file — durable where the snapshot is not.
  Retired by the same anchors as the rejection reason (a newer plan heading or
  `Plan written` park). Gated on `!retryable`: a flaky-environment stop's
  ledger is noise. `replanTask` then **fuses** it —
  `<human reason> — prior run: <digest>` — into the existing
  `planRejectedNote`, so it reaches `{{replan.reason}}` with zero new state
  fields or template sections, exactly design 10's channel. plan.md gains one
  sentence telling the planner an attempt ledger demands a materially
  different approach (oracle updated in `engine.test.ts`).
- **The reasonless fallback** (`pendingPlanRejection`/`replanFor`,
  `task/store.ts`): the parser now distinguishes "no rejection pending" from
  "pending with no reason" (`extractReplanReason` is just `replanFor`'s
  `.reason`), and both PLAN-entry builders — `planEntryState`
  (`workflow/orchestrate.ts`) and the claim/watch `entryState`
  (`source/backlog.ts`) — go through one `replanFor`, which substitutes
  `NO_REASON_FALLBACK` text. The fallback must be a VALUE: the template
  language has no inverted section.
- **The bounded line** (`REPLAN_REASON_MAX = 1200`, `oneLineReason` in
  `workflow/gate.ts`): one clamp at the single choke point every writer —
  CLI, MCP, hub composer — passes through. Generous enough for a fused digest.
- **The echoed refusal** (`replanQueued`): the claim-held arm now echoes the
  typed reason back — "Your reason was NOT recorded — re-send it then: …" —
  so it survives the refusal. (The hub's composer already keeps its comments
  on a refusal; nothing to change there.)

## What was deliberately not done

- No frontmatter or in-memory carrier for the cap context — design 10
  explicitly rejected both; the audit note is the one channel.
- No persistence of the reason through a held claim (e.g. riding the
  plan-request marker): appending to a file the live planner is rewriting is
  a lost update, and the ephemeral marker must not become a second reason
  channel.
- Only the NEWEST pending digest threads — same last-note-wins rule as the
  rejection reason; multi-round accumulation would need a multi-note parser
  no current consumer wants.

## Where it lives

`RUN_STOPPED_MARKER`/`stopContextNote`/`extractStopContext`/`pendingPlanRejection`/
`replanFor`/`NO_REASON_FALLBACK` in `packages/core/src/task/store.ts`;
`attemptsDigest` + the digest note in `runStop` (`workflow/terminal.ts`); the
fuse in `replanTask` + the clamp in `oneLineReason` + the echo in
`replanQueued` (`workflow/gate.ts`); `replanFor` threading in
`workflow/orchestrate.ts` and `source/backlog.ts`; the ledger sentence in
`workflows/engineering/stages/plan.md`. Tests: `store.test.ts`,
`terminal.test.ts`, `gate.test.ts`, `engine.test.ts`.
