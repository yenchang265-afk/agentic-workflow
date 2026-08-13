import assert from "node:assert/strict"
import { test } from "node:test"
import {
  admitVerdict,
  allAxesUnassessedReason,
  axisCoverageIssue,
  axisUnassessed,
  criteriaIssue,
  failFeedbackIssue,
  noAdmissibleVerdictReason,
  rejectedFallback,
  evidenceIssue,
  axisVerdict,
  blockingFindingsIssue,
  effectiveVerdict,
  WORKFLOW_REVIEW_TAG,
  WORKFLOW_VERIFY_TAG,
  mergeAxes,
  mergeRejected,
  parseVerdict,
  passFocusBlock,
  planContractBlock,
  planVisualizationBlock,
  stageDriftAdvice,
  stageDriftNote,
  stageDriftRefusal,
  uncoveredAxes,
  verdictContractBlock,
  verdictFeedbackBlock,
  withCoverageGap,
  withUnassessedGuard,
  workScopeBlock,
  worstOf,
  type VerdictRecord,
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

test("verdictContractBlock is byte-identical whether fanout is omitted or explicitly off", () => {
  // Every stage that does NOT fan out renders this; a drift here would rewrite
  // every existing loop's prompt.
  assert.equal(verdictContractBlock("review", AXES, "single"), verdictContractBlock("review", AXES))
  assert.equal(verdictContractBlock("verify", undefined, "single"), verdictContractBlock("verify"))
  // With no axes there is nothing to fan out over, so the flag changes nothing.
  assert.equal(verdictContractBlock("verify", undefined, "axis"), verdictContractBlock("verify"))
})

test("the lens contract asks for the axes the lens bears on — never all of them, never a false rejection", () => {
  const block = verdictContractBlock("review", AXES, "lens")
  // The bug: lens passes rendered the SINGLE-pass contract, so every lens was
  // told "MUST carry an `axes` array covering all 5 axes … a call missing an
  // axis is REJECTED" directly above "focus exclusively on <lens>". The threat
  // was empty — `passAxes` returns undefined for a lens, so nothing rejected —
  // and obeying it meant inventing four axis verdicts, which merge worst-wins
  // into the STAGE's verdict for axes nobody reviewed.
  assert.doesNotMatch(block, /covering all 5 axes/)
  assert.doesNotMatch(block, /A call missing an axis is REJECTED/)
  assert.doesNotMatch(block, /exactly ONE/, "a lens is not an axis pass either")
  // What it says instead: your lens's axes, from the stage's vocabulary, and
  // leave out what you did not review.
  assert.match(block, /REVIEW LENS line/)
  assert.match(block, /axes your lens actually bears on/)
  assert.match(block, /must be left out rather than recorded as a clean PASS/)
  for (const axis of AXES) assert.match(block, new RegExp(axis))
})

test("the three contract modes are mutually distinct for an axis-bearing stage", () => {
  const single = verdictContractBlock("review", AXES, "single")
  const axis = verdictContractBlock("review", AXES, "axis")
  const lens = verdictContractBlock("review", AXES, "lens")
  assert.notEqual(single, axis)
  assert.notEqual(single, lens)
  assert.notEqual(axis, lens)
  // With no axes there is nothing to differ over, so every mode collapses to one
  // string — that is what every axis-less check stage across every kind renders.
  assert.equal(verdictContractBlock("verify", undefined, "lens"), verdictContractBlock("verify"))
})

test("the fan-out contract asks for ONE axis, not all of them", () => {
  const block = verdictContractBlock("review", AXES, "axis")
  for (const axis of AXES) assert.match(block, new RegExp(axis))
  assert.match(block, /exactly ONE/)
  assert.match(block, /REVIEW AXIS line/)
  assert.match(block, /that ONE axis and no others/)
  assert.match(block, /worst-wins/)
  // The contradiction this variant exists to prevent: the pass is told by its
  // suffix to report one axis, so the contract must not also demand all five.
  assert.doesNotMatch(block, /covering all 5 axes/)
  assert.doesNotMatch(block, /complete array/)
})

// --- passFocusBlock (what a single focused pass is told it covers) ---

test("passFocusBlock: a lens pass names its lens on a REVIEW LENS line the contract can point at", () => {
  // Pinned as a literal, because this string is every reviewLenses user's prompt.
  // It led with "Review lens 2/3:" while the lens contract told the pass to look
  // for "the REVIEW LENS line" — the axis branch has always named its own line
  // that way, and a contract pointing at a line that does not exist is how a
  // focused pass ends up guessing what it owns.
  assert.equal(
    passFocusBlock({ focus: "a hostile attacker", mode: "lens" }, 1, 3),
    "REVIEW LENS 2/3: a hostile attacker. Focus exclusively on a hostile attacker. The other lenses " +
      "run as separate passes — don't repeat them. Record this pass's verdict via workflow_verdict as usual, " +
      "carrying per-axis results only for the axes your lens actually bears on.",
  )
})

test("passFocusBlock: an axis pass is told to report its axis and nothing else", () => {
  const block = passFocusBlock({ focus: "security", mode: "axis" }, 3, 5)
  assert.match(block, /REVIEW AXIS 4\/5: security\./)
  assert.match(block, /security ONLY/)
  assert.match(block, /The other 4 axes run as separate/)
  assert.match(block, /axes: \[\{ axis: "security", verdict, findings \}\]/)
  assert.match(block, /exactly that one entry/)
})

test("passFocusBlock: the single unfocused pass gets nothing appended", () => {
  assert.equal(passFocusBlock({ focus: null, mode: "single" }, 0, 1), "")
})

// --- uncoveredAxes / withCoverageGap (the stage-level completeness gate) ---

test("uncoveredAxes: names the axes an accumulated record never reported", () => {
  const record = { verdict: "PASS" as const, axes: [{ axis: "correctness", verdict: "PASS" as const }] }
  assert.deepEqual(uncoveredAxes(record, AXES), ["readability", "architecture", "security", "performance"])
  assert.deepEqual(uncoveredAxes({ verdict: "PASS", axes: fiveAxes() }, AXES), [])
  assert.deepEqual(uncoveredAxes(null, AXES), AXES)
})

test("uncoveredAxes: no requirement means no gap, and matching tolerates case and whitespace", () => {
  assert.deepEqual(uncoveredAxes({ verdict: "PASS" }, undefined), [])
  assert.deepEqual(uncoveredAxes({ verdict: "PASS" }, []), [])
  const axes = AXES.map((a) => ({ axis: ` ${a.toUpperCase()} `, verdict: "PASS" as const }))
  assert.deepEqual(uncoveredAxes({ verdict: "PASS", axes }, AXES), [])
})

test("withCoverageGap: an uncovered axis is ERROR, never FAIL — a rebuild on a review that never ran wastes an iteration", () => {
  const record = {
    verdict: "PASS" as const,
    reason: "looks fine",
    axes: [{ axis: "correctness", verdict: "PASS" as const, findings: [{ severity: "suggestion" as const, detail: "nit" }] }],
  }
  const gapped = withCoverageGap(record, ["security", "performance"])
  assert.equal(gapped.verdict, "ERROR")
  assert.match(gapped.reason ?? "", /looks fine · axes security, performance recorded no per-axis result/)
  // The axes that DID report keep their findings — the run log and the next
  // prompt must not lose the work that actually happened.
  assert.deepEqual(gapped.axes, record.axes)
})

test("withCoverageGap: complete coverage returns the record untouched", () => {
  const record = { verdict: "FAIL" as const, reason: "bug", axes: fiveAxes() }
  assert.equal(withCoverageGap(record, []), record)
})

test("a focused pass is admitted against its own axis alone — the whole point of per-axis fan-out", () => {
  const incoming = { verdict: "PASS" as const, axes: [{ axis: "security", verdict: "PASS" as const }] }
  // Under the stage's full requirement this same call is rejected...
  assert.ok(axisCoverageIssue(incoming, AXES))
  // ...and narrowed to the pass's own axis it is accepted.
  assert.equal(axisCoverageIssue(incoming, ["security"]), null)
  const admission = admitVerdict(incoming, ["security"], null)
  assert.ok(admission.ok)
})

test("a focused pass that reports the wrong axis is rejected, and the message names only its own", () => {
  const incoming = { verdict: "PASS" as const, axes: [{ axis: "correctness", verdict: "PASS" as const }] }
  const issue = axisCoverageIssue(incoming, ["security"])
  assert.ok(issue)
  assert.equal(issue.match(/Missing: ([^.]+)\./)?.[1], "security")
  // Plural boilerplate would read as a bug and invite the pass to send all five.
  assert.doesNotMatch(issue, /all 1 axes/)
  assert.doesNotMatch(issue, /must carry all 1/)
  assert.match(issue, /the axis "security"/)
})

test("a fan-out FAIL still has to name a blocking finding", () => {
  const record = { verdict: "FAIL" as const, axes: [{ axis: "security", verdict: "FAIL" as const }] }
  assert.ok(blockingFindingsIssue(record, ["security"]))
  const named = {
    verdict: "FAIL" as const,
    axes: [
      { axis: "security", verdict: "FAIL" as const, findings: [{ severity: "critical" as const, detail: "no authz", location: "a.ts:4" }] },
    ],
  }
  assert.equal(blockingFindingsIssue(named, ["security"]), null)
})

test("consecutive focused passes accumulate into one complete record", () => {
  let pending: VerdictRecord | null = null
  for (const axis of AXES) {
    const admission = admitVerdict({ verdict: "PASS", axes: [{ axis, verdict: "PASS" }] }, [axis], pending)
    assert.ok(admission.ok)
    pending = admission.record
  }
  assert.deepEqual(uncoveredAxes(pending, AXES), [])
  assert.equal(effectiveVerdict(pending!), "PASS")
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

// --- planVisualizationBlock (the opt-in diagram instruction for planContract stages) ---

test("planVisualizationBlock names the stage, the mermaid fence, and every shape criterion", () => {
  const block = planVisualizationBlock("plan")
  assert.match(block, /PLAN VISUALIZATION/)
  assert.match(block, /plan/)
  assert.match(block, /```mermaid/)
  assert.match(block, /## Implementation Plan/)
  for (const shape of [/state or lifecycle/i, /two or more packages/i, /concurrency/i, /data-shape/i]) {
    assert.match(block, shape)
  }
})

test("planVisualizationBlock is agent-judged: no gate, steps beat the diagram, small plans skip it", () => {
  const block = planVisualizationBlock("plan")
  assert.match(block, /No gate enforces/i)
  assert.match(block, /steps are authoritative/i)
  assert.match(block, /skip the diagram/i)
  // SHOULD, never MUST — a hard demand here would contradict "your judgment"
  // and invite the livelock the planContract enforcement note warns about.
  assert.doesNotMatch(block, /MUST/)
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

// --- stageDriftAdvice (the same drift, addressed to the orchestrator) ---

test("stageDriftAdvice names both stages, the ignored verdict, and the skipped calls", () => {
  // The reported failure: a REVIEW subagent runs while the machine is at VERIFY,
  // and the only trace was a note in a file the driving model never reads. The
  // advice has to say what was lost AND what to do, or the orchestrator reads a
  // re-fired VERIFY as "the review has not happened yet" and reports the
  // discarded findings as if the loop had taken them.
  const advice = stageDriftAdvice("verify", "review", "FAIL")
  assert.match(advice, /VERIFY/)
  assert.match(advice, /REVIEW/)
  assert.match(advice, /FAIL/)
  assert.match(advice, /IGNORED/)
  assert.match(advice, /workflow_advance|workflow_stage/)
  assert.match(advice, /re-run/i)
})

test("stageDriftAdvice covers the other cause too — a stage running a later stage's work", () => {
  assert.match(stageDriftAdvice("build", "verify", "PASS"), /inside its own turn/i)
})

test("stageDriftAdvice works without a verdict value", () => {
  const advice = stageDriftAdvice("verify", "review", null)
  assert.match(advice, /REVIEW/)
  assert.doesNotMatch(advice, /\(\)/) // no empty parenthetical where the verdict would be
})

// --- stageDriftRefusal (the same drift, addressed to the refused caller) ---

test("stageDriftRefusal keeps the fact, then says what to do instead of retrying", () => {
  // The reported failure: a REVIEW subagent's verdict refused while the machine
  // sat at VERIFY, and a refusal the caller cannot act on is one it retries
  // until the stage's budget is gone.
  const refusal = stageDriftRefusal("verify", "review", { orchestrated: true })
  assert.match(refusal, /The loop is at verify, not review — verdict ignored/)
  assert.match(refusal, /do not retry/i)
  assert.match(refusal, /workflow_advance|workflow_stage/)
  assert.match(refusal, /stage drift/i)
})

test("stageDriftRefusal forbids re-filing under the stage the loop IS at", () => {
  // The nag that closes a subagent names the marker's stage, so the tempting
  // "fix" is to re-file as VERIFY — which fabricates a verdict nothing earned.
  const refusal = stageDriftRefusal("verify", "review", { orchestrated: false })
  assert.match(refusal, /do not re-file it as a verify verdict/i)
  assert.match(refusal, /nothing earned/i)
})

test("stageDriftRefusal's driver flavour names no tool the driver host lacks", () => {
  const refusal = stageDriftRefusal("verify", "review", { orchestrated: false })
  assert.match(refusal, /the driver runs review again/i)
  // OpenCode has no workflow_advance/workflow_stage — advice the caller cannot
  // execute is worse than none.
  assert.doesNotMatch(refusal, /workflow_advance|workflow_stage/)
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
  // A finding-less ERROR axis is unassessed, not failing — reported in its own
  // non-blocking section so the fact still reaches the next iteration.
  assert.doesNotMatch(block, /- performance \(ERROR\)/)
  assert.match(block, /Unassessed review axes .*non-blocking.*:/)
  assert.match(block, /- performance$/m)
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

test("effectiveVerdict: a minority unassessed axis is non-blocking", () => {
  // The contract invites "ERROR on an axis you genuinely could not assess"
  // (no hot path → performance unassessable). Letting that one axis make the
  // STAGE ERROR routed an honest review to onError — a stop blaming the
  // environment and a stranded task. The skip is scoped: only a finding-less
  // ERROR axis is neutral.
  assert.equal(effectiveVerdict({ verdict: "PASS", axes: fiveAxes({ performance: { verdict: "ERROR" } }) }), "PASS")
  assert.equal(effectiveVerdict({ verdict: "FAIL", axes: fiveAxes({ performance: { verdict: "ERROR" } }) }), "FAIL")
})

test("effectiveVerdict: an ERROR axis WITH a blocking finding still makes the stage ERROR", () => {
  // The checks axis relies on this: a broken runner records ERROR with critical
  // findings, and ERROR outranking FAIL is what routes it to onError.
  const axes = [
    ...fiveAxes(),
    { axis: "checks", verdict: "ERROR" as const, findings: [{ severity: "critical" as const, detail: "npm test exited 127" }] },
  ]
  assert.equal(effectiveVerdict({ verdict: "PASS", axes }), "ERROR")
})

test("axisUnassessed: a finding-less ERROR is unassessed; anything else is not", () => {
  assert.equal(axisUnassessed({ axis: "performance", verdict: "ERROR" }), true)
  assert.equal(axisUnassessed({ axis: "performance", verdict: "ERROR", findings: [] }), true)
  assert.equal(axisUnassessed({ axis: "performance", verdict: "ERROR", findings: [{ severity: "suggestion", detail: "x" }] }), true)
  assert.equal(axisUnassessed({ axis: "performance", verdict: "ERROR", findings: [{ severity: "critical", detail: "x" }] }), false)
  assert.equal(axisUnassessed({ axis: "performance", verdict: "PASS" }), false)
  assert.equal(axisUnassessed({ axis: "performance", verdict: "FAIL" }), false)
})

test("withUnassessedGuard: a declared PASS whose every axis is unassessed is refused as ERROR", () => {
  const record: VerdictRecord = { verdict: "PASS", axes: AXES.map((axis) => ({ axis, verdict: "ERROR" as const })) }
  const guarded = withUnassessedGuard(record)
  assert.equal(guarded?.verdict, "ERROR")
  assert.ok(guarded?.reason?.includes(allAxesUnassessedReason()))
})

test("withUnassessedGuard: identity on FAIL/ERROR, a mixed record, no axes, and null", () => {
  const fail: VerdictRecord = { verdict: "FAIL", axes: AXES.map((axis) => ({ axis, verdict: "ERROR" as const })) }
  assert.equal(withUnassessedGuard(fail), fail, "a declared FAIL stays FAIL — rejectedFallback's rule")
  const mixed: VerdictRecord = { verdict: "PASS", axes: fiveAxes({ performance: { verdict: "ERROR" } }) }
  assert.equal(withUnassessedGuard(mixed), mixed, "one assessed axis is enough")
  const bare: VerdictRecord = { verdict: "PASS" }
  assert.equal(withUnassessedGuard(bare), bare, "no axes ⇒ nothing to judge (VERIFY, sitters)")
  assert.equal(withUnassessedGuard(null), null)
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

test("blockingFindingsIssue: a FAIL whose every axis is a finding-less ERROR is rejected, not admitted", () => {
  // Used to slide through admission as effective-ERROR; unassessed axes are now
  // skipped, so the record is effective-FAIL with nothing named to fix.
  const record: VerdictRecord = { verdict: "FAIL", axes: AXES.map((axis) => ({ axis, verdict: "ERROR" as const })) }
  assert.ok(blockingFindingsIssue(record, AXES))
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


// --- proof of work: a PASS must be backed by work the host saw ---

const NPM_TEST = { kind: "command" as const, ref: "npm test", result: "42 passed" }
const ctx = (over: Partial<Parameters<typeof evidenceIssue>[1] & object> = {}) => ({
  stage: "verify",
  required: true,
  observed: { commands: ["cd /wt && npm test"], reads: [] },
  ...over,
})

test("evidenceIssue is inert on a stage that does not require evidence", () => {
  // Every kind that has not opted in must behave exactly as before.
  assert.equal(evidenceIssue({ verdict: "PASS" }, undefined), null)
  assert.equal(evidenceIssue({ verdict: "PASS" }, ctx({ required: false })), null)
})

test("evidenceIssue gates PASS only — a FAIL or ERROR owes no evidence", () => {
  // A stage reporting a broken test runner has nothing it could truthfully cite;
  // demanding evidence there would trap it in a rejection loop.
  assert.equal(evidenceIssue({ verdict: "FAIL", reason: "tests red" }, ctx()), null)
  assert.equal(evidenceIssue({ verdict: "ERROR", reason: "no runner" }, ctx()), null)
})

test("evidenceIssue gates the EFFECTIVE verdict, so a PASS worsened by an axis is not gated", () => {
  const record = {
    verdict: "PASS" as const,
    axes: [{ axis: "security", verdict: "PASS" as const, findings: [{ severity: "critical" as const, detail: "hole" }] }],
  }
  assert.equal(effectiveVerdict(record), "FAIL")
  assert.equal(evidenceIssue(record, ctx()), null)
})

test("a PASS citing nothing is rejected, and the message says what to send", () => {
  const issue = evidenceIssue({ verdict: "PASS" }, ctx())
  assert.match(issue ?? "", /must cite what you actually observed/)
  assert.match(issue ?? "", /evidence/)
})

test("a PASS from a pass that ran nothing is rejected however well it cites", () => {
  const issue = evidenceIssue({ verdict: "PASS", evidence: [NPM_TEST] }, ctx({ observed: { commands: [], reads: [] } }))
  assert.match(issue ?? "", /ran no commands and read no files/)
})

test("a PASS whose every citation is uncorroborated is rejected and the citations are named", () => {
  const issue = evidenceIssue({ verdict: "PASS", evidence: [NPM_TEST] }, ctx({ observed: { commands: ["git status"], reads: [] } }))
  assert.match(issue ?? "", /none of the evidence cited/)
  assert.match(issue ?? "", /npm test/)
})

test("a PASS corroborated by what the host saw is admitted", () => {
  assert.equal(evidenceIssue({ verdict: "PASS", evidence: [NPM_TEST] }, ctx()), null)
})

test("a host that does not observe still enforces the declared rule, and no more", () => {
  // `observed: null` means "this host records nothing" — the gate weakens to
  // rule A rather than failing every stage on a repo whose hooks are absent.
  assert.match(evidenceIssue({ verdict: "PASS" }, ctx({ observed: null })) ?? "", /must cite/)
  assert.equal(evidenceIssue({ verdict: "PASS", evidence: [{ kind: "command", ref: "anything" }] }, ctx({ observed: null })), null)
})

test("admitVerdict refuses an unearned PASS and returns no record to store", () => {
  const admission = admitVerdict({ verdict: "PASS" }, undefined, null, ctx())
  assert.equal(admission.ok, false)
})

test("admitVerdict gates the INCOMING call, so a second evidence-free PASS cannot ride on the first's citations", () => {
  const first = admitVerdict({ verdict: "PASS", evidence: [NPM_TEST] }, undefined, null, ctx())
  assert.ok(first.ok)
  const second = admitVerdict({ verdict: "PASS" }, undefined, first.ok ? first.record : null, ctx())
  assert.equal(second.ok, false)
})

test("admitVerdict accumulates evidence across repeat calls, de-duped", () => {
  const first = admitVerdict({ verdict: "PASS", evidence: [NPM_TEST] }, undefined, null, ctx())
  assert.ok(first.ok)
  const second = admitVerdict(
    { verdict: "PASS", evidence: [NPM_TEST, { kind: "file", ref: "src/limit.ts:88" }] },
    undefined,
    first.ok ? first.record : null,
    ctx({ observed: { commands: ["cd /wt && npm test"], reads: ["/wt/src/limit.ts"] } }),
  )
  assert.ok(second.ok)
  assert.deepEqual(second.ok ? (second.record.evidence ?? []).map((i) => i.ref) : [], ["npm test", "src/limit.ts:88"])
})

test("admitVerdict without an evidence context behaves exactly as before", () => {
  assert.ok(admitVerdict({ verdict: "PASS" }, undefined, null).ok)
})

test("the contract paragraph carries the proof-of-work half only when the stage requires it", () => {
  assert.doesNotMatch(verdictContractBlock("verify"), /PROOF OF WORK/)
  assert.match(verdictContractBlock("verify", undefined, "single", true), /PROOF OF WORK/)
  // Byte-identical to the axis-less, evidence-less form is what every other
  // check stage across every kind renders.
  assert.equal(verdictContractBlock("verify"), verdictContractBlock("verify", undefined, "single", false))
})

// --- a FAIL must name what has to change (every check stage) ---

test("failFeedbackIssue rejects an effective FAIL that names nothing", () => {
  const issue = failFeedbackIssue({ verdict: "FAIL" })
  assert.match(issue ?? "", /must name what has to change/)
  assert.match(issue ?? "", /reason/)
})

test("failFeedbackIssue is satisfied by a reason, a failed criterion, or a blocking finding — any one", () => {
  assert.equal(failFeedbackIssue({ verdict: "FAIL", reason: "tests red" }), null)
  assert.equal(failFeedbackIssue({ verdict: "FAIL", criteria: [{ criterion: "returns 429", pass: false }] }), null)
  assert.equal(
    failFeedbackIssue({
      verdict: "FAIL",
      axes: [{ axis: "checks", verdict: "FAIL", findings: [{ severity: "critical", detail: "npm test exited 1" }] }],
    }),
    null,
  )
})

test("failFeedbackIssue is not satisfied by whitespace, met criteria, or suggestion findings", () => {
  assert.notEqual(failFeedbackIssue({ verdict: "FAIL", reason: "  " }), null)
  assert.notEqual(failFeedbackIssue({ verdict: "FAIL", criteria: [{ criterion: "returns 429", pass: true }] }), null)
  assert.notEqual(
    failFeedbackIssue({
      verdict: "FAIL",
      axes: [{ axis: "checks", verdict: "FAIL", findings: [{ severity: "suggestion", detail: "rename it" }] }],
    }),
    null,
  )
})

test("failFeedbackIssue gates the EFFECTIVE FAIL: a declared PASS worsened by a blocking finding already names it", () => {
  // The worsening finding IS the feedback, so the record passes.
  const record: VerdictRecord = {
    verdict: "PASS",
    axes: [{ axis: "security", verdict: "PASS", findings: [{ severity: "critical", detail: "hole" }] }],
  }
  assert.equal(effectiveVerdict(record), "FAIL")
  assert.equal(failFeedbackIssue(record), null)
})

test("failFeedbackIssue leaves PASS and ERROR alone", () => {
  assert.equal(failFeedbackIssue({ verdict: "PASS" }), null)
  assert.equal(failFeedbackIssue({ verdict: "ERROR" }), null)
})

test("admitVerdict refuses a bare FAIL, and on an axes stage the axis message wins", () => {
  const bare = admitVerdict({ verdict: "FAIL" }, undefined, null)
  assert.equal(bare.ok, false)
  assert.match(bare.ok ? "" : bare.message, /must name what has to change/)
  // Axes stage: a finding-less FAIL still draws blockingFindingsIssue's more
  // specific message, not failFeedbackIssue's.
  const axes = admitVerdict({ verdict: "FAIL", reason: "bad", axes: fiveAxes() }, AXES, null)
  assert.equal(axes.ok, false)
  assert.match(axes.ok ? "" : axes.message, /severity "critical" or "important"/)
})

// --- a PASS must account for the acceptance criteria (axis-less check stages) ---

const criteriaCtx = (acceptance: string[] = ["returns 429 over limit", "configurable per route"]) => ({
  stage: "verify",
  acceptance,
})

test("criteriaIssue is inert with no context, empty acceptance, or a non-PASS verdict", () => {
  assert.equal(criteriaIssue({ verdict: "PASS" }, undefined), null)
  assert.equal(criteriaIssue({ verdict: "PASS" }, criteriaCtx([])), null)
  assert.equal(criteriaIssue({ verdict: "FAIL", reason: "r" }, criteriaCtx()), null)
  assert.equal(criteriaIssue({ verdict: "ERROR", reason: "r" }, criteriaCtx()), null)
})

test("criteriaIssue rejects a PASS with missing or incomplete criteria, naming the bullets", () => {
  const missing = criteriaIssue({ verdict: "PASS" }, criteriaCtx())
  assert.match(missing ?? "", /given 2 acceptance criteria/)
  assert.match(missing ?? "", /returns 429 over limit/)
  assert.match(missing ?? "", /\{ criterion, pass \}/)
  const partial = criteriaIssue({ verdict: "PASS", criteria: [{ criterion: "returns 429 over limit", pass: true }] }, criteriaCtx())
  assert.match(partial ?? "", /carried 1 criteria entry/)
})

test("criteriaIssue admits a PASS covering every bullet, and ignores blank entries", () => {
  const record: VerdictRecord = {
    verdict: "PASS",
    criteria: [
      { criterion: "returns 429 over limit", pass: true },
      { criterion: "configurable per route", pass: true },
    ],
  }
  assert.equal(criteriaIssue(record, criteriaCtx()), null)
  // Blank entries do not count toward coverage.
  const blank: VerdictRecord = { verdict: "PASS", criteria: [{ criterion: "  ", pass: true }, { criterion: "x", pass: true }] }
  assert.notEqual(criteriaIssue(blank, criteriaCtx()), null)
})

test("criteriaIssue rejects the contradiction: a PASS marking a criterion not met", () => {
  const record: VerdictRecord = {
    verdict: "PASS",
    criteria: [
      { criterion: "returns 429 over limit", pass: true },
      { criterion: "configurable per route", pass: false },
    ],
  }
  const issue = criteriaIssue(record, criteriaCtx())
  assert.match(issue ?? "", /not met/)
  assert.match(issue ?? "", /verdict FAIL/)
  assert.match(issue ?? "", /configurable per route/)
})

test("criteriaIssue clamps a long bullet list in the rejection message", () => {
  const many = Array.from({ length: 12 }, (_, i) => `criterion ${i + 1}`)
  const issue = criteriaIssue({ verdict: "PASS" }, criteriaCtx(many))
  assert.match(issue ?? "", /criterion 8/)
  assert.doesNotMatch(issue ?? "", /"criterion 9"/)
  assert.match(issue ?? "", /and 4 more/)
})

test("admitVerdict joins the criteria and evidence rejections into ONE message", () => {
  // One retry must be able to fix both faults; serial rejections would burn it.
  const admission = admitVerdict({ verdict: "PASS" }, undefined, null, ctx(), criteriaCtx())
  assert.equal(admission.ok, false)
  const message = admission.ok ? "" : admission.message
  assert.match(message, /acceptance criteria/)
  assert.match(message, /ALSO:/)
  assert.match(message, /must cite what you actually observed/)
})

test("admitVerdict with a criteria context admits a complete, met PASS", () => {
  const admission = admitVerdict(
    {
      verdict: "PASS",
      criteria: [
        { criterion: "returns 429 over limit", pass: true },
        { criterion: "configurable per route", pass: true },
      ],
      evidence: [NPM_TEST],
    },
    undefined,
    null,
    ctx(),
    criteriaCtx(),
  )
  assert.ok(admission.ok)
})

test("the contract paragraph carries the acceptance-criteria half only when given a count", () => {
  assert.doesNotMatch(verdictContractBlock("verify"), /ACCEPTANCE CRITERIA/)
  assert.match(verdictContractBlock("verify", undefined, "single", true, 2), /given 2 acceptance criteria/)
  assert.match(verdictContractBlock("verify", undefined, "single", true, 1), /given 1 acceptance criterion/)
  // Omitted or zero ⇒ byte-identical to today's rendering.
  assert.equal(verdictContractBlock("verify", undefined, "single", true), verdictContractBlock("verify", undefined, "single", true, 0))
})

// --- seeded check commands: activity, but never a PASS's only corroboration ---

test("a PASS citing only the seeded check command is rejected, with the pass's own work sampled", () => {
  const issue = evidenceIssue(
    { verdict: "PASS", evidence: [NPM_TEST] },
    ctx({ observed: { commands: [], reads: ["/wt/src/limit.ts"] }, seeded: ["cd /wt && npm test"] }),
  )
  assert.match(issue ?? "", /the loop itself ran for you/)
  assert.match(issue ?? "", /src\/limit\.ts/)
})

test("a seeded set defeats the ran-nothing rejection but not the seeded-only one", () => {
  // Empty observed + seeded: not "did nothing" (the driver ran real checks),
  // but a PASS citing only those checks is still rejected.
  const issue = evidenceIssue(
    { verdict: "PASS", evidence: [NPM_TEST] },
    ctx({ observed: { commands: [], reads: [] }, seeded: ["cd /wt && npm test"] }),
  )
  assert.doesNotMatch(issue ?? "", /ran no commands and read no files, so a PASS is unsupported/)
  assert.match(issue ?? "", /the loop itself ran for you/)
  assert.match(issue ?? "", /no commands and read no files of its own/)
})

test("a PASS citing the seeded command plus its own observed work is admitted", () => {
  assert.equal(
    evidenceIssue(
      { verdict: "PASS", evidence: [NPM_TEST, { kind: "file", ref: "src/limit.ts:88" }] },
      ctx({ observed: { commands: [], reads: ["/wt/src/limit.ts"] }, seeded: ["cd /wt && npm test"] }),
    ),
    null,
  )
})

test("a citation matching neither observed nor seeded still draws the unobserved message", () => {
  const issue = evidenceIssue(
    { verdict: "PASS", evidence: [{ kind: "command", ref: "cargo test" }] },
    ctx({ observed: { commands: ["git status"], reads: [] }, seeded: ["cd /wt && npm test"] }),
  )
  assert.match(issue ?? "", /none of the evidence cited/)
})

test("a null observation set ignores the seed entirely — the declared-only rule stands", () => {
  // A hook-less host must not flip into strict matching because checks ran.
  assert.equal(
    evidenceIssue({ verdict: "PASS", evidence: [{ kind: "command", ref: "anything" }] }, ctx({ observed: null, seeded: ["npm test"] })),
    null,
  )
})

// --- a twice-rejected verdict: the loop acts on what the stage declared ---
//
// The regression these close: a review that FAILED had its call refused (bad
// shape), the host re-fired the same review, the second refusal became ERROR,
// and `review.onError` stopped the run — so a failing review never reached the
// BUILD its findings were for.

test("rejectedFallback records a twice-rejected FAIL as the stage's FAIL, with the rejection in the reason", () => {
  const rejected = {
    record: { verdict: "FAIL" as const, reason: "auth bypass", axes: fiveAxes() },
    message: "Verdict NOT recorded — a FAIL must name what has to change.",
  }
  const salvaged = rejectedFallback(rejected)
  assert.equal(effectiveVerdict(salvaged!), "FAIL", "the stage fails, so onFail re-fires BUILD")
  assert.match(salvaged!.reason!, /auth bypass/, "the stage's own reason survives")
  assert.match(salvaged!.reason!, /rejected twice/, "...and says the verdict arrived malformed")
  assert.match(salvaged!.reason!, /must name what has to change/, "...quoting the refusal itself")
  // The feedback block is what the next BUILD reads — it must not be empty, which
  // is the whole reason a bare FAIL is refused in the first place.
  assert.match(verdictFeedbackBlock(salvaged), /auth bypass/)
})

test("rejectedFallback never launders an unearned PASS", () => {
  const salvaged = rejectedFallback({
    record: { verdict: "PASS", axes: fiveAxes() },
    message: "Verdict NOT recorded — a PASS must cite evidence.",
  })
  assert.equal(salvaged, null, "an effective PASS keeps the caller's ERROR stop")
})

test("rejectedFallback salvages on the DERIVED verdict, not the declared one", () => {
  // Declared PASS, but an axis carries a Critical finding: the stage said
  // something blocking, so it is salvaged as the FAIL it effectively is.
  const salvaged = rejectedFallback({
    record: {
      verdict: "PASS",
      axes: fiveAxes().map((a) => (a.axis === "security" ? { ...a, findings: [{ severity: "critical" as const, detail: "secret logged" }] } : a)),
    },
    message: "Verdict NOT recorded — incomplete coverage.",
  })
  assert.equal(effectiveVerdict(salvaged!), "FAIL")
})

test("rejectedFallback keeps a declared ERROR an ERROR", () => {
  const salvaged = rejectedFallback({ record: { verdict: "ERROR", reason: "no test runner" }, message: "Verdict NOT recorded — bad shape." })
  assert.equal(effectiveVerdict(salvaged!), "ERROR", "an unrunnable check still stops the loop")
})

test("mergeRejected keeps a rejected FAIL from vanishing behind a later rejected PASS", () => {
  // The two-rejection sequence that used to ERROR-stop a run: attempt 0 FAILs
  // with axes but no blocking finding (refused), attempt 1 "corrects" to an
  // uncorroborated PASS (refused). Last-rejection-wins made rejectedFallback
  // see an effective PASS → null → ERROR; worst-wins routing keeps the FAIL,
  // so onFail fires BUILD with the findings.
  const first = {
    record: { verdict: "FAIL" as const, reason: "auth bypass", axes: fiveAxes() },
    message: "Verdict NOT recorded — a FAIL must name what has to change.",
  }
  const second = {
    record: { verdict: "PASS" as const, axes: fiveAxes() },
    message: "Verdict NOT recorded — a PASS must cite evidence.",
  }
  const merged = mergeRejected(first, second)
  const salvaged = rejectedFallback(merged)
  assert.ok(salvaged, "the merged rejection still routes — no ERROR stop")
  assert.equal(effectiveVerdict(salvaged), "FAIL", "worst-wins: the FAIL survives the later PASS")
  assert.match(salvaged.reason!, /auth bypass/, "the FAIL's own reason survives the merge")
  assert.match(merged.message, /cite evidence/, "the newest rejection message names the current shape fault")
})

test("mergeRejected merges axes and findings like admitVerdict's accepted merge", () => {
  const withFinding = fiveAxes().map((a) => (a.axis === "security" ? { ...a, verdict: "FAIL" as const, findings: [{ severity: "critical" as const, detail: "secret logged" }] } : a))
  const merged = mergeRejected(
    { record: { verdict: "FAIL", axes: withFinding }, message: "first refusal" },
    { record: { verdict: "PASS", axes: fiveAxes() }, message: "second refusal" },
  )
  const security = merged.record.axes!.find((a) => a.axis === "security")!
  assert.equal(security.verdict, "FAIL", "per-axis worst-wins")
  assert.equal(security.findings?.[0]?.detail, "secret logged", "findings survive the later clean pass")
})

test("mergeRejected with no prior rejection is the incoming one", () => {
  const incoming = { record: { verdict: "FAIL" as const }, message: "refused" }
  assert.deepEqual(mergeRejected(null, incoming), incoming)
  assert.deepEqual(mergeRejected(undefined, incoming), incoming)
})

test("rejectedFallback of nothing is nothing", () => {
  assert.equal(rejectedFallback(null), null)
  assert.equal(rejectedFallback(undefined), null)
})

test("noAdmissibleVerdictReason tells a dead channel apart from a refused verdict", () => {
  const silent = noAdmissibleVerdictReason({})
  assert.match(silent, /channel is unreachable/)
  assert.match(silent, /fix the plugin wiring/)
  const refused = noAdmissibleVerdictReason({
    rejected: { record: { verdict: "PASS" }, message: "Verdict NOT recorded — a PASS must cite evidence." },
  })
  assert.match(refused, /every verdict offered was rejected/)
  assert.match(refused, /the channel works/)
  assert.match(refused, /must cite evidence/)
  assert.doesNotMatch(refused, /plugin wiring/, "a channel that answered twice must not send anyone after the wiring")
})

test("noAdmissibleVerdictReason carries the host's pass tag and the untrusted prose", () => {
  const reason = noAdmissibleVerdictReason({ detail: " (axes: security)", prose: "PASS" })
  assert.match(reason, /retry \(axes: security\) —/)
  assert.match(reason, /prose claimed PASS, ignored/)
})

test("planContractBlock demands checks that terminate, and forbids a criterion only a running server proves", () => {
  const block = planContractBlock("plan")
  assert.match(block, /### Verification/)
  // A check that never exits is the one shape the loop cannot grade: as a
  // driver-run check it times out to ERROR and stops the run, and as an agent
  // command it eats the host's tool deadline. PLAN is where that is prevented.
  assert.match(block, /TERMINATES with an exit code/)
  assert.match(block, /dev server/)
  assert.match(block, /cannot mark it met/)
  // …and the plan is told what to write instead, so the clause is actionable
  // rather than a refusal the planner has to route around on its own.
  assert.match(block, /e2e run that boots/)
  assert.match(block, /### Out of Scope/)
})
