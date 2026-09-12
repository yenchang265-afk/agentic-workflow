import type { Client } from "../host.js"
import { parseRunMetrics, type RunMetrics } from "./metrics-file.js"
import { parseRunLog, type ParsedRunLog, type RunLogSummary, type RunSummaryRow } from "./runlog.js"

/**
 * The pass-level half of the cross-run metrics (design 64), shared by the
 * hub's Metrics tab and both hosts' `metrics` verb.
 *
 * The unit of analysis is the PASS — one terminal `RunLogSummary` — never the
 * file: a `runs/<id>.md` accumulates a plan pass and then a build pass, each
 * with its own cap, iteration count and verdict stream. The hub's aggregate
 * used to hold this arithmetic in its own package, so a terminal had no way
 * to ask "is the loop getting better" without a browser; and every number
 * folded the whole of `runs/` — a year of history — so a regression this
 * month read as a rounding error. `MetricsWindow` narrows the population by
 * time and by kind BEFORE anything is counted, and `weeklyTrend` is the same
 * numbers per ISO week.
 */

// --- types (the hub re-exports these; they were its own before design 64) ---

export interface BurnBucket {
  readonly from: number
  readonly to: number
  readonly passes: number
}

export interface IterationBurn {
  readonly passesMeasured: number
  readonly passesUnmeasured: number
  readonly meanRatio: number | null
  readonly medianRatio: number | null
  readonly cappedPasses: number
  readonly capTripRate: number | null
  readonly buckets: readonly BurnBucket[]
}

export interface FirstPassYield {
  readonly passesMeasured: number
  readonly passesWithoutChecks: number
  readonly cleanPasses: number
  readonly rate: number | null
}

export interface StageDuration {
  readonly stage: string
  readonly rows: number
  readonly meanSeconds: number
  readonly medianSeconds: number
  readonly maxSeconds: number
}

/** One run's on-disk evidence, already read and parsed. */
export interface RunMetricsInput {
  readonly id: string
  readonly log: ParsedRunLog
  /** Parsed `<id>.metrics.json`; null when absent or schema-invalid. */
  readonly sidecar: RunMetrics | null
}

/** The population a roll-up counts: passes ending at or after `since`, of one kind. Both optional. */
export interface MetricsWindow {
  /** Epoch ms; passes whose `at` is older are excluded. */
  readonly since?: number
  /** Only passes of this kind. Historical logs recorded no kind and are almost all engineering, so they count as engineering. */
  readonly kind?: string
}

// --- helpers ---

const BUCKET_EDGES = [0, 0.25, 0.5, 0.75] as const
const JUDGED = new Set(["PASS", "FAIL", "ERROR"])

/** A row whose verdict is a judgment (not `none`/absent) — a check stage's row. Pure. */
export const isCheckRow = (row: RunSummaryRow): boolean => row.verdict !== undefined && JUDGED.has(row.verdict)

/**
 * Per-stage aggregation label: stage names are shared across kinds, so a
 * non-engineering kind is prefixed; engineering keeps bare names so historical
 * rows (which recorded no kind) do not split into a parallel population. Pure.
 */
export const stageLabel = (kind: string | undefined, stage: string): string => (kind && kind !== "engineering" ? `${kind}/${stage}` : stage)

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((sum, x) => sum + x, 0) / xs.length)

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

export const rate = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole)

/** The kind a pass belongs to for filtering: its footer's kind, else engineering (historical logs). Pure. */
export const passKind = (pass: { readonly kind?: string }): string => pass.kind ?? "engineering"

const inWindow = (at: string | undefined, kind: string | undefined, window: MetricsWindow): boolean => {
  if (window.kind !== undefined && (kind ?? "engineering") !== window.kind) return false
  if (window.since !== undefined) {
    const t = at ? Date.parse(at) : Number.NaN
    if (Number.isNaN(t) || t < window.since) return false
  }
  return true
}

/**
 * Narrow every input to the window: passes by `at`/`kind`, sidecar entries by
 * `endedAt`/`kind`. Inputs left with neither are dropped, so `runsTotal`
 * counts what the window actually covers. An empty window is the identity. Pure.
 */
