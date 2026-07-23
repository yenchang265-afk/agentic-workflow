import assert from "node:assert/strict"
import { test } from "node:test"
import { withLock } from "./lock.js"

/**
 * The shared serialization primitive under gate moves, config saves, and
 * scaffolds. Its contract: same key runs strictly in order, different keys
 * interleave, and a rejection propagates to its caller without wedging the
 * chain for the next caller.
 */

const step = (log: string[], name: string, ms: number) => async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, ms))
  log.push(name)
}

test("withLock serializes per key and keeps different keys concurrent", async () => {
  const log: string[] = []
  await Promise.all([withLock("same", step(log, "first", 30)), withLock("same", step(log, "second", 1))])
  assert.deepEqual(log, ["first", "second"])

  const log2: string[] = []
  await Promise.all([withLock("one", step(log2, "slow", 30)), withLock("two", step(log2, "fast", 1))])
  assert.deepEqual(log2, ["fast", "slow"])
})

test("a rejection reaches its caller and does not wedge the chain", async () => {
  await assert.rejects(withLock("same", () => Promise.reject(new Error("veto"))))
  const log: string[] = []
  await withLock("same", step(log, "after-reject", 1))
  assert.deepEqual(log, ["after-reject"])
})

test("withLock returns the callback's value", async () => {
  assert.equal(await withLock("value", async () => 42), 42)
})
