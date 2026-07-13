import type { LoopState } from "../loop/state.js"

/**
 * The work-source abstraction the unified scheduler polls: a source knows how
 * to find claimable units of work for one loop kind (backlog folders, GitHub
 * PRs, …), claim them atomically, and release a claim whose drive died before
 * doing real work. The scheduler (`scheduler/scheduler.ts`) walks sources in
 * priority order; the winning item carries a fully-constructed entry
 * `LoopState`, so drivers stay source-agnostic.
 */

/** Why a poll claimed nothing — the message, and whether a human can act on it. */
export interface ClaimSkipReason {
  readonly message: string
  readonly actionable: boolean
}

/** One claimed unit of work, ready to drive. */
export interface WorkItem {
  readonly id: string
  /** The loop kind (manifest) that drives this item. */
  readonly loopKind: string
  /** Human-facing title for toasts/logs. */
  readonly title: string
  readonly entryStage: string
  /** The fully-constructed loop state to enter at. */
  readonly state: LoopState
  /** The toast/log line announcing the claim. */
  readonly claimMessage: string
  /** Source-private handle (e.g. the backlog `Task`). */
  readonly ref?: unknown
}

/** How a claimed item's drive ended. */
export interface TerminalOutcome {
  readonly kind: "done" | "park" | "stop" | "error"
  readonly message: string
  /**
   * Set on a `stop` that must NOT be recorded as a failed attempt: a transient
   * `onError` stop (environment/tooling error the manifest asks to retry next poll)
   * or a mid-drive interrupt/human ESC. A dedup ledger leaves the target/head
   * claimable so the next poll re-claims it. Absent ⇒ record the failed attempt
   * (a genuine iteration-cap exhaustion), preserving prior behavior (C2).
   */
  readonly retryable?: boolean
}

export interface WorkSource {
  readonly loopKind: string
  /**
   * Walk this source's pools in priority order and atomically claim the next
   * item. Exactly one of `item`/`skip` is non-null: a claim, or the reason
   * there was nothing to claim.
   */
  claimNext(): Promise<{ item: WorkItem | null; skip: ClaimSkipReason | null }>
  /** Release a claimed item whose drive died before real work started. */
  release(item: WorkItem): Promise<void>
  /**
   * Record how a drive ended (dedup ledgers, claim-marker cleanup). Drivers
   * call this once after every terminal action on a scheduler-claimed item.
   * Optional: the backlog source needs none (terminal bookkeeping rides the
   * task file the drive already annotates).
   */
  onTerminal?(item: WorkItem, outcome: TerminalOutcome): Promise<void>
}
