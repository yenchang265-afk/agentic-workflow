/**
 * Deterministic check commands for check stages: the driver runs them, the
 * engine carries their results, and their exit codes floor the stage's verdict.
 *
 * The point is to stop asking a model for the one fact that is purely
 * mechanical. "Did the command exit 0" needs no reasoning, and everything the
 * loop does with it — `effectiveVerdict`, the transition table, the iteration
 * budget — is deterministic already; only the input was a self-report. See
 * docs/design/improvements/08-deterministic-gate-commands.md.
 *
 * Named `check`, not `gate`: `workflow/gate.ts` next door owns the HUMAN gate
 * verbs (approve/replan/ship) and its own `GateResult`.
 *
 * Everything here is pure except `runChecks`, which is impure over the `Shell`
 * port only — same shape as `isolate.ts` and `git.ts`.
 */

import type { CheckDef } from "../manifest/schema.js"
import type { Shell } from "../host.js"
import type { AxisResult, VerdictRecord } from "./verdict.js"

/** How much of a check's combined output rides along into the prompt. */
export const CHECK_OUTPUT_MAX = 2_000

/** The axis a stage's check results contribute to its verdict. */
export const CHECKS_AXIS = "checks"

/**
 * `pass` ⇒ exit 0. `error` ⇒ the check could not run at all. `fail` ⇒ it ran and
 * said no.
 */
export type CheckOutcome = "pass" | "fail" | "error"

export interface CheckResult {
  readonly name: string
  readonly command: string
  readonly exitCode: number
  readonly outcome: CheckOutcome
  /**
   * Tail of stdout+stderr, truncated to `CHECK_OUTPUT_MAX`. UNTRUSTED: it is
   * repo content echoed into a prompt, so every render of it carries the
   * data-not-instructions fence. The tail, not the head — a runner's failure
   * summary is at the end.
   */
  readonly output: string
}

/**
 * 0 ⇒ pass; 126/127 ⇒ error; anything else ⇒ fail. Pure.
 *
 * A shell returns 127 for "command not found" and 126 for "found but not
 * executable" — precisely "the check itself could not run", which is what ERROR
 * means (`verdict.ts`): it routes to `onError` and stops for a human instead of
 * burning a re-build iteration. `npm test` exiting 1 is a genuine FAIL.
 *
 * The residual, deliberately un-guessed: a runner that exits 1 *because* it is
 * misconfigured reads as FAIL. That is the same ambiguity a human reading CI
 * has, and a heuristic for it would be worse than the ambiguity.
 */
export const classifyExit = (exitCode: number): CheckOutcome =>
  exitCode === 0 ? "pass" : exitCode === 126 || exitCode === 127 ? "error" : "fail"

/** Keep the last `max` characters, marking what was dropped. Pure. */
const tail = (text: string, max: number): string =>
  text.length <= max ? text : `…[${text.length - max} chars elided]\n${text.slice(-max)}`

/**
 * Run a stage's checks in `dir`, in declaration order. Impure over `Shell`.
 *
 * `.nothrow()` is mandatory, not stylistic: a red check must produce a RESULT.
 * An exception here would abort the fire, and a broken test suite would look
 * like a broken loop. The `{ raw }` interpolation and the
 * `.cwd().quiet().nothrow()` chain are the `runWorktreeSetup` precedent
 * verbatim (`isolate.ts`).
 *
 * Sequential rather than concurrent: two suites in one work tree share a build
 * directory and a port, and a check that fails only when run beside another is
 * the exact non-determinism this module exists to remove.
 */
export const runChecks = async ($: Shell, defs: readonly CheckDef[], dir: string): Promise<CheckResult[]> => {
  const results: CheckResult[] = []
  for (const def of defs) {
    const cwd = def.cwd ? `${dir.replace(/\/$/, "")}/${def.cwd}` : dir
    const out = await $`${{ raw: def.command }}`.cwd(cwd).quiet().nothrow()
    const text = `${out.stdout.toString()}${out.stderr.toString()}`.trim()
    results.push({
      name: def.name,
      command: def.command,
      exitCode: out.exitCode,
      outcome: classifyExit(out.exitCode),
      output: tail(text, CHECK_OUTPUT_MAX),
    })
  }
  return results
}

/** Whether any check came back non-green. Pure. */
export const anyFailed = (results: readonly CheckResult[]): boolean => results.some((r) => r.outcome !== "pass")

/**
 * The block a stage prompt renders: one line per check, plus the failing ones'
 * output. Pre-rendered because `TemplateValue` has no arrays. Pure.
 */
export const checksBlock = (results: readonly CheckResult[]): string => {
  const lines = results.map((r) => `- ${r.name} (${r.command}) → ${r.outcome.toUpperCase()} (exit ${r.exitCode})`)
  const outputs = results
    .filter((r) => r.outcome !== "pass" && r.output)
    .map((r) => `\n--- ${r.name} output ---\n${r.output}`)
  return [...lines, ...outputs].join("\n")
}

/**
 * The commands a stage's checks ran, for seeding `ObservedEvidence`.
 *
 * Load-bearing, not a convenience: `evidenceIssue` rejects a PASS the host
 * observed no activity behind. A stage told (correctly) not to re-run the
 * checks can otherwise do nothing observable, get its PASS rejected, and record
 * a FAIL on a green suite. These commands ARE observed — the host ran them and
 * holds their exit codes — so they belong in that pass's observations. Pure.
 */
export const checkCommands = (results: readonly CheckResult[]): string[] => results.map((r) => r.command)

/**
 * The synthetic axis a stage's check results contribute, or null when they all
 * passed (or there were none) — in which case nothing is merged and the record
 * is byte-identical to today's. Pure.
 *
 * Every non-green check becomes a `critical` finding, which is what makes the
 * floor work through the mechanism the repo already trusts: `axisVerdict`
 * worsens the axis, `effectiveVerdict` worsens the stage, and `worstOf` makes
 * ERROR outrank FAIL — so a missing runner routes to `onError` and a red suite
 * to `onFail`, with no new control flow.
 */
export const checkAxis = (results: readonly CheckResult[]): AxisResult | null => {
  const bad = results.filter((r) => r.outcome !== "pass")
  if (!bad.length) return null
  return {
    axis: CHECKS_AXIS,
    verdict: bad.some((r) => r.outcome === "error") ? "ERROR" : "FAIL",
    findings: bad.map((r) => ({
      severity: "critical" as const,
      detail:
        `${r.name} exited ${r.exitCode} (${r.command})` +
        (r.outcome === "error" ? " — the check could not run" : "") +
        (r.output ? `\n${r.output}` : ""),
    })),
  }
}

/**
 * Merge the check axis into a recorded verdict. Pure.
 *
 * Applied at FINALIZATION, one site per host — never inside `admitVerdict`, and
 * never by pre-seeding the record. A seeded axis would have to be re-applied
 * everywhere the record is cleared, and worse, it would flow through
 * `blockingFindingsIssue` and get a genuine agent PASS *rejected* rather than
 * derived down. (`admitVerdict` also runs `evidenceIssue` now, so a pre-seeded
 * record would be judged against observed evidence too.) Flooring after
 * admission leaves the admission contract exactly as it is.
 *
 * Identity on empty results — including on a null record, which stays null so
 * "the stage never recorded a verdict" keeps meaning that.
 */
export const withCheckFloor = (record: VerdictRecord | null, results: readonly CheckResult[]): VerdictRecord | null => {
  const axis = checkAxis(results)
  if (!axis || !record) return record
  return { ...record, axes: [...(record.axes ?? []).filter((a) => a.axis !== CHECKS_AXIS), axis] }
}
