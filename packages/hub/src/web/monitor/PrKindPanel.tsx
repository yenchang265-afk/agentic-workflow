import type { ActiveResponse, KindBoardInfo } from "../../shared/api.js"
import { useEvents } from "../events.js"
import { repoPath, useRepo } from "../repo.js"
import { useJson } from "../useJson.js"
import { Chip } from "../ui/Chip.js"

/** " · N failed attempts" suffix, or "" when none — shared across the ledger chips. */
const failedSuffix = (n: number) => (n > 0 ? ` · ${n} failed attempt${n === 1 ? "" : "s"}` : "")

/**
 * Monitor view for a non-backlog kind (workSource "github-pr", "dependency-scan",
 * or "ci-runs"): there are no status folders to board, so it surfaces the kind's
 * description plus THIS kind's own dedup ledgers from the live-activity data. Each
 * ledger list is filtered to `info.kind` so two enabled kinds of the same source
 * type (e.g. pr-sitter + review-sitter) don't show each other's rows (C4), and
 * dep-sitter/main-sitter surface their real per-package / per-head state (C8).
 */
export const PrKindPanel = ({ info }: { info: KindBoardInfo }) => {
  const { versions } = useEvents()
  const { repoId } = useRepo()
  const { data } = useJson<ActiveResponse>(repoPath("/api/active", repoId), [versions.active, repoId])

  const prLedgers = (data?.prLedgers ?? []).filter((l) => l.kind === info.kind)
  const depLedgers = (data?.depLedgers ?? []).filter((l) => l.kind === info.kind)
  const headLedgers = (data?.headLedgers ?? []).filter((l) => l.kind === info.kind)

  const chips =
    info.sourceType === "dependency-scan"
      ? depLedgers.map((l) => (
          <Chip key={`${l.kind}-${l.pkg}`}>
            {l.pkg}
            {l.versionHandled ? ` → ${l.versionHandled}` : ""}
            {failedSuffix(l.failedAttempts)}
          </Chip>
        ))
      : info.sourceType === "ci-runs"
        ? headLedgers.map((l) => (
            <Chip key={`${l.kind}-${l.sha}`}>
              {l.sha.slice(0, 7)}
              {l.handled ? " · handled" : ""}
              {failedSuffix(l.failedAttempts)}
            </Chip>
          ))
        : prLedgers.map((l) => (
            <Chip key={`${l.kind ?? ""}-${l.pr}`}>
              PR #{l.pr}
              {failedSuffix(l.failedAttempts)}
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
