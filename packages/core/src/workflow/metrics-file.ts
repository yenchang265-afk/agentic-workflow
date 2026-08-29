import path from "node:path"
import { z } from "zod"

/**
 * The structured metrics sidecar, `<tasksDir>/runs/<id>.metrics.json` — the
 * machine-readable twin of the run log's summary table. One entry is appended
 * per terminal event (done/stopped/error), mirroring the run-log convention.
 * Durable telemetry like the run logs themselves: numbers, stage names, tool
 * names and the paths a stage wrote — never captured output, never secrets.
 *
 * `host` makes the observation asymmetry explicit: the opencode driver sees
 * per-stage tokens/cost (and records its sessionID so host storage can be
 * joined exactly); the Claude and Qwen hosts never call the LLM themselves —
 * their stages run as agent turns the host owns — so their entries carry
 * timing/verdicts only and tokens are joined from transcripts.
 *
 * SCHEMA EVOLUTION: the `version` literal is reserved for BREAKING shape
 * changes; additive fields ride v1 as `.optional()`. This is load-bearing, not
 * convention: `parseRunMetrics` fails closed and both writers treat a null
 * parse as "start fresh", so a version bump makes every not-yet-updated writer
 * (mixed plugin versions routinely share one repo) silently discard the whole
 * sidecar history on its next append. zod's default strip mode makes additive
 * fields safe in both directions — old files parse under the new schema, new
 * files parse under the old.
 */

export const RUN_METRICS_VERSION = 1 as const

const StageTokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
})

const StageToolUsageSchema = z.object({
  tool: z.string(),
  count: z.number().int().min(0),
  errors: z.number().int().min(0),
})

/** One acceptance criterion's judged outcome, mirrored from the stage's VerdictRecord. */
const SampleCriterionSchema = z.object({
  criterion: z.string(),
  pass: z.boolean(),
})

const SampleFindingSchema = z.object({
  severity: z.string(),
  detail: z.string(),
  location: z.string().optional(),
})

/**
 * One proof-of-work citation backing a PASS, mirrored from the stage's
 * VerdictRecord (`ref`/`result` already redacted at the writer).
 *
 * Declared here and not only on `StageSample`: zod strips what it does not
 * declare, and this sidecar is read-modify-write (`parseRunMetrics` →
 * `appendRunEntry`), so an undeclared field is not merely invisible to readers
 * — the next run's first flush REWRITES every prior entry without it. The
 * citations outliving the run is the whole point of the declared-evidence rule
 * (`metrics.ts`), so this is the field that pays for it.
 */
const SampleEvidenceSchema = z.object({
  kind: z.string(),
  ref: z.string(),
  result: z.string().optional(),
})

/** One review axis's verdict + findings, mirrored from the stage's VerdictRecord. */
const SampleAxisSchema = z.object({
  axis: z.string(),
  verdict: z.string(),
  findings: z.array(SampleFindingSchema).readonly().optional(),
})

const MetricsSampleSchema = z.object({
  stage: z.string(),
  iteration: z.number().int().min(0),
  ms: z.number(),
  verdict: z.string().optional(),
  lens: z.string().optional(),
  startedAt: z.string().optional(),
  tokens: StageTokensSchema.optional(),
  cost: z.number().optional(),
  model: z.string().optional(),
  // Optional, and it matters: `parseRunMetrics` fails closed and both writers
  // treat a null parse as "start fresh", so a required field here would silently
  // discard the history in every sidecar written before it existed.
  promptChars: z.number().int().min(0).optional(),
  promptElided: z.number().int().min(0).optional(),
  // Readonly so the driver's `StageSample` (readonly arrays) assigns to `RunEntry`.
  tools: z.array(StageToolUsageSchema).readonly().optional(),
  files: z.array(z.string()).readonly().optional(),
  // Structured verdict mirror (check stages only): per-criterion outcomes and
  // per-axis findings, redacted at the writer. The run log keeps them fused as
  // prose; these are what a "top recurring findings" roll-up joins on.
  criteria: z.array(SampleCriterionSchema).readonly().optional(),
  axes: z.array(SampleAxisSchema).readonly().optional(),
  // Check-stage command provenance (`ChecksSource`) + refused/dropped count —
  // what a check-discovery success-rate roll-up joins on.
  checksSource: z.string().optional(),
  checksRefused: z.number().int().min(0).optional(),
  // Proof-of-work citations backing a PASS, redacted at the writer.
  evidence: z.array(SampleEvidenceSchema).readonly().optional(),
})

