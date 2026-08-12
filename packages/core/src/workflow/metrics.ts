import { redact } from "../task/redact.js"
import type { Stage } from "./state.js"
import type { Verdict, VerdictRecord } from "./verdict.js"

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

/**
 * How often one tool was invoked in a stage pass, and how many of those calls
 * failed — the "what did the agent DO" signal the captured text alone can't
 * answer. Aggregated by tool name (not a per-call list) so a BUILD firing
 * hundreds of edits stays a handful of rows, cheap to store and read.
 */
export interface StageToolUsage {
  readonly tool: string
  readonly count: number
  /** Calls whose tool state ended in error. */
  readonly errors: number
}

/** Structured verdict mirror persisted with a check-stage sample (see `verdictStructure`). */
export interface SampleCriterion {
  readonly criterion: string
  readonly pass: boolean
}

export interface SampleFinding {
  readonly severity: string
  readonly detail: string
  readonly location?: string
}

export interface SampleAxis {
  readonly axis: string
  readonly verdict: string
  readonly findings?: readonly SampleFinding[]
}

/**
 * One proof-of-work citation from a PASS (see `workflow/evidence.ts`).
 *
 * Persisting these is what makes the declared-evidence rule worth having: the
 * gate only proves a PASS *cited* something, so the citations have to outlive
 * the run for a human to ever check them against the diff.
 */
export interface SampleEvidence {
  readonly kind: string
  readonly ref: string
  readonly result?: string
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
  /**
   * Characters in the prompt actually fired for this pass. Records what the model
   * received, including any host-appended suffix (a review lens, a verdict-retry
   * nag) — without it, prompt growth across a struggling run's iterations is
   * invisible and a context budget becomes folklore.
   */
  readonly promptChars?: number
  /** Characters a stage context budget elided from that prompt; omitted when none were. */
  readonly promptElided?: number
  /** Per-tool call counts for this pass — omitted when the host observes no tool parts. */
  readonly tools?: readonly StageToolUsage[]
  /** Distinct file paths the pass wrote/edited — omitted when none were touched. */
  readonly files?: readonly string[]
  /** Per-criterion outcomes from the pass's VerdictRecord (check stages only). */
  readonly criteria?: readonly SampleCriterion[]
  /** Per-axis findings from the pass's VerdictRecord (check stages only), redacted. */
  readonly axes?: readonly SampleAxis[]
  /**
   * Where this check stage's commands came from (`ChecksSource`) — check
   * stages only. `resolveStageChecks` computed this all along and both hosts
   * dropped it, which made "the plan declared checks and VERIFY silently ran
   * none" indistinguishable on disk from "no checks were ever declared".
   */
  readonly checksSource?: string
  /** How many declared checks were refused/dropped at resolution (warnings count). */
  readonly checksRefused?: number
  /**
   * The stage's required axes no configured review lens covers (check stages
   * running lens passes only) — the structured twin of the lens-downgrade
   * audit note, so the hub can count downgraded runs without parsing prose.
   */
  readonly unreviewedAxes?: readonly string[]
  /** Proof-of-work citations backing a PASS (check stages only), redacted. */
  readonly evidence?: readonly SampleEvidence[]
}

/**
 * The persistable mirror of a VerdictRecord's structure: criteria as-is, axis
 * findings with `detail`/`location` pushed through `redact` — findings quote
 * code and reviewer prose, and the sidecar is a committed file just like the
 * run log (whose append already redacts). Pure. Returns {} when the record
 * carries no structure, so spreading it into a sample adds no empty arrays.
 *
 * Evidence `ref` is redacted for a sharper reason than the findings are: a
 * citation is a command line the stage really ran, and the sitter kinds reach
 * Azure DevOps as `curl -u :$PAT …`. An unredacted `ref` would commit a resolved
 * token to the sidecar, so this is the one field where skipping redaction leaks
 * a credential rather than merely quoting code.
 */
export const verdictStructure = (
  record: VerdictRecord | null | undefined,
): { criteria?: readonly SampleCriterion[]; axes?: readonly SampleAxis[]; evidence?: readonly SampleEvidence[] } => {
  if (!record) return {}
  return {
    ...(record.criteria?.length ? { criteria: record.criteria } : {}),
    ...(record.evidence?.length
      ? {
          evidence: record.evidence.map((e) => ({
            kind: e.kind,
            ref: redact(e.ref).text,
            ...(e.result ? { result: redact(e.result).text } : {}),
          })),
        }
      : {}),
    ...(record.axes?.length
      ? {
          axes: record.axes.map((a) => ({
            axis: a.axis,
            verdict: a.verdict,
            ...(a.findings?.length
              ? {
                  findings: a.findings.map((f) => ({
                    severity: f.severity,
                    detail: redact(f.detail).text,
                    ...(f.location ? { location: redact(f.location).text } : {}),
                  })),
                }
              : {}),
          })),
        }
      : {}),
  }
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
  kind?: string,
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
  // The optional leading `kind:` segment namespaces stage metrics across kinds
  // (engineering `build` vs a sitter's `build`). Leading, so the load-bearing
  // FOOTER regex in runlog.ts extends with one optional prefix group and every
  // existing log still parses byte-identically.
  const kindNote = kind ? `kind: ${kind} · ` : ""
  const footer = `${kindNote}iterations used: ${iterationsUsed}/${maxIterations} · total: ${formatDuration(totalMs)}${costNote} · outcome: ${outcome}`
  return `${header}\n\n${table}\n\n${footer}`
}
