import { z } from "zod"
import { isLeaseStale, readLeaseOwner, staleThresholdMs } from "@agentic-loop/core/scheduler/lease"
import { listSnapshotIds } from "@agentic-loop/core/loop/persist"
import type { ActiveResponse, LeaseView, PrLedgerView, StageMarker } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { ok, type JsonResponse } from "../http.js"

/**
 * The "what is running right now" view. Every element is optional on disk:
 * `.stage.json` exists only while the Claude host runs a stage, the watch
 * lease only while an opencode watcher lives, snapshots only for crashed or
 * mid-flight loops, pr-sitter ledgers only once that kind has acted.
 */

const StageMarkerSchema = z.object({
  kind: z.string().optional(),
  stage: z.string(),
  taskId: z.string().nullable().optional(),
  worktree: z.string().nullable().optional(),
  deadline: z.number().nullable().optional(),
})

const LedgerSchema = z.object({
  pr: z.number(),
  updatedAt: z.string().optional(),
  headShaHandled: z.string().optional(),
  failedAttempts: z.array(z.unknown()).default([]),
})

const readStageMarker = async (deps: HubDeps): Promise<StageMarker | null> => {
  const read = await deps.client.file
    .read({ query: { path: `${deps.tasksDir}/runs/.stage.json`, directory: deps.directory } })
    .catch(() => null)
  const content = read?.data?.content
  if (!content) return null
  try {
    const parsed = StageMarkerSchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const readLease = async (deps: HubDeps, now: Date): Promise<LeaseView | null> => {
  const owner = await readLeaseOwner(deps.sh, deps.directory, deps.tasksDir)
  if (!owner) return null
  return {
    pid: owner.pid,
    host: owner.host,
    startedAt: owner.startedAt,
    heartbeatAt: owner.heartbeatAt,
    stale: isLeaseStale(owner, now, staleThresholdMs(owner.intervalMs)),
  }
}

const readPrLedgers = async (deps: HubDeps): Promise<PrLedgerView[]> => {
  // Each PR-shaped kind keeps its ledgers under `runs/<kind>/` (core's ledgerDir);
  // scan every enabled github-pr kind, not just the literal pr-sitter, so a second
  // PR kind's ledgers surface too — each view stamped with its kind.
  const prKinds = deps.boards.filter((b) => b.sourceType === "github-pr").map((b) => b.kind)
  const ledgers: PrLedgerView[] = []
  for (const kind of prKinds) {
    const listed = await deps.client.file
      .list({ query: { path: `${deps.tasksDir}/runs/${kind}`, directory: deps.directory } })
      .catch(() => null)
    const files = (listed?.data ?? []).filter((n) => n.type === "file" && n.name.endsWith(".json"))
    for (const file of files) {
      const read = await deps.client.file.read({ query: { path: file.path, directory: deps.directory } }).catch(() => null)
      const content = read?.data?.content
      if (!content) continue
      try {
        const parsed = LedgerSchema.safeParse(JSON.parse(content))
        if (!parsed.success) continue
        const l = parsed.data
        ledgers.push({
          pr: l.pr,
          kind,
          ...(l.updatedAt ? { updatedAt: l.updatedAt } : {}),
          ...(l.headShaHandled ? { headShaHandled: l.headShaHandled } : {}),
          failedAttempts: l.failedAttempts.length,
        })
      } catch {
        // unparseable ledger — skip
      }
    }
  }
  ledgers.sort((a, b) => a.pr - b.pr || (a.kind ?? "").localeCompare(b.kind ?? ""))
  return ledgers
}

export const getActive = async (deps: HubDeps, now: Date = new Date()): Promise<JsonResponse> => {
  const response: ActiveResponse = {
    stage: await readStageMarker(deps),
    lease: await readLease(deps, now),
    snapshotIds: await listSnapshotIds(deps.client, deps.directory, deps.tasksDir),
    prLedgers: await readPrLedgers(deps),
  }
  return ok(response)
}
