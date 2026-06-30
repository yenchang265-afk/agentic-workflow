import assert from "node:assert/strict"
import { test } from "node:test"
import { parseVerdict } from "./verdict.ts"

test("parses a PASS verdict", () => {
  assert.equal(parseVerdict("checks ran\nLOOP_VERIFY: PASS"), "PASS")
})

test("parses a FAIL verdict", () => {
  assert.equal(parseVerdict("LOOP_VERIFY: FAIL\nmissing test"), "FAIL")
})

test("is case-insensitive and tolerates extra spacing", () => {
  assert.equal(parseVerdict("loop_verify:   pass"), "PASS")
})

test("returns the last verdict when several appear", () => {
  assert.equal(parseVerdict("LOOP_VERIFY: FAIL\n...redo...\nLOOP_VERIFY: PASS"), "PASS")
})

test("returns null when no verdict is present", () => {
  assert.equal(parseVerdict("all good, tests green"), null)
  assert.equal(parseVerdict(""), null)
})
