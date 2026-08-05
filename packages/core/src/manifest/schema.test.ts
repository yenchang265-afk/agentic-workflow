import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { effectiveAllowlist, FANOUT_MAX, gateStatuses, parseManifest } from "./schema.js"

const base = {
  kind: "k",
  version: 1,
  description: "test kind",
  workSource: { type: "backlog", statuses: ["queued", "done"], pools: [{ status: "queued", entryStage: "work" }] },
  stages: [
    { name: "work", kind: "work", command: "work", agent: "a", prompt: "stages/work.md" },
    { name: "check", kind: "check", command: "check", agent: "a", prompt: "stages/check.md" },
  ],
  transitions: {
    work: { onDone: { kind: "fire", stage: "check" } },
    check: {
      onPass: { kind: "done", message: "done" },
      onFail: { kind: "fire", stage: "work", countIteration: true, capMessage: "capped at {maxIterations}" },
      onError: { kind: "stop", message: "stopped" },
    },
  },
}

test("a well-formed manifest parses with defaults applied", () => {
  const m = parseManifest(base)
  assert.equal(m.stages[0]?.isolation, "worktree")
  assert.deepEqual(m.stages[0]?.bashAllowlist, [])
  assert.deepEqual(m.hooks.compose, {})
  assert.ok(m.workSource.type === "backlog")
})

test("rejects a stage prompt outside stages/ — manifests are user-authored and hub-writable", () => {
  const withPrompt = (prompt: string) => ({
    ...base,
    stages: [{ ...base.stages[0]!, prompt }, base.stages[1]!],
  })
  assert.throws(() => parseManifest(withPrompt("../../../../etc/passwd")), /prompt/)
  assert.throws(() => parseManifest(withPrompt("stages/../../secrets.md")), /prompt/)
  assert.throws(() => parseManifest(withPrompt("/etc/passwd")), /prompt/)
  assert.throws(() => parseManifest(withPrompt("stages/nested/dir.md")), /prompt/)
  assert.throws(() => parseManifest(withPrompt("stages/.md")), /prompt/, "dot-leading names are rejected")
  assert.equal(parseManifest(withPrompt("stages/work-2.md")).stages[0]?.prompt, "stages/work-2.md")
})

test("rejects a stage with no transitions entry", () => {
  const raw = { ...base, transitions: { work: base.transitions.work } }
  assert.throws(() => parseManifest(raw), /"check" has no transitions entry/)
})

test("rejects a work stage without onDone and a check stage missing a verdict arm", () => {
  assert.throws(
    () => parseManifest({ ...base, transitions: { ...base.transitions, work: {} } }),
    /work stage "work" needs transitions.onDone/,
  )
  assert.throws(
    () =>
      parseManifest({
        ...base,
        transitions: { ...base.transitions, check: { onPass: { kind: "done", message: "d" } } },
      }),
    /check stage "check" needs onPass, onFail, and onError/,
  )
})

test("rejects a fire at an unknown stage and a counted fire without capMessage", () => {
  assert.throws(
    () => parseManifest({ ...base, transitions: { ...base.transitions, work: { onDone: { kind: "fire", stage: "nope" } } } }),
    /unknown stage "nope"/,
  )
  assert.throws(
    () =>
      parseManifest({
        ...base,
        transitions: {
          ...base.transitions,
          check: { ...base.transitions.check, onFail: { kind: "fire", stage: "work", countIteration: true } },
        },
      }),
    /needs a capMessage/,
  )
})

test("rejects a backlog pool whose entryStage names no stage", () => {
  const raw = {
    ...base,
    workSource: { type: "backlog", statuses: ["queued", "done"], pools: [{ status: "queued", entryStage: "wrok" }] },
  }
  assert.throws(() => parseManifest(raw), /pool "queued" enters unknown stage "wrok"/)
})

test("a stage's optional model round-trips, defaults to undefined, and rejects an empty string", () => {
  const withModel = parseManifest({
    ...base,
    stages: [{ ...base.stages[0], model: "anthropic/claude-sonnet-4-5" }, base.stages[1]],
  })
  assert.equal(withModel.stages[0]?.model, "anthropic/claude-sonnet-4-5")
  assert.equal(withModel.stages[1]?.model, undefined)
  assert.equal(parseManifest(base).stages[0]?.model, undefined)
  assert.throws(() => parseManifest({ ...base, stages: [{ ...base.stages[0], model: "" }, base.stages[1]] }), /model/)
})

