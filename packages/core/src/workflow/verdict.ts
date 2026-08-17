/**
 * Verdict types for the loop's two check stages (VERIFY and REVIEW), plus a
 * parser for the human-readable verdict line they end their transcripts with:
 *   WORKFLOW_VERIFY: PASS / WORKFLOW_VERIFY: FAIL
 *   WORKFLOW_REVIEW: PASS / WORKFLOW_REVIEW: FAIL
 *
 * The text line is **diagnostic only**. The authoritative verdict channel is
 * the `workflow_verdict` plugin tool (see driver.ts) — free text is untrusted:
 * a stage quoting its own contract, or repo content echoed into the output,
 * must never be able to flip the loop's control flow. The driver uses
 * `parseVerdict` only to log a discrepancy when a stage wrote a text verdict
 * but never called the tool (which the loop counts as FAIL).
 *
 * Pure and total: returns the last verdict found for the given tag, or null
 * when none is present.
 */

import {
  mergeEvidence,
  noActivityMessage,
  noEvidenceMessage,
  observedNothing,
  seededOnlyMessage,
  substantiated,
  unobservedItems,
  unobservedMessage,
  type EvidenceContext,
  type EvidenceItem,
} from "./evidence.js"

/**
 * PASS/FAIL decide the loop's control flow; ERROR means the check itself
 * could not run (broken environment, missing test runner) — the loop stops
 * for a human instead of burning a re-plan/re-build iteration on it.
 */
export type Verdict = "PASS" | "FAIL" | "ERROR"

/** Per-acceptance-criterion result carried alongside a verdict (optional). */
export interface CriterionResult {
  readonly criterion: string
  readonly pass: boolean
}

/**
 * How much a review finding blocks: `critical`/`important` block a PASS,
 * `suggestion` never does. The wording matches the workflow-review agent's own
 * severity vocabulary, so the machine enforces the rule the prompt states
 * ("PASS only if there are no Critical or Important findings on any axis")
 * instead of trusting the agent to apply it.
 *
 * Three sites carry this vocabulary and must agree: this union is the machine
 * contract, `prompts/agents/workflow-review/body.md` is the gate that says what
 * the loop does with each level, and `skills/code-review-and-quality/SKILL.md`
 * → Severity defines what each level *means* — the prose source of truth the
 * review skills grade against. A skill teaching a fourth level is not a style
 * slip: the agent emits it, this union rejects the whole `workflow_verdict`
 * call, and a no-call is recorded as a FAIL on a possibly-clean diff.
 * `scripts/skill-severity.test.mjs` holds the skills to these three words.
 */
export type Severity = "critical" | "important" | "suggestion"

/** One finding on one review axis. `location` is the "file:line" the prompt asks for. */
export interface AxisFinding {
  readonly severity: Severity
  readonly detail: string
  readonly location?: string
}

/**
 * One axis's result within a multi-axis check (today: the engineering loop's
 * five-axis REVIEW, declared as `requiredAxes` on the stage).
 *
 * The axis carries a full `Verdict`, not a boolean, because a per-axis ERROR is
 * load-bearing: "no hot path in this diff, could not assess performance" is the
 * case ERROR exists for, and collapsing it to FAIL burns a build iteration on
 * work that was never wrong. A finding-less axis ERROR is therefore
 * NON-BLOCKING (`axisUnassessed`): `effectiveVerdict` skips it, and only a
 * record whose every axis is unassessed is refused (`withUnassessedGuard`).
 *
 * What requiring axes buys and what it does not: it makes a *skipped* axis
 * impossible and a shallow one visible in the run log. It cannot make a review
 * honest — five empty PASS axes satisfy the check. It is a completeness check,
 * not an honesty check; don't add validation that pretends otherwise.
 */
export interface AxisResult {
  readonly axis: string
  readonly verdict: Verdict
  readonly findings?: readonly AxisFinding[]
}

/**
 * A verdict plus the optional structured reasons the check stage recorded via
 * the `workflow_verdict` tool. `reason`/`criteria` steer the *next iteration's
 * prompt* — never control flow, which remains `verdict` alone (same trust
 * level as the verdict itself, since they arrive through the same tool call).
 *
 * `axes` is the exception: it steers the next prompt *and* control flow, via
 * `effectiveVerdict`. That is deliberate — an agent that reports overall PASS
 * while flagging a Critical finding on one axis must not be able to ship it.
 * Deriving the verdict is strictly safer than trusting the declared one.
 *
 * `evidence` steers neither: it is a *gate* on recording a PASS at all
 * (`evidenceIssue`), checked against what the host observed the stage do.
 */
export interface VerdictRecord {
  readonly verdict: Verdict
  readonly reason?: string
  readonly criteria?: readonly CriterionResult[]
  readonly axes?: readonly AxisResult[]
  readonly evidence?: readonly EvidenceItem[]
}

/**
 * Combine several review-lens verdicts into one: any ERROR wins (the check
 * couldn't run), else any FAIL/missing wins, else PASS. A missing verdict
 * (null) counts as FAIL — never a stall — as a conservative default; callers
 * that can tell "the lens ran but its verdict channel broke" apart from a
 * genuine FAIL must screen those nulls into ERROR before combining (the
 * OpenCode driver does — a broken channel must not burn a rebuild iteration).
 * Pure.
 */
export const worstOf = (verdicts: readonly (Verdict | null)[]): Verdict => {
  if (verdicts.some((v) => v === "ERROR")) return "ERROR"
  if (verdicts.some((v) => v !== "PASS")) return "FAIL"
  return "PASS"
}

/** Axis names are matched normalized — a capitalization typo must not loop the retry forever. */
const axisKey = (axis: string): string => axis.trim().toLowerCase()

const isBlocking = (f: AxisFinding): boolean => f.severity !== "suggestion"

const hasBlockingFinding = (axis: AxisResult): boolean => (axis.findings ?? []).some(isBlocking)

/**
 * An axis the reviewer could not assess: declared ERROR carrying no blocking
 * finding. Non-blocking — `effectiveVerdict` skips it, `verdictFeedbackBlock`
 * reports it as unassessed, and only a record whose EVERY axis is unassessed is
 * refused (`withUnassessedGuard`). The synthetic checks axis can never read as
 * unassessed: a broken check runner records ERROR WITH critical findings
 * (`checkAxis`), which is what keeps its onError routing. Pure.
 */
export const axisUnassessed = (a: AxisResult): boolean => a.verdict === "ERROR" && !hasBlockingFinding(a)

/**
 * One axis's effective verdict: what it declared, worsened by its own findings.
 * An axis cannot claim PASS while carrying a Critical or Important finding.
 * Pure.
 */
export const axisVerdict = (axis: AxisResult): Verdict =>
  worstOf([axis.verdict, hasBlockingFinding(axis) ? "FAIL" : "PASS"])

