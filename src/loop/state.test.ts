import assert from "node:assert/strict"
import { test } from "node:test"
import type { Config, LoopState, TaskRef } from "./state.ts"
import {
  advanceOnIdle,
  clearLoop,
  composeArgs,
  findSessionDriving,
  resumeAtBuild,
  setLoop,
  startAtPlan,
} from "./state.ts"

const config: Config = {
  maxIterations: 3,
  tasksDir: "docs/tasks",
  stageTimeoutMinutes: 60,
  watchIntervalMinutes: 5,
  reviewLenses: [],
}

/** A minimal build-entry state for tests that don't care about the task. */
const mk = (goal: string, task?: TaskRef): LoopState => ({
  goal,
  stage: "build",
  iteration: 0,
  artifacts: {},
  ...(task ? { task } : {}),
})

// --- entering the loop at build (plan approved via /agent-loop-task approve-plan) ---

const task: TaskRef = { id: "add-foo", path: "/r/docs/tasks/in-progress/add-foo.md", acceptance: [] }

test("resumeAtBuild constructs a build-entry state with the approved plan threaded", () => {
  const s = resumeAtBuild("add foo", task, "PLAN BODY")
  assert.equal(s.stage, "build")
  assert.equal(s.iteration, 0)
  assert.equal(s.artifacts.plan, "PLAN BODY")
  assert.deepEqual(s.task, task)
})

test("composeArgs threads the approved plan when entering at build via resumeAtBuild", () => {
  const s = resumeAtBuild("add foo", task, "PLAN BODY")
  assert.match(composeArgs(s, "build"), /Approved plan:\nPLAN BODY/)
})

// --- the PLAN stage: enters at plan, terminates with a park ---

test("startAtPlan constructs a plan-entry state, threading a prior plan only on a replan", () => {
  const s = startAtPlan("add foo", task)
  assert.equal(s.stage, "plan")
  assert.equal(s.artifacts.plan, undefined)
  const r = startAtPlan("add foo", task, "OLD PLAN")
  assert.equal(r.artifacts.plan, "OLD PLAN")
})

test("composeArgs for plan threads the prior plan and acceptance criteria", () => {
  const t: TaskRef = { id: "t", path: "/p", acceptance: ["Returns 429 over limit"] }
  const args = composeArgs(startAtPlan("g", t, "OLD PLAN"), "plan")
  assert.match(args, /Prior plan/)
  assert.match(args, /OLD PLAN/)
  assert.match(args, /Acceptance criteria/)
  assert.doesNotMatch(composeArgs(startAtPlan("g", t), "plan"), /Prior plan/)
})

test("a completed PLAN stage parks — it never advances into build", () => {
  const s = startAtPlan("add foo", task)
  const { action } = advanceOnIdle(s, config, "plan written")
  assert.equal(action.kind, "park")
  if (action.kind === "park") assert.match(action.message, /plan-review/)
})

// --- build → verify ---

test("build auto-advances to verify", () => {
  const s = resumeAtBuild("add foo", task, "PLAN BODY")
  const { state, action } = advanceOnIdle(s, config, "diff summary")
  assert.equal(state.stage, "verify")
  assert.equal(action.kind, "fire")
})

// --- verify ---

test("verify PASS advances to review", () => {
  const s = { ...mk("g"), stage: "verify" as const }
  const { state, action } = advanceOnIdle(s, config, "all criteria met", "PASS")
  assert.equal(state.stage, "review")
  assert.equal(action.kind, "fire")
  if (action.kind === "fire") assert.equal(action.stage, "review")
})

test("verify FAIL within budget re-builds with the failure threaded", () => {
  const s = { ...mk("g"), stage: "verify" as const, iteration: 0, artifacts: { plan: "P" } }
  const { state, action } = advanceOnIdle(s, config, "gap: missing test", "FAIL")
  assert.equal(state.stage, "build")
  assert.equal(state.iteration, 1)
  if (action.kind === "fire") {
    assert.equal(action.stage, "build")
    assert.match(action.arguments, /Verify failure to address:/)
    assert.match(action.arguments, /missing test/)
  }
})

