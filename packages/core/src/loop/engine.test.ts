import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadManifest } from "../manifest/load.js"
import { advance, composePrompt, firstStep } from "./engine.js"
import type { Action, Config, LoopState, TaskRef } from "./state.js"
import { resumeAtBuild, startAtPlan } from "./state.js"
import type { Verdict } from "./verdict.js"

/**
 * Parity suite: the manifest-interpreted engine must reproduce the original
 * hardcoded engineering state machine exactly. The pre-manifest
 * `composeArgs`/`advanceOnIdle` implementations are FROZEN below as the
 * oracle — do not "fix" them; they define the golden behavior the
 * `loops/engineering/` manifest transcribes. Loads the real manifest, not a
 * fixture.
 */

const LOOPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..", "loops")
const eng = loadManifest(LOOPS_DIR, "engineering")

const config: Config = {
  maxIterations: 3,
  tasksDir: "docs/tasks",
  stageTimeoutMinutes: 60,
  reviewLenses: [],
  loops: {},
}

// --- the frozen oracle (verbatim from the pre-manifest state.ts) ---

const oracleComposeArgs = (state: LoopState, target: string): string => {
  const a = state.artifacts
  const accept = state.task?.acceptance ?? []
  const acceptBlock = (heading: string): string => `${heading}\n${accept.map((c) => `- ${c}`).join("\n")}`
  const parts: string[] = [`Goal: ${state.goal}`]
  if (target === "plan") {
    if (state.task) {
      parts.push(`Task file: ${state.task.path} — write the ## Implementation Plan onto this file in place.`)
    }
    if (a.plan) {
      parts.push(
        `Prior plan (rejected or capped out — the new plan must address why this one failed, using the task file's audit notes):\n${a.plan}`,
      )
    }
    if (accept.length) parts.push(acceptBlock("Acceptance criteria (the plan must lead to satisfying each):"))
  } else if (target === "build") {
    if (a.plan) parts.push(`Approved plan:\n${a.plan}`)
    if (a.verify) parts.push(`Verify failure to address:\n${a.verify}`)
    if (a.review) parts.push(`Review feedback to address:\n${a.review}`)
    if (accept.length) parts.push(acceptBlock("Acceptance criteria (the build must satisfy each):"))
  } else if (target === "verify") {
    if (a.plan) parts.push(`Plan & acceptance criteria:\n${a.plan}`)
    if (a.build) parts.push(`Build summary:\n${a.build}`)
    if (accept.length) parts.push(acceptBlock("Acceptance criteria (the verdict must check each):"))
  } else if (target === "review") {
    if (a.plan) parts.push(`Approved plan:\n${a.plan}`)
    if (a.build) parts.push(`Build summary:\n${a.build}`)
    if (state.git) {
      const wt = state.git.worktree
      const diffCmd = wt
        ? `git -C ${wt} diff ${state.git.base}...${state.git.branch}`
        : `git diff ${state.git.base}...${state.git.branch}`
      parts.push(
        `Diff boundary: this loop's work is the commits on branch ${state.git.branch} since ${state.git.base} — ` +
          `review exactly \`${diffCmd}\`, nothing outside it.`,
      )
    }
  }
  if (state.git?.worktree) {
    parts.push(
      `Worktree: this loop's isolated checkout is ${state.git.worktree} — every file you read, edit, or ` +
        `test lives THERE, not in the repo root. Use absolute paths under it for edit/read; prefix every ` +
        `shell command with \`cd ${state.git.worktree} && \` (or use \`git -C ${state.git.worktree} …\`). ` +
        `Never modify anything outside it.`,
    )
  }
  return parts.join("\n\n")
}

const withArtifact = (state: LoopState, stage: string, output: string): LoopState => ({
  ...state,
  artifacts: { ...state.artifacts, [stage]: output },
})

const withoutArtifact = (state: LoopState, stage: string): LoopState => {
  const { [stage]: _dropped, ...rest } = state.artifacts
  return { ...state, artifacts: rest }
}

const oracleFire = (state: LoopState, stage: string): { state: LoopState; action: Action } => ({
  state: { ...state, stage },
  action: { kind: "fire", stage, arguments: oracleComposeArgs({ ...state, stage }, stage) },
})

