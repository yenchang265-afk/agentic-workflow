import assert from "node:assert/strict"
import { test } from "node:test"
import type { Config } from "./state.ts"
import { advanceOnIdle, composeArgs, createState, resume } from "./state.ts"

const config: Config = { maxIterations: 3, gateBeforeBuild: true, gateBeforeShip: true, tasksDir: "docs/tasks" }

// --- define ---

test("createState starts the loop at define", () => {
  assert.equal(createState("add foo").stage, "define")
})

test("define auto-advances to plan", () => {
  const s = { ...createState("g"), stage: "define" as const }
  const { state, action } = advanceOnIdle(s, config, "the spec")
  assert.equal(state.stage, "plan")
  assert.equal(action.kind, "fire")
  if (action.kind === "fire") assert.equal(action.stage, "plan")
})

// --- plan → build gate ---

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

test("resume from the build gate fires build with the plan threaded", () => {
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

test("resume is a noop for a stage that never gates (e.g. build)", () => {
  const s = { ...createState("g"), stage: "build" as const, paused: true }
  assert.equal(resume(s).action.kind, "noop")
})

// --- build → verify ---

test("build auto-advances to verify", () => {
  const s = { ...createState("g"), stage: "build" as const }
  const { state, action } = advanceOnIdle(s, config, "diff summary")
  assert.equal(state.stage, "verify")
  assert.equal(action.kind, "fire")
})

// --- verify ---

test("verify PASS advances to review", () => {
  const s = { ...createState("g"), stage: "verify" as const }
  const { state, action } = advanceOnIdle(s, config, "all met\nLOOP_VERIFY: PASS")
  assert.equal(state.stage, "review")
  assert.equal(action.kind, "fire")
  if (action.kind === "fire") assert.equal(action.stage, "review")
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

// --- review → ship gate, and review FAIL loops back to build ---

test("review PASS gates before ship when gateBeforeShip is on", () => {
  const s = { ...createState("g"), stage: "review" as const }
  const { state, action } = advanceOnIdle(s, config, "five-axis review clean\nLOOP_REVIEW: PASS")
  assert.equal(action.kind, "gate")
  assert.equal(state.paused, true)
  assert.equal(state.stage, "review")
})

test("review PASS fires ship directly when gating is off", () => {
  const s = { ...createState("g"), stage: "review" as const }
  const { action } = advanceOnIdle(s, { ...config, gateBeforeShip: false }, "LOOP_REVIEW: PASS")
  assert.equal(action.kind, "fire")
  if (action.kind === "fire") assert.equal(action.stage, "ship")
})

test("resume from the ship gate fires ship with build and review threaded", () => {
  const paused = {
    ...createState("g"),
    stage: "review" as const,
    paused: true,
    artifacts: { build: "BUILD SUMMARY", review: "REVIEW REPORT" },
  }
  const { state, action } = resume(paused)
  assert.equal(state.stage, "ship")
  assert.equal(state.paused, false)
  if (action.kind === "fire") {
    assert.equal(action.stage, "ship")
    assert.match(action.arguments, /BUILD SUMMARY/)
    assert.match(action.arguments, /REVIEW REPORT/)
  }
})

test("review FAIL within budget re-builds (not re-plans) with the feedback threaded", () => {
  const s = { ...createState("g"), stage: "review" as const, iteration: 0, artifacts: { plan: "P" } }
  const { state, action } = advanceOnIdle(s, config, "gap: missing input validation\nLOOP_REVIEW: FAIL")
  assert.equal(state.stage, "build")
  assert.equal(state.iteration, 1)
  if (action.kind === "fire") {
    assert.equal(action.stage, "build")
    assert.match(action.arguments, /missing input validation/)
  }
})

test("review FAIL at the iteration cap stops", () => {
  const s = { ...createState("g"), stage: "review" as const, iteration: 2 }
  const { action } = advanceOnIdle(s, config, "LOOP_REVIEW: FAIL")
  assert.equal(action.kind, "stop")
})

test("an unparseable review verdict is treated as FAIL", () => {
  const s = { ...createState("g"), stage: "review" as const, iteration: 2 }
  const { action } = advanceOnIdle(s, config, "looks okay I guess")
  assert.equal(action.kind, "stop")
})

// --- ship ---

test("ship finishes the loop", () => {
  const s = { ...createState("g"), stage: "ship" as const }
  const { action } = advanceOnIdle(s, config, "PR description drafted")
  assert.equal(action.kind, "done")
})

// --- composeArgs ---

test("composeArgs threads only the relevant prior artifacts", () => {
  const s = { ...createState("goalX"), artifacts: { define: "SPEC", plan: "P", build: "B", review: "R" } }
  assert.match(composeArgs(s, "plan"), /Spec:\nSPEC/)
  assert.match(composeArgs(s, "build"), /Approved plan:\nP/)
  assert.match(composeArgs(s, "build"), /Review feedback to address:\nR/)
  assert.match(composeArgs(s, "verify"), /Build summary:\nB/)
  assert.match(composeArgs(s, "review"), /Approved plan:\nP/)
  assert.match(composeArgs(s, "review"), /Build summary:\nB/)
  assert.match(composeArgs(s, "ship"), /Build summary:\nB/)
  assert.match(composeArgs(s, "ship"), /Review summary:\nR/)
})

test("createState carries an optional task ref", () => {
  const task = { id: "add-foo", path: "/r/docs/tasks/in-progress/add-foo.md", acceptance: ["x"] }
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

test("composeArgs threads the linked Azure DevOps work item into every stage", () => {
  const task = {
    id: "t",
    path: "/p",
    acceptance: [],
    azureId: "1234",
    azureUrl: "https://dev.azure.com/acme/Platform/_workitems/edit/1234",
  }
  const s = createState("g", task)
  for (const stage of ["define", "plan", "build", "verify", "review", "ship"] as const) {
    const args = composeArgs(s, stage)
    assert.match(args, /Linked Azure DevOps work item: #1234 — https:\/\/dev\.azure\.com/)
  }
})

test("composeArgs omits the URL suffix when only azureId is set", () => {
  const task = { id: "t", path: "/p", acceptance: [], azureId: "1234" }
  const args = composeArgs(createState("g", task), "plan")
  assert.match(args, /Linked Azure DevOps work item: #1234$/m)
})

test("composeArgs omits the Azure line entirely when the task has no azureId", () => {
  const task = { id: "t", path: "/p", acceptance: [] }
  assert.doesNotMatch(composeArgs(createState("g", task), "plan"), /Azure DevOps/)
})
