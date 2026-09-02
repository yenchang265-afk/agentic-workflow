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
import type { Shell, ShellOutput, ShellPromise } from "../host.js"
import { withUnassessedGuard, type AxisResult, type VerdictRecord } from "./verdict.js"

/** How much of a check's combined output rides along into the prompt. */
export const CHECK_OUTPUT_MAX = 2_000

/**
 * The exit code a timed-out check reports — the `timeout(1)` convention, so a
 * host that shells out to `timeout` and one that kills the child itself agree.
 */
export const CHECK_TIMEOUT_EXIT = 124

/** Wall-clock cap per check when the caller names none. */
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60_000

/** The axis a stage's check results contribute to its verdict. */
export const CHECKS_AXIS = "checks"

/**
 * How many times a check that FAILED is run again before its failure is
 * believed (design 50). One: a fail-then-pass is the flake signature, and a
 * second failure is confirmation enough — a third run would only be paid by
 * genuinely red suites, which are the common case. `error` and `pass` are never
 * rerun: a missing runner does not come back, and a green check proved itself.
 */
export const CHECK_RERUNS = 1

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
  /** Extra runs taken after a first failure (at most `CHECK_RERUNS`). Absent when the first run settled it. */
  readonly reruns?: number
  /**
   * The first run failed and a rerun passed. `outcome` is the rerun's PASS —
   * the stage is not floored — but `output` keeps the FIRST run's failing tail,
   * and `checkAxis` turns the flake into a non-blocking `suggestion` finding so
   * it reaches the ship gate instead of vanishing behind a green line.
   */
  readonly flaky?: true
}

/**
 * 0 ⇒ pass; 124/126/127 ⇒ error; anything else ⇒ fail. Pure.
 *
 * A shell returns 127 for "command not found" and 126 for "found but not
 * executable" — precisely "the check itself could not run", which is what ERROR
 * means (`verdict.ts`): it routes to `onError` and stops for a human instead of
 * burning a re-build iteration. `npm test` exiting 1 is a genuine FAIL.
 *
 * 124 (`CHECK_TIMEOUT_EXIT`) is listed EXPLICITLY rather than left to fall
 * through to FAIL. A FAIL sends the loop back to BUILD, which re-fires the same
 * check, which hangs again — burning every iteration to the cap on a stage that
 * never produced a result. ERROR stops once, with the check named.
 *
 * The residual, deliberately un-guessed: a runner that exits 1 *because* it is
 * misconfigured reads as FAIL. That is the same ambiguity a human reading CI
 * has, and a heuristic for it would be worse than the ambiguity.
 */
export const classifyExit = (exitCode: number): CheckOutcome =>
  exitCode === 0 ? "pass" : exitCode === CHECK_TIMEOUT_EXIT || exitCode === 126 || exitCode === 127 ? "error" : "fail"

/** Keep the last `max` characters, marking what was dropped. Pure. */
const tail = (text: string, max: number): string =>
  text.length <= max ? text : `…[${text.length - max} chars elided]\n${text.slice(-max)}`

/** A synthetic `ShellOutput` for a check the loop gave up waiting on. Pure. */
const timedOutResult = (timeoutMs: number): ShellOutput => ({
  exitCode: CHECK_TIMEOUT_EXIT,
  stdout: { toString: () => "" },
  stderr: { toString: () => `timed out after ${Math.round(timeoutMs / 1000)}s — the loop stopped waiting` },
})

/**
 * Await one check under a wall-clock cap.
 *
 * Prefers the host's own `timeout` when it has one, because only the host can
 * KILL the child; the race is the fallback for a host whose shell cannot
 * (Bun's `$`). The fallback's residual is explicit: the drive loop is unblocked,
 * the child may still be running. Bounding the loop is the point — a hanging
 * check with no cap wedges the whole run with no way out, since neither host's
 * stage deadline covers the check phase (OpenCode's stage timer races the model
 * session only; the Claude host tests its deadline in `workflow_advance`, and
 * checks run back in `workflow_stage`).
 */
