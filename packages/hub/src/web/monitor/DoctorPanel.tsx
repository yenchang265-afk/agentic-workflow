import { useState } from "react"
import type { DoctorFixResponse, DoctorReport } from "../../shared/api.js"
import { postJson } from "../api.js"
import { useEvents } from "../events.js"
import { repoPath, useRepo } from "../repo.js"
import { Button } from "../ui/Button.js"
import { Confirm } from "../ui/Confirm.js"
import { useResource } from "../resource.js"

/**
 * The backlog doctor panel. `Board.tsx` opens it from what used to be a
 * dead-end "backlog anomalies — run doctor" chip that pointed you at a CLI verb.
 *
 * Report is read-only; the one write (fix) rescues strays to draft/, removes
 * emptied stray folders, and releases stale orphaned claim markers — a commit,
 * hence a confirm. Duplicates are never touched.
 */

const nonEmpty = (r: DoctorReport): boolean =>
  r.findings.length > 0 || r.heldClaims.length > 0 || r.strayRequests.length > 0

export const DoctorPanel = () => {
  const { repoId } = useRepo()
  const { versions } = useEvents()
  const { data, error } = useResource<DoctorReport>(repoPath("/api/doctor", repoId), [repoId, versions.backlog, versions.gate])
  const [result, setResult] = useState<DoctorFixResponse | null>(null)
  const [fixError, setFixError] = useState<string | null>(null)

  // Rendered from any backlog kind's board: the doctor reads the shared
  // backlog root, and the audit judges folders against every enabled kind's
  // status set — the repairs are the same wherever it was opened from.
  if (error) return <div className="error-banner">Could not run the doctor: {error}</div>
  if (!data) return null
  if (!nonEmpty(data) && !result) return <p className="doctor-clean">Backlog is clean — nothing to repair.</p>

  // Only strays and empty dirs and claims and stray requests are auto-fixable;
  // duplicates never are.
  const fixable =
    data.strayFiles.length + data.unknownDirs.length + data.heldClaims.length + data.strayRequests.length

  const runFix = async (): Promise<void> => {
    try {
      setResult(await postJson<DoctorFixResponse>(repoPath("/api/doctor/fix", repoId), {}))
      setFixError(null)
    } catch (e) {
      setResult(null)
      setFixError((e as Error).message)
    }
  }

  return (
    <div className="doctor">
      {data.watcherLive && (
        <p className="doctor-note">
          A watch session is live{data.watcherPid ? ` (pid ${data.watcherPid})` : ""} and writes no stage marker, so the
          hub can’t tell which task it’s driving. Claim release is skipped while it runs — stop it and re-run to release
          stuck claims. Strays and empty folders are still repaired.
        </p>
      )}

      {data.findings.length > 0 && (
        <ul className="doctor-findings">
          {data.findings.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}

      {data.heldClaims.length > 0 && (
        <p className="doctor-note">
          Held claim markers: {data.heldClaims.map((c) => `${c.id} (${c.status})`).join(", ")} — a stale, undriven one is
          released by fix; a live one is kept.
        </p>
      )}

      {data.strayRequests.length > 0 && (
        <p className="doctor-note">
          Plan requests whose task has left <code>queued/</code>: {data.strayRequests.join(", ")} — inert, and dropped
          by fix. Unlike a claim these are never kept: nothing can be driving a task that isn’t there.
        </p>
      )}

      {data.duplicates.length > 0 && (
        <p className="doctor-note doctor-note--warn">
          Duplicate ids never auto-resolved (the hub can’t know which copy is canonical):{" "}
          {data.duplicates.map((d) => `${d.id} in ${d.statuses.join(" + ")}`).join("; ")} — keep one, and use the
          Abandon button on the rest.
        </p>
      )}

      <div className="doctor-actions">
        <Confirm
          title="Repair the backlog?"
          detail={
            <>
              Rescues stray task files to <code>draft/</code>, removes emptied stray folders, and releases stale orphaned
              claim markers — then commits. Duplicate ids are left untouched.
            </>
          }
          confirmLabel="Repair"
          onConfirm={runFix}
          trigger={<Button variant="primary" disabled={fixable === 0}>{fixable > 0 ? `Repair ${fixable} item${fixable === 1 ? "" : "s"}` : "Nothing to auto-fix"}</Button>}
        />
        {result && (
          <span className="doctor-result">
            {[
              result.rescued.length ? `rescued ${result.rescued.length}` : "",
              result.removedDirs.length ? `removed ${result.removedDirs.length} folder(s)` : "",
              result.releasedClaims.length ? `released ${result.releasedClaims.length} claim(s)` : "",
              result.revokedRequests.length ? `dropped ${result.revokedRequests.length} stray request(s)` : "",
              result.claimsSkipped ? "claims skipped (watcher live)" : "",
              result.failed?.length ? `${result.failed.length} left for you` : "",
            ]
              .filter(Boolean)
              .join(" · ") || "nothing to repair"}
          </span>
        )}
        {fixError && <span className="doctor-error">{fixError}</span>}
      </div>

      {result?.failed?.length ? (
        <ul className="doctor-findings">
          {result.failed.map((f) => (
            <li key={f.path}>
              <code>{f.path}</code> — {f.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
