import assert from "node:assert/strict"
import { test } from "node:test"
import type { WorkflowState, TaskRef } from "./state.js"
import { clearWorkflow, findSessionDriving, planStageTaskId, resumeAtBuild, setWorkflow, startAtPlan } from "./state.js"

// Transition and prompt-composition behavior is covered by the engine parity
// suite (engine.test.ts); this file covers the constructors and the
// in-memory session store.

const mk = (goal: string, task?: TaskRef): WorkflowState => ({
  goal,
  stage: "build",
  iteration: 0,
  artifacts: {},
  ...(task ? { task } : {}),
})

const task: TaskRef = { id: "add-foo", path: "/r/docs/tasks/in-progress/add-foo.md", acceptance: [] }

test("resumeAtBuild constructs a build-entry state with the approved plan threaded", () => {
  const s = resumeAtBuild("add foo", task, "PLAN BODY")
  assert.equal(s.stage, "build")
  assert.equal(s.iteration, 0)
  assert.equal(s.artifacts.plan, "PLAN BODY")
  assert.deepEqual(s.task, task)
})

test("startAtPlan constructs a plan-entry state, threading a prior plan only on a replan", () => {
  const s = startAtPlan("add foo", task)
  assert.equal(s.stage, "plan")
  assert.equal(s.artifacts.plan, undefined)
  const r = startAtPlan("add foo", task, "OLD PLAN")
  assert.equal(r.artifacts.plan, "OLD PLAN")
})

test("findSessionDriving locates the session whose loop drives a task id", () => {
  const t: TaskRef = { id: "add-foo", path: "/p", acceptance: [] }
  setWorkflow("ses-1", mk("g", t))
  try {
    assert.equal(findSessionDriving("add-foo"), "ses-1")
    assert.equal(findSessionDriving("other-task"), undefined)
  } finally {
    clearWorkflow("ses-1")
  }
})

test("findSessionDriving ignores loops with no task ref", () => {
  setWorkflow("ses-2", mk("just a goal"))
  try {
    assert.equal(findSessionDriving("just a goal"), undefined)
  } finally {
    clearWorkflow("ses-2")
  }
})

test("planStageTaskId resolves the PLAN-stage task id from any session, else null", () => {
  assert.equal(planStageTaskId(), null)
  const t: TaskRef = { id: "add-foo", path: "/p", acceptance: [] }
  setWorkflow("ses-drive", startAtPlan("add foo", t))
  try {
    // A subagent's own sessionID isn't in the store, but the carve-out still resolves.
    assert.equal(planStageTaskId(), "add-foo")
  } finally {
    clearWorkflow("ses-drive")
  }
  // A non-PLAN loop (BUILD) does not arm the carve-out.
  setWorkflow("ses-build", mk("g", t))
  try {
    assert.equal(planStageTaskId(), null)
  } finally {
    clearWorkflow("ses-build")
  }
})