test("a verify-FAIL re-build drops stale review feedback from an older build", () => {
  const s = { ...mk("g"), stage: "verify" as const, iteration: 1, artifacts: { plan: "P", review: "OLD REVIEW" } }
  const { state, action } = advanceOnIdle(s, config, "still failing", "FAIL")
  assert.equal(state.stage, "build")
  assert.equal(state.artifacts.review, undefined)
  if (action.kind === "fire") assert.doesNotMatch(action.arguments, /OLD REVIEW/)
})

test("verify FAIL at the iteration cap stops and points at /agent-loop-task replan", () => {
  const s = { ...mk("g"), stage: "verify" as const, iteration: 2 }
  const { action } = advanceOnIdle(s, config, "gaps remain", "FAIL")
  assert.equal(action.kind, "stop")
  if (action.kind === "stop") assert.match(action.message, /\/agent-loop-task replan/)
})

test("a missing verify verdict is treated as FAIL", () => {
  const s = { ...mk("g"), stage: "verify" as const, iteration: 2 }
  const { action } = advanceOnIdle(s, config, "I think it's fine?", null)
  assert.equal(action.kind, "stop")
})

test("a PASS that appears only in verify's text — not via the verdict tool — is not trusted", () => {
  const s = { ...mk("g"), stage: "verify" as const, iteration: 0 }
  const { state } = advanceOnIdle(s, config, "all good\nLOOP_VERIFY: PASS", null)
  assert.equal(state.stage, "build") // re-builds as a FAIL instead of advancing
})

test("verify ERROR stops without burning a re-build iteration", () => {
  const s = { ...mk("g"), stage: "verify" as const, iteration: 0 }
  const { state, action } = advanceOnIdle(s, config, "test runner missing", "ERROR")
  assert.equal(action.kind, "stop")
  if (action.kind === "stop") assert.match(action.message, /environment|infrastructure/i)
  assert.equal(state.iteration, 0)
})

test("review ERROR stops without burning a re-build iteration", () => {
  const s = { ...mk("g"), stage: "review" as const, iteration: 1 }
  const { state, action } = advanceOnIdle(s, config, "could not read the diff", "ERROR")
  assert.equal(action.kind, "stop")
  assert.equal(state.iteration, 1)
})

// --- review finishes the loop, and review FAIL loops back to build ---

test("review PASS finishes the loop", () => {
  const s = { ...mk("g"), stage: "review" as const }
  const { action } = advanceOnIdle(s, config, "five-axis review clean", "PASS")
  assert.equal(action.kind, "done")
})

test("review FAIL within budget re-builds with the feedback threaded", () => {
  const s = { ...mk("g"), stage: "review" as const, iteration: 0, artifacts: { plan: "P" } }
  const { state, action } = advanceOnIdle(s, config, "gap: missing input validation", "FAIL")
  assert.equal(state.stage, "build")
  assert.equal(state.iteration, 1)
  if (action.kind === "fire") {
    assert.equal(action.stage, "build")
    assert.match(action.arguments, /missing input validation/)
  }
})

test("a review-FAIL re-build drops the stale verify output from the older build", () => {
  const s = { ...mk("g"), stage: "review" as const, iteration: 0, artifacts: { plan: "P", verify: "OLD VERIFY PASS" } }
  const { state, action } = advanceOnIdle(s, config, "findings", "FAIL")
  assert.equal(state.stage, "build")
  assert.equal(state.artifacts.verify, undefined)
  if (action.kind === "fire") assert.doesNotMatch(action.arguments, /OLD VERIFY PASS/)
})

test("review FAIL at the iteration cap stops", () => {
  const s = { ...mk("g"), stage: "review" as const, iteration: 2 }
  const { action } = advanceOnIdle(s, config, "findings remain", "FAIL")
  assert.equal(action.kind, "stop")
})

test("a missing review verdict is treated as FAIL", () => {
  const s = { ...mk("g"), stage: "review" as const, iteration: 2 }
  const { action } = advanceOnIdle(s, config, "looks okay I guess", null)
  assert.equal(action.kind, "stop")
})

