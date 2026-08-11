import type { RunLogSummary, RunSummaryRow } from "@agentic-workflow/core/workflow/runlog"
import type { StageVerdicts, VerdictFlips } from "../../shared/api.js"
import { stageLabel } from "./stage-label.js"

/**
 * Verdict tallies and thrash detection over run-log summaries. Pure.
 *
 * A *check row* is one the parser gave a verdict: `PASS`, `FAIL` or `ERROR`. It
 * excludes both a `—` cell (which `parseRunLog` drops to `undefined`, e.g. a
 * build row) and the literal `"none"` — a check that ran and declined to judge.
 * Neither is evidence about whether a check passed, so neither may move a rate.
 */

const JUDGED = new Set(["PASS", "FAIL", "ERROR"])

/** True when the parser gave this row a real judgement (`PASS`/`FAIL`/`ERROR`). Pure. */
export const isCheckRow = (row: RunSummaryRow): boolean => row.verdict !== undefined && JUDGED.has(row.verdict)

interface Tally {
  pass: number
  fail: number
  error: number
  none: number
}

const empty = (): Tally => ({ pass: 0, fail: 0, error: 0, none: 0 })

/**
 * Per-stage verdict counts across every pass, **lens variants merged** — the
 * question this answers is "how often does review fail", not which lens failed.
 * Stages that never carried a verdict produce no row at all.
 */
export const stageVerdicts = (passes: readonly RunLogSummary[]): StageVerdicts[] => {
  const byStage = new Map<string, Tally>()
  const bump = (stage: string, key: keyof Tally): void => {
    const tally = byStage.get(stage) ?? empty()
    byStage.set(stage, { ...tally, [key]: tally[key] + 1 })
  }
  for (const pass of passes) {
    for (const row of pass.rows) {
      const stage = stageLabel(pass.kind, row.stage)
      if (row.verdict === "none") bump(stage, "none")
      else if (row.verdict === "PASS") bump(stage, "pass")
      else if (row.verdict === "FAIL") bump(stage, "fail")
      else if (row.verdict === "ERROR") bump(stage, "error")
    }
  }
  return [...byStage.entries()]
    .map(([stage, t]) => ({ stage, ...t }))
    .sort((a, b) => b.pass + b.fail + b.error + b.none - (a.pass + a.fail + a.error + a.none))
}

/**
 * Verdict transitions between consecutive iterations of the same check.
 *
 * Two boundaries matter, and getting either wrong invents flips that never
 * happened:
 *
 * - **The lens is part of the key.** A multi-lens review emits several rows per
 *   iteration; keying by stage alone interleaves `review (security)` with
 *   `review (performance)` and reports transitions between two rows of the same
 *   iteration.
 * - **A pass is the boundary.** A plan pass ending FAIL followed by a build pass
 *   opening PASS is not a recovery — they are independent runs sharing a file.
 * - **An iteration is one endpoint.** A verdict retry re-emits the same
 *   stage+lens+iteration; two rows of one iteration are one verdict recorded
 *   twice, never a transition.
 *
 * Only PASS and FAIL rows enter a stream. An `ERROR` (an infra failure, not a
 * judgement) between a FAIL and a later PASS must not consume that adjacency and
 * hide the recovery — the thrash signal is about pass/fail churn, so a stage
 * erroring out is simply skipped rather than treated as a transition endpoint.
 */
export const verdictFlips = (passes: readonly RunLogSummary[]): VerdictFlips => {
  let failToPass = 0
  let passToFail = 0
  let failToFail = 0
  let passesWithFlips = 0

  for (const pass of passes) {
    const streams = new Map<string, RunSummaryRow[]>()
    for (const row of pass.rows) {
      if (row.verdict !== "PASS" && row.verdict !== "FAIL") continue
      const key = `${row.stage}|${row.lens ?? ""}`
      streams.set(key, [...(streams.get(key) ?? []), row])
    }
    let flipsHere = 0
    for (const rows of streams.values()) {
      // One row per ITERATION before counting adjacencies: a verdict retry
      // re-emits the same stage+lens+iteration (see metrics/fanout.ts), and an
      // adjacent same-iteration pair read as a transition that never happened.
      // The last row wins — it is the verdict the loop acted on.
      const byIteration = new Map<number, RunSummaryRow>()
      for (const row of [...rows].sort((a, b) => a.iteration - b.iteration)) byIteration.set(row.iteration, row)
      const ordered = [...byIteration.values()]
      for (let i = 1; i < ordered.length; i++) {
        const from = ordered[i - 1]?.verdict
        const to = ordered[i]?.verdict
        if (from === "FAIL" && to === "PASS") (failToPass++, flipsHere++)
        else if (from === "PASS" && to === "FAIL") (passToFail++, flipsHere++)
        else if (from === "FAIL" && to === "FAIL") (failToFail++, flipsHere++)
      }
    }
    if (flipsHere > 0) passesWithFlips++
  }

  return { failToPass, passToFail, failToFail, passesWithFlips }
}
