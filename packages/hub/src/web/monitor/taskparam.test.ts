import assert from "node:assert/strict"
import { test } from "node:test"
import { parseTaskParam, taskParam } from "./taskparam.js"

test("parseTaskParam reads a well-formed status/id pair", () => {
  assert.deepEqual(parseTaskParam("plan-review/fix-pagination"), { status: "plan-review", id: "fix-pagination" })
  assert.deepEqual(parseTaskParam("draft/x"), { status: "draft", id: "x" })
})

test("parseTaskParam keeps the whole id, slashes and all", () => {
  // Truncating at the second slash would open a DIFFERENT task than the link
  // named — worse than opening none.
  assert.deepEqual(parseTaskParam("queued/a/b/c"), { status: "queued", id: "a/b/c" })
})

test("parseTaskParam rejects anything that isn't a real status/id pair", () => {
  for (const param of [
    undefined,
    "",
    "draft", // no id
    "draft/", // empty id
    "/fix-pagination", // no status
    "not-a-status/fix-pagination", // typo or an old link
    "DRAFT/fix-pagination", // vocabulary is lowercase
  ]) {
    assert.equal(parseTaskParam(param), null, `param: ${String(param)}`)
  }
})

test("taskParam round-trips through parseTaskParam", () => {
  const round = parseTaskParam(taskParam("in-review", "ship-me"))
  assert.deepEqual(round, { status: "in-review", id: "ship-me" })
})