// --- composeArgs ---

test("composeArgs threads only the relevant prior artifacts", () => {
  const s = { ...mk("goalX"), artifacts: { plan: "P", build: "B", review: "R" } }
  assert.match(composeArgs(s, "build"), /Approved plan:\nP/)
  assert.match(composeArgs(s, "build"), /Review feedback to address:\nR/)
  assert.match(composeArgs(s, "verify"), /Build summary:\nB/)
  assert.match(composeArgs(s, "review"), /Approved plan:\nP/)
  assert.match(composeArgs(s, "review"), /Build summary:\nB/)
})

test("composeArgs threads acceptance criteria into build and verify when a task supplies them", () => {
  const t: TaskRef = { id: "t", path: "/p", acceptance: ["Returns 429 over limit", "Configurable per route"] }
  const s = mk("g", t)
  for (const stage of ["build", "verify"] as const) {
    const args = composeArgs(s, stage)
    assert.match(args, /Acceptance criteria/)
    assert.match(args, /- Returns 429 over limit/)
    assert.match(args, /- Configurable per route/)
  }
})

test("composeArgs omits the acceptance block when there is no task", () => {
  assert.doesNotMatch(composeArgs(mk("g"), "verify"), /Acceptance criteria/)
})

// --- git isolation (branch-per-task) ---

test("composeArgs threads the diff boundary into review when a git ref is set", () => {
  const s = { ...mk("g"), git: { base: "main", branch: "loop/add-foo" } }
  const args = composeArgs(s, "review")
  assert.match(args, /git diff main\.\.\.loop\/add-foo/)
})

test("composeArgs omits the diff boundary when no git ref is set", () => {
  assert.doesNotMatch(composeArgs(mk("g"), "review"), /Diff boundary/)
})

test("composeArgs does not thread the diff boundary into build or verify", () => {
  const s = { ...mk("g"), git: { base: "main", branch: "loop/add-foo" } }
  assert.doesNotMatch(composeArgs(s, "build"), /Diff boundary/)
  assert.doesNotMatch(composeArgs(s, "verify"), /Diff boundary/)
})

// --- worktree isolation pinning ---

test("composeArgs threads a Worktree pinning block into build/verify/review when a worktree is set", () => {
  const s = { ...mk("g"), git: { base: "main", branch: "loop/add-foo", worktree: "/wt/add-foo" } }
  for (const stage of ["build", "verify", "review"] as const) {
    const args = composeArgs(s, stage)
    assert.match(args, /Worktree: this loop's isolated checkout is \/wt\/add-foo/)
    assert.match(args, /cd \/wt\/add-foo &&/)
  }
})

test("composeArgs omits the Worktree block when git isolation has no worktree (shared-tree mode)", () => {
  const s = { ...mk("g"), git: { base: "main", branch: "loop/add-foo" } }
  assert.doesNotMatch(composeArgs(s, "build"), /Worktree:/)
})

test("composeArgs review diff boundary uses git -C <worktree> in worktree mode", () => {
  const s = { ...mk("g"), git: { base: "main", branch: "loop/add-foo", worktree: "/wt/add-foo" } }
  assert.match(composeArgs(s, "review"), /git -C \/wt\/add-foo diff main\.\.\.loop\/add-foo/)
})

// --- findSessionDriving (recover's live-loop guard) ---

test("findSessionDriving locates the session whose loop drives a task id", () => {
  const t: TaskRef = { id: "add-foo", path: "/p", acceptance: [] }
  setLoop("ses-1", mk("g", t))
  try {
    assert.equal(findSessionDriving("add-foo"), "ses-1")
    assert.equal(findSessionDriving("other-task"), undefined)
  } finally {
    clearLoop("ses-1")
  }
})

test("findSessionDriving ignores loops with no task ref", () => {
  setLoop("ses-2", mk("just a goal"))
  try {
    assert.equal(findSessionDriving("just a goal"), undefined)
  } finally {
    clearLoop("ses-2")
  }
})
