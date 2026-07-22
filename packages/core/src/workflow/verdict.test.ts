import assert from "node:assert/strict"
import { test } from "node:test"
import {
  admitVerdict,
  axisCoverageIssue,
  axisVerdict,
  blockingFindingsIssue,
  effectiveVerdict,
  WORKFLOW_REVIEW_TAG,
  WORKFLOW_VERIFY_TAG,
  mergeAxes,
  parseVerdict,
  stageDriftNote,
  verdictContractBlock,
  verdictFeedbackBlock,
  workScopeBlock,
  worstOf,
} from "./verdict.js"

const AXES = ["correctness", "readability", "architecture", "security", "performance"]

/** A complete, clean five-axis payload — the shape the review stage must record. */
const fiveAxes = (overrides: Record<string, Partial<{ verdict: "PASS" | "FAIL" | "ERROR" }>> = {}) =>
  AXES.map((axis) => ({ axis, verdict: "PASS" as const, ...overrides[axis] }))

test("parses a PASS verdict", () => {
  assert.equal(parseVerdict("checks ran\nWORKFLOW_VERIFY: PASS", WORKFLOW_VERIFY_TAG), "PASS")
})

test("parses a FAIL verdict", () => {
  assert.equal(parseVerdict("WORKFLOW_VERIFY: FAIL\nmissing test", WORKFLOW_VERIFY_TAG), "FAIL")
})

test("is case-insensitive and tolerates extra spacing", () => {
  assert.equal(parseVerdict("workflow_verify:   pass", WORKFLOW_VERIFY_TAG), "PASS")
})

test("returns the last verdict when several appear", () => {
  assert.equal(parseVerdict("WORKFLOW_VERIFY: FAIL\n...redo...\nWORKFLOW_VERIFY: PASS", WORKFLOW_VERIFY_TAG), "PASS")
})

test("returns null when no verdict is present", () => {
  assert.equal(parseVerdict("all good, tests green", WORKFLOW_VERIFY_TAG), null)
  assert.equal(parseVerdict("", WORKFLOW_VERIFY_TAG), null)
})

test("parses the WORKFLOW_REVIEW tag independently of WORKFLOW_VERIFY", () => {
  assert.equal(parseVerdict("five-axis review done\nWORKFLOW_REVIEW: PASS", WORKFLOW_REVIEW_TAG), "PASS")
  assert.equal(parseVerdict("WORKFLOW_REVIEW: FAIL\nsecurity gap", WORKFLOW_REVIEW_TAG), "FAIL")
})

test("a WORKFLOW_VERIFY tag in the text does not satisfy a WORKFLOW_REVIEW lookup", () => {
  assert.equal(parseVerdict("WORKFLOW_VERIFY: PASS", WORKFLOW_REVIEW_TAG), null)
})

// --- verdictContractBlock (the prompt-carried tool contract for check stages) ---

test("verdictContractBlock names the stage, the tool, and both registered tool names", () => {
  const block = verdictContractBlock("verify")
  assert.match(block, /workflow_verdict/)
  assert.match(block, /stage: "verify"/)
  assert.match(block, /mcp__agentic-workflow__workflow_verdict/)
  assert.match(block, /mcp__plugin_agentic-workflow_agentic-workflow__workflow_verdict/)
  assert.match(block, /PASS/)
})

test("verdictContractBlock warns that prose verdicts are ignored", () => {
  assert.match(verdictContractBlock("review"), /prose is IGNORED/i)
})

test("verdictContractBlock is byte-identical with no axes and with an empty axis list", () => {
  // Every check stage across every kind but engineering's review renders this
  // form; the hub's kind preview asserts on it too.
  assert.equal(verdictContractBlock("verify", []), verdictContractBlock("verify"))
  assert.equal(verdictContractBlock("verify", undefined), verdictContractBlock("verify"))
  assert.doesNotMatch(verdictContractBlock("verify"), /axes/)
})