export const windowInputs = (inputs: readonly RunMetricsInput[], window: MetricsWindow): RunMetricsInput[] => {
  if (window.since === undefined && window.kind === undefined) return [...inputs]
  const out: RunMetricsInput[] = []
  for (const input of inputs) {
    const summaries = input.log.summaries.filter((p) => inWindow(p.at, p.kind, window))
    const runs = (input.sidecar?.runs ?? []).filter((e) => inWindow(e.endedAt, e.kind, window))
    if (!summaries.length && !runs.length) continue
    out.push({
      id: input.id,
      log: { ...input.log, summaries },
      sidecar: input.sidecar ? { ...input.sidecar, runs } : null,
    })
  }
  return out
}

/** `7d` / `30d` / `90d` / `all` (or a bare day count) → a window, or null when unparseable. Pure. */
export const parseWindow = (text: string | undefined, now = Date.now()): { readonly since?: number } | null => {
  const t = (text ?? "all").trim().toLowerCase()
  if (t === "all" || t === "") return {}
  const m = /^(\d{1,4})d?$/.exec(t)
  if (!m) return null
  const days = Number(m[1])
  if (!Number.isInteger(days) || days <= 0) return null
  return { since: now - days * 86_400_000 }
}

/**
 * Iteration burn as a RATIO of each pass's own cap, so runs under different
 * caps stay comparable. A pass with no `iterations used: N/M` footer is counted
 * in `passesUnmeasured` and touches nothing else. Pure.
 */
export const iterationBurn = (passes: readonly RunLogSummary[]): IterationBurn => {
  const ratios: number[] = []
  let cappedPasses = 0
  let passesUnmeasured = 0
  for (const pass of passes) {
    if (pass.iterationsUsed === undefined || pass.cap === undefined || pass.cap <= 0) {
      passesUnmeasured++
      continue
    }
    ratios.push(pass.iterationsUsed / pass.cap)
    // `>=` not `===`: a cap lowered in config mid-run can leave a pass above it.
    if (pass.iterationsUsed >= pass.cap) cappedPasses++
  }
  const buckets: BurnBucket[] = [...BUCKET_EDGES.map((from) => ({ from, to: from + 0.25, passes: 0 })), { from: 1, to: 1, passes: 0 }]
  for (const ratio of ratios) {
    const index = ratio >= 1 ? buckets.length - 1 : Math.min(BUCKET_EDGES.length - 1, Math.floor(ratio / 0.25))
    const bucket = buckets[index]
    if (bucket) buckets[index] = { ...bucket, passes: bucket.passes + 1 }
  }
  return {
    passesMeasured: ratios.length,
    passesUnmeasured,
    meanRatio: ratios.length === 0 ? null : mean(ratios),
    medianRatio: ratios.length === 0 ? null : median(ratios),
    cappedPasses,
    capTripRate: rate(cappedPasses, ratios.length),
    buckets,
  }
}

/**
 * Share of passes that got every check right the first time — from the check
 * rows, not `iterationsUsed`, so it stays measurable on footer-less logs. Pure.
 */
export const firstPassYield = (passes: readonly RunLogSummary[]): FirstPassYield => {
  let passesMeasured = 0
  let passesWithoutChecks = 0
  let cleanPasses = 0
  for (const pass of passes) {
    const checks = pass.rows.filter(isCheckRow)
    if (checks.length === 0) {
      passesWithoutChecks++
      continue
    }
    passesMeasured++
    const highest = checks.reduce((max, row) => Math.max(max, row.iteration), 0)
    if (highest <= 1 && checks.every((row) => row.verdict === "PASS")) cleanPasses++
  }
  return { passesMeasured, passesWithoutChecks, cleanPasses, rate: rate(cleanPasses, passesMeasured) }
}

/** A row carries a duration only if its wall-clock cell names a unit — `—` parses to 0 and must not count. */
const hasDuration = (row: RunSummaryRow): boolean => /\d+\s*[hms]/.test(row.duration)

export const stageDurations = (passes: readonly RunLogSummary[]): StageDuration[] => {
  const byStage = new Map<string, number[]>()
  for (const pass of passes) {
    for (const row of pass.rows) {
      if (!hasDuration(row)) continue
      const stage = stageLabel(pass.kind, row.stage)
      byStage.set(stage, [...(byStage.get(stage) ?? []), row.seconds])
    }
  }
  return [...byStage.entries()]
    .map(([stage, seconds]) => ({
      stage,
      rows: seconds.length,
      meanSeconds: mean(seconds),
      medianSeconds: median(seconds),
      maxSeconds: seconds.reduce((m, s) => (s > m ? s : m), 0),
    }))
    .sort((a, b) => b.meanSeconds * b.rows - a.meanSeconds * a.rows)
}

