English | [繁體中文](45-comment-reason-budget.zh-TW.md)

# 45 — Plan-review comments share the reason budget

**Status: implemented.**

## The problem

The hub's plan-review drawer invites per-line anchored comments and fuses
them into the one `reason` a replan carries. `composeReason` joined them
unbounded — while core clamps every gate reason at `REPLAN_REASON_MAX`
(1200) through `oneLineReason`, whose ellipsis then ate the TAIL comments
whole. Two or three average anchored comments compose past 1200, so the
later comments silently never reached the next PLAN pass — exactly the
vague-replan failure the per-line commenting feature was built to fix, with
no warning anywhere.

## What changed

- **Budget-aware composition.** When the comfortable form (400 chars per
  note) fits, the output is byte-identical to before. When it would blow
  the budget, the note allotment divides evenly across comments (floor 40)
  so EVERY comment survives clipped — losing each note's tail beats losing
  whole comments. The final hard clip is reachable only when the floor
  engages (very many comments), where core's own clip would fire anyway.
- **A visible meter.** The drawer's send bar shows `reason N/1200`, and
  says when notes are being squeezed ("trim or consolidate to keep every
  point whole").
- **`REASON_BUDGET` is pinned to core.** Declared web-side because
  `comments.ts` is browser-bundled and core is node-flavoured;
  `comments.test.ts` imports core's `REPLAN_REASON_MAX` and asserts the two
  equal, so they cannot drift silently.

## Sharp edges

- **Anchors always survive whole** (clipped at their own 60-char cap): the
  quote is what tells the next PLAN pass *which* step a note is about — a
  note with no anchor is the "this is wrong, three stages later" failure
  the anchor exists to prevent.
- **Core's clamp stays.** `oneLineReason` remains the choke point on every
  writer's path; this change makes the hub compose INSIDE it rather than
  trusting it to truncate well.