/**
 * The verdict the loop acts on: the declared verdict worsened by every
 * ASSESSED axis. Records with no axes are unaffected, so VERIFY and the sitter
 * kinds keep today's behavior exactly.
 *
 * An unassessed axis (`axisUnassessed`) is skipped, not worsened in: the agent
 * contract explicitly invites "ERROR on an axis you genuinely could not
 * assess", and letting that one axis make the STAGE ERROR routed an honest
 * review to `onError` — a stop blaming the environment, a stranded task, and a
 * `recover` that re-derived the same ERROR forever. An axis ERROR that carries
 * blocking findings still worsens (the checks axis relies on that to route a
 * missing runner to onError), and a declared PASS whose EVERY axis is
 * unassessed is refused at finalization (`withUnassessedGuard`) — a review
 * that assessed nothing must not ship. Pure.
 */
export const effectiveVerdict = (record: VerdictRecord): Verdict =>
  worstOf([record.verdict, ...(record.axes ?? []).filter((a) => !axisUnassessed(a)).map(axisVerdict)])

/**
 * Union two axis lists: per-axis worst-wins verdict, findings de-duped. Used
 * for repeat `workflow_verdict` calls in one stage and for combining review lenses
 * — a lens that PASSED an axis still holds evidence about it, so its findings
 * survive alongside a later lens's FAIL. Pure.
 */
export const mergeAxes = (
  a: readonly AxisResult[] | undefined,
  b: readonly AxisResult[] | undefined,
): AxisResult[] => {
  const merged = new Map<string, AxisResult>()
  for (const axis of [...(a ?? []), ...(b ?? [])]) {
    const key = axisKey(axis.axis)
    const prev = merged.get(key)
    if (!prev) {
      merged.set(key, axis)
      continue
    }
    const seen = new Set((prev.findings ?? []).map((f) => `${f.severity}\u0000${f.detail}\u0000${f.location ?? ""}`))
    const findings = [
      ...(prev.findings ?? []),
      ...(axis.findings ?? []).filter((f) => !seen.has(`${f.severity}\u0000${f.detail}\u0000${f.location ?? ""}`)),
    ]
    merged.set(key, {
      axis: prev.axis,
      verdict: worstOf([prev.verdict, axis.verdict]),
      ...(findings.length ? { findings } : {}),
    })
  }
  return [...merged.values()]
}

/**
 * Reject a verdict that doesn't cover every axis the stage requires, or null
 * when it does (and null when the stage requires none — VERIFY and the sitter
 * kinds are untouched). Extra axes beyond the requirement are kept, not
 * rejected: an over-thorough review is not an error.
 *
 * The message has to make the retry succeed on the first try, so it names the
 * missing axes, says partial calls are not accumulated, gives the shape, and
 * spells out the two escape hatches — otherwise a model that genuinely could
 * not assess an axis either omits it (reject loop) or invents a finding. Pure.
 */
export const axisCoverageIssue = (
  record: VerdictRecord,
  requiredAxes: readonly string[] | undefined,
): string | null => {
  if (!requiredAxes?.length) return null
  const missing = uncoveredAxes(record, requiredAxes)
  if (!missing.length) return null
  const covered = new Set((record.axes ?? []).map((a) => axisKey(a.axis)))
  const got = (record.axes ?? []).map((a) => a.axis).join(", ") || "none"
  // A focused fan-out pass is required to carry exactly ONE axis, so the plural
  // wording ("all 1 axes … every call must carry all 1") would read as a bug and
  // invite the pass to send five instead of its own.
  const one = requiredAxes.length === 1
  return (
    `Verdict NOT recorded — this ${one ? "pass" : "stage"} requires a per-axis result for ` +
    `${one ? `the axis "${requiredAxes[0]}"` : `all ${requiredAxes.length} axes`} ` +
    `and your call covered ${covered.size} (${got}). Missing: ${missing.join(", ")}. ` +
    `Call workflow_verdict again with the COMPLETE axes array in ONE call — partial submissions are not ` +
    `accumulated${one ? "" : `, every call must carry all ${requiredAxes.length}`}. Shape: axes: [{ axis: "correctness", ` +
    `verdict: "PASS"|"FAIL"|"ERROR", findings: [{ severity: "critical"|"important"|"suggestion", ` +
    `detail: "...", location: "file:line" }] }, ...]. ` +
    `Use verdict "ERROR" on an axis you genuinely could not assess; an axis with no findings is a clean PASS.`
  )
}

/**
 * One focused pass of a check stage: what it covers, and under which regime.
 *
 * `single` is the ordinary one-pass stage (`focus: null`). `lens` is config
 * `reviewLenses` — a free-text angle that maps to no axis, so per-pass axis
 * coverage is not enforced for it. `axis` is a manifest `fanout: "axis"` pass,
 * which covers exactly one of the stage's `requiredAxes` and IS enforced
 * against it.
 */
export interface StagePass {
  /** The axis or lens this pass covers; null for the single unfocused pass. */
  readonly focus: string | null
  readonly mode: "lens" | "axis" | "single"
}

/**
 * The required axes an accumulated record does not cover, matched normalized.
 * Empty when the stage requires none, or when every one reported. Pure.
 */
export const uncoveredAxes = (
  record: VerdictRecord | null,
  requiredAxes: readonly string[] | undefined,
): string[] => {
  if (!requiredAxes?.length) return []
  const covered = new Set((record?.axes ?? []).map((a) => axisKey(a.axis)))
  return requiredAxes.filter((a) => !covered.has(axisKey(a)))
}

/** Why a fan-out stage stopped instead of acting on an incomplete review. Pure. */
export const uncoveredAxesReason = (missing: readonly string[]): string =>
  `${missing.length > 1 ? "axes" : "axis"} ${missing.join(", ")} recorded no per-axis result across this stage's ` +
  "fan-out passes — the review is incomplete, so the loop stops instead of re-building on it. " +
  "Re-run the missing passes (recover the task) once the verdict channel works."

/**
 * Worsen a fan-out check's accumulated record to ERROR when an axis went
 * uncovered, KEEPING the axes that did report so their findings still reach the
 * next prompt and the run log.
 *
 * A coverage gap is a BROKEN review, not a FAIL: re-building on a review that
 * never happened burns an iteration on possibly-correct work — the same
 * reasoning behind the OpenCode driver's missing-pass handling, and behind
 * ERROR existing at all. Returns the record unchanged when coverage is
 * complete, so a healthy fan-out is byte-identical to no gate. Pure.
 */
export const withCoverageGap = (record: VerdictRecord, missing: readonly string[]): VerdictRecord =>
  missing.length
    ? {
        ...record,
        verdict: "ERROR",
        reason: [record.reason, uncoveredAxesReason(missing)].filter(Boolean).join(" · "),
      }
    : record

