import assert from "node:assert/strict"
import { test } from "node:test"
import { ageLabel, burnLabel, isCapTripped } from "./age.js"

const NOW = Date.parse("2026-07-28T12:00:00Z")
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

test("ageLabel steps through the units", () => {
  assert.equal(ageLabel(ago(5_000), NOW), "just now")
  assert.equal(ageLabel(ago(5 * MIN), NOW), "5m")
  assert.equal(ageLabel(ago(59 * MIN), NOW), "59m")
  assert.equal(ageLabel(ago(3 * HOUR), NOW), "3h")
  assert.equal(ageLabel(ago(2 * DAY), NOW), "2d")
  assert.equal(ageLabel(ago(20 * DAY), NOW), "2w")
})

test("ageLabel returns null for an unknown age rather than claiming it is new", () => {
  // The whole point: an untimestamped task must not read as the freshest item
  // on the board when it may be the oldest.
  assert.equal(ageLabel(null, NOW), null)
  assert.equal(ageLabel("not a date", NOW), null)
})

test("ageLabel clamps a future timestamp instead of rendering a negative age", () => {
  assert.equal(ageLabel(new Date(NOW + HOUR).toISOString(), NOW), "just now")
})

test("burnLabel needs both halves — a used count with no cap is not a ratio", () => {
  assert.equal(burnLabel(3, 8), "3/8")
  assert.equal(burnLabel(0, 8), "0/8")
  assert.equal(burnLabel(3, null), null)
  assert.equal(burnLabel(null, 8), null)
})

test("isCapTripped is false when either half is unrecorded", () => {
  assert.equal(isCapTripped(8, 8), true)
  assert.equal(isCapTripped(9, 8), true)
  assert.equal(isCapTripped(7, 8), false)
  assert.equal(isCapTripped(null, 8), false)
  assert.equal(isCapTripped(8, null), false)
  assert.equal(isCapTripped(0, 0), false)
})
