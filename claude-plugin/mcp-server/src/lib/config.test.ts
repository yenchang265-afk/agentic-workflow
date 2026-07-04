import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CONFIG, parseConfig } from "./config.js"

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

test("watchIntervalMinutes is not a knob in this port (no watch mode)", () => {
  assert.ok(!("watchIntervalMinutes" in DEFAULT_CONFIG))
  const c = parseConfig({ watchIntervalMinutes: 5 })
  assert.ok(!("watchIntervalMinutes" in c)) // silently dropped like other removed keys
})

test("a config still carrying removed keys parses (silent deprecation)", () => {
  const c = parseConfig({ gateBeforeBuild: false, interviewBeforePlan: false })
  assert.equal(c.maxIterations, 3)
  assert.ok(!("gateBeforeBuild" in c))
})