const oracleAdvance = (
  state: LoopState,
  cfg: Config,
  output: string,
  verdict: Verdict | null = null,
): { state: LoopState; action: Action } => {
  const s = withArtifact(state, state.stage, output)
  switch (s.stage) {
    case "plan":
      return {
        state: s,
        action: {
          kind: "park",
          message: "Plan written — parked in plan-review/ for human review. Approve with /agent-loop-task approve-plan.",
        },
      }
    case "build":
      return oracleFire(s, "verify")
    case "verify": {
      if (verdict === "PASS") return oracleFire(s, "review")
      if (verdict === "ERROR") {
        return {
          state: s,
          action: {
            kind: "stop",
            message:
              "✗ Loop stopped — verify could not run (environment/infrastructure error). Fix the environment, then /agent-loop recover the task.",
          },
        }
      }
      if (s.iteration + 1 < cfg.maxIterations) {
        const next = { ...withoutArtifact(s, "review"), iteration: s.iteration + 1 }
        return oracleFire(next, "build")
      }
      return {
        state: s,
        action: {
          kind: "stop",
          message: `✗ Loop stopped — verify failed after ${cfg.maxIterations} iterations. If the plan itself is wrong, send it back to the PLAN stage with /agent-loop-task replan <id>.`,
        },
      }
    }
    case "review": {
      if (verdict === "PASS") {
        return { state: s, action: { kind: "done", message: "✓ Loop done — review passed. Ship it yourself." } }
      }
      if (verdict === "ERROR") {
        return {
          state: s,
          action: {
            kind: "stop",
            message:
              "✗ Loop stopped — review could not run (environment/infrastructure error). Fix the environment, then /agent-loop recover the task.",
          },
        }
      }
      if (s.iteration + 1 < cfg.maxIterations) {
        const next = { ...withoutArtifact(s, "verify"), iteration: s.iteration + 1 }
        return oracleFire(next, "build")
      }
      return {
        state: s,
        action: {
          kind: "stop",
          message: `✗ Loop stopped — review failed after ${cfg.maxIterations} iterations. If the plan itself is wrong, send it back to the PLAN stage with /agent-loop-task replan <id>.`,
        },
      }
    }
    default:
      throw new Error(`oracle has no stage ${s.stage}`)
  }
}

// --- fixtures ---

const mk = (goal: string, task?: TaskRef): LoopState => ({
  goal,
  stage: "build",
  iteration: 0,
  artifacts: {},
  ...(task ? { task } : {}),
})

const task: TaskRef = { id: "add-foo", path: "/r/docs/tasks/in-progress/add-foo.md", acceptance: [] }

// --- golden parity: composePrompt ≡ oracle composeArgs, byte for byte ---

const PROMPT_STATES: Record<string, LoopState> = {
  "build entry with plan": resumeAtBuild("add foo", task, "PLAN BODY"),
  "plan entry": startAtPlan("add foo", task),
  "replan with prior plan + acceptance": startAtPlan("g", { id: "t", path: "/p", acceptance: ["Returns 429 over limit"] }, "OLD PLAN"),
  "all artifacts": { ...mk("goalX"), artifacts: { plan: "P", build: "B", review: "R" } },
  "verify feedback": { ...mk("g"), artifacts: { plan: "P", verify: "V FAIL: missing test" } },
  "acceptance criteria": mk("g", { id: "t", path: "/p", acceptance: ["Returns 429 over limit", "Configurable per route"] }),
  "git shared-tree": { ...mk("g"), git: { base: "main", branch: "loop/add-foo" } },
  "git worktree": { ...mk("g"), git: { base: "main", branch: "loop/add-foo", worktree: "/wt/add-foo" }, artifacts: { plan: "P", build: "B" } },
  "no task no git": mk("bare goal"),
}

test("composePrompt reproduces the frozen composeArgs byte-identically for every stage × state", () => {
  for (const [label, state] of Object.entries(PROMPT_STATES)) {
    for (const stage of ["plan", "build", "verify", "review"]) {
      assert.equal(composePrompt(eng, state, stage), oracleComposeArgs(state, stage), `${label} → ${stage}`)
    }
  }
})

// --- golden parity: advance ≡ the frozen advanceOnIdle across the transition table ---

const strip = <T extends object>(o: T): Record<string, unknown> => {
  const { toStatus: _dropped, ...rest } = o as Record<string, unknown>
  return rest
}

