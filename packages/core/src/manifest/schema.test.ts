import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { effectiveAllowlist, gateStatuses, parseManifest } from "./schema.js"

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
  assert.equal(m.workSource.pools[0]?.manual, false)
})

test("a pool can opt out of auto-claiming with manual: true", () => {
  const raw = {
    ...base,
    workSource: {
      type: "backlog",
      statuses: ["queued", "done"],
      pools: [{ status: "queued", entryStage: "work", manual: true }],
    },
  }
  const m = parseManifest(raw)
  assert.equal(m.workSource.type === "backlog" && m.workSource.pools[0]?.manual, true)
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

test("effectiveAllowlist resolves ado access methods via composite keys, fail-closed when absent", () => {
  const withAccess = parseManifest({
    ...base,
    stages: [
      {
        ...base.stages[0],
        bashAllowlist: ["ls*"],
        platformAllowlist: { ado: ["curl*"], "ado:az": ["az repos pr show*"] },
      },
      base.stages[1],
    ],
  })
  const def = withAccess.stages[0]!
  // rest (and no access at all) stays the plain platform key.
  assert.deepEqual(effectiveAllowlist(def, "ado", "rest"), ["ls*", "curl*"])
  assert.deepEqual(effectiveAllowlist(def, "ado"), ["ls*", "curl*"])
  // az looks up the composite key; no inheritance from plain "ado".
  assert.deepEqual(effectiveAllowlist(def, "ado", "az"), ["ls*", "az repos pr show*"])
  // A missing composite key yields only the base list — fail-closed.
  assert.deepEqual(effectiveAllowlist(def, "ado", "mcp"), ["ls*"])
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