/** Outcome tallies keyed by the log's own word. Pure. */
export const outcomeTally = (passes: readonly RunLogSummary[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const pass of passes) counts[pass.outcome] = (counts[pass.outcome] ?? 0) + 1
  return counts
}

// --- trend ---

export interface WeekPoint {
  /** ISO date (YYYY-MM-DD) of the week's Monday, UTC. */
  readonly weekStart: string
  readonly passes: number
  readonly done: number
  readonly cappedPasses: number
  readonly capTripRate: number | null
  readonly firstPassRate: number | null
}

const mondayOf = (ms: number): string => {
  const d = new Date(ms)
  const day = (d.getUTCDay() + 6) % 7 // Monday = 0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
  return monday.toISOString().slice(0, 10)
}

/** The headline numbers per ISO week (UTC Monday), oldest first, capped at the newest `weeks`. Passes with an unparseable `at` are skipped. Pure. */
export const weeklyTrend = (passes: readonly RunLogSummary[], weeks = 12): WeekPoint[] => {
  const byWeek = new Map<string, RunLogSummary[]>()
  for (const pass of passes) {
    const t = Date.parse(pass.at)
    if (Number.isNaN(t)) continue
    const key = mondayOf(t)
    byWeek.set(key, [...(byWeek.get(key) ?? []), pass])
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-weeks)
    .map(([weekStart, ps]) => {
      const burn = iterationBurn(ps)
      return {
        weekStart,
        passes: ps.length,
        done: ps.filter((p) => p.outcome === "done").length,
        cappedPasses: burn.cappedPasses,
        capTripRate: burn.capTripRate,
        firstPassRate: firstPassYield(ps).rate,
      }
    })
}

// --- the terminal's view ---

export interface MetricsHeadline {
  readonly runs: number
  readonly passes: number
  readonly outcomes: Readonly<Record<string, number>>
  readonly burn: IterationBurn
  readonly firstPass: FirstPassYield
  readonly durations: readonly StageDuration[]
  readonly trend: readonly WeekPoint[]
  /** The kinds the (unwindowed) population carries, for the verb's usage line. */
  readonly kinds: readonly string[]
}

export const metricsHeadline = (inputs: readonly RunMetricsInput[], window: MetricsWindow = {}): MetricsHeadline => {
  const kinds = [...new Set(inputs.flatMap((i) => i.log.summaries.map(passKind)))].sort()
  const scoped = windowInputs(inputs, window)
  const passes = scoped.flatMap((i) => i.log.summaries)
  return {
    runs: scoped.length,
    passes: passes.length,
    outcomes: outcomeTally(passes),
    burn: iterationBurn(passes),
    firstPass: firstPassYield(passes),
    durations: stageDurations(passes),
    trend: weeklyTrend(passes),
    kinds,
  }
}

