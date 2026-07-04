import assert from "node:assert/strict"
import { test } from "node:test"
import type { Config } from "./state.ts"
import {
  advanceOnIdle,
  clearLoop,
  composeArgs,
  createState,
  findSessionDriving,
  resume,
  resumeAtBuild,
  resumeAtPlanGate,
  setLoop,
} from "./state.ts"

const config: Config = {
  maxIterations: 3,
  gateBeforeBuild: true,
  tasksDir: "docs/tasks",
  stageTimeoutMinutes: 60,
  reviewLenses: [],
}

// --- plan → build gate ---

test("createState starts the loop at plan", () => {
  assert.equal(createState("add foo").stage, "plan")
})

test("plan gates before build when gateBeforeBuild is on", () => {
  const s = { ...createState("g"), stage: "plan" as const }
  const { state, action } = advanceOnIdle(s, config, "the plan")
  assert.equal(action.kind, "gate")
  assert.equal(state.paused, true)
})

test("the first plan gate (iteration 0) tells the human it will park, not build", () => {
  const s = { ...createState("g"), stage: "plan" as const, iteration: 0 }
  const { action } = advanceOnIdle(s, config, "the plan")
  if (action.kind === "gate") assert.match(action.message, /park/)
})

test("a re-plan gate (iteration > 0) tells the human it will build, not park", () => {
  const s = { ...createState("g"), stage: "plan" as const, iteration: 1 }
  const { action } = advanceOnIdle(s, config, "the plan")
  if (action.kind === "gate") {
    assert.match(action.message, /build/)
    assert.doesNotMatch(action.message, /park/)
  }
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

// --- resuming/claiming a task from disk (planning and execution split) ---

const task = { id: "add-foo", path: "/r/docs/tasks/in-progress/add-foo.md", acceptance: [] }

test("resumeAtPlanGate reconstructs a paused plan-gate state with the persisted plan threaded", () => {
  const s = resumeAtPlanGate("add foo", task, "PLAN BODY")
  assert.equal(s.stage, "plan")
  assert.equal(s.paused, true)
  assert.equal(s.iteration, 0)
  assert.equal(s.artifacts.plan, "PLAN BODY")
  assert.deepEqual(s.task, task)
})

test("resumeAtBuild reconstructs an unpaused build-entry state with the approved plan threaded", () => {
  const s = resumeAtBuild("add foo", task, "PLAN BODY")
  assert.equal(s.stage, "build")
  assert.equal(s.paused, false)
  assert.equal(s.iteration, 0)
  assert.equal(s.artifacts.plan, "PLAN BODY")
})

test("composeArgs threads the approved plan when entering directly at build via resumeAtBuild", () => {
  const s = resumeAtBuild("add foo", task, "PLAN BODY")
  assert.match(composeArgs(s, "build"), /Approved plan:\nPLAN BODY/)
})

test("a resumeAtBuild-shaped state still advances build → verify like a normal loop", () => {
  const s = resumeAtBuild("add foo", task, "PLAN BODY")
  const { state, action } = advanceOnIdle(s, config, "diff summary")
  assert.equal(state.stage, "verify")
  assert.equal(action.kind, "fire")
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
  const { state, action } = advanceOnIdle(s, config, "all criteria met", "PASS")
  assert.equal(state.stage, "review")
  assert.equal(action.kind, "fire")
  if (action.kind === "fire") assert.equal(action.stage, "review")
})

test("verify FAIL within budget re-plans with the failure threaded", () => {
  const s = { ...createState("g"), stage: "verify" as const, iteration: 0, artifacts: { plan: "P" } }
  const { state, action } = advanceOnIdle(s, config, "gap: missing test", "FAIL")
  assert.equal(state.stage, "plan")
  assert.equal(state.iteration, 1)
  if (action.kind === "fire") {
    assert.equal(action.stage, "plan")
    assert.match(action.arguments, /missing test/)
  }
})

test("verify FAIL at the iteration cap stops", () => {
  const s = { ...createState("g"), stage: "verify" as const, iteration: 2 }
  const { action } = advanceOnIdle(s, config, "gaps remain", "FAIL")
  assert.equal(action.kind, "stop")
})

test("a missing verify verdict is treated as FAIL", () => {
  const s = { ...createState("g"), stage: "verify" as const, iteration: 2 }
  const { action } = advanceOnIdle(s, config, "I think it's fine?", null)
  assert.equal(action.kind, "stop")
})

test("a PASS that appears only in verify's text — not via the verdict tool — is not trusted", () => {
  const s = { ...createState("g"), stage: "verify" as const, iteration: 0 }
  const { state } = advanceOnIdle(s, config, "all good\nLOOP_VERIFY: PASS", null)
  assert.equal(state.stage, "plan") // re-plans as a FAIL instead of advancing
})

test("verify ERROR stops without burning a re-plan iteration", () => {
  const s = { ...createState("g"), stage: "verify" as const, iteration: 0 }
  const { state, action } = advanceOnIdle(s, config, "test runner missing", "ERROR")
  assert.equal(action.kind, "stop")
  if (action.kind === "stop") assert.match(action.message, /environment|infrastructure/i)
  assert.equal(state.iteration, 0)
})

test("review ERROR stops without burning a re-build iteration", () => {
  const s = { ...createState("g"), stage: "review" as const, iteration: 1 }
  const { state, action } = advanceOnIdle(s, config, "could not read the diff", "ERROR")
  assert.equal(action.kind, "stop")
  assert.equal(state.iteration, 1)
})

// --- review finishes the loop, and review FAIL loops back to build ---

test("review PASS finishes the loop", () => {
  const s = { ...createState("g"), stage: "review" as const }
  const { action } = advanceOnIdle(s, config, "five-axis review clean", "PASS")
  assert.equal(action.kind, "done")
})

test("review FAIL within budget re-builds (not re-plans) with the feedback threaded", () => {
  const s = { ...createState("g"), stage: "review" as const, iteration: 0, artifacts: { plan: "P" } }
  const { state, action } = advanceOnIdle(s, config, "gap: missing input validation", "FAIL")
  assert.equal(state.stage, "build")
  assert.equal(state.iteration, 1)
  if (action.kind === "fire") {
    assert.equal(action.stage, "build")
    assert.match(action.arguments, /missing input validation/)
  }
})

test("review FAIL at the iteration cap stops", () => {
  const s = { ...createState("g"), stage: "review" as const, iteration: 2 }
  const { action } = advanceOnIdle(s, config, "findings remain", "FAIL")
  assert.equal(action.kind, "stop")
})

test("a missing review verdict is treated as FAIL", () => {
  const s = { ...createState("g"), stage: "review" as const, iteration: 2 }
  const { action } = advanceOnIdle(s, config, "looks okay I guess", null)
  assert.equal(action.kind, "stop")
})

// --- composeArgs ---

test("composeArgs threads only the relevant prior artifacts", () => {
  const s = { ...createState("goalX"), artifacts: { plan: "P", build: "B", review: "R" } }
  assert.match(composeArgs(s, "build"), /Approved plan:\nP/)
  assert.match(composeArgs(s, "build"), /Review feedback to address:\nR/)
  assert.match(composeArgs(s, "verify"), /Build summary:\nB/)
  assert.match(composeArgs(s, "review"), /Approved plan:\nP/)
  assert.match(composeArgs(s, "review"), /Build summary:\nB/)
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
  for (const stage of ["plan", "build", "verify", "review"] as const) {
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

// --- git isolation (branch-per-task) ---

test("composeArgs threads the diff boundary into review when a git ref is set", () => {
  const s = { ...createState("g"), git: { base: "main", branch: "loop/add-foo" } }
  const args = composeArgs(s, "review")
  assert.match(args, /git diff main\.\.\.loop\/add-foo/)
})

test("composeArgs omits the diff boundary when no git ref is set", () => {
  assert.doesNotMatch(composeArgs(createState("g"), "review"), /Diff boundary/)
})

test("composeArgs does not thread the diff boundary into build or verify", () => {
  const s = { ...createState("g"), git: { base: "main", branch: "loop/add-foo" } }
  assert.doesNotMatch(composeArgs(s, "build"), /Diff boundary/)
  assert.doesNotMatch(composeArgs(s, "verify"), /Diff boundary/)
})

// --- worktree isolation pinning ---

test("composeArgs threads a Worktree pinning block into build/verify/review when a worktree is set", () => {
  const s = { ...createState("g"), git: { base: "main", branch: "loop/add-foo", worktree: "/wt/add-foo" } }
  for (const stage of ["build", "verify", "review"] as const) {
    const args = composeArgs(s, stage)
    assert.match(args, /Worktree: this loop's isolated checkout is \/wt\/add-foo/)
    assert.match(args, /cd \/wt\/add-foo &&/)
  }
})

test("composeArgs never threads the Worktree block into plan", () => {
  const s = { ...createState("g"), git: { base: "main", branch: "loop/add-foo", worktree: "/wt/add-foo" } }
  assert.doesNotMatch(composeArgs(s, "plan"), /Worktree:/)
})

test("composeArgs omits the Worktree block when git isolation has no worktree (shared-tree mode)", () => {
  const s = { ...createState("g"), git: { base: "main", branch: "loop/add-foo" } }
  assert.doesNotMatch(composeArgs(s, "build"), /Worktree:/)
})

test("composeArgs review diff boundary uses git -C <worktree> in worktree mode", () => {
  const s = { ...createState("g"), git: { base: "main", branch: "loop/add-foo", worktree: "/wt/add-foo" } }
  assert.match(composeArgs(s, "review"), /git -C \/wt\/add-foo diff main\.\.\.loop\/add-foo/)
})

// --- findSessionDriving (recover's live-loop guard) ---

test("findSessionDriving locates the session whose loop drives a task id", () => {
  const task = { id: "add-foo", path: "/p", acceptance: [] }
  setLoop("ses-1", createState("g", task))
  try {
    assert.equal(findSessionDriving("add-foo"), "ses-1")
    assert.equal(findSessionDriving("other-task"), undefined)
  } finally {
    clearLoop("ses-1")
  }
})

test("findSessionDriving ignores free-text loops with no task ref", () => {
  setLoop("ses-2", createState("just a goal"))
  try {
    assert.equal(findSessionDriving("just a goal"), undefined)
  } finally {
    clearLoop("ses-2")
  }
})
