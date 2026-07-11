import { parseRunLog } from "@agentic-loop/core/loop/runlog"
import { parseRunMetrics, type RunEntry } from "@agentic-loop/core/loop/metrics-file"
import type { RunTokensResponse, TokenRow } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { addTokens, attribute, windowsFromSamples, windowsFromSummary, ZERO_TOKENS, type StageWindow } from "./attribute.js"
import { readUsageRecords } from "./transcripts.js"
import { readSessionUsage } from "./opencodedb.js"

/**
 * One resolver, three sources in preference order: the metrics sidecar is
 * authoritative where its samples carry tokens (opencode runs going forward);
 * Claude-host and legacy samples fall back to transcript time-window
 * attribution (flagged estimated); opencode runs that predate token capture
 * fall back to a session-total opencode.db lookup where the runtime has
 * node:sqlite. Every degradation lands in `notes` instead of an error.
 */

/** Slack around reconstructed windows — stage stamps trail the LLM turns slightly. */
const WINDOW_SLACK_MS = 60_000

const read = async (deps: HubDeps, rel: string): Promise<string | null> => {
  const res = await deps.client.file.read({ query: { path: rel, directory: deps.directory } }).catch(() => null)
  return res?.data?.content ?? null
}

const attributedRows = async (
  deps: HubDeps,
  windows: readonly StageWindow[],
): Promise<TokenRow[]> => {
  if (windows.length === 0) return []
  const from = Math.min(...windows.map((w) => w.startMs)) - WINDOW_SLACK_MS
  const to = Math.max(...windows.map((w) => w.endMs)) + WINDOW_SLACK_MS
  const records = await readUsageRecords(deps.projectsDir, deps.directory, from, to)
  return attribute(windows, records).map(({ window, tokens, model }) => ({
    stage: window.stage,
    ...(window.lens ? { lens: window.lens } : {}),
    iteration: window.iteration,
    tokens,
    ...(model ? { model } : {}),
    source: "transcripts" as const,
    estimated: true,
  }))
}

const entryRows = async (deps: HubDeps, entry: RunEntry, notes: string[]): Promise<TokenRow[]> => {
  const rows: TokenRow[] = []
  const observed = entry.samples.filter((s) => s.tokens)
  for (const s of observed) {
    rows.push({
      stage: s.stage,
      ...(s.lens ? { lens: s.lens } : {}),
      iteration: s.iteration + 1,
      tokens: s.tokens ?? ZERO_TOKENS,
      ...(s.cost !== undefined ? { cost: s.cost } : {}),
      ...(s.model ? { model: s.model } : {}),
      source: "sidecar",
      estimated: false,
    })
  }
  const unobserved = entry.samples.filter((s) => !s.tokens)
  if (unobserved.length === 0) return rows

  if (entry.host === "claude") {
    const windows = windowsFromSamples(unobserved)
    if (windows.length === 0) {
      notes.push("claude-host samples carry no startedAt — tokens for this run are not attributable")
      return rows
    }
    const joined = await attributedRows(deps, windows)
    if (joined.length === 0) notes.push("no transcript usage found in this run's stage windows")
    return [...rows, ...joined]
  }

  // opencode entry whose samples predate token capture: session-total backfill
  if (entry.sessionID) {
    const db = await readSessionUsage(deps.opencodeDbPath, entry.sessionID)
    if (db.available) {
      rows.push({
        stage: "(session total)",
        iteration: 1,
        tokens: db.usage.tokens,
        cost: db.usage.cost,
        source: "opencode-db",
        estimated: true,
      })
    } else {
      notes.push(db.reason)
    }
  } else {
    notes.push("opencode run predates token capture and recorded no sessionID — nothing to join")
  }
  return rows
}

export const resolveRunTokens = async (deps: HubDeps, runId: string): Promise<RunTokensResponse | null> => {
  const notes: string[] = []
  const rows: TokenRow[] = []

  const sidecarRaw = await read(deps, `${deps.tasksDir}/runs/${runId}.metrics.json`)
  const sidecar = sidecarRaw !== null ? parseRunMetrics(sidecarRaw) : null
  if (sidecarRaw !== null && sidecar === null) notes.push("metrics sidecar unreadable — ignored")

  if (sidecar) {
    for (const entry of sidecar.runs) rows.push(...(await entryRows(deps, entry, notes)))
  } else {
    const logRaw = await read(deps, `${deps.tasksDir}/runs/${runId}.md`)
    if (logRaw === null) return null
    notes.push("run predates the metrics sidecar — stage windows reconstructed from the run-log summary")
    const { summaries } = parseRunLog(logRaw)
    for (const summary of summaries) {
      const joined = await attributedRows(deps, windowsFromSummary(summary))
      rows.push(...joined)
    }
    if (rows.length === 0) notes.push("no transcript usage found in the reconstructed windows")
  }

  const totals = rows.reduce((acc, r) => addTokens(acc, r.tokens), ZERO_TOKENS)
  const costs = rows.filter((r) => r.cost !== undefined)
  return {
    runId,
    rows,
    totals,
    ...(costs.length ? { cost: costs.reduce((sum, r) => sum + (r.cost ?? 0), 0) } : {}),
    notes,
  }
}
