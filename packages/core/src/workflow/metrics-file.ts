import path from "node:path"
import { z } from "zod"

/**
 * The structured metrics sidecar, `<tasksDir>/runs/<id>.metrics.json` — the
 * machine-readable twin of the run log's summary table. One entry is appended
 * per terminal event (done/stopped/error), mirroring the run-log convention.
 * Durable telemetry like the run logs themselves: numbers and stage names
 * only, no captured output, no secrets.
 *
 * `host` makes the observation asymmetry explicit: the opencode driver sees
 * per-stage tokens/cost (and records its sessionID so host storage can be
 * joined exactly); the Claude host never calls the LLM itself, so its entries
 * carry timing/verdicts only and tokens are joined from transcripts.
 */

export const RUN_METRICS_VERSION = 1 as const

const StageTokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
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
})

const RunEntrySchema = z.object({
  endedAt: z.string(),
  // Absent on an in-progress (`open`) entry — the run has not reached a terminal
  // event yet. No consumer reads `outcome`, so making it optional is zero-ripple.
  outcome: z.enum(["done", "stopped", "error"]).optional(),
  detail: z.string().default(""),
  host: z.enum(["opencode", "claude"]),
  sessionID: z.string().optional(),
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