test("a stage's optional context map round-trips, defaults to undefined, and rejects a non-positive limit", () => {
  const withContext = parseManifest({
    ...base,
    stages: [{ ...base.stages[0], context: { work: 24_000, check: 8_000 } }, base.stages[1]],
  })
  assert.deepEqual(withContext.stages[0]?.context, { work: 24_000, check: 8_000 })
  assert.equal(withContext.stages[1]?.context, undefined)
  assert.equal(parseManifest(base).stages[0]?.context, undefined)
  for (const bad of [0, -1, 1.5]) {
    assert.throws(
      () => parseManifest({ ...base, stages: [{ ...base.stages[0], context: { check: bad } }, base.stages[1]] }),
      /context/,
      `limit ${bad} was accepted`,
    )
  }
})

test("rejects a context key naming no stage of the manifest — a typo must not resolve to unbounded", () => {
  const raw = { ...base, stages: [{ ...base.stages[0], context: { pln: 1_000 } }, base.stages[1]] }
  assert.throws(() => parseManifest(raw), /budgets unknown artifact "pln"/)
})

test("no shipped manifest sets context — every stage is unbounded today", () => {
  const workflowsDir = path.join(import.meta.dirname, "..", "..", "workflows")
  for (const kind of fs.readdirSync(workflowsDir).filter((d) => fs.existsSync(path.join(workflowsDir, d, "workflow.json")))) {
    const m = parseManifest(JSON.parse(fs.readFileSync(path.join(workflowsDir, kind, "workflow.json"), "utf8")))
    for (const s of m.stages) assert.equal(s.context, undefined, `${kind}/${s.name} sets a context budget`)
  }
})

test("no shipped manifest declares checks — every kind still runs exactly as it did", () => {
  const workflowsDir = path.join(import.meta.dirname, "..", "..", "workflows")
  for (const kind of fs.readdirSync(workflowsDir).filter((d) => fs.existsSync(path.join(workflowsDir, d, "workflow.json")))) {
    const m = parseManifest(JSON.parse(fs.readFileSync(path.join(workflowsDir, kind, "workflow.json"), "utf8")))
    for (const s of m.stages) assert.deepEqual(s.checks, [], `${kind}/${s.name} declares check commands`)
  }
})

test("a check stage's checks round-trip, with cwd optional", () => {
  const m = parseManifest({
    ...base,
    stages: [
      base.stages[0],
      { ...base.stages[1], checks: [{ name: "tests", command: "npm test" }, { name: "web", command: "npm test", cwd: "packages/web" }] },
    ],
  })
  assert.deepEqual(m.stages[1]?.checks, [
    { name: "tests", command: "npm test" },
    { name: "web", command: "npm test", cwd: "packages/web" },
  ])
})

test("a work stage cannot declare checks — there is no verdict to floor", () => {
  assert.throws(
    () =>
      parseManifest({
        ...base,
        stages: [{ ...base.stages[0], checks: [{ name: "tests", command: "npm test" }] }, base.stages[1]],
      }),
    /cannot set checks/,
  )
})

test("duplicate check names in one stage are rejected — the name keys the axis finding", () => {
  assert.throws(
    () =>
      parseManifest({
        ...base,
        stages: [
          base.stages[0],
          { ...base.stages[1], checks: [{ name: "tests", command: "npm test" }, { name: "tests", command: "npm run e2e" }] },
        ],
      }),
    /duplicate check names/,
  )
})

test("a check stage's requiredAxes round-trips and defaults to undefined", () => {
  const axes = ["correctness", "security"]
  const raw = {
    ...base,
    stages: [base.stages[0], { ...base.stages[1], requiredAxes: axes }],
  }
  assert.deepEqual(parseManifest(raw).stages[1]?.requiredAxes, axes)
  assert.equal(parseManifest(base).stages[1]?.requiredAxes, undefined)
})

test("rejects requiredAxes on a work stage — only a verdict can carry axes", () => {
  const raw = {
    ...base,
    stages: [{ ...base.stages[0], requiredAxes: ["correctness"] }, base.stages[1]],
  }
  assert.throws(() => parseManifest(raw), /work stage "work" cannot set requiredAxes/)
})

test("requireEvidence round-trips through a JSON save and defaults to false", () => {
  const raw = { ...base, stages: [base.stages[0], { ...base.stages[1], requireEvidence: true }] }
  const parsed = parseManifest(raw)
  assert.equal(parsed.stages[1]?.requireEvidence, true)
  assert.equal(parseManifest(base).stages[1]?.requireEvidence, false)
  // The hub re-serializes the PARSED manifest on save (routes/kinds.ts), so a
  // field the schema doesn't know is deleted from disk. Prove this one survives.
  assert.equal(parseManifest(JSON.parse(JSON.stringify(parsed))).stages[1]?.requireEvidence, true)
})

