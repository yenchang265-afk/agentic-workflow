import type { ClaimSkipReason, WorkItem, WorkSource } from "../source/types.js"

/**
 * The unified scheduler step both hosts' triggers call (OpenCode: idle events
 * + the watch timer; Claude Code: `loop_claim`). One tick: walk the enabled
 * loop kinds' work sources in priority order and claim the first available
 * item. Sources own atomicity (claim markers, ledgers); the scheduler owns
 * only ordering. Host-agnostic and side-effect-free beyond the sources' own
 * claims.
 */

export interface PolledClaim {
  readonly source: WorkSource
  readonly item: WorkItem
}

export interface PollResult {
  /** The winning claim, or null when every source came up empty. */
  readonly claim: PolledClaim | null
  /** Skip reasons from the sources walked before (and including) the empty ones. */
  readonly skips: readonly ClaimSkipReason[]
}

/** Walk `sources` in priority order; first successful claim wins. */
export const pollOnce = async (sources: readonly WorkSource[]): Promise<PollResult> => {
  const skips: ClaimSkipReason[] = []
  for (const source of sources) {
    const { item, skip } = await source.claimNext()
    if (item) return { claim: { source, item }, skips }
    if (skip) skips.push(skip)
  }
  return { claim: null, skips }
}

/** Merge skip reasons into one displayable reason; null when there were none. */
export const combineSkips = (skips: readonly ClaimSkipReason[]): ClaimSkipReason | null => {
  if (skips.length === 0) return null
  if (skips.length === 1) return skips[0] ?? null
  return {
    message: skips.map((s) => s.message).join(" · "),
    actionable: skips.some((s) => s.actionable),
  }
}
