import { defaultWorkflowsDir } from "../manifest/dir.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import { loadManifest } from "../manifest/load.js"
import { effectiveAllowlist, stageDef } from "../manifest/schema.js"
import { advance, composePrompt, firstStep } from "./engine.js"
import type { Action, Config, LoopState, TaskRef } from "./state.js"
import { resumeAtBuild, startAtPlan } from "./state.js"
import { verdictContractBlock, workScopeBlock, type Verdict } from "./verdict.js"

/**
 * Parity suite: the manifest-interpreted engine must reproduce the original
 * hardcoded engineering state machine exactly. The pre-manifest
 * `composeArgs`/`advanceOnIdle` implementations are FROZEN below as the
 * oracle — do not "fix" them; they define the golden behavior the
 * `workflows/engineering/` manifest transcribes. Loads the real manifest, not a
 * fixture.
 */

const WORKFLOWS_DIR = defaultWorkflowsDir()
const eng = loadManifest(WORKFLOWS_DIR, "engineering")

const config: Config = {
  maxIterations: 3,
  tasksDir: "docs/tasks",
  stageTimeoutMinutes: 60,
  reviewLenses: [],
  workflows: {},
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

// Additive semantics on top of the frozen oracle: every stage now carries a
// prompt-level contract paragraph (see verdict.ts) — check stages the mandatory
// verdict contract, work stages the scope fence. Appended here rather than
// "fixed" inside the frozen composeArgs.
const oracleCompose = (state: LoopState, stage: string): string => {
  const base = oracleComposeArgs(state, stage)
  const def = stageDef(eng.manifest, stage)
  return def.kind === "check"
    ? `${base}\n\n${verdictContractBlock(stage, def.requiredAxes)}`
    : `${base}\n\n${workScopeBlock(stage)}`
}

const oracleFire = (state: LoopState, stage: string): { state: LoopState; action: Action } => ({
  state: { ...state, stage },
  action: { kind: "fire", stage, arguments: oracleCompose({ ...state, stage }, stage) },
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
          message: "Plan written — parked in plan-review/ for human review. Approve with /agentic-workflow:engineering approve.",
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
              "✗ Workflow stopped — verify could not run (environment/infrastructure error). Fix the environment, then /agentic-workflow:engineering recover the task.",
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
          message: `✗ Workflow stopped — verify failed after ${cfg.maxIterations} iterations. If the plan itself is wrong, send it back to the PLAN stage with /agentic-workflow:engineering replan <id>.`,
        },
      }
    }
    case "review": {
      if (verdict === "PASS") {
        return { state: s, action: { kind: "done", message: "✓ Workflow done — review passed. Ship it yourself." } }
      }
      if (verdict === "ERROR") {
        return {
          state: s,
          action: {
            kind: "stop",
            message:
              "✗ Workflow stopped — review could not run (environment/infrastructure error). Fix the environment, then /agentic-workflow:engineering recover the task.",
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
          message: `✗ Workflow stopped — review failed after ${cfg.maxIterations} iterations. If the plan itself is wrong, send it back to the PLAN stage with /agentic-workflow:engineering replan <id>.`,
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
  "git shared-tree": { ...mk("g"), git: { base: "main", branch: "feature/add-foo" } },
  "git worktree": { ...mk("g"), git: { base: "main", branch: "feature/add-foo", worktree: "/wt/add-foo" }, artifacts: { plan: "P", build: "B" } },
  "no task no git": mk("bare goal"),
}

test("composePrompt reproduces the frozen composeArgs byte-identically for every stage × state", () => {
  for (const [label, state] of Object.entries(PROMPT_STATES)) {
    for (const stage of ["plan", "build", "verify", "review"]) {
      assert.equal(composePrompt(eng, state, stage), oracleCompose(state, stage), `${label} → ${stage}`)
    }
  }
})

test("composePrompt appends the verdict contract to check stages only", () => {
  const state = resumeAtBuild("add foo", task, "PLAN BODY")
  for (const stage of ["verify", "review"]) {
    const prompt = composePrompt(eng, { ...state, stage }, stage)
    assert.ok(prompt.endsWith(verdictContractBlock(stage, stageDef(eng.manifest, stage).requiredAxes)), `${stage} carries the contract`)
    assert.match(prompt, /loop_verdict/)
  }
  for (const stage of ["plan", "build"]) {
    assert.doesNotMatch(composePrompt(eng, { ...state, stage }, stage), /MANDATORY VERDICT/, `${stage} has no contract`)
  }
})

test("composePrompt carries the five-axis payload contract on review, and none on verify", () => {
  const state = resumeAtBuild("add foo", task, "PLAN BODY")
  const review = composePrompt(eng, { ...state, stage: "review" }, "review")
  for (const axis of ["correctness", "readability", "architecture", "security", "performance"]) {
    assert.match(review, new RegExp(axis), `review names the ${axis} axis`)
  }
  assert.match(review, /REJECTED/)
  // VERIFY declares no requiredAxes — its contract must stay exactly as it was.
  assert.doesNotMatch(composePrompt(eng, { ...state, stage: "verify" }, "verify"), /axes/)
})

test("composePrompt fences work stages to their own stage", () => {
  const state = resumeAtBuild("add foo", task, "PLAN BODY")
  for (const stage of ["plan", "build"]) {
    const prompt = composePrompt(eng, { ...state, stage }, stage)
    assert.ok(prompt.endsWith(workScopeBlock(stage)), `${stage} carries the scope fence`)
  }
  // A check stage's own contract is the verdict one — never both.
  for (const stage of ["verify", "review"]) {
    assert.doesNotMatch(composePrompt(eng, { ...state, stage }, stage), /STAGE SCOPE/, `${stage} has no scope fence`)
  }
})

test("the scope fence reaches every kind's work stages, not just engineering", () => {
  const prompt = composePrompt(sitter, prState("fix"), "fix")
  assert.ok(prompt.endsWith(workScopeBlock("fix")), "pr-sitter fix carries the scope fence")
})

// --- golden parity: advance ≡ the frozen advanceOnIdle across the transition table ---

const strip = <T extends object>(o: T): Record<string, unknown> => {
  // Drop the fields the frozen legacy oracle could not express (additive manifest
  // semantics): `toStatus` and the `retryable` stop flag (asserted separately below).
  const { toStatus: _dropped, retryable: _retryable, ...rest } = o as Record<string, unknown>
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
  { label: "verify text PASS untrusted", state: { ...mk("g"), stage: "verify" }, output: "all good\nWORKFLOW_VERIFY: PASS", verdict: null },
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

test("an onError (ERROR verdict) stop is marked retryable; a cap stop is not (C2)", () => {
  // A transient environment/tooling error the manifest asks to retry next poll — the
  // work source must NOT record it as a failed attempt, so it stays claimable.
  const onError = advance(eng, { ...mk("g"), stage: "verify" }, config, "test runner missing", "ERROR")
  assert.equal(onError.action.kind, "stop")
  if (onError.action.kind === "stop") assert.equal(onError.action.retryable, true)

  // A genuine iteration-cap exhaustion stays unmarked ⇒ recorded as a failed attempt.
  const cap = advance(eng, { ...mk("g"), stage: "verify", iteration: 2 }, config, "gaps remain", "FAIL")
  assert.equal(cap.action.kind, "stop")
  if (cap.action.kind === "stop") assert.equal(cap.action.retryable, undefined)
})

test("firstStep fires the state's own stage with its composed prompt", () => {
  const s = resumeAtBuild("add foo", task, "PLAN BODY")
  const { action } = firstStep(eng, s)
  assert.equal(action.kind, "fire")
  if (action.kind === "fire") {
    assert.equal(action.stage, "build")
    assert.equal(action.arguments, oracleCompose(s, "build"))
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

// --- the pr-sitter manifest walks end-to-end through the same engine ---

const sitter = loadManifest(WORKFLOWS_DIR, "pr-sitter")
const prState = (stage: string, artifacts: Record<string, string> = {}, iteration = 0): LoopState => ({
  kind: "pr-sitter",
  goal: 'PR #7 "Add rate limiting" — failing checks: ci/test',
  stage,
  iteration,
  artifacts,
  git: { base: "main", branch: "feat/rate-limit" },
})

test("pr-sitter: triage PASS fires fix with the findings threaded; FAIL is done without pushing", () => {
  const pass = advance(sitter, prState("triage"), config, "1. ci/test fails: assertion X", "PASS")
  assert.equal(pass.action.kind, "fire")
  if (pass.action.kind === "fire") {
    assert.equal(pass.action.stage, "fix")
    assert.match(pass.action.arguments, /Triage findings to address/)
    assert.match(pass.action.arguments, /assertion X/)
    assert.match(pass.action.arguments, /do NOT push/)
  }
  const idle = advance(sitter, prState("triage"), config, "all green, nothing to do", "FAIL")
  assert.equal(idle.action.kind, "done")
  if (idle.action.kind === "done") {
    assert.match(idle.action.message, /nothing actionable/)
    assert.equal(idle.action.toStatus, undefined)
  }
})

test("pr-sitter: fix → verify → publish → done; verify FAIL re-fires fix until the cap", () => {
  const afterFix = advance(sitter, prState("fix", { triage: "F1" }), config, "fixed the assertion")
  assert.equal(afterFix.action.kind, "fire")
  if (afterFix.action.kind === "fire") assert.equal(afterFix.action.stage, "verify")

  const pass = advance(sitter, prState("verify", { triage: "F1", fix: "S" }), config, "all findings addressed", "PASS")
  assert.equal(pass.action.kind, "fire")
  if (pass.action.kind === "fire") {
    assert.equal(pass.action.stage, "publish")
    assert.match(pass.action.arguments, /git push origin feat\/rate-limit/)
    assert.match(pass.action.arguments, /NEVER merge/)
  }

  const refix = advance(sitter, prState("verify", { triage: "F1" }), config, "test still red", "FAIL")
  assert.equal(refix.action.kind, "fire")
  if (refix.action.kind === "fire") assert.equal(refix.action.stage, "fix")
  assert.equal(refix.state.iteration, 1)

  const capped = advance(sitter, prState("verify", { triage: "F1" }, 2), config, "still red", "FAIL")
  assert.equal(capped.action.kind, "stop")
  if (capped.action.kind === "stop") assert.match(capped.action.message, /after 3 iterations.*parks until a human/s)

  const published = advance(sitter, prState("publish", { triage: "F1", fix: "S", verify: "OK" }), config, "pushed + replied")
  assert.equal(published.action.kind, "done")
})

test("pr-sitter: a missing triage verdict reads as FAIL (nothing to do), never as PASS", () => {
  const { action } = advance(sitter, prState("triage"), config, "WORKFLOW_TRIAGE: PASS in prose only", null)
  assert.equal(action.kind, "done")
})

// --- code-platform prompt switching (additive; the oracle above is untouched) ---

test("pr-sitter prompts render gh guidance by default and ADO REST guidance when the state is stamped ado", () => {
  const sitter = loadManifest(WORKFLOWS_DIR, "pr-sitter")
  const state: LoopState = {
    kind: "pr-sitter",
    goal: "PR #7",
    stage: "triage",
    iteration: 0,
    artifacts: {},
    git: { base: "main", branch: "feat/x" },
  }
  const gh = composePrompt(sitter, state, "triage")
  assert.match(gh, /gh pr view/)
  assert.doesNotMatch(gh, /AZURE_DEVOPS_EXT_PAT/)
  // An ado state WITHOUT a platformAccess stamp is a curl-era claim: it must
  // keep rendering the REST branch (stage markers froze a curl allowlist).
  const ado = composePrompt(sitter, { ...state, platform: "ado" }, "triage")
  assert.match(ado, /_apis\/git\/pullrequests/)
  assert.match(ado, /curl -sS -u :"\$AZURE_DEVOPS_EXT_PAT"/)
  assert.doesNotMatch(ado, /gh pr view/)
  assert.doesNotMatch(ado, /az repos/) // exactly one access branch renders
  const publish = composePrompt(sitter, { ...state, platform: "ado", stage: "publish" }, "publish")
  assert.match(publish, /threads\/<threadId>\/comments/)
  assert.match(publish, /NEVER complete, abandon, or approve/)
  assert.doesNotMatch(publish, /gh pr comment/)
  assert.doesNotMatch(publish, /az devops invoke/)
})

test("pr-sitter ado prompts branch on the platformAccess stamp: az CLI, explicit rest, and mcp", () => {
  const sitter = loadManifest(WORKFLOWS_DIR, "pr-sitter")
  const state: LoopState = {
    kind: "pr-sitter",
    goal: "PR #7",
    stage: "triage",
    iteration: 0,
    artifacts: {},
    git: { base: "main", branch: "feat/x" },
    platform: "ado",
  }
  const az = composePrompt(sitter, { ...state, platformAccess: "az" }, "triage")
  assert.match(az, /az repos pr show --id <n>/)
  assert.match(az, /az repos pr policy list/)
  assert.doesNotMatch(az, /AZURE_DEVOPS_EXT_PAT/)
  assert.doesNotMatch(az, /gh pr view/)
  const azPublish = composePrompt(sitter, { ...state, platformAccess: "az", stage: "publish" }, "publish")
  assert.match(azPublish, /az devops invoke --area git --resource pullRequestThreadComments/)
  assert.match(azPublish, /NEVER complete, abandon, or approve/)
  assert.doesNotMatch(azPublish, /curl/)
  const rest = composePrompt(sitter, { ...state, platformAccess: "rest" }, "triage")
  assert.match(rest, /curl -sS -u :"\$AZURE_DEVOPS_EXT_PAT"/)
  assert.doesNotMatch(rest, /az repos/)
  const mcp = composePrompt(sitter, { ...state, platformAccess: "mcp" }, "triage")
  assert.match(mcp, /Azure DevOps MCP server/)
  assert.match(mcp, /ERROR verdict naming the missing capability/)
  assert.doesNotMatch(mcp, /curl/)
  assert.doesNotMatch(mcp, /az repos/)
  const mcpPublish = composePrompt(sitter, { ...state, platformAccess: "mcp", stage: "publish" }, "publish")
  assert.match(mcpPublish, /NEVER complete, abandon, or approve/)
})

// --- the review-sitter manifest walks end-to-end through the same engine ---

const reviewer = loadManifest(WORKFLOWS_DIR, "review-sitter")
const reviewState = (stage: string, artifacts: Record<string, string> = {}): LoopState => ({
  kind: "review-sitter",
  goal: 'PR #9 "Add rate limiting" — review the changes and post one structured review comment',
  stage,
  iteration: 0,
  artifacts,
  git: { base: "main", branch: "feat/rate-limit" },
})

test("review-sitter: fetch PASS fires assess with the work order threaded; FAIL is done; ERROR stops", () => {
  const pass = advance(reviewer, reviewState("fetch"), config, "risk concentrates in limiter.ts", "PASS")
  assert.equal(pass.action.kind, "fire")
  if (pass.action.kind === "fire") {
    assert.equal(pass.action.stage, "assess")
    assert.match(pass.action.arguments, /Review work order/)
    assert.match(pass.action.arguments, /limiter\.ts/)
    assert.match(pass.action.arguments, /Make NO edits and push nothing/)
  }
  const idle = advance(reviewer, reviewState("fetch"), config, "review request withdrawn", "FAIL")
  assert.equal(idle.action.kind, "done")
  if (idle.action.kind === "done") {
    assert.match(idle.action.message, /nothing to review/)
    assert.equal(idle.action.toStatus, undefined)
  }
  const broken = advance(reviewer, reviewState("fetch"), config, "gh exploded", "ERROR")
  assert.equal(broken.action.kind, "stop")
})

test("review-sitter: assess → publish → done; the publish prompt is comment-only", () => {
  const afterAssess = advance(reviewer, reviewState("assess", { fetch: "W1" }), config, "the draft review")
  assert.equal(afterAssess.action.kind, "fire")
  if (afterAssess.action.kind === "fire") {
    assert.equal(afterAssess.action.stage, "publish")
    assert.match(afterAssess.action.arguments, /exactly ONE comment/)
    assert.match(afterAssess.action.arguments, /NEVER approve, request changes, merge, close, or push/)
    assert.match(afterAssess.action.arguments, /the draft review/)
    assert.doesNotMatch(afterAssess.action.arguments, /git push/)
  }
  const published = advance(reviewer, reviewState("publish", { fetch: "W1", assess: "R" }), config, "posted")
  assert.equal(published.action.kind, "done")
  if (published.action.kind === "done") assert.match(published.action.message, /human call/)
})

test("review-sitter: a missing fetch verdict reads as FAIL (done), never as PASS", () => {
  const { action } = advance(reviewer, reviewState("fetch"), config, "PASS in prose only", null)
  assert.equal(action.kind, "done")
})

test("review-sitter prompts render gh guidance by default and ADO REST guidance when stamped ado", () => {
  const state = reviewState("fetch")
  const gh = composePrompt(reviewer, state, "fetch")
  assert.match(gh, /gh pr view/)
  assert.doesNotMatch(gh, /AZURE_DEVOPS_EXT_PAT/)
  const ado = composePrompt(reviewer, { ...state, platform: "ado" }, "fetch")
  assert.match(ado, /_apis\/git\/pullrequests/)
  assert.doesNotMatch(ado, /gh pr view/)
  const publish = composePrompt(reviewer, { ...state, platform: "ado", stage: "publish" }, "publish")
  assert.match(publish, /pullRequests\/<n>\/threads/)
  assert.match(publish, /NEVER vote, approve, complete, abandon, or push/)
  assert.doesNotMatch(publish, /gh pr comment/)
})

test("review-sitter holds strictly less authority than pr-sitter: comment-only publish, no push, no api, no budget", () => {
  const publish = reviewer.manifest.stages.find((s) => s.name === "publish")
  assert.ok(publish)
  const allow = effectiveAllowlist(publish, "github")
  assert.ok(allow.includes("gh pr comment *"))
  // No glob grants pushing, merging, approving, or the raw API (which could
  // approve/merge): the allowlist IS the "never approve" guarantee.
  assert.ok(allow.every((g) => !/push|merge|gh pr review|gh api/.test(g)))
  const assess = reviewer.manifest.stages.find((s) => s.name === "assess")
  assert.equal(assess?.kind, "work")
  assert.equal(assess?.isolation, "worktree")
  assert.ok((assess?.bashAllowlist.length ?? 0) > 0)
  const fetch = reviewer.manifest.stages.find((s) => s.name === "fetch")
  assert.equal(fetch?.kind, "check")
  assert.equal(fetch?.isolation, "none")
  // One pass per requested head: no retry budget anywhere in the kind.
  assert.equal(reviewer.manifest.maxIterations, undefined)
  for (const t of Object.values(reviewer.manifest.transitions)) {
    for (const e of [t.onDone, t.onPass, t.onFail, t.onError]) {
      assert.ok(!(e?.kind === "fire" && e.countIteration))
    }
  }
})

test("pr-sitter and review-sitter allowlists carry no open gh api glob — comments endpoint only", () => {
  // "gh api *" permits arbitrary authenticated GitHub mutations (merge, approve,
  // ref deletion) from stages whose input is untrusted third-party PR text. The
  // only gh api need is review-thread comments (read + per-thread replies), so
  // only that endpoint's glob may appear.
  const prSitter = loadManifest(WORKFLOWS_DIR, "pr-sitter")
  for (const manifest of [prSitter, reviewer]) {
    for (const stage of manifest.manifest.stages) {
      const allow = effectiveAllowlist(stage, "github")
      assert.ok(!allow.includes("gh api *"), `${manifest.manifest.kind}/${stage.name} must not allowlist "gh api *"`)
      for (const g of allow) {
        if (g.startsWith("gh api")) {
          assert.equal(g, "gh api repos/*/pulls/*/comments*", `${manifest.manifest.kind}/${stage.name}: unexpected gh api glob "${g}"`)
        }
      }
    }
  }
  // The pr-sitter publish ADO globs are thread-scoped, mirroring the agent
  // frontmatter's long-standing promise (comment replies only).
  const publish = prSitter.manifest.stages.find((s) => s.name === "publish")
  assert.ok(publish)
  const adoAllow = effectiveAllowlist(publish, "ado")
  assert.ok(adoAllow.every((g) => !g.startsWith("curl") || g.includes("/threads")), `publish ADO curl must be /threads-scoped: ${adoAllow.join(", ")}`)
})

// --- the dep-sitter manifest walks end-to-end through the same engine ---

const depSitter = loadManifest(WORKFLOWS_DIR, "dep-sitter")
const depState = (stage: string, artifacts: Record<string, string> = {}, iteration = 0): LoopState => ({
  kind: "dep-sitter",
  goal: "Upgrade lodash to 4.17.21\n\nCurrently on 4.17.20 — a patch bump closing a high-severity advisory.",
  stage,
  iteration,
  artifacts,
  git: { base: "main", branch: "feature/upgrade-lodash-to-4-17-21" },
})

test("dep-sitter: scan PASS fires upgrade; FAIL is done; verify caps at 2 iterations recommending the park", () => {
  const pass = advance(depSitter, depState("scan"), config, "lodash 4.17.20 → 4.17.21, CVE-2026-1", "PASS")
  assert.equal(pass.action.kind, "fire")
  if (pass.action.kind === "fire") {
    assert.equal(pass.action.stage, "upgrade")
    assert.match(pass.action.arguments, /Upgrade work order/)
    assert.match(pass.action.arguments, /do NOT push/)
  }
  const resolved = advance(depSitter, depState("scan"), config, "already fixed", "FAIL")
  assert.equal(resolved.action.kind, "done")
  if (resolved.action.kind === "done") assert.match(resolved.action.message, /already resolved/)

  const afterUpgrade = advance(depSitter, depState("upgrade", { scan: "W" }), config, "bumped + lockfile")
  assert.equal(afterUpgrade.action.kind, "fire")
  if (afterUpgrade.action.kind === "fire") assert.equal(afterUpgrade.action.stage, "verify")

  // maxIterations: 2 — the second verify FAIL stops the loop.
  const refix = advance(depSitter, depState("verify", { scan: "W", upgrade: "S" }), config, "audit still red", "FAIL")
  assert.equal(refix.action.kind, "fire")
  const capped = advance(depSitter, depState("verify", { scan: "W" }, 1), config, "still red", "FAIL")
  assert.equal(capped.action.kind, "stop")
  if (capped.action.kind === "stop") assert.match(capped.action.message, /after 2 iterations.*parks until its target version moves/s)

  const published = advance(depSitter, depState("publish", { scan: "W", verify: "OK" }), config, "draft PR opened")
  assert.equal(published.action.kind, "done")
  if (published.action.kind === "done") assert.match(published.action.message, /Merging stays a human call/)
})

test("dep-sitter publish pushes only feature/ branches and opens draft PRs — no merge, no api, no bare push", () => {
  const publish = depSitter.manifest.stages.find((s) => s.name === "publish")
  assert.ok(publish)
  const allow = effectiveAllowlist(publish, "github")
  assert.ok(allow.includes("git push origin feature/*"))
  assert.ok(allow.includes("gh pr create *"))
  assert.ok(allow.every((g) => !/gh pr merge|gh api|gh pr review/.test(g)))
  // The push glob is branch-scoped: a bare "git push origin *" must not exist.
  assert.ok(!allow.includes("git push origin *"))
  const prompt = composePrompt(depSitter, depState("publish", { scan: "W", verify: "OK" }), "publish")
  assert.match(prompt, /gh pr create --draft/)
  assert.match(prompt, /NEVER merge or close/)
  const adoAllow = effectiveAllowlist(publish, "ado")
  assert.ok(adoAllow.some((g) => g.includes("dev.azure.com")))
  assert.ok(adoAllow.every((g) => !/gh /.test(g)))
  // az access swaps the curl globs for az ones (the guard's az backstop pins
  // create to --draft); mcp grants no extra bash — fail-closed to the base list.
  const azAllow = effectiveAllowlist(publish, "ado", "az")
  assert.ok(azAllow.includes("az repos pr create*"))
  assert.ok(azAllow.every((g) => !/curl|gh /.test(g)))
  assert.deepEqual(effectiveAllowlist(publish, "ado", "mcp"), publish.bashAllowlist)
})

test("dep-sitter allowlists cover all three ecosystems' read/test verbs; publish stays unchanged", () => {
  const scan = depSitter.manifest.stages.find((s) => s.name === "scan")
  assert.ok(scan?.bashAllowlist.includes("osv-scanner *"))
  assert.ok(scan?.bashAllowlist.some((g) => g.startsWith("mvn dependency:tree")))
  assert.ok(scan?.bashAllowlist.some((g) => g.startsWith("./gradlew depend")))
  // Scan stays read-only: no install/test verbs.
  assert.ok(scan?.bashAllowlist.every((g) => !/npm install|mvn test|gradle test/.test(g)))
  const verify = depSitter.manifest.stages.find((s) => s.name === "verify")
  assert.ok(verify?.bashAllowlist.includes("osv-scanner *"))
  assert.ok(verify?.bashAllowlist.includes("./gradlew test*"))
  assert.ok(verify?.bashAllowlist.includes("cd * && ./mvnw verify*"))
  // Publish gains nothing: still push-to-feature/* + platform PR verbs only.
  const publish = depSitter.manifest.stages.find((s) => s.name === "publish")
  assert.ok(publish?.bashAllowlist.every((g) => !/osv-scanner|mvn |gradle/.test(g)))
})

test("dep-sitter publish renders gh guidance by default and ADO PR-creation guidance when stamped ado", () => {
  const state = depState("publish", { scan: "W", verify: "OK" })
  const gh = composePrompt(depSitter, state, "publish")
  assert.match(gh, /gh pr create --draft/)
  assert.doesNotMatch(gh, /AZURE_DEVOPS_EXT_PAT/)
  const ado = composePrompt(depSitter, { ...state, platform: "ado" }, "publish")
  assert.match(ado, /_apis\/git\/repositories\/<repo>\/pullrequests\?api-version=7\.1/)
  assert.match(ado, /"isDraft":true/)
  assert.match(ado, /curl -sS -u :"\$AZURE_DEVOPS_EXT_PAT"/)
  assert.doesNotMatch(ado, /gh pr create/)
})

// --- the main-sitter manifest walks end-to-end through the same engine ---

const mainSitter = loadManifest(WORKFLOWS_DIR, "main-sitter")
const mainState = (stage: string, artifacts: Record<string, string> = {}, iteration = 0): LoopState => ({
  kind: "main-sitter",
  goal: "Red CI on main at abcdef123456\n\nFailing workflow(s): CI.",
  stage,
  iteration,
  artifacts,
  git: { base: "main", branch: "main-sitter/abcdef123456" },
})

test("main-sitter: diagnose PASS fires remedy; FAIL (flake) is done; verify caps at 2 recommending the revert", () => {
  const pass = advance(mainSitter, mainState("diagnose"), config, "culprit: sha-bad from PR #12", "PASS")
  assert.equal(pass.action.kind, "fire")
  if (pass.action.kind === "fire") {
    assert.equal(pass.action.stage, "remedy")
    assert.match(pass.action.arguments, /Remedy work order/)
    assert.match(pass.action.arguments, /NEVER touch main itself/)
  }
  const flake = advance(mainSitter, mainState("diagnose"), config, "passes locally, flaky infra", "FAIL")
  assert.equal(flake.action.kind, "done")
  if (flake.action.kind === "done") assert.match(flake.action.message, /flake or the branch already recovered/)

  const capped = advance(mainSitter, mainState("verify", { diagnose: "W" }, 1), config, "still red", "FAIL")
  assert.equal(capped.action.kind, "stop")
  if (capped.action.kind === "stop") assert.match(capped.action.message, /prefer the revert path/)

  const published = advance(mainSitter, mainState("publish", { diagnose: "W", verify: "OK" }), config, "remedy PR opened")
  assert.equal(published.action.kind, "done")
  if (published.action.kind === "done") assert.match(published.action.message, /watched branch was never touched/)
})

test("main-sitter can never push the watched branch: the push glob is scoped to main-sitter/ remedy branches", () => {
  const publish = mainSitter.manifest.stages.find((s) => s.name === "publish")
  assert.ok(publish)
  const allow = effectiveAllowlist(publish, "github")
  assert.ok(allow.includes("git push origin main-sitter/*"))
  assert.ok(!allow.includes("git push origin *"))
  assert.ok(allow.every((g) => !/gh pr merge|gh api|gh pr review/.test(g)))
  const diagnose = mainSitter.manifest.stages.find((s) => s.name === "diagnose")
  assert.equal(diagnose?.kind, "check")
  assert.ok(diagnose?.bashAllowlist.some((g) => g.startsWith("git bisect")))
  const prompt = composePrompt(mainSitter, mainState("publish", { diagnose: "D", verify: "OK" }), "publish")
  assert.match(prompt, /gh pr create --draft --base main/)
  assert.match(prompt, /NEVER push main/)
  const adoAllow = effectiveAllowlist(publish, "ado")
  assert.ok(adoAllow.some((g) => g.includes("dev.azure.com")))
  assert.ok(adoAllow.every((g) => !/gh /.test(g)))
  const azAllow = effectiveAllowlist(publish, "ado", "az")
  assert.ok(azAllow.includes("az repos pr create*"))
  assert.ok(azAllow.every((g) => !/curl|gh /.test(g)))
})

test("main-sitter renders gh guidance by default and ADO REST guidance when stamped ado", () => {
  const diagState = mainState("diagnose")
  const gh = composePrompt(mainSitter, diagState, "diagnose")
  assert.match(gh, /gh run view --log/)
  assert.doesNotMatch(gh, /AZURE_DEVOPS_EXT_PAT/)
  const ado = composePrompt(mainSitter, { ...diagState, platform: "ado" }, "diagnose")
  assert.match(ado, /_apis\/build\/builds\/<buildId>\/logs/)
  assert.match(ado, /_apis\/git\/repositories\/<repo>\/commits\/<sha>\/pullrequests/)
  assert.match(ado, /curl -sS -u :"\$AZURE_DEVOPS_EXT_PAT"/)
  assert.doesNotMatch(ado, /gh run view/)

  const pubState = mainState("publish", { diagnose: "D", verify: "OK" })
  const ghPublish = composePrompt(mainSitter, pubState, "publish")
  assert.match(ghPublish, /gh pr create --draft --base main/)
  const adoPublish = composePrompt(mainSitter, { ...pubState, platform: "ado" }, "publish")
  assert.match(adoPublish, /_apis\/git\/repositories\/<repo>\/pullrequests\?api-version=7\.1/)
  assert.match(adoPublish, /"isDraft":true/)
  assert.match(adoPublish, /NEVER push main/)
  assert.doesNotMatch(adoPublish, /gh pr create/)
})

test("main-sitter and dep-sitter render az CLI guidance when the state is stamped access az", () => {
  const azDiag = composePrompt(mainSitter, { ...mainState("diagnose"), platform: "ado", platformAccess: "az" }, "diagnose")
  assert.match(azDiag, /az pipelines runs list --branch main/)
  assert.match(azDiag, /az devops invoke --area build --resource logs/)
  assert.doesNotMatch(azDiag, /curl/)
  const azPub = composePrompt(
    mainSitter,
    { ...mainState("publish", { diagnose: "D", verify: "OK" }), platform: "ado", platformAccess: "az" },
    "publish",
  )
  assert.match(azPub, /az repos pr create --draft --source-branch main-sitter\/abcdef123456 --target-branch main/)
  assert.match(azPub, /NEVER push main/)
  assert.doesNotMatch(azPub, /curl/)
  const azDep = composePrompt(
    depSitter,
    { ...depState("publish", { scan: "W", verify: "OK" }), platform: "ado", platformAccess: "az" },
    "publish",
  )
  assert.match(azDep, /az repos pr create --draft/)
  assert.doesNotMatch(azDep, /AZURE_DEVOPS_EXT_PAT/)
})
