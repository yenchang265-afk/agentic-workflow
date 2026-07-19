import type { BacklogSummary } from "@agentic-loop/core/task/store"
import type { BacklogAnomalies } from "@agentic-loop/core/task/audit"
import type { LoopManifest } from "@agentic-loop/core/manifest/schema"
import type { ParsedRunLog } from "@agentic-loop/core/loop/runlog"
import type { StageTokens } from "@agentic-loop/core/loop/metrics"
import type { TaskStatus } from "@agentic-loop/core/task/statuses"

export type { ParsedRunLog, RunLogStageSection, RunLogSummary, RunSummaryRow } from "@agentic-loop/core/loop/runlog"
export type { StageTokens } from "@agentic-loop/core/loop/metrics"
/** The gate's result shape is core's, verbatim — the hub renders it, it doesn't define it. */
export type { GateResult, GateVariant } from "@agentic-loop/core/loop/gate"
export type { TaskStatus } from "@agentic-loop/core/task/statuses"

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
  /**
   * A loop is driving this task RIGHT NOW (the live `.stage.json` marker's
   * taskId matches this run's id). Set so run history can show "in progress"
   * instead of the last completed run's terminal outcome — which otherwise
   * lingers as "done" through a whole subsequent pass (plan park → engineering).
   */
  readonly active?: boolean
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
  /** BUILD/VERIFY/REVIEW retry count for the current task; absent on older markers. */
  readonly iteration?: number | null
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
  /** Set when the hub can perform this step itself (the UI renders a button). */
  readonly action?: "gen-prompts"
}

export interface SaveKindResponse {
  readonly written: readonly string[]
  /** Remaining manual steps the hub cannot (or should not) generate. */
  readonly checklist: readonly ChecklistItem[]
}

export interface ChecklistResponse {
  readonly checklist: readonly ChecklistItem[]
}

// --- creator: repo assets ----------------------------------------------------

/** An agent persona under prompts/agents/<name>/. */
export interface AssetAgent {
  readonly name: string
  readonly description?: string
}

/** An OpenCode command wrapper plugins/opencode/commands/<name>.md. */
export interface AssetCommand {
  readonly name: string
  readonly agent?: string
  readonly description?: string
}

/** A skill skills/<name>/SKILL.md, invocable by name from agent prose. */
export interface AssetSkill {
  readonly name: string
  readonly description?: string
}

export interface AssetsResponse {
  readonly agents: readonly AssetAgent[]
  readonly commands: readonly AssetCommand[]
  readonly skills: readonly AssetSkill[]
}

/** builder = edits files, full bash; checker = read-only, allowlisted bash + verdict tool. */
export type AgentPreset = "builder" | "checker"

export interface ScaffoldAgentRequest {
  readonly name: string
  readonly description: string
  readonly preset: AgentPreset
  /** Skill names woven into body.md as "Invoke the `X` skill" prose; must exist in skills/. */
  readonly skills?: readonly string[]
}

export interface ScaffoldCommandRequest {
  readonly name: string
  readonly description: string
  readonly agent: string
}

export interface ScaffoldSkillRequest {
  readonly name: string
  readonly description: string
}

export interface ScaffoldResponse {
  readonly written: readonly string[]
  /** Caveats worth surfacing (e.g. the checker preset's gen:prompts ordering note). */
  readonly notes?: readonly string[]
}

export interface GenPromptsResponse {
  /** false = the generator ran and failed; the UI renders `output` either way. */
  readonly ok: boolean
  readonly output: string
}

// --- backlog doctor ----------------------------------------------------------

/** One task id present in more than one status folder — reported, never auto-fixed. */
export interface DuplicateTask {
  readonly id: string
  readonly statuses: readonly string[]
}

/** One held claim marker: a task id and the pool status whose `.claims/` holds it. */
export interface HeldClaim {
  readonly id: string
  readonly status: string
}