const awaitCheck = async (started: ShellPromise, timeoutMs: number): Promise<ShellOutput> => {
  if (typeof started.timeout === "function") return started.timeout(timeoutMs)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      started,
      // NOT unref'd, deliberately. An unref'd timer does not hold the event loop
      // open — and in the case this exists for, a check that never settles, the
      // pending shell promise holds nothing open either, so the loop drains and
      // the timeout never fires. `finally` clears the timer on the normal path,
      // which is what unref would otherwise have bought.
      new Promise<ShellOutput>((resolve) => {
        timer = setTimeout(() => resolve(timedOutResult(timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

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
 *
 * `timeoutMs` is DEFAULTED rather than required so a host that forgets to thread
 * the config knob still runs bounded — the failure mode of an unbounded check is
 * a wedged loop, which no caller should be able to opt into by omission.
 *
 * `onCheck` fires before each check starts, with the check and its effective
 * cap. It is the LIVENESS seam: the check phase runs before the fire's own
 * stage-marker write and claim restamp, on a stamp as old as the previous
 * stage's whole runtime, and sequential checks legally compound past the stale
 * window — so the hosts restamp their claim there, bounding the gap another
 * process can observe to one check's cap instead of the phase's total. Not
 * wrapped in a catch: the hosts' restamps are internally best-effort already,
 * and a callback that genuinely throws has lost the very guarantee it exists
 * for — that must surface, not be paved over into a silent unstamped phase.
 */
export const runChecks = async (
  $: Shell,
  defs: readonly CheckDef[],
  dir: string,
  timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS,
  onCheck?: (def: CheckDef, capMs: number) => Promise<void> | void,
): Promise<CheckResult[]> => {
  const results: CheckResult[] = []
  for (const def of defs) {
    const cwd = def.cwd ? `${dir.replace(/\/$/, "")}/${def.cwd}` : dir
    // A check's own cap wins over the stage-wide one. Without it the stage cap is
    // set by the slowest check, and every faster one is effectively unbounded.
    const cap = def.timeoutMinutes ? def.timeoutMinutes * 60_000 : timeoutMs
    const once = async (): Promise<{ exitCode: number; outcome: CheckOutcome; output: string }> => {
      // Fired per RUN, not per check: a rerun is another full cap on a stamp
      // that has already aged by one cap, which is exactly the gap the
      // restamp exists to close.
      await onCheck?.(def, cap)
      const out = await awaitCheck($`${{ raw: def.command }}`.cwd(cwd).quiet().nothrow(), cap)
      const text = `${out.stdout.toString()}${out.stderr.toString()}`.trim()
      return { exitCode: out.exitCode, outcome: classifyExit(out.exitCode), output: tail(text, CHECK_OUTPUT_MAX) }
    }
    const first = await once()
    // Confirm before blaming: a `fail` — and only a `fail` — is run once more.
    // Without this a flaky suite sent the loop back to BUILD with a `critical`
    // finding for a defect that does not exist, and BUILD then "fixed" it.
    let last = first
    let reruns = 0
    while (last.outcome === "fail" && reruns < CHECK_RERUNS) {
      last = await once()
      reruns++
    }
    const flaky = reruns > 0 && last.outcome === "pass"
    results.push({
      name: def.name,
      command: def.command,
      exitCode: last.exitCode,
      outcome: last.outcome,
      // A flake keeps the FAILING run's tail — that is the evidence a human
      // wants; the passing run printed nothing worth reading.
      output: flaky ? first.output : last.output,
      ...(reruns ? { reruns } : {}),
      ...(flaky ? { flaky: true as const } : {}),
    })
  }
  return results
}

/**
 * Total wall-clock budget of a check list: each check's own cap, else the
 * stage-wide default — the most `runChecks` can legally spend. Hosts advertise
 * `now + this` as the stage-marker deadline before the first check runs;
 * without it the PREVIOUS stage's expired deadline stands for the whole phase,
 * which `taskDrivenByStageMarker` reads as a dead run and recover's
 * crash-evidence arm treats as safe to take over. Pure.
 */
export const checksBudgetMs = (defs: readonly CheckDef[], timeoutMs: number = DEFAULT_CHECK_TIMEOUT_MS): number =>
  // Every check may legally run 1 + CHECK_RERUNS times; the budget is an UPPER
  // bound on the phase, so it counts the reruns whether or not they happen.
  // Advertising the single-run sum would let a rerun phase outlive its own
  // deadline and read as a dead run to `taskDrivenByStageMarker`.
  defs.reduce((sum, def) => sum + (def.timeoutMinutes ? def.timeoutMinutes * 60_000 : timeoutMs), 0) * (1 + CHECK_RERUNS)

/** Whether any check came back non-green. Pure. */
export const anyFailed = (results: readonly CheckResult[]): boolean => results.some((r) => r.outcome !== "pass")

/**
 * The block a stage prompt renders: one line per check, plus the failing ones'
 * output. Pre-rendered because `TemplateValue` has no arrays. Pure.
 */
export const checksBlock = (results: readonly CheckResult[]): string => {
  const lines = results.map(
    (r) =>
      `- ${r.name} (${r.command}) → ${r.outcome.toUpperCase()} (exit ${r.exitCode})` +
      (r.flaky
        ? " — FLAKY: the first run failed and a rerun passed; not a regression, but name it in your verdict"
        : r.reruns
          ? ` — failed ${1 + r.reruns} times running`
          : ""),
  )
  const outputs = results
    .filter((r) => (r.outcome !== "pass" || r.flaky) && r.output)
    .map((r) => `\n--- ${r.name} ${r.flaky ? "first-run (failing) output" : "output"} ---\n${r.output}`)
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
  const flaky = results.filter((r) => r.flaky)
  if (!bad.length && !flaky.length) return null
  return {
    axis: CHECKS_AXIS,
    // Flakes alone leave the axis a PASS: a `suggestion` is non-blocking, so the
    // floor does not fire — but the finding rides `suggestionFindings` to the
    // ship gate, where "this suite flaked" is a fact the human should weigh.
    verdict: bad.some((r) => r.outcome === "error") ? "ERROR" : bad.length ? "FAIL" : "PASS",
    findings: [
      ...bad.map((r) => ({
        severity: "critical" as const,
        detail:
          `${r.name} exited ${r.exitCode} (${r.command})` +
          (r.outcome === "error" ? " — the check could not run" : r.reruns ? ` — failed ${1 + r.reruns} times running` : "") +
          (r.output ? `\n${r.output}` : ""),
      })),
      ...flaky.map((r) => ({
        severity: "suggestion" as const,
        detail: `${r.name} (${r.command}) is FLAKY — failed once, passed on rerun` + (r.output ? `\n${r.output}` : ""),
      })),
    ],
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

/**
 * The ONE finalization call both hosts make on a check stage's accumulated
 * record: floor it with the driver-run checks, then refuse a declared PASS
 * whose every axis was unassessed (`withUnassessedGuard`). Bundled into a
 * single export so a host cannot apply the floor and forget the guard — the
 * same silent-drop failure `verdictFeedbackBlock` names. Order is load-bearing:
 * a red or broken check adds the (assessed) checks axis first, so its FAIL or
 * ERROR wins and only a green-check, assessed-nothing PASS trips the guard.
 * Identity on empty results and on null. Pure.
 */
export const finalizeCheckRecord = (record: VerdictRecord | null, results: readonly CheckResult[]): VerdictRecord | null =>
  withUnassessedGuard(withCheckFloor(record, results))
