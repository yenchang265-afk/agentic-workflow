import path from "node:path"
import { staleClaimMinutes } from "@agentic-workflow/core/claim-marker"
import { commitPaths, gitActor } from "@agentic-workflow/core/workflow/git"
import { auditBacklog, formatAnomalies } from "@agentic-workflow/core/task/audit"
import {
  appendNote,
  auditNote,
  isOrphanedPlanClaim,
  listByStatus,
  listClaimIds,
  releaseOrphanedClaims,
  rescueStray,
} from "@agentic-workflow/core/task/store"
import type { DoctorReport, DoctorFixResponse, HeldClaim } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { auditStatuses } from "../kindboard.js"
import { makeDrivingOracle } from "../driving.js"
import { ok, type JsonResponse } from "../http.js"

/**
 * The backlog doctor: report structural anomalies and held claims, and (on
 * /fix) apply only the unambiguous repairs. Mirrors `workflow_doctor` /
 * `/agentic-workflow:engineering doctor [fix]` exactly — the MCP server and the
 * OpenCode driver already agree, and a third divergent semantic here would be a
 * bug factory.
 *
 * The pools swept for claims come from the enabled kinds' manifests, not a
 * hardcoded list, so a custom kind's pools are covered too.
 */

const claimPools = (deps: HubDeps): string[] => [...new Set(deps.boards.flatMap((b) => b.pools))]

/** GET /api/doctor — read-only: what the sweep finds, plus which claims are held. */
export const getDoctor = async (deps: HubDeps): Promise<JsonResponse> => {
  const anomalies = await auditBacklog(deps.client, deps.directory, deps.tasksDir, auditStatuses(deps.boards))
  const findings = formatAnomalies(anomalies, deps.tasksDir)

  const oracle = await makeDrivingOracle(deps)
  const heldClaims: HeldClaim[] = []
  for (const status of claimPools(deps)) {
    for (const id of await listClaimIds(deps.sh, deps.directory, deps.tasksDir, status)) {
      heldClaims.push({ id, status })
    }
  }

  const report: DoctorReport = {
    findings,
    unknownDirs: anomalies.unknownDirs,
    strayFiles: anomalies.strayFiles,
    duplicates: anomalies.duplicates.map((d) => ({ id: d.id, statuses: [...d.statuses] })),
    heldClaims,
    // A live watcher with no stage marker is either polling idle or inside the
    // claim→marker window — surfaced so /fix can explain why it skipped claim release.
    watcherLive: oracle.watcherLive,
    ...(oracle.watcherLive && oracle.leasePid !== null ? { watcherPid: oracle.leasePid } : {}),
  }
  return ok(report)
}

/**
 * POST /api/doctor/fix — apply the unambiguous repairs: rescue strays to draft/
 * (audited), remove now-empty stray folders, release stale orphaned claim
 * markers. Duplicates are never auto-resolved — the hub is the worst place to
 * guess which copy is canonical. One commit at the end when anything was rescued.
 */
export const postDoctorFix = async (deps: HubDeps): Promise<JsonResponse> => {
  const anomalies = await auditBacklog(deps.client, deps.directory, deps.tasksDir, auditStatuses(deps.boards))
  const actor = await gitActor(deps.sh, deps.directory)

  const rescued: string[] = []
  const failed: { path: string; reason: string }[] = []
  for (const stray of anomalies.strayFiles) {
    try {
      const { id, path: newPath } = await rescueStray(deps.sh, deps.directory, deps.tasksDir, stray)
      await appendNote(deps.sh, { id, path: newPath }, auditNote(`Rescued from ${stray} — was outside every status folder`, new Date(), actor))
      rescued.push(stray)
    } catch (err) {
      // rescueStray refuses to clobber an existing draft/<id>.md — surface that
      // instead of throwing the whole fix. It stays for a human to resolve.
      failed.push({ path: stray, reason: (err as Error).message })
    }
  }

  const removedDirs: string[] = []
  for (const dir of anomalies.unknownDirs) {
    const out = await deps.sh`rmdir ${path.join(deps.directory, deps.tasksDir, dir)}`.quiet().nothrow()
    if (out.exitCode === 0) removedDirs.push(dir)
  }

  /*
   * Claim release, the delicate half. `isDriving` here must be MARKER-based, not
   * the oracle's claim-based one: every claim we might release is claimed by
   * definition, so a claim-based signal would report "driving" for all of them
   * and release nothing. Both hosts now write a stage marker while driving
   * (Claude's `.stage.json`, OpenCode's `.stage-opencode.json` — both read by
   * the oracle), but a live watcher with NO marker is still ambiguous: it may
   * be idle-polling, or inside the window between claiming a task and writing
   * the marker — releasing any claim there risks stealing the watcher's, so
   * skip claim release wholesale in that case.
   * Strays and empty dirs are unrelated and were already fixed above.
   */
  const oracle = await makeDrivingOracle(deps)
  const released: string[] = []
  let claimsSkipped = false
  if (oracle.watcherLive && oracle.markerTaskId === null) {
    claimsSkipped = true
  } else {
    const drivingByMarker = (id: string): boolean => oracle.markerTaskId === id
    for (const status of claimPools(deps)) {
      const ids = await listClaimIds(deps.sh, deps.directory, deps.tasksDir, status)
      if (ids.length === 0) continue
      const tasks = await listByStatus(deps.client, deps.directory, deps.tasksDir, status, deps.log)
      released.push(
        ...(await releaseOrphanedClaims(deps.sh, tasks, ids, path.join(deps.directory, deps.tasksDir, status), {
          isDriving: drivingByMarker,
          // A live stage can hold its marker for a whole stage timeout without
          // writing anything durable — never judge one dead before then.
          staleMinutes: staleClaimMinutes(deps.config.stageTimeoutMinutes),
          // A queued task is planless by design, so it needs the plan-claim orphan
          // rule; other pools use the default (unmatched BUILD note / missing file).
          ...(status === "queued" ? { isOrphaned: isOrphanedPlanClaim } : {}),
        })),
      )
    }
  }

  if (rescued.length > 0) {
    await commitPaths(deps.sh, deps.directory, [deps.tasksDir], `loop: doctor rescued ${rescued.length} stray task file(s) to draft/`)
  }

  const response: DoctorFixResponse = {
    rescued,
    removedDirs,
    releasedClaims: released,
    claimsSkipped,
    // Duplicates are reported, never fixed — echoed back so the UI keeps showing them.
    duplicates: anomalies.duplicates.map((d) => ({ id: d.id, statuses: [...d.statuses] })),
    ...(failed.length > 0 ? { failed } : {}),
  }
  return ok(response)
}
