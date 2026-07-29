import assert from "node:assert/strict"
import test from "node:test"
import { unwrapAdoResult } from "./unwrap.js"

test("structuredContent is preferred and passed through verbatim", () => {
  const r = unwrapAdoResult({ structuredContent: { pullRequestId: 7 }, content: [{ text: "ignored" }] })
  assert.deepEqual(r, { ok: true, data: { pullRequestId: 7 } })
})

test("a JSON text block is parsed", () => {
  const r = unwrapAdoResult({ content: [{ type: "text", text: '{"value":[{"pullRequestId":7}]}' }] })
  assert.deepEqual(r, { ok: true, data: { value: [{ pullRequestId: 7 }] } })
})

test("isError reports the server's message", () => {
  const r = unwrapAdoResult({ isError: true, content: [{ type: "text", text: "TF401019: repo not found" }] })
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.error : "", /TF401019/)
})

test("isError with no detail still reports a cause", () => {
  const r = unwrapAdoResult({ isError: true })
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.error : "", /no detail/)
})

test("an empty result is a failure, not an empty success", () => {
  // Degrading this to `{ok:true, data:undefined}` would read downstream as "no
  // PRs need attention", so the loop would quietly stop claiming work.
  const r = unwrapAdoResult({ content: [] })
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.error : "", /empty result/)
})

test("prose fails loudly at the boundary rather than degrading a snapshot", () => {
  const r = unwrapAdoResult({ content: [{ type: "text", text: "Here are the 3 pull requests you asked about." }] })
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.error : "", /non-JSON/)
})

test("an overlong error is truncated", () => {
  const r = unwrapAdoResult({ isError: true, content: [{ text: "x".repeat(500) }] })
  assert.equal(r.ok, false)
  const error = r.ok === false ? r.error : ""
  assert.ok(error.length < 300, `expected truncation, got ${error.length} chars`)
  assert.match(error, /…$/)
})
