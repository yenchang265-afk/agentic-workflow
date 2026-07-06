import assert from "node:assert/strict"
import { test } from "node:test"
import { parseManifest } from "./schema.js"

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

test("rejects duplicate stage names", () => {
  assert.throws(() => parseManifest({ ...base, stages: [...base.stages, base.stages[0]] }), /duplicate stage names/)
})
