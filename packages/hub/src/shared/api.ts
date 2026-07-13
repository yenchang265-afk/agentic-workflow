import type { BacklogSummary } from "@agentic-loop/core/task/store"
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
  /** Short-hash handle — the copyable approve id (`f7k3`); the full id lives in `id`. */
  readonly shortId: string
  readonly title: string
  readonly type?: string
  readonly priority: number
  readonly labels: readonly string[]
  readonly acceptance: readonly string[]
  readonly paired: boolean
  readonly hasPlan: boolean
}

/** Per-kind dashboard metadata derived from a loop-kind manifest at startup. */
export interface KindBoardInfo {
  readonly kind: string
  readonly description: string
  readonly sourceType: "backlog" | "github-pr" | "dependency-scan" | "ci-runs"
  /** Board columns (the manifest's status-folder set); [] for non-backlog kinds. */
  readonly statuses: readonly string[]
  /** Statuses the kind parks/lands work into for a human — highlighted columns. */
  readonly gateStatuses: readonly string[]
  /** Claim-pool statuses, in priority order — the summary-chip counts. */
  readonly pools: readonly string[]
}

export interface MonitorKindsResponse {
  readonly kinds: readonly KindBoardInfo[]
}

export interface BacklogResponse {
  readonly kind: string
  readonly statuses: readonly string[]
  readonly gateStatuses: readonly string[]
  readonly tasks: Readonly<Record<string, readonly TaskCard[]>>
  /** Engineering-lifecycle roll-up; null for other kinds (their folders aren't its shape). */
  readonly summary: BacklogSummary | null
  readonly claimedIds: readonly string[]
  /** Structural anomalies from the backlog audit; null when none (engineering only). */
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
  readonly status: string
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

/** Raw hosted-PR dedup ledger entry (`runs/<kind>/pr-<n>.json`), passed through. */
export interface PrLedgerView {
  readonly pr: number
  /** The PR-shaped loop kind that owns this ledger (its `runs/` subdirectory); absent on legacy responses. */
  readonly kind?: string
  readonly updatedAt?: string
  readonly headShaHandled?: string
  readonly failedAttempts: number
}

/** Dependency-scan dedup ledger (`runs/<kind>/dep-<slug>.json`) — dep-sitter's per-package state. */
export interface DepLedgerView {
  readonly kind: string
  readonly pkg: string
  /** The last target version published for this package, if any. */
  readonly versionHandled?: string
  readonly updatedAt?: string
  readonly failedAttempts: number
}

/** CI-runs (branch-head) dedup ledger (`runs/<kind>/head-<sha>.json`) — main-sitter's per-head state. */
export interface HeadLedgerView {
  readonly kind: string
  readonly sha: string
  readonly handled: boolean
  readonly updatedAt?: string
  readonly failedAttempts: number
}

export interface ActiveResponse {
  readonly stage: StageMarker | null
  readonly lease: LeaseView | null
  readonly snapshotIds: readonly string[]
  readonly prLedgers: readonly PrLedgerView[]
  /** dependency-scan kinds' per-package ledgers (dep-sitter); [] when none. */
  readonly depLedgers: readonly DepLedgerView[]
  /** ci-runs kinds' per-head ledgers (main-sitter); [] when none. */
  readonly headLedgers: readonly HeadLedgerView[]
}

export interface ApiError {
  readonly error: string
}

/** One zod issue from server-side manifest validation. */
export interface ManifestIssue {
  readonly path: string
  readonly message: string
}

export interface ValidateResponse {
  readonly valid: boolean
  readonly issues: readonly ManifestIssue[]
}

export interface ChecklistItem {
  readonly done: boolean
  readonly label: string
}

export interface SaveKindResponse {
  readonly written: readonly string[]
  /** Remaining manual steps the hub cannot (or should not) generate. */
  readonly checklist: readonly ChecklistItem[]
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
  /** True while the run is still live — the sidecar's trailing entry is `open`,
   *  so rows/totals are partial and still accruing. Drives the panel's live badge. */
  readonly inProgress?: boolean
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

/** One monitored repo (from `--dir` / user-scope `hub.repos` resolution). */
export interface RepoInfo {
  readonly id: string
  readonly directory: string
}

export interface ReposResponse {
  readonly repos: readonly RepoInfo[]
}

/** A watcher diff, before the server tags it with its repo. */
export type HubEventBase =
  | { readonly type: "backlog" }
  | { readonly type: "run"; readonly id: string }
  | { readonly type: "active" }
  | { readonly type: "tokens"; readonly id: string }
  | { readonly type: "gate"; readonly taskId: string; readonly toStatus: string }

/** One live-update event on the `/api/events` SSE stream. */
export type HubEvent = HubEventBase & { readonly repo: string }
