import path from "node:path"
import { staleClaimMinutes } from "@agentic-workflow/core/claim-marker"
import { gitActor } from "@agentic-workflow/core/workflow/git"
import { commitBacklog } from "@agentic-workflow/core/workflow/gate"
import { auditBacklog, formatAnomalies } from "@agentic-workflow/core/task/audit"
import {
  appendNote,
  auditNote,
  claimWriterDead,
  confirmedStrayPlanRequestIds,
  isOrphanedPlanClaim,
  isOrphanedStartedClaim,
  listByStatus,
  listClaimIds,
  releaseOrphanedClaims,
  rescueStray,
} from "@agentic-workflow/core/task/store"
import { revokeStrayPlanRequests } from "@agentic-workflow/core/task/plan-request"
import { taskDrivenByStageMarker } from "@agentic-workflow/core/workflow/stage-marker"
import type { DoctorReport, DoctorFixResponse, HeldClaim } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { auditStatuses } from "../kindboard.js"
import { withGateLock } from "./gate.js"
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

  // A plan request whose task has left queued/ reorders nothing and blocks
  // nothing, but it lingers — so the doctor names it rather than leaving a
  // marker on disk with no explanation.
  const queued = await listByStatus(deps.client, deps.directory, deps.tasksDir, "queued", deps.log)
  // CONFIRMED strays only: the listing can lag the real FS (and skips
  // unparseable files), and a request written after it — the Plan button, a
  // just-approved task — must never be judged against it.
  const strayRequests = await confirmedStrayPlanRequestIds(
    deps.sh,
    deps.directory,
    deps.tasksDir,
    queued.map((t) => t.id),
    "queued",
    deps.log,
  )

  const report: DoctorReport = {
    findings,
    strayRequests,
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
export const postDoctorFix = async (deps: HubDeps): Promise<JsonResponse> =>
  // Under the gate lock like every other mutating route: a fix that interleaves
  // with a Plan click or an approve can otherwise judge markers against a board
  // state mid-change.
  withGateLock(deps.directory, () => doctorFix(deps))

const doctorFix = async (deps: HubDeps): Promise<JsonResponse> => {
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
    for (const status of claimPools(deps)) {
      const ids = await listClaimIds(deps.sh, deps.directory, deps.tasksDir, status)
      if (ids.length === 0) continue
      // Per-id marker LIVENESS (task match + deadline + writer pid via core's
      // taskDrivenByStageMarker), never "the first parseable marker's taskId":
      // that weaker test both pinned a SIGKILLed driver's task forever (its
      // leftover marker read as driving, so the wedged claim the gate verbs
      // send users here for could never be released) and let a stale marker
      // for task A shadow the live one for task B (first-parseable-wins),
      // releasing B's claim out from under a live drive.
      const liveDriven = new Set<string>()
      for (const id of ids) {
        if (await taskDrivenByStageMarker(deps.sh, deps.directory, deps.tasksDir, id)) liveDriven.add(id)
      }
      const tasks = await listByStatus(deps.client, deps.directory, deps.tasksDir, status, deps.log)
      released.push(
        ...(await releaseOrphanedClaims(deps.sh, tasks, ids, path.join(deps.directory, deps.tasksDir, status), {
          isDriving: (id) => liveDriven.has(id),
          // A live stage can hold its marker for a whole stage timeout without
          // writing anything durable — never judge one dead before then.
          staleMinutes: staleClaimMinutes(deps.config.stageTimeoutMinutes),
          // …unless the stamp PROVES the claimer is gone. The window is only a
          // proxy for that; where the pid answers it directly, a human clicking
          // doctor should not wait 75 minutes for a dead process.
          writerDead: (ref) => claimWriterDead(deps.sh, ref),
          // A queued task is planless by design, so it needs the plan-claim
          // orphan rule; started pools get the doctor rule
          // (`isOrphanedStartedClaim`): stale + undriven is dead whatever the
          // body says — the default rule's `isClaimable` gate made the doctor
          // useless against exactly the wedged markers users are sent here for.
          isOrphaned: status === "queued" ? isOrphanedPlanClaim : isOrphanedStartedClaim,
        })),
      )
    }
  }

  // A stray request's task has left the folder, so nothing can be driving it —
  // but the REQUEST marker itself can be racing a human's Plan click, so only
  // strays CONFIRMED against the real filesystem are revoked, and a request
  // written after that pass is left alone. No commit — never tracked.
  const queued = await listByStatus(deps.client, deps.directory, deps.tasksDir, "queued", deps.log)
  const confirmedStrays = await confirmedStrayPlanRequestIds(
    deps.sh,
    deps.directory,
    deps.tasksDir,
    queued.map((t) => t.id),
    "queued",
    deps.log,
  )
  const revokedRequests = await revokeStrayPlanRequests(deps.sh, deps.directory, deps.tasksDir, confirmedStrays)

  if (rescued.length > 0) {
    // Through core's `commitBacklog`, never raw `commitPaths`: that helper is the
    // single home of the `ignoreBacklog` policy ("callers must not re-derive
    // it"), and under the default `ignoreBacklog: true` it re-asserts the
    // `info/exclude` entry instead of committing — a raw commit here could land
    // the whole backlog (task files plus runs/ machine state) into the user's
    // history on a clone whose exclude entry was never asserted. Both CLI
    // hosts' doctors and the hub's own task editor already route through the
    // policy; this was the one writer that drifted.
    await commitBacklog(deps.sh, deps.directory, deps.config, `loop: doctor rescued ${rescued.length} stray task file(s) to draft/`)
  }

  const response: DoctorFixResponse = {
    rescued,
    removedDirs,
    releasedClaims: released,
    revokedRequests,
    claimsSkipped,
    // Duplicates are reported, never fixed — echoed back so the UI keeps showing them.
    duplicates: anomalies.duplicates.map((d) => ({ id: d.id, statuses: [...d.statuses] })),
    ...(failed.length > 0 ? { failed } : {}),
  }
  return ok(response)
}