export interface DoctorReport {
  /** Human-readable anomaly lines (from core's formatAnomalies). */
  readonly findings: readonly string[]
  readonly unknownDirs: readonly string[]
  readonly strayFiles: readonly string[]
  readonly duplicates: readonly DuplicateTask[]
  readonly heldClaims: readonly HeldClaim[]
  /** An OpenCode watcher lease is live — it writes no stage marker, so /fix can't tell which task it drives. */
  readonly watcherLive: boolean
  readonly watcherPid?: number
}

export interface DoctorFixResponse {
  /** Stray files rescued to draft/ (repo-relative source paths). */
  readonly rescued: readonly string[]
  readonly removedDirs: readonly string[]
  readonly releasedClaims: readonly string[]
  /** True when claim release was skipped wholesale: a watcher is live with no marker. */
  readonly claimsSkipped: boolean
  /** Reported, unchanged — the hub won't guess which duplicate is canonical. */
  readonly duplicates: readonly DuplicateTask[]
  /** Strays that couldn't be rescued (e.g. a draft/<id>.md collision) — left for a human. */
  readonly failed?: readonly { readonly path: string; readonly reason: string }[]
}

// --- config editor -----------------------------------------------------------

/**
 * `.agentic-loop.json` is two files: the user-scope `~/.agentic-loop.json` and
 * the repo's own. The editor always names which one it is reading or writing —
 * never the merged view. Saving a merged view back to the repo file would
 * flatten the user layer into it, committing `ado.pat` into a file core warns
 * must stay gitignored.
 */
export type ConfigLayer = "repo" | "user"

/** Which layer supplies a value. `default` = neither file sets it; the schema's default applies. */
export type ConfigProvenance = "repo" | "user" | "default"

/** The placeholder a secret's value is replaced with on the way out. Echo it back to leave the secret unchanged. */
export const REDACTED = "__REDACTED__"

export interface ConfigIssue {
  readonly path: string
  readonly message: string
}

/** A non-blocking complaint about a `loops.<kind>` knob. These annotate a save, never fail it. */
export interface ConfigWarning {
  readonly path: string
  readonly message: string
  /** A near-miss key name, when the knob looks like a typo of a real one. */
  readonly suggestion?: string
}

export interface ConfigLayerResponse {
  readonly layer: ConfigLayer
  /** Absolute path of the file this layer lives in, or null when the layer is disabled. */
  readonly path: string | null
  /** This layer's raw JSON, exactly as on disk, secrets redacted. Null when the file is absent. */
  readonly raw: Record<string, unknown> | null
  /**
   * The merged, schema-valid config both layers produce — display only, never
   * written back. Null when the merged view doesn't validate (see `issues`).
   */
  readonly effective: Record<string, unknown> | null
  /** Per-leaf-path provenance over the merged view, keyed by dotted path. */
  readonly provenance: Readonly<Record<string, ConfigProvenance>>
  /** Schema errors against the merged view. A save is refused while any exist. */
  readonly issues: readonly ConfigIssue[]
  readonly warnings: readonly ConfigWarning[]
  /**
   * Top-level keys present on disk that core's schema doesn't know — a host-only
   * key (`watchIntervalMinutes`), the hub's own `hub` section, or a typo.
   * Surfaced read-only so they are visibly preserved rather than silently
   * dropped, and so a typo shows up here instead of vanishing.
   */
  readonly passthrough: readonly string[]
  /** Dotted paths whose values were redacted on the way out. */
  readonly redactedPaths: readonly string[]
  /** Set when the file exists but isn't valid JSON — rendered, not thrown. */
  readonly parseError?: string
}

/** One edit: set a value at a dotted path, or delete it when `value` is absent. */
export interface ConfigEdit {
  readonly path: string
  readonly value?: unknown
}

export interface SaveConfigRequest {
  readonly layer: ConfigLayer
  readonly edits: readonly ConfigEdit[]
}

export interface SaveConfigResponse {
  readonly written: string
  readonly warnings: readonly ConfigWarning[]
}