test("verdictContractBlock names every required axis and the rejection rule", () => {
  const block = verdictContractBlock("review", AXES)
  for (const axis of AXES) assert.match(block, new RegExp(axis))
  assert.match(block, /REJECTED/)
  assert.match(block, /severity/)
  assert.match(block, /not accumulated across calls/)
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

test("workScopeBlock forbids calling workflow_verdict and claiming the loop finished", () => {
  const block = workScopeBlock("build")
  assert.match(block, /never call .*workflow_verdict/i)
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

// --- verdictFeedbackBlock (threading structured reasons into the next iteration) ---

test("verdictFeedbackBlock is empty for a null record or a clean PASS", () => {
  assert.equal(verdictFeedbackBlock(null), "")
  assert.equal(verdictFeedbackBlock({ verdict: "PASS" }), "")
})

test("verdictFeedbackBlock lists only the failed criteria and the reason", () => {
  const block = verdictFeedbackBlock({
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

test("verdictFeedbackBlock output is unchanged for an axis-less record (rename regression guard)", () => {
  // The two host call sites render VERIFY records too; adding axes must not
  // have disturbed the criteria-only output by so much as a newline.
  const record = { verdict: "FAIL" as const, reason: "boom", criteria: [{ criterion: "c1", pass: false }] }
  assert.equal(verdictFeedbackBlock(record), "Verdict reason: boom\nFailed criteria (from workflow_verdict):\n- c1")
})

test("verdictFeedbackBlock renders failing axes with their blocking findings only", () => {
  const block = verdictFeedbackBlock({
    verdict: "FAIL",
    axes: [
      { axis: "correctness", verdict: "PASS" },
      {
        axis: "security",
        verdict: "FAIL",
        findings: [
          { severity: "critical", detail: "unvalidated id in SQL template", location: "src/db/query.ts:41" },
          { severity: "suggestion", detail: "rename the helper" },
        ],
      },
      { axis: "performance", verdict: "ERROR", findings: [] },
    ],
  })
  assert.match(block, /Failing review axes \(from workflow_verdict\):/)
  assert.match(block, /- security \(FAIL\)/)
  assert.match(block, /\[critical\] unvalidated id in SQL template — src\/db\/query\.ts:41/)
  assert.match(block, /- performance \(ERROR\)/)
  assert.doesNotMatch(block, /correctness/) // a passing axis is not next-BUILD's problem
  assert.doesNotMatch(block, /rename the helper/) // suggestions never block
})

test("verdictFeedbackBlock surfaces an axis whose PASS is contradicted by a Critical finding", () => {
  const block = verdictFeedbackBlock({
    verdict: "PASS",
    axes: [{ axis: "security", verdict: "PASS", findings: [{ severity: "critical", detail: "secret logged" }] }],
  })
  assert.match(block, /- security \(FAIL\)/)
  assert.match(block, /secret logged/)
})

// --- axisVerdict / effectiveVerdict (the declared verdict is derived, never trusted) ---

test("axisVerdict: a Critical or Important finding overrides a declared PASS", () => {
  assert.equal(axisVerdict({ axis: "security", verdict: "PASS", findings: [{ severity: "critical", detail: "x" }] }), "FAIL")
  assert.equal(axisVerdict({ axis: "security", verdict: "PASS", findings: [{ severity: "important", detail: "x" }] }), "FAIL")
})

test("axisVerdict: suggestions alone leave a PASS standing", () => {
  assert.equal(axisVerdict({ axis: "readability", verdict: "PASS", findings: [{ severity: "suggestion", detail: "x" }] }), "PASS")
  assert.equal(axisVerdict({ axis: "readability", verdict: "PASS" }), "PASS")
})

test("axisVerdict: a declared ERROR survives (the axis could not be assessed)", () => {
  assert.equal(axisVerdict({ axis: "performance", verdict: "ERROR" }), "ERROR")
  assert.equal(axisVerdict({ axis: "performance", verdict: "FAIL" }), "FAIL")
})

test("effectiveVerdict: a declared PASS cannot outrank a failing axis", () => {
  assert.equal(effectiveVerdict({ verdict: "PASS", axes: fiveAxes({ security: { verdict: "FAIL" } }) }), "FAIL")
})

test("effectiveVerdict: any ERROR axis makes the stage ERROR", () => {
  assert.equal(effectiveVerdict({ verdict: "PASS", axes: fiveAxes({ performance: { verdict: "ERROR" } }) }), "ERROR")
})

test("effectiveVerdict: a record with no axes keeps its declared verdict", () => {
  assert.equal(effectiveVerdict({ verdict: "PASS" }), "PASS")
  assert.equal(effectiveVerdict({ verdict: "FAIL" }), "FAIL")
  assert.equal(effectiveVerdict({ verdict: "ERROR" }), "ERROR")
})

// --- axisCoverageIssue (the enforcement itself) ---

test("axisCoverageIssue: no requirement means no enforcement (VERIFY and the sitters are untouched)", () => {
  assert.equal(axisCoverageIssue({ verdict: "PASS" }, undefined), null)
  assert.equal(axisCoverageIssue({ verdict: "PASS" }, []), null)
})

test("axisCoverageIssue: a complete payload is accepted", () => {
  assert.equal(axisCoverageIssue({ verdict: "PASS", axes: fiveAxes() }, AXES), null)
})

test("axisCoverageIssue: names exactly the missing axes", () => {
  const issue = axisCoverageIssue(
    { verdict: "PASS", axes: [{ axis: "correctness", verdict: "PASS" }, { axis: "readability", verdict: "PASS" }] },
    AXES,
  )
  assert.ok(issue)
  // Assert on the extracted list, not the whole message — the payload-shape
  // example downstream names an axis too.
  assert.equal(issue.match(/Missing: ([^.]+)\./)?.[1], "architecture, security, performance")
})

test("axisCoverageIssue: the message tells the agent how to retry successfully in one call", () => {
  const issue = axisCoverageIssue({ verdict: "PASS" }, AXES)
  assert.ok(issue)
  assert.match(issue, /NOT recorded/)
  assert.match(issue, /ONE call/)
  assert.match(issue, /not\s+accumulated/)
  assert.match(issue, /ERROR.*could not assess/s) // the escape hatch, or the model invents findings
  assert.match(issue, /no findings is a clean PASS/)
})

test("axisCoverageIssue: axis matching tolerates case and whitespace", () => {
  const axes = AXES.map((a) => ({ axis: ` ${a.toUpperCase()} `, verdict: "PASS" as const }))
  assert.equal(axisCoverageIssue({ verdict: "PASS", axes }, AXES), null)
})

test("axisCoverageIssue: extra axes beyond the requirement are accepted, not rejected", () => {
  const axes = [...fiveAxes(), { axis: "test-adequacy", verdict: "PASS" as const }]
  assert.equal(axisCoverageIssue({ verdict: "PASS", axes }, AXES), null)
})

// --- blockingFindingsIssue (a FAIL must name what to fix) ---

test("blockingFindingsIssue: a FAIL with only suggestions is rejected", () => {
  const record = {
    verdict: "FAIL" as const,
    axes: fiveAxes().map((a) =>
      a.axis === "readability" ? { ...a, findings: [{ severity: "suggestion" as const, detail: "nit" }] } : a,
    ),
  }
  const issue = blockingFindingsIssue(record, AXES)
  assert.ok(issue)
  assert.match(issue, /critical.*important/s)
})

test("blockingFindingsIssue: a FAIL naming one Important finding is accepted", () => {
  const record = {
    verdict: "FAIL" as const,
    axes: fiveAxes().map((a) =>
      a.axis === "security" ? { ...a, findings: [{ severity: "important" as const, detail: "token logged" }] } : a,
    ),
  }
  assert.equal(blockingFindingsIssue(record, AXES), null)
})

test("blockingFindingsIssue: a clean PASS and an ERROR are both accepted", () => {
  assert.equal(blockingFindingsIssue({ verdict: "PASS", axes: fiveAxes() }, AXES), null)
  assert.equal(blockingFindingsIssue({ verdict: "ERROR", axes: fiveAxes() }, AXES), null)
})

test("blockingFindingsIssue: unenforced where no axes are required (a bare VERIFY FAIL stays legal)", () => {
  assert.equal(blockingFindingsIssue({ verdict: "FAIL", reason: "tests red" }, undefined), null)
})

// --- admitVerdict (the single seam both hosts record through) ---

test("admitVerdict rejects an incomplete payload and yields NO record to store", () => {
  const res = admitVerdict({ verdict: "PASS", axes: [{ axis: "correctness", verdict: "PASS" }] }, AXES, null)
  assert.equal(res.ok, false)
  // The point of the return type: a rejected call cannot hand a host anything
  // to store or stamp. `record` is not reachable on this branch.
  assert.ok(!("record" in res))
  assert.match(res.ok === false ? res.message : "", /Missing:/)
})

test("admitVerdict rejects a FAIL that names nothing to fix", () => {
  const res = admitVerdict({ verdict: "FAIL", reason: "vibes", axes: fiveAxes() }, AXES, null)
  assert.equal(res.ok, false)
})

test("admitVerdict accepts a complete payload and returns it unchanged when nothing is pending", () => {
  const rec = { verdict: "PASS" as const, axes: fiveAxes() }
  const res = admitVerdict(rec, AXES, null)
  assert.equal(res.ok, true)
  assert.deepEqual(res.ok === true ? res.record : null, rec)
})

test("admitVerdict combines repeat calls worst-wins — a FAIL cannot be replaced by a later PASS", () => {
  const failing = {
    verdict: "FAIL" as const,
    reason: "sql hole",
    axes: fiveAxes({ security: { verdict: "FAIL" } }).map((a) =>
      a.axis === "security" ? { ...a, findings: [{ severity: "critical" as const, detail: "sql hole" }] } : a,
    ),
  }
  const res = admitVerdict({ verdict: "PASS", axes: fiveAxes() }, AXES, failing)
  assert.equal(res.ok, true)
  const record = res.ok === true ? res.record : null
  assert.equal(record?.verdict, "FAIL")
  assert.equal(record?.axes?.find((a) => a.axis === "security")?.verdict, "FAIL")
})

test("admitVerdict enforces nothing where no axes are required (VERIFY keeps today's contract)", () => {
  assert.equal(admitVerdict({ verdict: "FAIL", reason: "tests red" }, undefined, null).ok, true)
  assert.equal(admitVerdict({ verdict: "PASS" }, undefined, null).ok, true)
})

// --- mergeAxes (repeat calls in one stage, and multi-lens review) ---

test("mergeAxes: per-axis worst-wins across lenses", () => {
  const merged = mergeAxes([{ axis: "security", verdict: "PASS" }], [{ axis: "security", verdict: "FAIL" }])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]?.verdict, "FAIL")
  assert.equal(mergeAxes([{ axis: "a", verdict: "FAIL" }], [{ axis: "a", verdict: "ERROR" }])[0]?.verdict, "ERROR")
})

test("mergeAxes: findings from a PASSing lens survive alongside a failing one", () => {
  const merged = mergeAxes(
    [{ axis: "security", verdict: "PASS", findings: [{ severity: "suggestion", detail: "context from lens A" }] }],
    [{ axis: "security", verdict: "FAIL", findings: [{ severity: "critical", detail: "hole from lens B" }] }],
  )
  assert.equal(merged[0]?.findings?.length, 2)
})

test("mergeAxes: identical findings are de-duped", () => {
  const finding = { severity: "critical" as const, detail: "same", location: "a.ts:1" }
  const merged = mergeAxes([{ axis: "x", verdict: "FAIL", findings: [finding] }], [{ axis: "x", verdict: "FAIL", findings: [finding] }])
  assert.equal(merged[0]?.findings?.length, 1)
})

test("mergeAxes: an axis present on only one side survives", () => {
  const merged = mergeAxes([{ axis: "a", verdict: "PASS" }], [{ axis: "b", verdict: "FAIL" }])
  assert.deepEqual(merged.map((m) => m.axis).sort(), ["a", "b"])
})

test("mergeAxes: undefined sides are treated as empty", () => {
  assert.deepEqual(mergeAxes(undefined, undefined), [])
  assert.equal(mergeAxes(undefined, [{ axis: "a", verdict: "PASS" }]).length, 1)
})
