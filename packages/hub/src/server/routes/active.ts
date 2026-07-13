import { z } from "zod"
import { isLeaseStale, readLeaseOwner, staleThresholdMs } from "@agentic-loop/core/scheduler/lease"
import { listSnapshotIds } from "@agentic-loop/core/loop/persist"
import type {
  ActiveResponse,
  DepLedgerView,
  HeadLedgerView,
  KindBoardInfo,
  LeaseView,
  PrLedgerView,
  StageMarker,
} from "../../shared/api.js"
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

const DepLedgerSchema = z.object({
  pkg: z.string(),
  versionHandled: z.string().optional(),
  updatedAt: z.string().optional(),
  failedAttempts: z.array(z.unknown()).default([]),
})

const HeadLedgerSchema = z.object({
  sha: z.string(),
  handled: z.boolean().default(false),
  updatedAt: z.string().optional(),
  failedAttempts: z.array(z.unknown()).default([]),
})

/**
 * List and parse the `<prefix>*.json` ledger files under `runs/<kind>` for every
 * board of a given source type, mapping each into a view. The shared shape behind
 * the three source-specific readers below — a source keeps its dedup ledgers under
 * its own `runs/<kind>/` (core's ledgerDir), one file per deduped unit.
 */
const scanLedgers = async <T>(
  deps: HubDeps,
  sourceType: KindBoardInfo["sourceType"],
  prefix: string,
  parse: (content: string, kind: string) => T | null,
): Promise<T[]> => {
  const kinds = deps.boards.filter((b) => b.sourceType === sourceType).map((b) => b.kind)
  const out: T[] = []
  for (const kind of kinds) {
    const listed = await deps.client.file
      .list({ query: { path: `${deps.tasksDir}/runs/${kind}`, directory: deps.directory } })
      .catch(() => null)
    const files = (listed?.data ?? []).filter((n) => n.type === "file" && n.name.startsWith(prefix) && n.name.endsWith(".json"))
    for (const file of files) {
      const read = await deps.client.file.read({ query: { path: file.path, directory: deps.directory } }).catch(() => null)
      const content = read?.data?.content
      if (!content) continue
      try {
        const view = parse(content, kind)
        if (view) out.push(view)
      } catch {
        // unparseable ledger — skip
      }
    }
  }
  return out
}

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

// Each work source keeps its ledgers under `runs/<kind>/`; scan every enabled kind of
// each source type (not just the literal pr-sitter/dep-sitter/main-sitter), stamped with
// its kind so the monitor can show each kind ONLY its own dedup state (C4/C8).
const readPrLedgers = async (deps: HubDeps): Promise<PrLedgerView[]> => {
  const ledgers = await scanLedgers<PrLedgerView>(deps, "github-pr", "pr-", (content, kind) => {
    const parsed = LedgerSchema.safeParse(JSON.parse(content))
    if (!parsed.success) return null
    const l = parsed.data
    return {
      pr: l.pr,
      kind,
      ...(l.updatedAt ? { updatedAt: l.updatedAt } : {}),
      ...(l.headShaHandled ? { headShaHandled: l.headShaHandled } : {}),
      failedAttempts: l.failedAttempts.length,
    }
  })
  ledgers.sort((a, b) => a.pr - b.pr || (a.kind ?? "").localeCompare(b.kind ?? ""))
  return ledgers
}

const readDepLedgers = async (deps: HubDeps): Promise<DepLedgerView[]> => {
  const ledgers = await scanLedgers<DepLedgerView>(deps, "dependency-scan", "dep-", (content, kind) => {
    const parsed = DepLedgerSchema.safeParse(JSON.parse(content))
    if (!parsed.success) return null
    const l = parsed.data
    return {
      kind,
      pkg: l.pkg,
      ...(l.versionHandled ? { versionHandled: l.versionHandled } : {}),
      ...(l.updatedAt ? { updatedAt: l.updatedAt } : {}),
      failedAttempts: l.failedAttempts.length,
    }
  })
  ledgers.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.kind.localeCompare(b.kind))
  return ledgers
}

const readHeadLedgers = async (deps: HubDeps): Promise<HeadLedgerView[]> => {
  const ledgers = await scanLedgers<HeadLedgerView>(deps, "ci-runs", "head-", (content, kind) => {
    const parsed = HeadLedgerSchema.safeParse(JSON.parse(content))
    if (!parsed.success) return null
    const l = parsed.data
    return {
      kind,
      sha: l.sha,
      handled: l.handled,
      ...(l.updatedAt ? { updatedAt: l.updatedAt } : {}),
      failedAttempts: l.failedAttempts.length,
    }
  })
  ledgers.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.sha.localeCompare(b.sha))
  return ledgers
}

export const getActive = async (deps: HubDeps, now: Date = new Date()): Promise<JsonResponse> => {
  const response: ActiveResponse = {
    stage: await readStageMarker(deps),
    lease: await readLease(deps, now),
    snapshotIds: await listSnapshotIds(deps.client, deps.directory, deps.tasksDir),
    prLedgers: await readPrLedgers(deps),
    depLedgers: await readDepLedgers(deps),
    headLedgers: await readHeadLedgers(deps),
  }
  return ok(response)
}
