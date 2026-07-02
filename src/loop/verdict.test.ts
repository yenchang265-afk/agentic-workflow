import assert from "node:assert/strict"
import { test } from "node:test"
import { LOOP_REVIEW_TAG, LOOP_VERIFY_TAG, parseVerdict } from "./verdict.ts"

test("parses a PASS verdict", () => {
  assert.equal(parseVerdict("checks ran\nLOOP_VERIFY: PASS", LOOP_VERIFY_TAG), "PASS")
})

test("parses a FAIL verdict", () => {
  assert.equal(parseVerdict("LOOP_VERIFY: FAIL\nmissing test", LOOP_VERIFY_TAG), "FAIL")
})

test("is case-insensitive and tolerates extra spacing", () => {
  assert.equal(parseVerdict("loop_verify:   pass", LOOP_VERIFY_TAG), "PASS")
})

test("returns the last verdict when several appear", () => {
  assert.equal(parseVerdict("LOOP_VERIFY: FAIL\n...redo...\nLOOP_VERIFY: PASS", LOOP_VERIFY_TAG), "PASS")
})

test("returns null when no verdict is present", () => {
  assert.equal(parseVerdict("all good, tests green", LOOP_VERIFY_TAG), null)
  assert.equal(parseVerdict("", LOOP_VERIFY_TAG), null)
})

test("parses the LOOP_REVIEW tag independently of LOOP_VERIFY", () => {
  assert.equal(parseVerdict("five-axis review done\nLOOP_REVIEW: PASS", LOOP_REVIEW_TAG), "PASS")
  assert.equal(parseVerdict("LOOP_REVIEW: FAIL\nsecurity gap", LOOP_REVIEW_TAG), "FAIL")
})

test("a LOOP_VERIFY tag in the text does not satisfy a LOOP_REVIEW lookup", () => {
  assert.equal(parseVerdict("LOOP_VERIFY: PASS", LOOP_REVIEW_TAG), null)
})
