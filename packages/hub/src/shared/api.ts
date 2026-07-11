import type { BacklogSummary, TaskStatus } from "@agentic-loop/core/task/store"
import type { BacklogAnomalies } from "@agentic-loop/core/task/audit"
import type { LoopManifest } from "@agentic-loop/core/manifest/schema"
import type { ParsedRunLog } from "@agentic-loop/core/loop/runlog"
import type { StageTokens } from "@agentic-loop/core/loop/metrics"

export type { ParsedRunLog, RunLogStageSection, RunLogSummary, RunSummaryRow } from "@agentic-loop/core/loop/runlog"
export type { StageTokens } from "@agentic-loop/core/loop/metrics"

/**
 * The hub's wire types, shared verbatim by the node server and the browser
 * bundle. Type-only imports from core keep the two sides in lockstep with the
 * real backlog/manifest shapes without pulling core code into the SPA.
 */

/** A task card on the monitor board — frontmatter summary, no body. */
export interface TaskCard {
  readonly id: string
  readonly title: string
  readonly type?: string
  readonly priority: number
  readonly labels: readonly string[]
  readonly acceptance: readonly string[]
  readonly paired: boolean
  readonly hasPlan: boolean
}

export interface BacklogResponse {
  readonly statuses: readonly TaskStatus[]
  readonly tasks: Readonly<Record<TaskStatus, readonly TaskCard[]>>
  readonly summary: BacklogSummary
  readonly claimedIds: readonly string[]
  /** Structural anomalies from the backlog audit; null when the sweep found none. */
  readonly anomalies: BacklogAnomalies | null
}

/** One `> <event> [<ISO> by <actor>]` audit blockquote from a task body. */
export interface AuditNote {
  readonly event: string
  readonly at: string
  readonly by: string
}

export interface TaskDetailResponse {
  readonly card: TaskCard
  readonly status: TaskStatus
  readonly body: string
  readonly plan?: string
  readonly notes: readonly AuditNote[]
}

export interface KindSummary {
  readonly kind: string
  readonly description: string
  readonly stages: readonly string[]
}

export interface KindsResponse {
  readonly kinds: readonly KindSummary[]
}

export interface KindDetailResponse {
  readonly manifest: LoopManifest
  readonly prompts: Readonly<Record<string, string>>
}

/** One run-log file in `runs/` — id plus its latest terminal summary, if any. */
export interface RunListItem {
  readonly id: string
  readonly outcome?: string
  readonly detail?: string
  readonly at?: string
  /** Number of terminal summaries recorded in the log (plan run + build run…). */
  readonly runs: number
}

export interface RunsResponse {
  readonly runs: readonly RunListItem[]
}

/** Display-only view of a `runs/<id>.state.json` crash-resume snapshot. */
export interface SnapshotView {
  readonly kind?: string
  readonly goal: string
  readonly stage: string
  readonly iteration: number
  readonly taskId?: string
  readonly branch?: string
  readonly worktree?: string
}

export interface RunDetailResponse {
  readonly id: string
  readonly log: ParsedRunLog
  readonly snapshot: SnapshotView | null
}

/** The Claude host's live-stage marker (`runs/.stage.json`); opencode writes none. */
export interface StageMarker {
  readonly kind?: string
  readonly stage: string
  readonly taskId?: string | null
  readonly worktree?: string | null
  readonly deadline?: number | null
}

export interface LeaseView {
  readonly pid: number
  readonly host: string
  readonly startedAt: string
  readonly heartbeatAt: string
  readonly stale: boolean
}

/** Raw pr-sitter dedup ledger entry (`runs/pr-sitter/pr-<n>.json`), passed through. */
export interface PrLedgerView {
  readonly pr: number
  readonly updatedAt?: string
  readonly headShaHandled?: string
  readonly failedAttempts: number
}

export interface ActiveResponse {
  readonly stage: StageMarker | null
  readonly lease: LeaseView | null
  readonly snapshotIds: readonly string[]
  readonly prLedgers: readonly PrLedgerView[]
}

export interface ApiError {
  readonly error: string
}

/** Where a token row's numbers came from. */
export type TokenSource = "sidecar" | "transcripts" | "opencode-db"

export interface TokenRow {
  readonly stage: string
  readonly lens?: string
  /** 1-based for display. */
  readonly iteration: number
  readonly tokens: StageTokens
  readonly cost?: number
  readonly model?: string
  readonly source: TokenSource
  /** True when attribution is by time-window overlap, not exact observation. */
  readonly estimated: boolean
}

export interface RunTokensResponse {
  readonly runId: string
  readonly rows: readonly TokenRow[]
  readonly totals: StageTokens
  readonly cost?: number
  /** Human-readable caveats: missing sidecar, unavailable opencode-db, estimation. */
  readonly notes: readonly string[]
}

export interface TokensSummaryEntry {
  readonly id: string
  readonly input: number
  readonly output: number
  readonly cost?: number
  readonly estimated: boolean
}

export interface TokensSummaryResponse {
  readonly runs: readonly TokensSummaryEntry[]
}

/** One live-update event on the `/api/events` SSE stream. */
export type HubEvent =
  | { readonly type: "backlog" }
  | { readonly type: "run"; readonly id: string }
  | { readonly type: "active" }
  | { readonly type: "gate"; readonly taskId: string; readonly toStatus: string }