/**
 * The human gate moves the hub can perform. Each maps 1:1 onto a core op in
 * `loop/gate.ts` — never core's `*Any` shortcuts, which infer the gate from
 * wherever the task sits. A button knows its own column.
 */
export type GateAction = "approve-task" | "approve-plan" | "replan" | "ship"

export interface GateRequest {
  /** The full task id (not a short-hash prefix) — the board has it. */
  readonly id: string
  /**
   * The status the client believed the task was in. The board is SSE-driven and
   * can lag; the server refuses with a 409 rather than gate a task the human
   * did not actually see there.
   */
  readonly expectStatus: TaskStatus
  /** replan only: why the plan was rejected, threaded into the audit note and the next PLAN pass. */
  readonly reason?: string
  /** ship only: the loop kind, for the PR it opens. Defaults to engineering. */
  readonly kind?: string
}

/**
 * Deleting a task — the hub's only destructive action. Two steps by design: the
 * client fetches a `DeletePreview` to show what would be destroyed, then POSTs a
 * `DeleteRequest`. `force` is offered only once the preview reports blockers.
 */
export interface DeleteRequest {
  readonly id: string
  /** Same stale-board guard as `GateRequest` — a 409 beats destroying the wrong task. */
  readonly expectStatus: TaskStatus
  /** Discard a dirty worktree / unmerged commits, and execute an epic's cascade. */
  readonly force?: boolean
}

/** What deleting a task would destroy. Read-only; mutates nothing. */
export interface DeletePreview {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  /** This task's worktree directory, or null when it has none. */
  readonly worktree: string | null
  readonly worktreeDirty: boolean
  readonly branch: string
  readonly branchExists: boolean
  /** Commits reachable from nowhere else; `null` = undeterminable, treated as unsafe. */
  readonly unmergedCommits: number | null
  readonly isEpic: boolean
  /** Child slices a tracking epic would take with it. */
  readonly children: readonly { readonly id: string; readonly title: string; readonly status: TaskStatus }[]
  /** Non-empty ⇒ deleting needs `force`. */
  readonly blockers: readonly string[]
  /** A live loop is driving it — refused regardless of `force`. */
  readonly isDriving: boolean
}

/**
 * Which optional pieces of loop state the previewed prompt renders against.
 * These are the switches that make conditional blocks (`{{#task.id}}`,
 * `{{#worktree}}`, `{{#platform.ado}}`) fire or vanish — the point of the
 * preview is watching them do so, not reading the text once.
 */
export interface PreviewSample {
  /** Loop started from a backlog task → `{{#task.id}}` / `{{#acceptance}}` render. */
  readonly task: boolean
  /** Git isolation established → `{{#git}}` / `{{git.diffCmd}}` render. */
  readonly git: boolean
  /** Worktree isolation (implies git) → `{{#worktree}}` renders. */
  readonly worktree: boolean
  /** Code platform the prompt renders for → `{{#platform.ado}}` vs `{{#platform.github}}`. */
  readonly platform: "github" | "ado"
}

export interface PreviewRequest {
  readonly manifest: unknown
  /** Stage prompt sources, keyed by stage name — the creator's unsaved drafts. */
  readonly prompts: Readonly<Record<string, string>>
  readonly stage: string
  readonly sample?: Partial<PreviewSample>
}

export interface PreviewResponse {
  /** The stage prompt as the loop would compose it, sample values substituted. */
  readonly rendered: string
  /** Set when the render is not the whole story (e.g. the stage has a compose hook). */
  readonly note?: string
  /** The sample actually used, after defaults — so the UI can reflect its own toggles. */
  readonly sample: PreviewSample
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
  /** `.agentic-loop.json` changed — the server has already reloaded by the time this arrives. */
  | { readonly type: "config" }
  /** The monitored-repo set grew (a repo became loop-enabled) — refetch /api/repos. Tagged with the new repo's id. */
  | { readonly type: "repos" }

/** One live-update event on the `/api/events` SSE stream. */
export type HubEvent = HubEventBase & { readonly repo: string }