const pct = (r: number | null): string => (r === null ? "n/a" : `${String(Math.round(r * 100))}%`)
const secs = (s: number): string => (s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${String(Math.round(s / 60))}m` : `${String(Math.round(s))}s`)

/** The lines both hosts print for `metrics`. Pure. */
export const formatMetricsHeadline = (h: MetricsHeadline, label: string): string[] => {
  const lines = [`Loop metrics (${label}): ${String(h.passes)} pass(es) across ${String(h.runs)} run(s)`]
  if (!h.passes) {
    lines.push("  no passes in this window" + (h.kinds.length ? ` — kinds on record: ${h.kinds.join(", ")}` : ""))
    return lines
  }
  lines.push(`  outcomes: ${Object.entries(h.outcomes).map(([k, n]) => `${k} ${String(n)}`).join(" · ")}`)
  lines.push(`  cap-trip ${pct(h.burn.capTripRate)} (${String(h.burn.cappedPasses)}/${String(h.burn.passesMeasured)} measured) · first-pass yield ${pct(h.firstPass.rate)} (${String(h.firstPass.cleanPasses)}/${String(h.firstPass.passesMeasured)})`)
  if (h.durations.length) lines.push(`  slowest stages: ${h.durations.slice(0, 3).map((d) => `${d.stage} ${secs(d.meanSeconds)} mean over ${String(d.rows)}`).join(" · ")}`)
  if (h.trend.length > 1) {
    lines.push("  by week (Mon): passes · done · cap-trip · first-pass")
    for (const w of h.trend) lines.push(`    ${w.weekStart}  ${String(w.passes).padStart(3)} · ${String(w.done).padStart(3)} · ${pct(w.capTripRate).padStart(4)} · ${pct(w.firstPassRate).padStart(4)}`)
  }
  return lines
}

// --- IO: the one reader every surface shares ---

/** A file's identity for the parse cache: size AND mtime, per `transcripts.ts`'s lesson (size alone served a same-length rewrite stale). */
export interface FileStamp {
  readonly size: number
  readonly mtimeMs: number
}

/** One cached parse: the stamps of both files it was parsed from, and the result. */
export interface RunParseCacheEntry {
  readonly key: string
  readonly input: RunMetricsInput
}

export interface ReadRunInputsOptions {
  /**
   * Stat an ABSOLUTE path, or null when it does not exist. Core's `Client` has
   * no stat, so caching is opt-in through this hook (design 72): the hub
   * passes `fs.statSync`, and with it a parse is reused until either file's
   * size or mtime changes — on a DrvFs tree with hundreds of runs, re-parsing
   * everything per SSE tick was the dominant cost of the Metrics tab.
   */
  readonly stat?: (absPath: string) => FileStamp | null
  /** Process-lifetime cache keyed by run id; caller-owned so its lifetime is the caller's. */
  readonly cache?: Map<string, RunParseCacheEntry>
  /** Files read at once; a serial loop scaled latency with the whole history. */
  readonly concurrency?: number
}

const stampKey = (log: FileStamp | null, sidecar: FileStamp | null): string =>
  `${log ? `${String(log.size)}:${String(log.mtimeMs)}` : "-"}|${sidecar ? `${String(sidecar.size)}:${String(sidecar.mtimeMs)}` : "-"}`

/** Every run's two files under `<tasksDir>/runs`, parsed; `skipped` lists ids whose log could not be read. */
export const readRunInputs = async (
  client: Client,
  directory: string,
  tasksDir: string,
  opts: ReadRunInputsOptions = {},
): Promise<{ readonly inputs: RunMetricsInput[]; readonly skipped: string[] }> => {
  const rel = `${tasksDir}/runs`
  let ids: string[] = []
  try {
    const res = await client.file.list({ query: { path: rel, directory } })
    ids = (res.data ?? []).filter((n) => n.type === "file" && n.name.endsWith(".md")).map((n) => n.name.replace(/\.md$/, ""))
  } catch {
    return { inputs: [], skipped: [] }
  }
  const read = async (p: string): Promise<string | null> => {
    try {
      const res = await client.file.read({ query: { path: p, directory } })
      return res.data?.content ?? null
    } catch {
      return null
    }
  }
  const abs = (p: string): string => `${directory}/${p}`
  const one = async (id: string): Promise<RunMetricsInput | null> => {
    const logRel = `${rel}/${id}.md`
    const sidecarRel = `${rel}/${id}.metrics.json`
    let key: string | null = null
    if (opts.stat && opts.cache) {
      key = stampKey(opts.stat(abs(logRel)), opts.stat(abs(sidecarRel)))
      const hit = opts.cache.get(id)
      if (hit && hit.key === key) return hit.input
    }
    const [log, sidecar] = await Promise.all([read(logRel), read(sidecarRel)])
    if (log === null) return null
    const input: RunMetricsInput = { id, log: parseRunLog(log), sidecar: sidecar === null ? null : parseRunMetrics(sidecar) }
    if (key !== null && opts.cache) opts.cache.set(id, { key, input })
    return input
  }
  // Bounded worker pool, order preserved: a serial loop scaled latency with the
  // backlog's whole history, an unbounded fan-out materialises every log at once.
  const limit = Math.max(1, Math.floor(opts.concurrency ?? 16))
  const results = new Array<RunMetricsInput | null>(ids.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < ids.length) {
      const i = cursor++
      results[i] = await one(ids[i] as string)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, worker))
  const inputs: RunMetricsInput[] = []
  const skipped: string[] = []
  ids.forEach((id, i) => {
    const r = results[i]
    if (r) inputs.push(r)
    else skipped.push(id)
  })
  // Ids that vanished leave no stale cache entry behind.
  if (opts.cache) {
    const live = new Set(ids)
    for (const k of [...opts.cache.keys()]) if (!live.has(k)) opts.cache.delete(k)
  }
  return { inputs, skipped }
}
