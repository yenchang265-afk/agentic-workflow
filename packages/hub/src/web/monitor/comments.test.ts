import assert from "node:assert/strict"
import { test } from "node:test"
import { REPLAN_REASON_MAX } from "@agentic-workflow/core/workflow/gate"
import { composeReason, REASON_BUDGET, reasonStats, sendableCount, type AnchoredComment } from "./comments.js"

const c = (over: Partial<AnchoredComment> = {}): AnchoredComment => ({
  id: "L1",
  target: "plan",
  anchor: "Move the store",
  note: "this skips the rollback path",
  ...over,
})

test("composeReason quotes each anchor with its note, so the next pass knows what was meant", () => {
  assert.equal(
    composeReason([c(), c({ id: "L9", target: "task", anchor: "Acceptance", note: "criterion 2 is untestable" })]),
    "plan “Move the store”: this skips the rollback path; task “Acceptance”: criterion 2 is untestable",
  )
})

test("composeReason is one line — a multi-line note cannot break out of the audit blockquote", () => {
  const reason = composeReason([c({ note: "first thought\n\nsecond thought" })])
  assert.ok(!reason.includes("\n"))
  assert.match(reason, /first thought second thought/)
})

test("composeReason clips a long anchor but keeps the note", () => {
  const anchor = "A very long plan step that goes on well past what belongs in a single audit note line"
  const reason = composeReason([c({ anchor })])
  assert.match(reason, /…”: this skips the rollback path$/)
  assert.ok(reason.length < anchor.length + 60)
})

test("an abandoned composer sends nothing", () => {
  const comments = [c({ note: "   " }), c({ id: "L2", note: "real" })]
  assert.equal(composeReason(comments), "plan “Move the store”: real")
  assert.equal(sendableCount(comments), 1)
  assert.equal(composeReason([]), "")
})

// This file is browser-bundled, so the budget is DECLARED here rather than
// imported from node-flavoured core — this pin is what keeps the two equal.
// If it fails, core moved its clamp: move REASON_BUDGET with it.
test("REASON_BUDGET is core's REPLAN_REASON_MAX — the clamp every reason writer passes through", () => {
  assert.equal(REASON_BUDGET, REPLAN_REASON_MAX)
})

test("composeReason fits the budget with every comment surviving — the tail is never silently dropped", () => {
  // Long notes on many comments used to compose past core's clamp, whose
  // ellipsis then ate the LAST comments whole: the drawer invited per-line
  // comments and silently never delivered the later ones to the next PLAN
  // pass. Now the note allotment divides instead.
  const many = Array.from({ length: 6 }, (_, i) =>
    c({ id: `L${String(i)}`, anchor: `Plan step ${String(i)} about the store migration`, note: `note ${String(i)}: ${"x".repeat(390)}` }),
  )
  const reason = composeReason(many)
  assert.ok(reason.length <= REASON_BUDGET, `composed ${String(reason.length)} chars — past the budget core would clip`)
  for (let i = 0; i < many.length; i++) {
    assert.ok(reason.includes(`Plan step ${String(i)}`), `comment ${String(i)}'s anchor survived`)
    assert.ok(reason.includes(`note ${String(i)}:`), `comment ${String(i)}'s note head survived`)
  }
  const stats = reasonStats(many)
  assert.equal(stats.budget, REASON_BUDGET)
  assert.equal(stats.squeezed, true)
  assert.equal(stats.length, reason.length)
})

test("a comfortable composition is untouched, and reports unsqueezed", () => {
  const two = [c(), c({ id: "L9", target: "task", anchor: "Acceptance", note: "criterion 2 is untestable" })]
  assert.equal(
    composeReason(two),
    "plan “Move the store”: this skips the rollback path; task “Acceptance”: criterion 2 is untestable",
  )
  assert.equal(reasonStats(two).squeezed, false)
})
