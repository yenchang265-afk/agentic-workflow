import assert from "node:assert/strict"
import { test } from "node:test"
import { failedCriteriaBlock, LOOP_REVIEW_TAG, LOOP_VERIFY_TAG, parseVerdict, worstOf } from "./verdict.ts"

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

// --- worstOf (multi-lens review combination) ---

test("worstOf: all PASS → PASS", () => {
  assert.equal(worstOf(["PASS", "PASS", "PASS"]), "PASS")
})

test("worstOf: any ERROR wins over FAIL and PASS", () => {
  assert.equal(worstOf(["PASS", "FAIL", "ERROR"]), "ERROR")
  assert.equal(worstOf(["ERROR", "PASS"]), "ERROR")
})

test("worstOf: any FAIL (or missing verdict) with no ERROR → FAIL", () => {
  assert.equal(worstOf(["PASS", "FAIL"]), "FAIL")
  assert.equal(worstOf(["PASS", null]), "FAIL")
})

test("worstOf: an empty list is PASS (no passes recorded a failure)", () => {
  assert.equal(worstOf([]), "PASS")
})

// --- failedCriteriaBlock (threading structured reasons into the next iteration) ---

test("failedCriteriaBlock is empty for a null record or a clean PASS", () => {
  assert.equal(failedCriteriaBlock(null), "")
  assert.equal(failedCriteriaBlock({ verdict: "PASS" }), "")
})

test("failedCriteriaBlock lists only the failed criteria and the reason", () => {
  const block = failedCriteriaBlock({
    verdict: "FAIL",
    reason: "rate limit not enforced",
    criteria: [
      { criterion: "Returns 429 over the limit", pass: false },
      { criterion: "Limit is configurable", pass: true },
      { criterion: "Documented", pass: false },
    ],
  })
  assert.match(block, /Verdict reason: rate limit not enforced/)
  assert.match(block, /- Returns 429 over the limit/)
  assert.match(block, /- Documented/)
  assert.doesNotMatch(block, /configurable/)
})