test("rejects requireEvidence on a work stage — only a verdict can carry evidence", () => {
  const raw = { ...base, stages: [{ ...base.stages[0], requireEvidence: true }, base.stages[1]] }
  assert.throws(() => parseManifest(raw), /work stage "work" cannot set requireEvidence/)
})

test("planContract round-trips through a JSON save and defaults to false", () => {
  const raw = { ...base, stages: [{ ...base.stages[0], planContract: true }, base.stages[1]] }
  const parsed = parseManifest(raw)
  assert.equal(parsed.stages[0]?.planContract, true)
  assert.equal(parseManifest(base).stages[0]?.planContract, false)
  // Survive the hub's parse→re-serialize save cycle, same as requireEvidence.
  assert.equal(parseManifest(JSON.parse(JSON.stringify(parsed))).stages[0]?.planContract, true)
})

test("rejects planContract on a check stage — it writes no plan", () => {
  const raw = { ...base, stages: [base.stages[0], { ...base.stages[1], planContract: true }] }
  assert.throws(() => parseManifest(raw), /check stage "check" cannot set planContract/)
})

test("planVisualization round-trips through a JSON save and defaults to false", () => {
  const raw = { ...base, stages: [{ ...base.stages[0], planContract: true, planVisualization: true }, base.stages[1]] }
  const parsed = parseManifest(raw)
  assert.equal(parsed.stages[0]?.planVisualization, true)
  assert.equal(parseManifest(base).stages[0]?.planVisualization, false)
  // Survive the hub's parse→re-serialize save cycle, same as planContract.
  assert.equal(parseManifest(JSON.parse(JSON.stringify(parsed))).stages[0]?.planVisualization, true)
})

test("rejects planVisualization on a check stage — it writes no plan", () => {
  const raw = { ...base, stages: [base.stages[0], { ...base.stages[1], planVisualization: true }] }
  assert.throws(() => parseManifest(raw), /check stage "check" cannot set planVisualization/)
})

test("rejects planVisualization without planContract — the diagram lives inside the contract's plan document", () => {
  const raw = { ...base, stages: [{ ...base.stages[0], planVisualization: true }, base.stages[1]] }
  assert.throws(() => parseManifest(raw), /sets planVisualization without planContract/)
})

test("a check stage's fanout round-trips through a JSON save and defaults to undefined", () => {
  const raw = {
    ...base,
    stages: [base.stages[0], { ...base.stages[1], requiredAxes: ["correctness", "security"], fanout: "axis" }],
  }
  const parsed = parseManifest(raw)
  assert.equal(parsed.stages[1]?.fanout, "axis")
  assert.equal(parseManifest(base).stages[1]?.fanout, undefined)
  // The hub re-serializes the PARSED manifest on save (routes/kinds.ts), so a
  // field the schema doesn't know is deleted from disk. Prove this one survives.
  assert.equal(parseManifest(JSON.parse(JSON.stringify(parsed))).stages[1]?.fanout, "axis")
})

test("rejects fanout on a work stage — there is no verdict to fan out", () => {
  const raw = { ...base, stages: [{ ...base.stages[0], fanout: "axis" }, base.stages[1]] }
  assert.throws(() => parseManifest(raw), /work stage "work" cannot set fanout/)
})

test('rejects fanout "axis" with no requiredAxes — the axis list is the pass list', () => {
  const raw = { ...base, stages: [base.stages[0], { ...base.stages[1], fanout: "axis" }] }
  assert.throws(() => parseManifest(raw), /declares no requiredAxes/)
})

test("rejects a fan-out over more axes than FANOUT_MAX — each axis is a full subagent pass", () => {
  const axes = Array.from({ length: FANOUT_MAX + 1 }, (_, i) => `axis-${i}`)
  const raw = { ...base, stages: [base.stages[0], { ...base.stages[1], requiredAxes: axes, fanout: "axis" }] }
  assert.throws(() => parseManifest(raw), new RegExp(`at most ${FANOUT_MAX}`))
  const ok = { ...base, stages: [base.stages[0], { ...base.stages[1], requiredAxes: axes.slice(1), fanout: "axis" }] }
  assert.equal(parseManifest(ok).stages[1]?.fanout, "axis")
})

test("rejects an unknown fanout strategy", () => {
  const raw = {
    ...base,
    stages: [base.stages[0], { ...base.stages[1], requiredAxes: ["correctness"], fanout: "file" }],
  }
  assert.throws(() => parseManifest(raw), /fanout/)
})