/** Why a declared PASS whose every axis was unassessed stopped the loop. Pure. */
export const allAxesUnassessedReason = (): string =>
  "every axis was recorded ERROR (could not assess) under a declared PASS — the review assessed nothing, " +
  "so the loop stops instead of shipping on it. If the review itself could not run, declare the OVERALL " +
  "verdict ERROR with a reason; recover the task once the cause is fixed."

/**
 * Refuse a declared PASS whose every axis is unassessed: a minority axis ERROR
 * is non-blocking (`effectiveVerdict` skips it), but a review that assessed
 * NOTHING must not ship on the strength of the skip. Worsened to ERROR — the
 * same "broken review, not a FAIL" reasoning as `withCoverageGap` — so it
 * routes to onError instead of burning a rebuild iteration.
 *
 * Applied at FINALIZATION on the accumulated record (see
 * `finalizeCheckRecord`), never inside `effectiveVerdict`: on the OpenCode
 * driver `effectiveVerdict` is evaluated PER FAN-OUT PASS, where a single-axis
 * pass whose one axis was unassessable is exactly the legitimate minority case
 * this must not flip. FAIL and ERROR records pass through unchanged — a
 * declared FAIL stays FAIL (`rejectedFallback`'s rule). Identity on null. Pure.
 */
export const withUnassessedGuard = (record: VerdictRecord | null): VerdictRecord | null =>
  record && record.verdict === "PASS" && (record.axes?.length ?? 0) > 0 && (record.axes ?? []).every(axisUnassessed)
    ? { ...record, verdict: "ERROR", reason: [record.reason, allAxesUnassessedReason()].filter(Boolean).join(" · ") }
    : record

/**
 * Reject a FAIL that names nothing to fix, or null when the verdict is sound.
 * Only enforced on stages that require axes — elsewhere a bare FAIL + reason is
 * the established contract. A FAIL with no blocking finding produces an empty
 * feedback block, so the next BUILD iteration is told to fix "something". Pure.
 */
export const blockingFindingsIssue = (
  record: VerdictRecord,
  requiredAxes: readonly string[] | undefined,
): string | null => {
  if (!requiredAxes?.length) return null
  if (effectiveVerdict(record) !== "FAIL") return null
  if ((record.axes ?? []).some(hasBlockingFinding)) return null
  return (
    "Verdict NOT recorded — a FAIL must name what has to change: at least one axis needs a finding with " +
    'severity "critical" or "important". Add the blocking finding (with its file:line) and call workflow_verdict ' +
    "again, or record PASS if nothing blocks — suggestion-only findings do not fail a stage."
  )
}

/**
 * Reject an effective FAIL that names NOTHING to fix, or null when it names
 * anything (or is not a FAIL). Applies to every check stage: `reason`, a
 * criterion marked not met, or a blocking axis finding each satisfy it.
 *
 * Without this, a bare `{verdict: "FAIL"}` was admissible on an axis-less stage
 * (`blockingFindingsIssue` is gated on `requiredAxes`, and the tool schema's
 * `reason` is optional) — its `verdictFeedbackBlock` rendered empty, so the
 * next BUILD iteration was told to fix "something". Ordered AFTER
 * `blockingFindingsIssue`, whose message is the more specific one on stages
 * that require axes. Brick-proof by construction: a FAIL this rejects twice is
 * still recorded as declared (`rejectedFallback`), now carrying the rejection
 * message in `reason` — strictly more feedback than the empty block. Pure.
 */
export const failFeedbackIssue = (record: VerdictRecord): string | null => {
  if (effectiveVerdict(record) !== "FAIL") return null
  if (record.reason?.trim()) return null
  if ((record.criteria ?? []).some((c) => !c.pass && c.criterion.trim())) return null
  if ((record.axes ?? []).some(hasBlockingFinding)) return null
  return (
    "Verdict NOT recorded — a FAIL must name what has to change. Call workflow_verdict again with any of: " +
    "a one-line `reason`, a criteria entry { criterion, pass: false } naming the unmet acceptance criterion, " +
    "or a blocking axis finding. If nothing actually blocks, record PASS instead — " +
    "an unexplained FAIL sends the next build iteration off to fix \"something\"."
  )
}

/**
 * What `criteriaIssue` needs: the acceptance criteria the stage was given —
 * the same `state.task.acceptance` its prompt's `{{acceptance.bullets}}`
 * renders, threaded by the host so contract and admission read one source.
 * Empty ⇒ no requirement (sitter kinds carry no task and are untouched).
 */
export interface CriteriaContext {
  /** The check stage being admitted, for the rejection wording. */
  readonly stage: string
  /** Acceptance bullets the stage was given; empty ⇒ no requirement. */
  readonly acceptance: readonly string[]
}

/** How many acceptance bullets a rejection message names before eliding. */
const CRITERIA_MESSAGE_MAX = 8

/**
 * Reject a PASS that does not account for the stage's acceptance criteria, or
 * null when it does (and null when the stage was given none — every other
 * stage and kind is untouched).
 *
 * Two rules:
 *  1. A PASS carrying any criterion marked not met is a contradiction — the
 *     persona's own gate is "PASS only if every criterion is met", enforced
 *     mechanically here instead of trusted.
 *  2. Coverage is COUNT-based: at least one non-empty entry per acceptance
 *     bullet. Deliberately no text matching against the bullets — like
 *     `requiredAxes` this is a completeness check, not an honesty check, and
 *     text-matching a paraphrasing model rejects sound PASSes whose retry
 *     budget ends in an ERROR stop (`rejectedFallback` never salvages a PASS).
 *
 * Only PASS is gated, the same asymmetry as `evidenceIssue`: the dangerous
 * direction is the unearned PASS, and a FAIL already has `failFeedbackIssue`.
 * Pure.
 */
export const criteriaIssue = (record: VerdictRecord, ctx: CriteriaContext | undefined): string | null => {
  if (!ctx?.acceptance.length) return null
  if (effectiveVerdict(record) !== "PASS") return null
  const criteria = (record.criteria ?? []).filter((c) => c.criterion.trim())
  const unmet = criteria.filter((c) => !c.pass)
  if (unmet.length) {
    return (
      `Verdict NOT recorded — this ${ctx.stage.toUpperCase()} PASS marks ${unmet.length === 1 ? "a criterion" : `${unmet.length} criteria`} ` +
      `as not met (${unmet.map((c) => `"${c.criterion}"`).join(", ")}). A criterion not met means the stage FAILED: ` +
      "call workflow_verdict again with verdict FAIL and a reason, or — if the criterion IS actually met — correct its `pass` flag."
    )
  }
  if (criteria.length >= ctx.acceptance.length) return null
  const shown = ctx.acceptance.slice(0, CRITERIA_MESSAGE_MAX)
  const elided = ctx.acceptance.length - shown.length
  return (
    `Verdict NOT recorded — this ${ctx.stage.toUpperCase()} stage was given ${ctx.acceptance.length} acceptance ` +
    `${ctx.acceptance.length === 1 ? "criterion" : "criteria"} and your call carried ${criteria.length} criteria ` +
    `${criteria.length === 1 ? "entry" : "entries"}. A PASS must account for each one. Call workflow_verdict again with a ` +
    "`criteria` array holding one { criterion, pass } entry per criterion, in the order given" +
    `: ${shown.map((c) => `"${c}"`).join("; ")}${elided > 0 ? `; …and ${elided} more (see the Acceptance criteria section of your prompt)` : ""}. ` +
    "Mark a criterion you could not verify as { pass: false } and record FAIL instead of PASS."
  )
}

