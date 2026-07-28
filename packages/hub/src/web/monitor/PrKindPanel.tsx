import type { ActiveResponse, FailedAttemptView, KindBoardInfo } from "../../shared/api.js"
import { useEvents } from "../events.js"
import { repoPath, useRepo } from "../repo.js"
import { useResource } from "../resource.js"
import { Chip } from "../ui/Chip.js"

/** " · N failed attempts" suffix, or "" when none — shared across the ledger chips (here and ActivePanel). */
export const failedSuffix = (n: number) => (n > 0 ? ` · ${n} failed attempt${n === 1 ? "" : "s"}` : "")

/** " · updated <local time>" suffix, or "" when the ledger predates the stamp. */
export const updatedSuffix = (at?: string) => (at ? ` · updated ${new Date(at).toLocaleString()}` : "")

/**
 * Tooltip text for the attempts behind a "N failed attempts" count — one line
 * per attempt, whichever of its source-specific fields exist (trigger + head
 * sha for PRs, target version for deps, timestamp alone for heads).
 */
export const attemptsTitle = (details?: readonly FailedAttemptView[]): string | undefined =>
  details?.length
    ? details
        .map((a) =>
          [a.trigger, a.target, a.headSha?.slice(0, 7), a.at ? new Date(a.at).toLocaleString() : undefined]
            .filter(Boolean)
            .join(" · "),
        )
        .filter((line) => line.length > 0)
        .join("\n") || undefined
    : undefined

/**
 * Monitor view for a non-backlog kind (workSource "pull-request", "dependency-scan",
 * or "ci-runs"): there are no status folders to board, so it surfaces the kind's
 * description plus THIS kind's own dedup ledgers from the live-activity data. Each
 * ledger list is filtered to `info.kind` so two enabled kinds of the same source
 * type (e.g. pr-sitter + review-sitter) don't show each other's rows (C4), and
 * dep-sitter/main-sitter surface their real per-package / per-head state (C8).
 */
export const PrKindPanel = ({ info }: { info: KindBoardInfo }) => {
  const { versions } = useEvents()
  const { repoId } = useRepo()
  const { data, error } = useResource<ActiveResponse>(repoPath("/api/active", repoId), [versions.active, repoId])

  if (error) return <div className="error-banner">Could not load ledgers: {error}</div>

  const prLedgers = (data?.prLedgers ?? []).filter((l) => l.kind === info.kind)
  const depLedgers = (data?.depLedgers ?? []).filter((l) => l.kind === info.kind)
  const headLedgers = (data?.headLedgers ?? []).filter((l) => l.kind === info.kind)

  const chips =
    info.sourceType === "dependency-scan"
      ? depLedgers.map((l) => (
          <Chip key={`${l.kind}-${l.pkg}`} title={attemptsTitle(l.failedAttemptDetails)}>
            {l.pkg}
            {l.versionHandled ? ` → ${l.versionHandled}` : ""}
            {failedSuffix(l.failedAttempts)}
            {updatedSuffix(l.updatedAt)}
          </Chip>
        ))
      : info.sourceType === "ci-runs"
        ? headLedgers.map((l) => (
            <Chip key={`${l.kind}-${l.sha}`} title={attemptsTitle(l.failedAttemptDetails)}>
              {l.sha.slice(0, 7)}
              {l.handled ? " · handled" : ""}
              {failedSuffix(l.failedAttempts)}
              {updatedSuffix(l.updatedAt)}
            </Chip>
          ))
        : prLedgers.map((l) => (
            <Chip key={`${l.kind ?? ""}-${l.pr}`} title={attemptsTitle(l.failedAttemptDetails)}>
              PR #{l.pr}
              {failedSuffix(l.failedAttempts)}
              {updatedSuffix(l.updatedAt)}
            </Chip>
          ))

  const empty =
    info.sourceType === "dependency-scan"
      ? "No dependency upgrades handled yet — ledgers appear after the first claim."
      : info.sourceType === "ci-runs"
        ? "No branch heads handled yet — ledgers appear after the first claim."
        : "No PRs handled yet — ledgers appear after the first claim."

  return (
    <div className="pr-kind">
      <p className="pr-kind-desc">{info.description}</p>
      {chips.length === 0 ? <div className="placeholder">{empty}</div> : <div className="summary-chips">{chips}</div>}
    </div>
  )
}
