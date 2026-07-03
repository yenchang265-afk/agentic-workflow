import assert from "node:assert/strict"
import { test } from "node:test"
import type { Task } from "./schema.ts"
import { extractPlan, hasPlan, isClaimable, isRecoverable, PLAN_HEADING, selectNext, wasInterrupted } from "./store.ts"

const task = (id: string, priority: number, body = ""): Task => ({
  id,
  title: id,
  priority,
  acceptance: [],
  body,
  path: `/r/docs/tasks/in-progress/${id}.md`,
})

test("selectNext returns null for an empty backlog", () => {
  assert.equal(selectNext([]), null)
})

test("selectNext picks the lowest priority number first", () => {
  const picked = selectNext([task("b", 5), task("a", 2), task("c", 9)])
  assert.equal(picked?.id, "a")
})

test("selectNext breaks priority ties by id", () => {
  const picked = selectNext([task("zebra", 1), task("apple", 1)])
  assert.equal(picked?.id, "apple")
})

test("selectNext does not mutate the input array", () => {
  const tasks = [task("b", 5), task("a", 2)]
  selectNext(tasks)
  assert.equal(tasks[0]?.id, "b")
})

test("hasPlan is false when the body has no plan heading", () => {
  assert.equal(hasPlan(task("a", 0, "Some description.")), false)
})

test("hasPlan is true once the plan heading is present", () => {
  const body = `Some description.\n\n${PLAN_HEADING}\n\n1. Do the thing.`
  assert.equal(hasPlan(task("a", 0, body)), true)
})

test("extractPlan returns undefined when there is no plan heading", () => {
  assert.equal(extractPlan(task("a", 0, "Some description.")), undefined)
})

test("extractPlan returns the text after the heading, trimmed", () => {
  const body = `Some description.\n\n${PLAN_HEADING}\n\n1. Do the thing.\n2. Test it.`
  assert.equal(extractPlan(task("a", 0, body)), "1. Do the thing.\n2. Test it.")
})

test("wasInterrupted is false when there is no build marker", () => {
  assert.equal(wasInterrupted(task("a", 0, "Some description.")), false)
})

test("wasInterrupted is false when the last start has a matching finish", () => {
  const body = "> BUILD started (iteration 1)\n> BUILD finished (iteration 1)"
  assert.equal(wasInterrupted(task("a", 0, body)), false)
})

test("wasInterrupted is true when a start has no matching finish", () => {
  const body = "> BUILD started (iteration 1)"
  assert.equal(wasInterrupted(task("a", 0, body)), true)
})

test("wasInterrupted is true when only the latest pair is unmatched", () => {
  const body = [
    "> BUILD started (iteration 1)",
    "> BUILD finished (iteration 1)",
    "> BUILD started (iteration 2)",
  ].join("\n")
  assert.equal(wasInterrupted(task("a", 0, body)), true)
})

test("isClaimable is false when there is no plan", () => {
  assert.equal(isClaimable(task("a", 0, "Some description.")), false)
})

test("isClaimable is false when a plan exists but a build already started and finished", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.\n\n> BUILD started (iteration 1)\n> BUILD finished (iteration 1)`
  assert.equal(isClaimable(task("a", 0, body)), false)
})

test("isClaimable is false when a plan exists and the last build start is unmatched (interrupted)", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.\n\n> BUILD started (iteration 1)`
  // Distinct from wasInterrupted, which is also true here — isClaimable cares
  // about ANY build marker, not just whether the last pair is unmatched.
  assert.equal(wasInterrupted(task("a", 0, body)), true)
  assert.equal(isClaimable(task("a", 0, body)), false)
})

test("isClaimable is true when a plan exists and there are zero build markers", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.`
  assert.equal(isClaimable(task("a", 0, body)), true)
})

test("isRecoverable is false when there is no plan", () => {
  assert.equal(isRecoverable(task("a", 0, "> BUILD started (iteration 1)")), false)
})

test("isRecoverable is false when a planned task was never started", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.`
  assert.equal(isRecoverable(task("a", 0, body)), false)
})

test("isRecoverable is true once a planned task has any build marker", () => {
  const body = `${PLAN_HEADING}\n\n1. Do the thing.\n\n> BUILD started (iteration 1)`
  assert.equal(isRecoverable(task("a", 0, body)), true)
})

test("isRecoverable stays true after a matched finish (recover is for any stuck started task)", () => {
  const body = `${PLAN_HEADING}\n\n1. Do it.\n\n> BUILD started (iteration 1)\n> BUILD finished (iteration 1)`
  assert.equal(isRecoverable(task("a", 0, body)), true)
})