/**
 * Reject a PASS that is not backed by work, or null when it is (and null when
 * the stage does not require evidence — every kind that doesn't opt in is
 * untouched). The rules, in the order that produces the most useful retry
 * message:
 *
 *  1. A PASS citing nothing is rejected. That is rule A: cheap, and it makes
 *     the claim explicit and auditable rather than implicit.
 *  2. A PASS from a pass the host saw run NOTHING is rejected, whatever it
 *     cited — unless the driver ran checks for this stage (`seeded`), which are
 *     real work the stage may legitimately trust without re-running.
 *  3. A PASS corroborated by the agent's OWN observed work is admitted.
 *     Deliberately "at least one item" and not "every" — see `substantiated`
 *     for why a stricter rule trades a fabricated PASS for a deadlocked loop.
 *  4. A PASS whose only corroborated citations are the SEEDED check commands is
 *     rejected (`seededOnlyMessage`): established fact is not the agent's proof
 *     of work, and merging the seed into `observed` let a stage that did
 *     nothing itself cite the pre-run command and pass the gate.
 *  5. Otherwise nothing cited matches anything observed — rejected.
 *
 * Only PASS is gated, on purpose. A FAIL already has to name what to fix
 * (`failFeedbackIssue`/`blockingFindingsIssue`) and an ERROR means the check
 * could not run — demanding evidence of a stage that just reported a broken
 * test runner would trap it in a rejection loop with nothing it could
 * truthfully say. The dangerous direction is the unearned PASS. Pure.
 */
export const evidenceIssue = (record: VerdictRecord, ctx: EvidenceContext | undefined): string | null => {
  if (!ctx?.required) return null
  if (effectiveVerdict(record) !== "PASS") return null
  const declared = record.evidence ?? []
  if (!declared.length) return noEvidenceMessage(ctx.stage)
  if (!ctx.observed) return null // this host does not observe — the declared rule stands alone
  const seeded = ctx.seeded ?? []
  if (observedNothing(ctx.observed) && !seeded.length) return noActivityMessage(ctx.stage)
  if (substantiated(declared, ctx.observed)) return null
  if (seeded.length && substantiated(declared, { commands: seeded, reads: [] })) {
    return seededOnlyMessage(ctx.stage, ctx.observed)
  }
  return unobservedMessage(ctx.stage, unobservedItems(declared, ctx.observed))
}

/**
 * The outcome of offering a verdict to the loop: either a rejection to hand
 * back to the calling agent, or the record the host should store.
 */
export type VerdictAdmission =
  | { readonly ok: false; readonly message: string }
  | { readonly ok: true; readonly record: VerdictRecord }

/**
 * Decide whether an incoming verdict may be recorded, and produce the record to
 * store if so — the single seam both hosts go through.
 *
 * This exists as a *return type* rather than a sequence of guards because the
 * ordering is load-bearing and unenforceable by convention: on the Claude host,
 * stamping a verdict marks the stage satisfied for the SubagentStop guard and
 * burns its one-shot nag sentinel, so a rejected verdict that reached the stamp
 * would let the subagent stop having recorded nothing valid. A host that can
 * only obtain a record from the `ok: true` branch cannot make that mistake.
 *
 * Repeat calls within one stage combine worst-wins (multi-lens review, or an
 * agent correcting itself) — never overwrite, so a FAIL cannot be replaced by a
 * later PASS. Pure.
 */
export const admitVerdict = (
  incoming: VerdictRecord,
  requiredAxes: readonly string[] | undefined,
  pending: VerdictRecord | null,
  // Optional so every caller that predates evidence keeps today's behavior, and
  // so a host that cannot observe tool calls can still pass the declared-only
  // context instead of being forced to fake an observation set.
  evidence?: EvidenceContext,
  // Optional for the same reason: a caller that predates the criteria gate —
  // or a kind whose stage carries no acceptance — is byte-identical.
  criteriaCtx?: CriteriaContext,
): VerdictAdmission => {
  // Gated on the INCOMING record, not the merge: each call must justify its own
  // PASS. Merging first would let a second, evidence-free PASS ride in on the
  // first one's citations.
  const gate =
    axisCoverageIssue(incoming, requiredAxes) ??
    blockingFindingsIssue(incoming, requiredAxes) ??
    failFeedbackIssue(incoming)
  if (gate) return { ok: false, message: gate }
  // The PASS-side gates are COLLECTED, not short-circuited: the retry budget is
  // one, so a PASS missing both its criteria and its evidence must learn both
  // faults from one rejection — serially it would fix one, be rejected for the
  // other, and ERROR-stop the run.
  const passIssues = [criteriaIssue(incoming, criteriaCtx), evidenceIssue(incoming, evidence)].filter(
    (i): i is string => i !== null,
  )
  if (passIssues.length) return { ok: false, message: passIssues.join("\nALSO: ") }
  if (!pending) return { ok: true, record: incoming }
  const reasons = [pending.reason, incoming.reason].filter(Boolean)
  const criteria = [...(pending.criteria ?? []), ...(incoming.criteria ?? [])]
  const axes = mergeAxes(pending.axes, incoming.axes)
  const cited = mergeEvidence(pending.evidence, incoming.evidence)
  return {
    ok: true,
    record: {
      verdict: worstOf([pending.verdict, incoming.verdict]),
      ...(reasons.length ? { reason: reasons.join(" · ") } : {}),
      ...(criteria.length ? { criteria } : {}),
      ...(axes.length ? { axes } : {}),
      ...(cited.length ? { evidence: cited } : {}),
    },
  }
}

/**
 * A verdict `admitVerdict` refused, kept by the host until the stage ends.
 *
 * A rejection is not "nothing happened": the channel worked, the stage reported,
 * and the shape was wrong. Keeping the refused record (not just a "something was
 * rejected" flag) is what lets `rejectedFallback` route the run on what the stage
 * DECLARED once the retry is spent.
 */
export interface RejectedVerdict {
  readonly record: VerdictRecord
  readonly message: string
}

