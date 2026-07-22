import assert from "node:assert/strict"
import { test } from "node:test"
import { barWidth, bucketLabel, pct } from "./format.js"

test("pct renders an unmeasurable rate differently from a genuine zero", () => {
  // The distinction the whole `number | null` convention exists to preserve:
  // "no pass recorded a cap" must not read as "no pass tripped the cap".
  assert.equal(pct(null), "—")
  assert.equal(pct(0), "0%")
  assert.equal(pct(1), "100%")
  assert.equal(pct(0.5), "50%")
})

test("pct rounds to the requested precision", () => {
  assert.equal(pct(1 / 3), "33%")
  assert.equal(pct(1 / 3, 1), "33.3%")
})

test("bucketLabel closes the capped bucket at a single value", () => {
  assert.equal(bucketLabel({ from: 0, to: 0.25, passes: 0 }), "0–25%")
  assert.equal(bucketLabel({ from: 0.75, to: 1, passes: 0 }), "75–100%")
  assert.equal(bucketLabel({ from: 1, to: 1, passes: 3 }), "100%")
})

test("barWidth keeps a single-run bucket visible beside a large one", () => {
  assert.equal(barWidth(100, 100, 300), 300)
  assert.equal(barWidth(50, 100, 300), 150)
  // Would round to 0.3px and vanish; floored to 1px instead.
  assert.equal(barWidth(1, 1000, 300), 1)
  assert.equal(barWidth(0, 100, 300), 0)
  assert.equal(barWidth(5, 0, 300), 0)
})