const RunEntrySchema = z.object({
  endedAt: z.string(),
  // Absent on an in-progress (`open`) entry — the run has not reached a terminal
  // event yet. No consumer reads `outcome`, so making it optional is zero-ripple.
  outcome: z.enum(["done", "stopped", "error"]).optional(),
  detail: z.string().default(""),
  host: z.enum(["opencode", "claude", "qwen"]),
  sessionID: z.string().optional(),
  /** The workflow kind this run belonged to — without it, `build` in engineering
   *  and `build` in a sitter tally into one metrics row. */
  kind: z.string().optional(),
  /** Only meaningful with `outcome: "stopped"`: true when the stop was a
   *  transient environment error the source may retry, not cap exhaustion. */
  retryable: z.boolean().optional(),
  samples: z.array(MetricsSampleSchema),
  /** True while the run is still live: a per-stage flush wrote samples-so-far.
   *  The terminal event replaces this entry with its finalized twin. */
  open: z.boolean().optional(),
})

export const RunMetricsSchema = z.object({
  version: z.literal(RUN_METRICS_VERSION),
  runs: z.array(RunEntrySchema),
})

export type MetricsSample = z.infer<typeof MetricsSampleSchema>
export type RunEntry = z.infer<typeof RunEntrySchema>
export type RunMetrics = z.infer<typeof RunMetricsSchema>

/** Absolute path of a task's metrics sidecar. Pure. */
export const metricsPath = (directory: string, tasksDir: string, id: string): string =>
  path.join(directory, tasksDir, "runs", `${id}.metrics.json`)

/** Parse a sidecar's raw JSON; null on unparseable or schema-invalid content (fail closed). Pure. */
export const parseRunMetrics = (raw: string): RunMetrics | null => {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const result = RunMetricsSchema.safeParse(json)
  return result.success ? result.data : null
}

/**
 * Append one run entry to a sidecar's existing content (null/unparseable →
 * start fresh — telemetry never fails a run over a corrupt file) and return
 * the new serialized document. Pure.
 */
export const appendRunMetrics = (existingRaw: string | null, run: RunEntry): string => {
  const existing = existingRaw !== null ? parseRunMetrics(existingRaw) : null
  const doc: RunMetrics = {
    version: RUN_METRICS_VERSION,
    runs: [...(existing?.runs ?? []), run],
  }
  return JSON.stringify(doc, null, 2)
}

/**
 * Upsert one run entry (null/unparseable → start fresh). If the last existing
 * entry is still `open`, replace it; otherwise append. This is what makes the
 * live flow safe: each per-stage flush writes a full `open: true` snapshot that
 * overwrites the previous flush, and the terminal event writes the finalized
 * entry (no `open`) that overwrites the trailing open one — so at most one open
 * entry ever exists and finalize never leaves a duplicate. Pure.
 */
export const upsertRunMetrics = (existingRaw: string | null, run: RunEntry): string => {
  const existing = existingRaw !== null ? parseRunMetrics(existingRaw) : null
  const prior = existing?.runs ?? []
  const replaceLast = prior.length > 0 && prior[prior.length - 1]?.open === true
  const runs = replaceLast ? [...prior.slice(0, -1), run] : [...prior, run]
  return JSON.stringify({ version: RUN_METRICS_VERSION, runs }, null, 2)
}