/**
 * Fold a newly refused record into the one already held: WORST verdict wins,
 * axes/criteria/evidence merge — the same composition `admitVerdict` applies to
 * accepted repeat calls, because the failure mode is the same. Keeping only the
 * LAST rejection lost a rejected FAIL behind a later rejected PASS: the retry
 * "corrected" a FAIL-with-no-blocking-finding into an uncorroborated PASS,
 * `rejectedFallback` saw an effective PASS, returned null, and the run
 * ERROR-stopped — the findings never reached the rebuild that `onFail` exists
 * to fire. The newest rejection message is kept (it names the shape fault the
 * retry was told to fix). Pure.
 */
export const mergeRejected = (prev: RejectedVerdict | null | undefined, incoming: RejectedVerdict): RejectedVerdict => {
  if (!prev) return incoming
  const reasons = [prev.record.reason, incoming.record.reason].filter(Boolean)
  const criteria = [...(prev.record.criteria ?? []), ...(incoming.record.criteria ?? [])]
  const axes = mergeAxes(prev.record.axes, incoming.record.axes)
  const cited = mergeEvidence(prev.record.evidence, incoming.record.evidence)
  return {
    record: {
      verdict: worstOf([prev.record.verdict, incoming.record.verdict]),
      ...(reasons.length ? { reason: reasons.join(" · ") } : {}),
      ...(criteria.length ? { criteria } : {}),
      ...(axes.length ? { axes } : {}),
      ...(cited.length ? { evidence: cited } : {}),
    },
    message: incoming.message,
  }
}

/**
 * The record to act on when a check stage's verdict was REJECTED rather than
 * never offered, and its one retry produced nothing admissible either.
 *
 * Without this, a review that plainly failed ended the loop: the rejected FAIL
 * left `pending` empty, the host re-fired the same check (the "another REVIEW
 * instead of a BUILD" symptom), and the second miss became ERROR — so
 * `review.onError` stopped the run and the findings never reached a rebuild. The
 * declared verdict is the honest thing to fall back on, and the rejection message
 * rides along in `reason` so the next BUILD is told both what failed and that the
 * verdict arrived malformed.
 *
 * An EFFECTIVE PASS is never salvaged (returns null ⇒ the caller keeps its ERROR
 * stop). Every rejection a PASS can draw — no evidence, evidence naming work the
 * host never saw — exists precisely because the PASS was not earned; laundering
 * it here would ship unreviewed work, which is strictly worse than stopping.
 * Pure.
 */
export const rejectedFallback = (rejected: RejectedVerdict | null | undefined): VerdictRecord | null => {
  if (!rejected) return null
  const declared = effectiveVerdict(rejected.record)
  if (declared === "PASS") return null
  const reason = [rejected.record.reason, `verdict was rejected twice and recorded as declared — ${rejected.message}`]
    .filter(Boolean)
    .join(" · ")
  return { ...rejected.record, verdict: declared, reason }
}

/**
 * The ERROR reason for a check stage that ended with no admissible verdict.
 *
 * Two genuinely different faults, and they must not share one message: nothing
 * was ever recorded (the channel is unreachable — the plugin wiring is the thing
 * to fix), or everything recorded was refused (the channel works — the verdict's
 * SHAPE is the thing to fix). Reported as one for a while, which sent operators
 * to check MCP wiring that was working correctly. Pure.
 */
export const noAdmissibleVerdictReason = (opts: {
  readonly rejected?: RejectedVerdict | null
  /** Host-specific tag for the passes that went missing, e.g. " (axes: security)". Empty when single-pass. */
  readonly detail?: string
  /** What the stage's untrusted prose claimed, for the audit trail only. */
  readonly prose?: Verdict | null
}): string => {
  const detail = opts.detail ?? ""
  const prose = opts.prose ? ` (prose claimed ${opts.prose}, ignored — free text is untrusted)` : ""
  return opts.rejected
    ? `every verdict offered was rejected${detail} — the channel works, the verdict's shape does not: ` +
        `${opts.rejected.message} Fix the stage's verdict call (or its agent contract), then recover the task.${prose}`
    : `no workflow_verdict recorded even after a retry${detail} — the verdict channel is unreachable from the stage subagent ` +
        `or the agent contract was not applied; fix the plugin wiring, then recover the task${prose}`
}

/**
 * Render a check stage's structured feedback as a prompt block for the next
 * iteration, or "". Reason, then failed criteria, then failing axes.
 *
 * Axes render here rather than in a sibling function on purpose: this has two
 * host call sites, and a second function is one each host can forget to
 * concatenate — the same silent-drop failure `verdictContractBlock` exists to
 * prevent. Suggestions are dropped; only what blocks reaches the next BUILD.
 * Pure.
 */
export const verdictFeedbackBlock = (record: VerdictRecord | null): string => {
  const failed = record?.criteria?.filter((c) => !c.pass) ?? []
  const lines: string[] = []
  if (record?.reason) lines.push(`Verdict reason: ${record.reason}`)
  if (failed.length) {
    lines.push("Failed criteria (from workflow_verdict):")
    for (const c of failed) lines.push(`- ${c.criterion}`)
  }
  const failing = (record?.axes ?? []).filter((a) => !axisUnassessed(a) && axisVerdict(a) !== "PASS")
  if (failing.length) {
    lines.push("Failing review axes (from workflow_verdict):")
    for (const axis of failing) {
      lines.push(`- ${axis.axis} (${axisVerdict(axis)})`)
      for (const f of (axis.findings ?? []).filter(isBlocking)) {
        lines.push(`  - [${f.severity}] ${f.detail}${f.location ? ` — ${f.location}` : ""}`)
      }
    }
  }
  // Unassessed axes are not failures, but they are a fact the next iteration
  // (and the in-review human) should see: "performance was never assessed" is
  // information a PASS would otherwise silently swallow.
  const unassessed = (record?.axes ?? []).filter(axisUnassessed)
  if (unassessed.length) {
    lines.push("Unassessed review axes (reviewer could not assess — non-blocking, from workflow_verdict):")
    for (const axis of unassessed) lines.push(`- ${axis.axis}`)
  }
  return lines.join("\n")
}

/** The verdict tags emitted by the loop's check stages. */
export const WORKFLOW_VERIFY_TAG = "WORKFLOW_VERIFY"
export const WORKFLOW_REVIEW_TAG = "WORKFLOW_REVIEW"

