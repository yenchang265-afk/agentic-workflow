import assert from "node:assert/strict"
import { test } from "node:test"
import { clamp, clampWithStats, ELISION } from "./budget.js"

const long = (n: number, fill = "x"): string => fill.repeat(n)

test("clamp is the identity under the limit and at Infinity — the unset-knob path", () => {
  assert.equal(clamp("short text", 100), "short text")
  assert.equal(clamp(long(50_000), Number.POSITIVE_INFINITY), long(50_000))
  assert.equal(clamp("", 10), "")
  // Exactly at the limit is still the identity.
  assert.equal(clamp(long(100), 100), long(100))
})

test("clamp preserves both head and tail and carries the elision marker", () => {
  // A check stage opens with its rationale and closes with the failing assertion;
  // a head-only truncate throws away the half naming the file and line.
  const text = `Verdict reason: two tests are red.\n${long(5_000)}\nFailing: src/foo.ts:42 expected 3, got 4`
  const out = clamp(text, 400)
  assert.ok(out.startsWith("Verdict reason: two tests are red."), "head lost")
  assert.ok(out.endsWith("src/foo.ts:42 expected 3, got 4"), "tail lost")
  assert.ok(out.includes("elided by the stage context budget"), "marker missing")
  assert.ok(out.length <= 400, `clamped to ${out.length}, over the limit`)
})

test("the marker reports the true elided count", () => {
  const text = long(10_000)
  const { text: out, elided } = clampWithStats(text, 1_000)
  assert.equal(elided, text.length - (out.length - ELISION(elided).length))
  assert.ok(out.includes(ELISION(elided)), "the marker does not carry the reported count")
})

test("clamp is idempotent — a clamped artifact re-clamped is unchanged", () => {
  const once = clamp(long(20_000), 900)
  assert.equal(clamp(once, 900), once)
})

test("a limit below the marker length degrades to the marker alone, never a negative slice", () => {
  const out = clamp(long(5_000), 5)
  assert.ok(out.length > 0)
  assert.ok(out.includes("elided by the stage context budget"))
  assert.ok(!out.includes("xxxxx"), "content survived a limit that cannot hold any")
  // And it stays stable under a second pass.
  assert.equal(clamp(out, 5), out)
})

test("clampWithStats reports elided 0 at Infinity and the exact count when it bites", () => {
  assert.deepEqual(clampWithStats("abc", Number.POSITIVE_INFINITY), { text: "abc", elided: 0 })
  assert.deepEqual(clampWithStats("abc", 100), { text: "abc", elided: 0 })
  const { elided } = clampWithStats(long(3_000), 500)
  assert.ok(elided > 0 && elided < 3_000)
})

test("a zero or negative limit still yields the marker, not an empty artifact", () => {
  // A stage must never receive text that reads as a complete artifact when it is not.
  for (const limit of [0, -1]) {
    const out = clamp(long(1_000), limit)
    assert.ok(out.includes("elided by the stage context budget"), `limit ${limit} produced ${JSON.stringify(out)}`)
  }
})