test("the shipped engineering manifest requires all five review axes and none on verify", () => {
  const workflowsDir = path.join(import.meta.dirname, "..", "..", "workflows")
  const m = parseManifest(JSON.parse(fs.readFileSync(path.join(workflowsDir, "engineering", "workflow.json"), "utf8")))
  assert.deepEqual(m.stages.find((s) => s.name === "review")?.requiredAxes, [
    "correctness",
    "readability",
    "architecture",
    "security",
    "performance",
  ])
  assert.equal(m.stages.find((s) => s.name === "verify")?.requiredAxes, undefined)
})

test("rejects duplicate stage names", () => {
  assert.throws(() => parseManifest({ ...base, stages: [...base.stages, base.stages[0]] }), /duplicate stage names/)
})

test("platformAllowlist defaults empty and effectiveAllowlist merges the platform's globs", () => {
  const m = parseManifest(base)
  assert.deepEqual(m.stages[0]?.platformAllowlist, {})
  const withPlatform = parseManifest({
    ...base,
    stages: [
      {
        ...base.stages[0],
        bashAllowlist: ["ls*"],
        platformAllowlist: { github: ["gh pr view*"], ado: ["curl*"] },
      },
      base.stages[1],
    ],
  })
  const def = withPlatform.stages[0]!
  assert.deepEqual(effectiveAllowlist(def, "github"), ["ls*", "gh pr view*"])
  assert.deepEqual(effectiveAllowlist(def, "ado"), ["ls*", "curl*"])
  assert.deepEqual(effectiveAllowlist(def, "other"), ["ls*"])
})


test("rejects an empty glob inside platformAllowlist", () => {
  assert.throws(
    () =>
      parseManifest({
        ...base,
        stages: [{ ...base.stages[0], platformAllowlist: { ado: [""] } }, base.stages[1]],
      }),
    /platformAllowlist/,
  )
})

test("gateStatuses collects park/done toStatus targets across transitions", () => {
  const m = parseManifest({
    ...base,
    transitions: {
      work: { onDone: { kind: "park", toStatus: "waiting-review", message: "parked" } },
      check: {
        onPass: { kind: "done", toStatus: "done", message: "done" },
        onFail: { kind: "fire", stage: "work", countIteration: true, capMessage: "capped at {maxIterations}" },
        onError: { kind: "stop", message: "stopped" },
      },
    },
  })
  assert.deepEqual(gateStatuses(m).sort(), ["done", "waiting-review"])
})

test("gateStatuses is empty when no effect targets a status", () => {
  assert.deepEqual(gateStatuses(parseManifest(base)), [])
})

test("gateStatuses derives the engineering kind's gates from its shipped manifest", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "workflows", "engineering", "workflow.json"), "utf8"))
  // "draft" comes from workSource.humanGates, not the transition table — nothing
  // parks into it, a human authors it there.
  assert.deepEqual(gateStatuses(parseManifest(raw)).sort(), ["draft", "in-review", "plan-review"])
})

test("humanGates defaults to [] and is unioned into gateStatuses, deduped", () => {
  const plain = parseManifest(base)
  assert.deepEqual(plain.workSource.type === "backlog" && plain.workSource.humanGates, [])
  assert.deepEqual(gateStatuses(plain), [])

  const withGates = parseManifest({
    ...base,
    workSource: { ...base.workSource, humanGates: ["queued", "done"] },
    transitions: {
      ...base.transitions,
      check: { ...base.transitions.check, onPass: { kind: "done", toStatus: "done", message: "done" } },
    },
  })
  // "done" is both landed-into and declared; "queued" only declared. Each appears once.
  assert.deepEqual(gateStatuses(withGates).sort(), ["done", "queued"])
})

test("a humanGates status is a gate, not a pool — it never becomes claimable", () => {
  const m = parseManifest({ ...base, workSource: { ...base.workSource, humanGates: ["done"] } })
  assert.ok(m.workSource.type === "backlog")
  assert.ok(!m.workSource.pools.some((p) => p.status === "done"))
})

test("humanGates must name a declared status", () => {
  assert.throws(
    () => parseManifest({ ...base, workSource: { ...base.workSource, humanGates: ["nope"] } }),
    /humanGates lists "nope", which is not one of workSource.statuses/,
  )
})