/**
 * The mandatory verdict-contract paragraph appended to every CHECK stage's
 * composed prompt (see engine.ts `composePrompt`). The contract normally
 * lives in the workflow-verify/workflow-review agent definitions, but a mis-resolved
 * subagent binding or a stripped tool allowlist silently loses it — and the
 * stage then "passes" in prose while the loop records FAIL. Carrying the
 * contract in the prompt itself makes it survive any dispatch path, on both
 * hosts.
 *
 * `requiredAxes` (from the stage's manifest entry) adds the per-axis payload
 * contract. Omitting it must keep the string byte-identical to the axis-less
 * form — every other check stage across every kind renders that one.
 *
 * `mode` picks which per-axis contract to render, and it has to match the passes
 * that will actually run: the prompt is composed ONCE for the stage, then each
 * pass gets `passFocusBlock` appended. A contract that contradicts the suffix is
 * obeyed whichever way the model read last.
 *
 *  - `"single"` — one unfocused pass: cover every required axis in one call.
 *  - `"axis"` — `fanout: "axis"`: cover the ONE axis this pass owns.
 *  - `"lens"` — config `reviewLenses`: cover the axes YOUR LENS bears on.
 *
 * The `lens` branch is not cosmetic. Lens passes used to render the `single`
 * contract — "MUST carry an `axes` array covering all 5 axes … a call missing an
 * axis is REJECTED" — directly above a suffix saying "focus exclusively on
 * <lens>". Both cannot be satisfied, and the threat was empty: `passAxes`
 * returns `undefined` for a lens, so nothing rejected anything. It left the pass
 * two ways to comply and both were bad. Obey the contract and a security lens
 * invents four axis verdicts it did no work for — and because passes merge
 * worst-wins, a fabricated "correctness: PASS" becomes the STAGE's correctness
 * verdict, which is worse than no coverage: it manufactures the guarantee
 * instead of dropping it. Obey the suffix and the coverage silently vanishes.
 *
 * `requireEvidence` (the stage's manifest flag) adds the proof-of-work
 * contract. It has to be in the PROMPT and not only in the tool's schema
 * description: a stage that first learns of the requirement from a rejection has
 * already finished its work, and re-citing commands from memory is exactly the
 * fabrication the gate exists to catch. Default `false` keeps every existing
 * rendering byte-identical.
 *
 * `criteriaCount` (how many acceptance criteria the stage's prompt carries, from
 * the same `state.task.acceptance` the admission gate reads — see
 * `criteriaIssue`) adds the per-criterion contract, for the same reason
 * `requireEvidence` is here: the requirement must reach the stage BEFORE it
 * works, not first as a rejection. Omitted/zero keeps the rendering
 * byte-identical. Pure.
 */
export const verdictContractBlock = (
  stage: string,
  requiredAxes?: readonly string[],
  mode: "single" | "axis" | "lens" = "single",
  requireEvidence = false,
  criteriaCount?: number,
): string =>
  [
    "MANDATORY VERDICT: before you finish, record your verdict by calling the `workflow_verdict` tool",
    "(on Claude Code it appears as `mcp__agentic-workflow__workflow_verdict` or, plugin-bundled,",
    "`mcp__plugin_agentic-workflow_agentic-workflow__workflow_verdict`)",
    `exactly once, with stage: "${stage}", verdict: "PASS" | "FAIL" | "ERROR", and a one-line reason on FAIL/ERROR.`,
    "A verdict written only in prose is IGNORED and the loop records this stage as a failure.",
    "A FAIL that names nothing to fix — no reason, no criterion marked not met, no blocking finding — is REJECTED and you must call again.",
    "If the workflow_verdict tool is not in your tool list, state that explicitly in your final message and finish.",
    ...(criteriaCount
      ? [
          `ACCEPTANCE CRITERIA: this stage was given ${criteriaCount} acceptance ${criteriaCount === 1 ? "criterion" : "criteria"} (listed in this prompt).`,
          "The same call MUST carry a `criteria` array with one { criterion, pass } entry per criterion, in the order given.",
          "A PASS whose criteria are missing or incomplete, or that marks any criterion not met, is REJECTED —",
          "record FAIL when a criterion is not met.",
        ]
      : []),
    ...(requiredAxes?.length
      ? mode === "lens"
        ? [
            "This stage runs as several INDEPENDENT focused passes, one per review LENS, and YOUR pass covers",
            "exactly the one lens named in the REVIEW LENS line of this prompt.",
            `Carry an \`axes\` array for the axes your lens actually bears on, drawn from this stage's axes —`,
            `${requiredAxes.join(", ")} —`,
            'each { axis, verdict: "PASS" | "FAIL" | "ERROR", findings: [{ severity: "critical" | "important" | "suggestion", detail, location: "file:line" }] }.',
            "Report ONLY axes you actually reviewed through your lens: the sibling lenses cover the rest, and every",
            "pass is merged worst-wins, so an axis you did not examine must be left out rather than recorded as a",
            "clean PASS — a guess there becomes the whole stage's verdict for that axis.",
            'Use "ERROR" for an axis you genuinely could not assess — it is non-blocking and recorded as unassessed;',
            "an axis with no findings is a clean PASS.",
            "A Critical or Important finding on any axis of any pass makes the whole stage FAIL.",
          ]
        : mode === "axis"
          ? [
              `This stage runs as ${requiredAxes.length} INDEPENDENT focused passes, one per axis —`,
              `${requiredAxes.join(", ")} —`,
              "and YOUR pass covers exactly ONE of them, named in the REVIEW AXIS line of this prompt.",
              "The same call MUST carry an `axes` array holding that ONE axis and no others:",
              '{ axis, verdict: "PASS" | "FAIL" | "ERROR", findings: [{ severity: "critical" | "important" | "suggestion", detail, location: "file:line" }] }.',
              "A call that does not carry your own axis is REJECTED and you must call again.",
              "The sibling passes cover the rest, and every pass is merged worst-wins —",
              "a Critical or Important finding on your axis alone makes the whole stage FAIL.",
              'Use "ERROR" for an axis you genuinely could not assess — it is non-blocking and recorded as unassessed;',
              "an axis with no findings is a clean PASS.",
            ]
          : [
              `The same call MUST carry an \`axes\` array covering all ${requiredAxes.length} axes —`,
              `${requiredAxes.join(", ")} —`,
              'each { axis, verdict: "PASS" | "FAIL" | "ERROR", findings: [{ severity: "critical" | "important" | "suggestion", detail, location: "file:line" }] }.',
              "A call missing an axis is REJECTED and you must call again with the complete array;",
              "partial submissions are not accumulated across calls.",
              'Use "ERROR" for an axis you genuinely could not assess — it is non-blocking and recorded as unassessed;',
              "an axis with no findings is a clean PASS. A PASS in which EVERY axis is ERROR is refused:",
              "if the review itself could not run, declare the OVERALL verdict ERROR with a reason.",
              "Your overall verdict is worsened to match your axes — a Critical or Important finding anywhere makes the stage FAIL.",
            ]
      : []),
    ...(requireEvidence
      ? [
          "PROOF OF WORK: a PASS must also carry an `evidence` array citing what you actually observed —",
          '[{ kind: "command", ref: "<the command you ran>", result: "<what it printed>" },',
          '{ kind: "file", ref: "<path or path:line you read>", result: "<what you saw there>" }].',
          "Cite them as you issued them: this session's real commands and paths are recorded independently, and",
          "a PASS citing nothing — or nothing that matches what you actually ran — is REJECTED, not recorded.",
          "At least one citation must be work YOU did in this pass: check commands the loop pre-ran for you are",
          "established fact, not your proof of work — cite them additionally if you rely on them (never re-run them),",
          "alongside at least one file you read or command you ran yourself.",
          "So run the checks and read the code BEFORE you record, not after.",
          "FAIL and ERROR need no evidence: if the check could not run, record ERROR with a reason naming what is missing.",
        ]
      : []),
  ].join(" ")

