import assert from "node:assert/strict"
import { test } from "node:test"
import type { Config } from "./state.ts"
import { advanceOnIdle, composeArgs, createState, resume } from "./state.ts"

const config: Config = { maxIterations: 3, gateBeforeBuild: true, tasksDir: "docs/tasks" }

test("explore auto-advances to plan, threading findings", () => {
  const s = createState("add foo")
  const { state, action } = advanceOnIdle(s, config, "explore findings here")
  assert.equal(action.kind, "fire")
  assert.equal(state.stage, "plan")
  if (action.kind === "fire") {
    assert.equal(action.stage, "plan")
    assert.match(action.arguments, /Goal: add foo/)
    assert.match(action.arguments, /explore findings here/)
  }
})

test("plan gates before build when gateBeforeBuild is on", () => {
  const s = { ...createState("g"), stage: "plan" as const }
  const { state, action } = advanceOnIdle(s, config, "the plan")
  assert.equal(action.kind, "gate")
  assert.equal(state.paused, true)
})

test("plan fires build directly when gating is off", () => {
  const s = { ...createState("g"), stage: "plan" as const }
  const { action } = advanceOnIdle(s, { ...config, gateBeforeBuild: false }, "the plan")
  assert.equal(action.kind, "fire")
  if (action.kind === "fire") assert.equal(action.stage, "build")
})

test("resume from the gate fires build with the plan threaded", () => {
  const paused = { ...createState("g"), stage: "plan" as const, paused: true, artifacts: { plan: "PLAN BODY" } }
  const { state, action } = resume(paused)
  assert.equal(state.stage, "build")
  assert.equal(state.paused, false)
  if (action.kind === "fire") {
    assert.equal(action.stage, "build")
    assert.match(action.arguments, /PLAN BODY/)
  }
})

test("resume is a noop when not paused", () => {
  const s = { ...createState("g"), stage: "plan" as const }
  assert.equal(resume(s).action.kind, "noop")
})

test("build auto-advances to verify", () => {
  const s = { ...createState("g"), stage: "build" as const }
  const { state, action } = advanceOnIdle(s, config, "diff summary")
  assert.equal(state.stage, "verify")
  assert.equal(action.kind, "fire")
})

test("verify PASS finishes the loop", () => {
  const s = { ...createState("g"), stage: "verify" as const }
  const { action } = advanceOnIdle(s, config, "all met\nLOOP_VERIFY: PASS")
  assert.equal(action.kind, "done")
})

test("verify FAIL within budget re-plans with the failure threaded", () => {
  const s = { ...createState("g"), stage: "verify" as const, iteration: 0, artifacts: { plan: "P" } }
  const { state, action } = advanceOnIdle(s, config, "gap: missing test\nLOOP_VERIFY: FAIL")
  assert.equal(state.stage, "plan")
  assert.equal(state.iteration, 1)
  if (action.kind === "fire") {
    assert.equal(action.stage, "plan")
    assert.match(action.arguments, /missing test/)
  }
})

test("verify FAIL at the iteration cap stops", () => {
  const s = { ...createState("g"), stage: "verify" as const, iteration: 2 }
  const { action } = advanceOnIdle(s, config, "LOOP_VERIFY: FAIL")
  assert.equal(action.kind, "stop")
})

test("an unparseable verify verdict is treated as FAIL", () => {
  const s = { ...createState("g"), stage: "verify" as const, iteration: 2 }
  const { action } = advanceOnIdle(s, config, "I think it's fine?")
  assert.equal(action.kind, "stop")
})

test("composeArgs threads only the relevant prior artifacts", () => {
  const s = { ...createState("goalX"), artifacts: { explore: "E", plan: "P", build: "B" } }
  assert.match(composeArgs(s, "build"), /Approved plan:\nP/)
  assert.doesNotMatch(composeArgs(s, "build"), /Explore findings/)
  assert.match(composeArgs(s, "verify"), /Build summary:\nB/)
})

test("createState carries an optional task ref", () => {
  const task = { id: "add-foo", path: "/r/docs/tasks/approved/add-foo.md", acceptance: ["x"] }
  const s = createState("g", task)
  assert.deepEqual(s.task, task)
  assert.equal(createState("g").task, undefined)
})

test("composeArgs threads acceptance criteria into verify when a task supplies them", () => {
  const task = { id: "t", path: "/p", acceptance: ["Returns 429 over limit", "Configurable per route"] }
  const s = createState("g", task)
  const verify = composeArgs(s, "verify")
  assert.match(verify, /Acceptance criteria/)
  assert.match(verify, /- Returns 429 over limit/)
  assert.match(verify, /- Configurable per route/)
})

test("composeArgs omits the acceptance block when there is no task", () => {
  assert.doesNotMatch(composeArgs(createState("g"), "verify"), /Acceptance criteria/)
})
