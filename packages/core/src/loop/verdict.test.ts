import assert from "node:assert/strict"
import { test } from "node:test"
import {
  failedCriteriaBlock,
  LOOP_REVIEW_TAG,
  LOOP_VERIFY_TAG,
  parseVerdict,
  stageDriftNote,
  verdictContractBlock,
  workScopeBlock,
  worstOf,
} from "./verdict.js"

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

// --- verdictContractBlock (the prompt-carried tool contract for check stages) ---

test("verdictContractBlock names the stage, the tool, and both registered tool names", () => {
  const block = verdictContractBlock("verify")
  assert.match(block, /loop_verdict/)
  assert.match(block, /stage: "verify"/)
  assert.match(block, /mcp__agentic-loop__loop_verdict/)
  assert.match(block, /mcp__plugin_agentic-loop_agentic-loop__loop_verdict/)
  assert.match(block, /PASS/)
})

test("verdictContractBlock warns that prose verdicts are ignored", () => {
  assert.match(verdictContractBlock("review"), /prose is IGNORED/i)
})

// --- workScopeBlock (the prompt-carried scope fence for work stages) ---

test("workScopeBlock names the stage and confines the turn to it", () => {
  const block = workScopeBlock("build")
  assert.match(block, /STAGE SCOPE/)
  assert.match(block, /build/)
  // What comes next is the loop's call — worded to stay true for the stages that
  // park (engineering plan) or end the run (the sitters' publish), not just those
  // that fire a successor.
  assert.match(block, /after your turn ends/i)
})

test("workScopeBlock forbids calling loop_verdict and claiming the loop finished", () => {
  const block = workScopeBlock("build")
  assert.match(block, /never call .*loop_verdict/i)
  assert.match(block, /never (state|claim)/i)
})

test("workScopeBlock does not carry the check stages' MANDATORY VERDICT wording", () => {
  assert.doesNotMatch(workScopeBlock("build"), /MANDATORY VERDICT/)
})

// --- stageDriftNote (the audit trail for a verdict recorded from the wrong stage) ---

test("stageDriftNote records both stages, the dropped verdict, and names the drift", () => {
  const note = stageDriftNote("build", "verify", "PASS")
  assert.match(note, /build/i)
  assert.match(note, /verify/i)
  assert.match(note, /PASS/)
  assert.match(note, /drift/i)
  assert.match(note, /ignored/i)
})

test("stageDriftNote works without a verdict value", () => {
  assert.match(stageDriftNote("build", "review", null), /review/i)
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