/**
 * The per-pass instruction appended AFTER composition to a focused check pass's
 * prompt, naming the one axis or lens that pass covers. "" for a single pass.
 *
 * Both hosts append this exact string — the OpenCode driver inside its pass
 * loop, the Claude MCP server when `workflow_stage` is called with a `focus` —
 * so a focused pass is told the same thing wherever it runs. It is appended
 * rather than composed in because the composed prompt is built once per stage,
 * not once per pass.
 *
 * The `lens` wording was once a byte-for-byte move of what the driver appended
 * before this helper existed. It leads with `REVIEW LENS <i>/<n>` now, to match
 * the line the lens contract in `verdictContractBlock` tells the pass to look
 * for — the axis branch has always named its `REVIEW AXIS` line the same way,
 * and a contract pointing at a line that does not exist is how a focused pass
 * ends up guessing what it owns. Pure.
 */
export const passFocusBlock = (pass: StagePass, index: number, total: number): string => {
  if (!pass.focus) return ""
  if (pass.mode === "lens") {
    return (
      `REVIEW LENS ${index + 1}/${total}: ${pass.focus}. Focus exclusively on ${pass.focus}. The other lenses ` +
      `run as separate passes — don't repeat them. Record this pass's verdict via workflow_verdict as usual, ` +
      `carrying per-axis results only for the axes your lens actually bears on.`
    )
  }
  return [
    `REVIEW AXIS ${index + 1}/${total}: ${pass.focus}.`,
    `Review this change for ${pass.focus} ONLY.`,
    `The other ${total - 1} ${total === 2 ? "axis runs" : "axes run"} as separate, independent passes —`,
    "do not review them and do not report findings on them; the pass that owns each one covers it properly.",
    `Call workflow_verdict ONCE with axes: [{ axis: "${pass.focus}", verdict, findings }] —`,
    "exactly that one entry, and nothing for any other axis.",
    `Your pass merges worst-wins with the others: a Critical or Important ${pass.focus} finding fails the whole stage.`,
  ].join(" ")
}

/**
 * The scope fence appended to every WORK stage's composed prompt, the
 * counterpart to `verdictContractBlock` (see engine.ts `composePrompt`).
 *
 * The state machine only advances when a stage's turn ENDS, so a work stage
 * that keeps going — building, then verifying and reviewing its own output in
 * the same turn — does that work while the loop still sits at its own stage.
 * Its `workflow_verdict` calls are rejected ("the loop is at build, not verify"),
 * the real check stage then re-runs everything, and the turn's final message
 * claims a PASS and a folder move that never happened. Naming the boundary in
 * the prompt is the only fence that survives every dispatch path, on both
 * hosts. Pure.
 */
export const workScopeBlock = (stage: string): string =>
  [
    `STAGE SCOPE: you are running the ${stage} stage only.`,
    `Finish your turn as soon as ${stage}'s own work is done and summarize what you did —`,
    "what happens next is the loop's decision, taken after your turn ends: it fires the next stage, parks for a human, or finishes.",
    "Do not run a later stage's work (verification, review, shipping) inside this turn:",
    "it is redone anyway, and it runs while the loop is still recorded at this stage.",
    "Never call the `workflow_verdict` tool — it is rejected outside its own check stage and the rejection is audited as stage drift.",
    "Never state that the task moved, that a check passed, or that the loop finished — only the loop moves work.",
  ].join(" ")

/**
 * The plan-structure contract appended to a work stage that sets
 * `planContract` (engineering's PLAN), after the scope fence. The check-stage
 * counterpart is `verdictContractBlock`: a contract stated only in a skill or
 * a persona file is skippable, one appended mechanically at composition
 * survives every dispatch path.
 *
 * Only the `### Verification` clause is enforced deterministically (`runPark`
 * refuses to park without the heading) — it is the one clause VERIFY consumes
 * and the one a regex can check without judging prose quality. The ordered
 * steps and Out of Scope clauses are held by this contract and the human plan
 * gate. Pure.
 *
 * The observability clause is there because a criterion no check stage can
 * observe has exactly one cheap outcome, and it is a fabricated PASS. Nothing on
 * a check stage's allowlist can watch a server: `npm run dev` is admitted (it
 * matches `npm run *`) but never exits, so as a driver-run check it times out to
 * exit 124 ⇒ ERROR ⇒ `verify.onError` stops the run, and as an agent command it
 * eats the host's tool deadline. Every form that WOULD make it observable — a
 * backgrounded `&` with a redirect, `nohup`, a `timeout` wrapper, a `curl` probe
 * — is off the allowlist and must stay off: a wrapper glob is a hole, since
 * `timeout * npm run *` also matches `timeout 5 bash -c "rm -rf x && npm run dev"`
 * (quotes stop `splitSegments` from splitting). So the criterion has to be born
 * checkable, here in PLAN; VERIFY refusing to mark an unobserved criterion met
 * (see `workflow-verify`'s step 2) is the backstop, not the fix.
 */
export const planContractBlock = (stage: string): string =>
  [
    `PLAN CONTRACT: the ${stage} stage's written plan (under \`## Implementation Plan\`) MUST contain:`,
    "(1) numbered, ordered steps, each naming the file path(s) it touches;",
    "(2) a `### Verification` subsection mapping each acceptance criterion to the exact command or observable check that proves it;",
    "(3) a `### Out of Scope` subsection naming what the plan deliberately does not do.",
    "Each check named there must be one a later stage can actually run: a command that TERMINATES with an exit code,",
    "within what that stage's own bash allowlist grants. A criterion whose only proof is watching a long-running process —",
    "a dev server answering on a port, a watch build — is unobservable to the loop, and a stage that cannot observe it",
    "cannot mark it met. Restate such a criterion as the exiting check that proves the same thing (an e2e run that boots",
    "and stops the server itself, an assertion over the built artifact or config), or put it in `### Out of Scope` for the",
    "human to judge at the ship gate.",
    "The `### Verification` subsection is enforced: a plan without that heading is refused by the loop before it reaches the human gate, and the task stays queued.",
  ].join(" ")

