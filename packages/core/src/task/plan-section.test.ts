import assert from "node:assert/strict"
import { test } from "node:test"
import { PLAN_HEADING, stripPlanAndAuditTail, withoutPlanSections } from "./plan-section.js"
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

test("a replanned task loses EVERY plan section — superseded plans no longer grow the goal", () => {
  // Deliberate change: superseded plans used to stay as "prose history", which
  // grew the rendered goal by one stale plan per replan cycle — text that
  // duplicates an older version of artifacts.plan and informs no stage. The
  // goal now stops at the FIRST heading.
  const goal = `fix it\n\n${PLAN_HEADING}\n\nold plan\n\n> replanned [2026-07-05T13:16:25.138Z]\n\n${PLAN_HEADING}\n\nnew plan\n`
  const stripped = stripPlanAndAuditTail(goal)
  assert.ok(!stripped.includes("old plan"), "the superseded plan is gone too — it informed no stage")
  assert.ok(!stripped.includes("new plan"), "the live plan is gone — it rides in artifacts.plan")
  assert.ok(stripped.includes("fix it"), "the prose before the first heading survives")
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

// --- withoutPlanSections: the PERSISTED strip, which must keep the audit trail ---

const REJECTED = "> Plan rejected — sent back to queued for re-planning — too broad [2026-07-05T14:00:00.000Z]"
const WRITTEN = "> Plan written [2026-07-05T13:59:00.000Z]"

test("withoutPlanSections is identity for a body with no plan", () => {
  const body = "goal prose\n\nmore context\n"
  assert.equal(withoutPlanSections(body), body)
  assert.equal(withoutPlanSections(""), "")
})

test("withoutPlanSections drops the plan and KEEPS every audit note", () => {
  const body = `goal prose\n\n${PLAN_HEADING}\n\n1. do the thing\n\n### Verification\n\n- test: npm test\n\n${WRITTEN}\n${REJECTED}\n`
  const out = withoutPlanSections(body)
  assert.ok(!out.includes("do the thing"), "the plan text is gone")
  assert.ok(!out.includes(PLAN_HEADING), "and so is its heading")
  assert.ok(!out.includes("### Verification"), "including the plan's own subsections")
  assert.ok(out.includes("goal prose"), "the goal survives")
  assert.ok(out.includes(WRITTEN) && out.includes(REJECTED), "the audit trail is the record a human has — it survives")
})

test("withoutPlanSections handles the interleaving a replan cycle produces", () => {
  // appendPlan appends at END of file, so a second PLAN pass lands AFTER the
  // notes of the first. Cutting one span from the first heading to EOF — what
  // stripPlanAndAuditTail may do for a prompt — would delete those notes.
  const body = `goal\n\n${PLAN_HEADING}\n\nfirst plan\n\n${WRITTEN}\n${REJECTED}\n\n${PLAN_HEADING}\n\nsecond plan\n\n${WRITTEN}\n`
  const out = withoutPlanSections(body)
  assert.ok(!out.includes("first plan") && !out.includes("second plan"), "both plans go")
  assert.equal(out.match(/> Plan written/g)?.length, 2, "both park notes stay")
  assert.ok(out.includes(REJECTED), "and the rejection between them")
})

test("withoutPlanSections leaves prose blank lines alone and does not accrete them at the seams", () => {
  const body = `intro\n\n\nstill the goal\n\n${PLAN_HEADING}\n\nplan\n\n${WRITTEN}\n`
  const out = withoutPlanSections(body)
  assert.ok(out.includes("intro\n\n\nstill the goal"), "interior blank runs are the human's prose")
  assert.equal(out, `intro\n\n\nstill the goal\n\n${WRITTEN}\n`)
  assert.equal(withoutPlanSections(out), out, "idempotent")
})

test("withoutPlanSections keeps a body that is nothing but a plan from becoming whitespace", () => {
  assert.equal(withoutPlanSections(`${PLAN_HEADING}\n\nonly a plan\n`), "")
})
