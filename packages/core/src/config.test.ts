import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CONFIG, enabledLoopKinds, parseConfig } from "./config.js"

test("defaults leave worktree isolation off and review single-pass", () => {
  assert.equal(DEFAULT_CONFIG.worktreesDir, undefined)
  assert.equal(DEFAULT_CONFIG.worktreeSetup, undefined)
  assert.deepEqual(DEFAULT_CONFIG.reviewLenses, [])
})

test("parseConfig accepts worktree knobs", () => {
  const c = parseConfig({ worktreesDir: ".loop-worktrees", worktreeSetup: "npm ci" })
  assert.equal(c.worktreesDir, ".loop-worktrees")
  assert.equal(c.worktreeSetup, "npm ci")
})

test("parseConfig rejects an empty worktreesDir", () => {
  assert.throws(() => parseConfig({ worktreesDir: "" }), /Invalid .*worktreesDir/)
})

test("parseConfig rejects an empty worktreeSetup", () => {
  assert.throws(() => parseConfig({ worktreeSetup: "" }), /Invalid .*worktreeSetup/)
})

test("parseConfig accepts review lenses and rejects more than five", () => {
  assert.deepEqual(parseConfig({ reviewLenses: ["correctness", "security"] }).reviewLenses, [
    "correctness",
    "security",
  ])
  assert.throws(() => parseConfig({ reviewLenses: ["a", "b", "c", "d", "e", "f"] }), /Invalid .*reviewLenses/)
})

test("parseConfig rejects an empty lens string", () => {
  assert.throws(() => parseConfig({ reviewLenses: [""] }), /Invalid .*reviewLenses/)
})

test("existing knobs keep their defaults and validation", () => {
  assert.equal(DEFAULT_CONFIG.maxIterations, 3)
  assert.equal(DEFAULT_CONFIG.tasksDir, "docs/tasks")
  assert.equal(DEFAULT_CONFIG.stageTimeoutMinutes, 60)
  assert.throws(() => parseConfig({ maxIterations: 0 }), /Invalid/)
})

test("a config still carrying removed keys parses (silent deprecation)", () => {
  const c = parseConfig({ gateBeforeBuild: false, interviewBeforePlan: false })
  assert.equal(c.maxIterations, 3)
  assert.ok(!("gateBeforeBuild" in c))
})

test("loops section defaults to empty and enabledLoopKinds keeps engineering on", () => {
  assert.deepEqual(DEFAULT_CONFIG.loops, {})
  assert.deepEqual(enabledLoopKinds(DEFAULT_CONFIG), ["engineering"])
})

test("other loop kinds are opt-in; engineering can be disabled", () => {
  const c = parseConfig({ loops: { "pr-sitter": { enabled: true, query: "author:@me" } } })
  assert.deepEqual(enabledLoopKinds(c), ["engineering", "pr-sitter"])
  const offByDefault = parseConfig({ loops: { "pr-sitter": {} } })
  assert.deepEqual(enabledLoopKinds(offByDefault), ["engineering", "pr-sitter"])
  const disabled = parseConfig({ loops: { engineering: { enabled: false }, "pr-sitter": { enabled: true } } })
  assert.deepEqual(enabledLoopKinds(disabled), ["pr-sitter"])
})

test("kind-specific knobs ride along in the loops section", () => {
  const c = parseConfig({ loops: { "pr-sitter": { enabled: true, query: "is:open author:@me" } } })
  assert.equal(c.loops["pr-sitter"]?.["query"], "is:open author:@me")
})