test("pull-request source accepts the review-requested trigger and a reviewer role; role defaults to author", () => {
  const pr = {
    ...base,
    workSource: { type: "pull-request", query: "is:open review-requested:@me", triggers: ["review-requested"], role: "reviewer" },
  }
  const m = parseManifest(pr)
  assert.equal(m.workSource.type === "pull-request" && m.workSource.role, "reviewer")
  const defaulted = parseManifest({
    ...base,
    workSource: { type: "pull-request", query: "is:open author:@me", triggers: ["failing-checks"] },
  })
  assert.equal(defaulted.workSource.type === "pull-request" && defaulted.workSource.role, "author")
  assert.throws(() =>
    parseManifest({
      ...base,
      workSource: { type: "pull-request", query: "q", triggers: ["failing-checks"], role: "owner" },
    }),
  )
})

test("dependency-scan source parses with its policy defaults", () => {
  const m = parseManifest({ ...base, workSource: { type: "dependency-scan" } })
  assert.equal(m.workSource.type, "dependency-scan")
  if (m.workSource.type === "dependency-scan") {
    assert.deepEqual(m.workSource.autoFix, ["patch", "minor"])
    assert.equal(m.workSource.severityFloor, "high")
    assert.equal(m.workSource.includeOutdated, false)
  }
  // Majors are never auto-fixable — the enum has no "major" member.
  assert.throws(() => parseManifest({ ...base, workSource: { type: "dependency-scan", autoFix: ["major"] } }))
})

test("ci-runs source parses with an optional branch and empty workflows default", () => {
  const m = parseManifest({ ...base, workSource: { type: "ci-runs" } })
  assert.equal(m.workSource.type, "ci-runs")
  if (m.workSource.type === "ci-runs") {
    assert.equal(m.workSource.branch, undefined)
    assert.deepEqual(m.workSource.workflows, [])
  }
  const pinned = parseManifest({ ...base, workSource: { type: "ci-runs", branch: "main", workflows: ["ci.yml"] } })
  if (pinned.workSource.type === "ci-runs") assert.equal(pinned.workSource.branch, "main")
})

test("a status folder must be a slug — it becomes a real path segment", () => {
  // `statuses` are joined into <tasksDir>/<status>/ by listByStatus, findByIdIn
  // and the hub's watcher (fs.readdirSync). Core deliberately does NOT guard the
  // status argument at those call sites ("any status folder a kind's manifest
  // declares"), so the manifest is where the rail belongs — the same reason
  // `stage.prompt` is pinned to `stages/<name>.md` rather than trusted.
  for (const bad of ["../../../../etc", "in progress", "In-Progress", "a/b", ".", ""]) {
    assert.throws(
      () => parseManifest({ ...base, workSource: { type: "backlog", statuses: [bad, "done"], pools: [{ status: "done", entryStage: "work" }] } }),
      /status/i,
      `expected "${bad}" to be refused`,
    )
  }
  // The real lifecycle folders keep parsing.
  const m = parseManifest({
    ...base,
    workSource: {
      type: "backlog",
      statuses: ["draft", "queued", "plan-review", "in-progress", "in-review", "completed", "abandoned"],
      pools: [{ status: "queued", entryStage: "work" }],
    },
  })
  assert.ok(m.workSource.type === "backlog" && m.workSource.statuses.includes("plan-review"))
})

test("a pool status must be a slug AND one of workSource.statuses", () => {
  // The gap the statuses rail left open: pools[].status is joined into the very
  // same <tasksDir>/<status>/ paths (listByStatus on every poll, the hub
  // doctor's claim sweep) and the hub creator writes free-text pool lines into
  // manifests — so a traversal escapes the backlog and a typo silently polls a
  // folder that never exists ("nothing to claim", forever).
  for (const bad of ["../../../../tmp/evil", "in progres/..", "In-Progress", ""]) {
    assert.throws(
      () => parseManifest({ ...base, workSource: { type: "backlog", statuses: ["queued"], pools: [{ status: bad, entryStage: "work" }] } }),
      /status/i,
      `expected pool status "${bad}" to be refused`,
    )
  }
  // A well-formed slug that is not a declared status is a typo, not a pool.
  assert.throws(
    () => parseManifest({ ...base, workSource: { type: "backlog", statuses: ["queued"], pools: [{ status: "in-progres", entryStage: "work" }] } }),
    /not one of workSource.statuses/i,
  )
})

test("a kind name must be a slug — it becomes a directory under runs/ and workflows/", () => {
  for (const bad of ["../evil", "a/b", "Engineering", ""]) {
    assert.throws(() => parseManifest({ ...base, kind: bad }), /kind/i, `expected "${bad}" to be refused`)
  }
  assert.equal(parseManifest({ ...base, kind: "pr-sitter" }).kind, "pr-sitter")
})
