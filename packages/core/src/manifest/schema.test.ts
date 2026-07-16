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
  const raw = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "loops", "engineering", "loop.json"), "utf8"))
  assert.deepEqual(gateStatuses(parseManifest(raw)).sort(), ["in-review", "plan-review"])
})

test("github-pr source accepts the review-requested trigger and a reviewer role; role defaults to author", () => {
  const pr = {
    ...base,
    workSource: { type: "github-pr", query: "is:open review-requested:@me", triggers: ["review-requested"], role: "reviewer" },
  }
  const m = parseManifest(pr)
  assert.equal(m.workSource.type === "github-pr" && m.workSource.role, "reviewer")
  const defaulted = parseManifest({
    ...base,
    workSource: { type: "github-pr", query: "is:open author:@me", triggers: ["failing-checks"] },
  })
  assert.equal(defaulted.workSource.type === "github-pr" && defaulted.workSource.role, "author")
  assert.throws(() =>
    parseManifest({
      ...base,
      workSource: { type: "github-pr", query: "q", triggers: ["failing-checks"], role: "owner" },
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
