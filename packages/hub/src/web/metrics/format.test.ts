import assert from "node:assert/strict"
import { test } from "node:test"
import { barWidth, bucketLabel, formatChars, formatTokens, pct, timeAgo } from "./format.js"

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

test("formatChars abbreviates at a thousand and keeps magnitudes distinguishable", () => {
  assert.equal(formatChars(0), "0")
  assert.equal(formatChars(999), "999")
  assert.equal(formatChars(1_000), "1.0k")
  assert.equal(formatChars(8_200), "8.2k")
  assert.equal(formatChars(24_000), "24.0k")
  // A mean is fractional; it must not render a decimal tail below 1k.
  assert.equal(formatChars(666.6), "667")
})

test("formatTokens abbreviates at k and M", () => {
  assert.equal(formatTokens(999), "999")
  assert.equal(formatTokens(1_500), "1.5k")
  assert.equal(formatTokens(2_400_000), "2.4M")
})

test("timeAgo scales units and never goes negative", () => {
  const now = Date.parse("2026-07-28T12:00:00.000Z")
  assert.equal(timeAgo("2026-07-28T11:59:55.000Z", now), "5s ago")
  assert.equal(timeAgo("2026-07-28T11:57:00.000Z", now), "3m ago")
  assert.equal(timeAgo("2026-07-28T09:45:00.000Z", now), "2h 15m ago")
  // Clock skew: a timestamp slightly in the future clamps to "0s ago".
  assert.equal(timeAgo("2026-07-28T12:00:02.000Z", now), "0s ago")
  // Unparseable input renders verbatim, not NaN.
  assert.equal(timeAgo("not-a-time", now), "not-a-time")
})