/**
 * The plan-visualization block appended after `planContractBlock` on a work
 * stage whose effective `planVisualization` is on (`planVisualizationFor`).
 * Agent-judged by design: the human plan gate reviews the SHAPE of a change,
 * and a diagram pays off exactly when that shape is hard to hold from prose —
 * so the block states the heuristic and the author decides. No gate enforces
 * it (`runPark` is untouched): a diagram forced onto a mechanical plan is
 * review noise, and the failure mode of enforcement is a livelock, same as
 * the `hasVerificationSection` note above. Pure.
 */
export const planVisualizationBlock = (stage: string): string =>
  [
    `PLAN VISUALIZATION: when the change's shape is what the plan reviewer has to judge, the ${stage} stage's plan SHOULD include`,
    "one or more ```mermaid fenced diagrams inside `## Implementation Plan`. Include a diagram when the change involves:",
    "(a) state or lifecycle transitions (a stateDiagram showing every arc, including release/cleanup paths);",
    "(b) flow across two or more packages or hosts (a sequence or flow diagram showing who calls what across the boundary);",
    "(c) concurrency, ordering, or locking (a sequence diagram of the interleavings that matter);",
    "(d) data-shape changes (a before/after structure sketch).",
    "Skip the diagram for small or mechanical plans — it would only add review burden.",
    "No gate enforces this; it is your judgment. If a diagram and the numbered steps ever disagree, the steps are authoritative — fix or drop the diagram.",
  ].join(" ")

/**
 * The `### Verification` clause of `planContractBlock`, as `runPark` enforces
 * it. Deliberately tolerant — case-insensitive, whitespace-tolerant, `\b` so
 * "### Verification & Testing" passes — because the failure mode of strictness
 * is a livelock: every refusal releases the claim and re-queues, and a model
 * that persistently misses an exact-match string burns a PLAN run per tick.
 * Kept beside the contract text so the demand and its enforcement cannot
 * drift. Pure.
 */
export const hasVerificationSection = (plan: string): boolean => /^###\s+verification\b/im.test(plan)

/**
 * The audit note appended to the task file when `workflow_verdict` arrives from a
 * stage the loop is not at. The rejection itself is returned only to the
 * calling agent, so without this note the drift is invisible until a later
 * stage behaves oddly (a re-run check, a fabricated PASS). Pure. Hosts append
 * it at most once per stage attempt — a drifting agent may call repeatedly.
 */
export const stageDriftNote = (activeStage: string, requested: string, verdict: Verdict | null): string =>
  `Stage drift: a ${requested.toUpperCase()} verdict${verdict ? ` (${verdict})` : ""} was recorded while the loop was at ` +
  `${activeStage.toUpperCase()} — ignored. The ${activeStage.toUpperCase()} stage ran a later stage's work inside its own turn; ` +
  `its claims about that work are unverified and the loop re-ran the real stage.`

/**
 * The same drift, addressed to the ORCHESTRATOR rather than the audit trail.
 *
 * `stageDriftNote` lands in the task file, which the driving model never reads —
 * so on a host with no driver the drift was invisible exactly where it could be
 * acted on. The two failures behind it need different words, and the requested
 * stage tells them apart on its own:
 *
 *  - the requested stage IS a stage of this loop the machine has not reached —
 *    a `workflow_advance`/`workflow_stage` step was skipped and a real stage ran
 *    unrecorded, so it has to be re-run once the machine is actually there;
 *  - anything else — a stage ran a later stage's work inside its own turn, which
 *    is drift to audit, not work to recover.
 *
 * Deliberately advice and not control flow: nothing here can move the machine,
 * because the verdict it describes was never trusted. Pure.
 */
export const stageDriftAdvice = (activeStage: string, requested: string, verdict: Verdict | null): string =>
  `A ${requested.toUpperCase()} verdict${verdict ? ` (${verdict})` : ""} was offered while the loop was at ` +
  `${activeStage.toUpperCase()}, and was IGNORED — only the running stage may record its own verdict. ` +
  `If a ${requested.toUpperCase()} subagent really ran, it was spawned before the loop reached that stage ` +
  `(a workflow_advance or workflow_stage call was skipped) and its work is lost: re-run it from the action ` +
  `below, and do not report its findings as if the loop had accepted them. If nothing spawned it, the ` +
  `${activeStage.toUpperCase()} stage ran a later stage's work inside its own turn — treat its claims about ` +
  `that work as unverified.`

/**
 * The same drift once more, addressed to the THIRD audience: the agent whose
 * `workflow_verdict` call was just refused.
 *
 * `stageDriftNote` writes the audit trail and `stageDriftAdvice` reaches the
 * orchestrator on its next action — neither reaches the caller, which got a bare
 * statement of fact. That reader can do nothing about it: a stage subagent cannot
 * move the machine on either host, so it retried a call that can never succeed
 * until the stage's whole budget was gone. Hence a refusal that names what to do
 * instead, and the two things it must NOT do:
 *
 *  - not retry — the refusal means the channel worked and the loop is elsewhere;
 *  - not re-file under `activeStage` — the SubagentStop nag names the marker's
 *    stage, so a drifted REVIEW "helpfully" re-filing as VERIFY turns lost
 *    coverage into a FABRICATED verdict, which is strictly worse than none.
 *
 * `orchestrated` picks the remedy, because only one of the two hosts has a
 * caller that could act on it: on Claude Code/Qwen a model owns
 * `workflow_advance`/`workflow_stage` and can be told which call was skipped; on
 * OpenCode the driver owns transitions and those tools do not exist, so naming
 * them there is advice the host cannot execute. Pure.
 */
export const stageDriftRefusal = (
  activeStage: string,
  requested: string,
  opts: { readonly orchestrated: boolean },
): string =>
  `The loop is at ${activeStage}, not ${requested} — verdict ignored. Only the running check stage may record ` +
  `its own verdict: a ${requested.toUpperCase()} verdict admitted here would grade work that ran under ` +
  `${activeStage.toUpperCase()}'s bash allowlist and evidence ledger. Do not retry this call, and do not re-file ` +
  `it as a ${activeStage} verdict — that would record a ${activeStage.toUpperCase()} verdict nothing earned. ` +
  `Nothing you did was recorded. Stop now and say in your final output that this is stage drift` +
  (opts.orchestrated
    ? `: a workflow_advance or workflow_stage call was skipped before you were spawned, so the orchestrator has to ` +
      `advance the loop to ${requested} and run this stage again.`
    : `; the driver runs ${requested} again when the loop reaches it.`)

export const parseVerdict =(text: string, tag: string): Verdict | null => {
  if (!text) return null
  const re = new RegExp(`${tag}:\\s*(PASS|FAIL|ERROR)`, "gi")
  let last: Verdict | null = null
  for (const match of text.matchAll(re)) {
    const verdict = match[1]
    if (verdict) last = verdict.toUpperCase() as Verdict
  }
  return last
}
