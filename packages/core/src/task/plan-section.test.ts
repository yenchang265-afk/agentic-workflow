import assert from "node:assert/strict"
import { test } from "node:test"
import { PLAN_HEADING, stripPlanAndAuditTail } from "./plan-section.js"
import { extractPlan } from "./store.js"
import type { Task } from "./schema.js"

const task = (body: string): Task => ({
  id: "t",
  title: "t",
  priority: 1,
  acceptance: [],
  labels: [],
  body,
  path: "/r/docs/tasks/in-progress/t.md",
})

const NOTE = "> CLAIMED — loop starting [2026-07-05T13:16:25.138Z]"
const BUILD_NOTE = "> BUILD started [2026-07-05T13:20:00.000Z]"

test("identity when the text has neither a plan nor an audit tail — byte-identical, trailing newline included", () => {
  const goal = "fix the flaky test\n\nSome context.\n"
  assert.equal(stripPlanAndAuditTail(goal), goal)
  assert.equal(stripPlanAndAuditTail(""), "")
})

test("strips the plan section and the audit notes accreted before it", () => {
  const goal = `fix it\n\nRequirements here.\n\n${NOTE}\n\n${PLAN_HEADING}\n\n1. do the thing\n\n${BUILD_NOTE}\n`
  assert.equal(stripPlanAndAuditTail(goal), "fix it\n\nRequirements here.")
})

test("strips a trailing audit run on a task that has no plan yet (queued + claimed)", () => {
  const goal = `fix it\n\nProse stays.\n\n${NOTE}\n${BUILD_NOTE}\n`
  assert.equal(stripPlanAndAuditTail(goal), "fix it\n\nProse stays.")
})

test("a prose blockquote is not an audit note and survives", () => {
  const goal = "fix it\n\n> the spec says the button must be blue\n"
  assert.equal(stripPlanAndAuditTail(goal), goal)
})

test("a plan heading quoted mid-line is not a plan section", () => {
  const goal = `fix it — the bug is in how we detect ${PLAN_HEADING} markers\n`
  assert.equal(stripPlanAndAuditTail(goal), goal)
})

test("a replanned task loses only the LAST plan — superseded plans are prose history", () => {
  const goal = `fix it\n\n${PLAN_HEADING}\n\nold plan\n\n> replanned [2026-07-05T13:16:25.138Z]\n\n${PLAN_HEADING}\n\nnew plan\n`
  const stripped = stripPlanAndAuditTail(goal)
  assert.ok(stripped.includes("old plan"), "the superseded plan stays — extractPlan never returns it")
  assert.ok(!stripped.includes("new plan"), "the live plan is gone — it rides in artifacts.plan")
})

test("stripping is idempotent", () => {
  const goal = `fix it\n\n${NOTE}\n\n${PLAN_HEADING}\n\nplan\n\n${BUILD_NOTE}\n`
  const once = stripPlanAndAuditTail(goal)
  assert.equal(stripPlanAndAuditTail(once), once)
})

test("round-trip: what the goal loses is exactly what artifacts.plan carries — nothing lost, nothing doubled", () => {
  const body = `Requirements prose.\n\n${NOTE}\n\n${PLAN_HEADING}\n\n1. step one\n2. step two\n\n${BUILD_NOTE}\n`
  const plan = extractPlan(task(body))
  const goal = stripPlanAndAuditTail(`t\n\n${body}`)
  assert.equal(plan, "1. step one\n2. step two")
  assert.ok(goal.includes("Requirements prose."))
  assert.ok(!goal.includes("step one"), "the plan text appears only in the artifact")
  assert.ok(!goal.includes("CLAIMED"), "audit notes appear in neither")
})