const CASES: { label: string; state: LoopState; output: string; verdict?: Verdict | null }[] = [
  { label: "plan parks", state: startAtPlan("add foo", task), output: "plan written" },
  { label: "build fires verify", state: resumeAtBuild("add foo", task, "PLAN BODY"), output: "diff summary" },
  { label: "verify PASS", state: { ...mk("g"), stage: "verify" }, output: "all criteria met", verdict: "PASS" },
  { label: "verify FAIL re-builds", state: { ...mk("g"), stage: "verify", artifacts: { plan: "P" } }, output: "gap: missing test", verdict: "FAIL" },
  { label: "verify FAIL drops stale review", state: { ...mk("g"), stage: "verify", iteration: 1, artifacts: { plan: "P", review: "OLD REVIEW" } }, output: "still failing", verdict: "FAIL" },
  { label: "verify FAIL at cap stops", state: { ...mk("g"), stage: "verify", iteration: 2 }, output: "gaps remain", verdict: "FAIL" },
  { label: "verify missing verdict = FAIL", state: { ...mk("g"), stage: "verify", iteration: 2 }, output: "I think it's fine?", verdict: null },
  { label: "verify text PASS untrusted", state: { ...mk("g"), stage: "verify" }, output: "all good\nLOOP_VERIFY: PASS", verdict: null },
  { label: "verify ERROR stops", state: { ...mk("g"), stage: "verify" }, output: "test runner missing", verdict: "ERROR" },
  { label: "review PASS done", state: { ...mk("g"), stage: "review" }, output: "five-axis review clean", verdict: "PASS" },
  { label: "review FAIL re-builds", state: { ...mk("g"), stage: "review", artifacts: { plan: "P" } }, output: "gap: missing input validation", verdict: "FAIL" },
  { label: "review FAIL drops stale verify", state: { ...mk("g"), stage: "review", artifacts: { plan: "P", verify: "OLD VERIFY PASS" } }, output: "findings", verdict: "FAIL" },
  { label: "review FAIL at cap stops", state: { ...mk("g"), stage: "review", iteration: 2 }, output: "findings remain", verdict: "FAIL" },
  { label: "review missing verdict = FAIL", state: { ...mk("g"), stage: "review", iteration: 2 }, output: "looks okay I guess", verdict: null },
  { label: "review ERROR stops", state: { ...mk("g"), stage: "review", iteration: 1 }, output: "could not read the diff", verdict: "ERROR" },
]

test("advance reproduces the frozen advanceOnIdle exactly (states and actions) across the transition table", () => {
  for (const c of CASES) {
    const legacy = oracleAdvance(c.state, config, c.output, c.verdict ?? null)
    const engine = advance(eng, c.state, config, c.output, c.verdict ?? null)
    assert.deepEqual(engine.state, legacy.state, `${c.label}: state`)
    assert.deepEqual(strip(engine.action), strip(legacy.action), `${c.label}: action`)
  }
})

// --- the manifest's additive semantics (what the legacy fn could not express) ---

test("park and done actions carry the manifest's toStatus", () => {
  const park = advance(eng, startAtPlan("g", task), config, "plan written")
  assert.equal(park.action.kind, "park")
  if (park.action.kind === "park") assert.equal(park.action.toStatus, "plan-review")

  const done = advance(eng, { ...mk("g"), stage: "review" }, config, "clean", "PASS")
  assert.equal(done.action.kind, "done")
  if (done.action.kind === "done") assert.equal(done.action.toStatus, "in-review")
})

test("firstStep fires the state's own stage with its composed prompt", () => {
  const s = resumeAtBuild("add foo", task, "PLAN BODY")
  const { action } = firstStep(eng, s)
  assert.equal(action.kind, "fire")
  if (action.kind === "fire") {
    assert.equal(action.stage, "build")
    assert.equal(action.arguments, oracleComposeArgs(s, "build"))
  }
})

test("the engineering manifest names commands, agents, and check-stage allowlists", () => {
  const plan = eng.manifest.stages.find((s) => s.name === "plan")
  assert.equal(plan?.command, "plan-task")
  assert.equal(plan?.isolation, "none")
  const verify = eng.manifest.stages.find((s) => s.name === "verify")
  assert.equal(verify?.kind, "check")
  assert.ok((verify?.bashAllowlist.length ?? 0) > 0)
})
