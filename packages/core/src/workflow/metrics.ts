import type { Stage } from "./state.js"
import type { Verdict } from "./verdict.js"

/**
 * Per-run stage metrics — wall-clock and verdict history — rendered into the
 * run log on a terminal event so "is the loop converging or burning
 * iterations?" is answerable weeks later. The accumulator lives in the driver
 * (keyed by session, in-memory); the rendering here is **pure**. See
 * docs/design/improvements/06.
 */

/** Token counts for one stage pass, when the host can observe them (opencode). */
export interface StageTokens {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface StageSample {
  readonly stage: Stage
  readonly iteration: number
  readonly ms: number
  /** Present for check stages (verify/review) only. */
  readonly verdict?: Verdict | "none"
  /** The review lens, when this sample is one lens pass of a multi-lens review. */
  readonly lens?: string
  /** ISO start of the pass — lets host transcripts be joined by time window. */
  readonly startedAt?: string
  /** Present only when the host observes usage (the Claude host cannot). */
  readonly tokens?: StageTokens
  readonly cost?: number
  readonly model?: string
}

export type Outcome = "done" | "stopped" | "error"

/** Format a millisecond duration as `2m 41s` / `45s` / `1h 03m`. Pure. */
export const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`
  return `${s}s`
}

/** Format a token count as `12.3k` / `456` / `2.1M`. Pure. */
export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** A sample's in/out token cell (`12.3k/1.2k`), or `—` when unobserved. Pure. */
const tokenCell = (t: StageTokens | undefined): string =>
  t ? `${formatTokens(t.input + t.cacheRead + t.cacheWrite)}/${formatTokens(t.output + t.reasoning)}` : "—"

const costCell = (cost: number | undefined): string => (cost !== undefined ? `$${cost.toFixed(4)}` : "—")

/**
 * Render a `## Run summary` markdown block from the collected samples. Pure —
 * the caller stamps the timestamp and appends via `appendRunLog`. Token and
 * cost columns appear only when at least one sample carries usage, so logs
 * from hosts that can't observe tokens render exactly as before.
 */
export const renderRunSummary = (
  samples: readonly StageSample[],
  outcome: Outcome,
  detail: string,
  maxIterations: number,
  stampISO: string,
): string => {
  const iterationsUsed = samples.reduce((max, s) => Math.max(max, s.iteration + 1), 0)
  const totalMs = samples.reduce((sum, s) => sum + s.ms, 0)
  const withTokens = samples.some((s) => s.tokens !== undefined || s.cost !== undefined)
  const header = `## Run summary · ${outcome}${detail ? `: ${detail}` : ""} · ${stampISO}`
  const rows = samples
    .map((s, i) => {
      const stage = s.lens ? `${s.stage} (${s.lens})` : s.stage
      const verdict = s.verdict ?? "—"
      const base = `| ${i + 1} | ${stage} | ${s.iteration + 1} | ${verdict} | ${formatDuration(s.ms)} |`
      return withTokens ? `${base} ${tokenCell(s.tokens)} | ${costCell(s.cost)} |` : base
    })
    .join("\n")
  const head = withTokens
    ? `| # | stage | iter | verdict | wall-clock | tokens | cost |\n|---|-------|------|---------|------------|--------|------|`
    : `| # | stage | iter | verdict | wall-clock |\n|---|-------|------|---------|------------|`
  const table = samples.length ? `${head}\n${rows}` : "_(no stages ran)_"
  const totalCost = samples.reduce((sum, s) => sum + (s.cost ?? 0), 0)
  const costNote = withTokens ? ` · cost: $${totalCost.toFixed(4)}` : ""
  const footer = `iterations used: ${iterationsUsed}/${maxIterations} · total: ${formatDuration(totalMs)}${costNote} · outcome: ${outcome}`
  return `${header}\n\n${table}\n\n${footer}`
}
