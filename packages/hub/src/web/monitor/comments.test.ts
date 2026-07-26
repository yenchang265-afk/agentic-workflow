import assert from "node:assert/strict"
import { test } from "node:test"
import { composeReason, sendableCount, type AnchoredComment } from "./comments.js"

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
