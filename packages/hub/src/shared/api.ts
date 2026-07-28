import type { BacklogSummary } from "@agentic-workflow/core/task/store"
import type { BacklogAnomalies } from "@agentic-workflow/core/task/audit"
import type { WorkflowManifest } from "@agentic-workflow/core/manifest/schema"
import type { ParsedRunLog } from "@agentic-workflow/core/workflow/runlog"
import type { StageTokens } from "@agentic-workflow/core/workflow/metrics"
import type { TaskStatus } from "@agentic-workflow/core/task/statuses"
import type { GateResult, GateVariant } from "@agentic-workflow/core/workflow/gate"

export type { ParsedRunLog, RunLogStageSection, RunLogSummary, RunSummaryRow } from "@agentic-workflow/core/workflow/runlog"
export type { StageTokens } from "@agentic-workflow/core/workflow/metrics"
/** The gate's result shape is core's, verbatim — the hub renders it, it doesn't define it. */
export type { GateResult, GateVariant } from "@agentic-workflow/core/workflow/gate"
export type { TaskStatus } from "@agentic-workflow/core/task/statuses"

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

/** Per-kind dashboard metadata derived from a workflow-kind manifest at startup. */
export interface KindBoardInfo {
  readonly kind: string
  readonly description: string
  readonly sourceType: "backlog" | "pull-request" | "dependency-scan" | "ci-runs"
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
  /**
   * Claim age: task id → the marker stamp's `claimedAt` ISO. Only ids whose
   * stamp was readable appear — a claim without a stamp shows no age rather
   * than a wrong one.
   */
  readonly claimStamps?: Readonly<Record<string, string>>
  /**
   * Minutes after `claimedAt` at which core's sweep MAY treat the claim as
   * stale (its floor — a configured stage timeout extends it). Display context
   * for the age, not a promise of takeover.
   */
  readonly staleClaimMinutes?: number
  /** Structural anomalies from the backlog-root audit (any backlog kind); null when clean. */
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
  /**
   * Present ONLY when this task can be edited in place: planless, and in
   * `draft/` or `queued/`. The server decides, so the browser cannot invent an
   * editable state for a task whose goal the loop already planned against.
   */
  readonly editable?: TaskEditable
}

/**
 * The editable split of a task body. `tail` is display-only — the browser never
 * sends it back; the server re-reads the file and rejoins its own tail at save
 * time, so a note appended while the human was typing survives and no client
 * can delete one.
 */
export interface TaskEditable {
  /** The prose a human may edit — the body minus its trailing audit run. */
  readonly prose: string
  /** The trailing `> …` audit run, for display only. */
  readonly tail: string
  /** Hash of `prose` at read time; echoed back as `baseHash` so a drifted edit is refused. */
  readonly hash: string
}

/** Body of `POST /api/tasks/:status/:id` — the whole editable task, not a patch. */
export interface SaveTaskRequest {
  /** Must equal the `:status` path param; the same stale-board guard the gate uses. */
  readonly expectStatus: TaskStatus
  /** Echoed from `TaskEditable.hash` — a mismatch means the file changed under the editor. */
  readonly baseHash: string
  readonly title: string
  readonly type?: string
  readonly priority: number
  readonly labels: readonly string[]
  readonly acceptance: readonly string[]
  /** The edited PROSE only — never the audit tail. */
  readonly body: string
  /** Why the task was reshaped. Recorded on the edit's audit note, and on the retask's. */
  readonly reason?: string
}

/**
 * Deliberately `GateResult`-shaped: the drawer renders a refusal with the same
 * `.gate-msg` code the gate buttons use.
 */
export type SaveTaskResponse =
  | {
      readonly ok: true
      readonly message: string
      readonly path: string
      /** Which fields actually changed; empty means the save was a no-op. */
      readonly changed: readonly string[]
      /**
       * Present only for a `queued/` task, where the save also withdraws the
       * approval. Carries core's `GateResult` verbatim — and may be `ok: false`
       * (the edit still landed; the task simply stayed in `queued/`).
       */
      readonly retask?: GateResult
    }
  | { readonly ok: false; readonly message: string; readonly variant?: GateVariant }

export interface KindSummary {
  readonly kind: string
  readonly description: string
  readonly stages: readonly string[]
}

export interface KindsResponse {
  readonly kinds: readonly KindSummary[]
}

export interface KindDetailResponse {
  readonly manifest: WorkflowManifest
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

/** One iteration's outcome from the snapshot's bounded attempts ledger (core's `AttemptRecord`). */
export interface AttemptView {
  readonly stage: string
  readonly iteration: number
  readonly verdict: string
  readonly reason?: string
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
  /** Stages whose captured output the snapshot carries — what a resume would see. Bodies stay in the run log. */
  readonly artifactStages?: readonly string[]
  /** Per-iteration verdicts + first-line reasons — the failure forensics trail. */
  readonly attempts?: readonly AttemptView[]
  /** Set when the run proceeded WITHOUT git isolation — otherwise invisible in every view. */
  readonly isolationWarning?: string
}

/** Per-tool call counts for one stage pass (mirrors core's StageToolUsage). */
export interface StageToolUsage {
  readonly tool: string
  readonly count: number
  readonly errors: number
}

/** What one stage pass DID — joined from the metrics sidecar onto a run-log section by (stage, iteration, lens). */
export interface StageActivity {
  readonly stage: string
  readonly lens?: string
  /** 1-based, to match the run-log section header. */
  readonly iteration: number
  readonly tools: readonly StageToolUsage[]
  readonly files?: readonly string[]
}

/** One stage execution span from the metrics sidecar — the run timeline's unit. */
export interface TimelineSpan {
  readonly stage: string
  readonly lens?: string
  /** 1-based, matching the run-log section headers. */
  readonly iteration: number
  readonly startedAt: string
  readonly ms: number
  readonly model?: string
  /** From a sidecar entry still `open` — the span may still be growing. */
  readonly live?: boolean
}

/** What a live run is doing right now, from the sidecar's trailing `open` entry. */
export interface LiveProgress {
  readonly stage: string
  readonly lens?: string
  /** 1-based. */
  readonly iteration: number
  readonly startedAt?: string
  readonly host: string
}

export interface RunDetailResponse {
  readonly id: string
  readonly log: ParsedRunLog
  readonly snapshot: SnapshotView | null
  /** Per-stage tool/file activity from the metrics sidecar; absent for runs that predate capture. */
  readonly activity?: readonly StageActivity[]
  /** Stage spans with a recorded start — absent when no sample carries `startedAt`. */
  readonly timeline?: readonly TimelineSpan[]
  /** Sidecar samples lacking `startedAt` — excluded from the timeline, counted not hidden. */
  readonly timelineExcluded?: number
  /** Present while the sidecar's trailing entry is `open` — the run is mid-stage right now. */
  readonly live?: LiveProgress
}

/** A host's live-stage marker — one file per host under `runs/` (Claude's `.stage.json`, plus `.stage-opencode.json` / `.stage-qwen.json`). */
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

/**
 * One recorded failed attempt from a dedup ledger — why the sitter gave up on
 * that head/target and when. Fields vary by source: PR ledgers carry
 * `headSha` + `trigger`, dep ledgers `target`, head ledgers `at` only.
 */
export interface FailedAttemptView {
  readonly at?: string
  readonly headSha?: string
  readonly trigger?: string
  readonly target?: string
}

/** Raw hosted-PR dedup ledger entry (`runs/<kind>/pr-<n>.json`), passed through. */
export interface PrLedgerView {
  readonly pr: number
  /** The PR-shaped workflow kind that owns this ledger (its `runs/` subdirectory); absent on legacy responses. */
  readonly kind?: string
  readonly updatedAt?: string
  readonly headShaHandled?: string
  readonly failedAttempts: number
  /** The attempts behind the count, when their shape parsed. */
  readonly failedAttemptDetails?: readonly FailedAttemptView[]
}

/** Dependency-scan dedup ledger (`runs/<kind>/dep-<slug>.json`) — dep-sitter's per-package state. */
export interface DepLedgerView {
  readonly kind: string
  readonly pkg: string
  /** The last target version published for this package, if any. */
  readonly versionHandled?: string
  readonly updatedAt?: string
  readonly failedAttempts: number
  /** The attempts behind the count, when their shape parsed. */
  readonly failedAttemptDetails?: readonly FailedAttemptView[]
}

/** CI-runs (branch-head) dedup ledger (`runs/<kind>/head-<sha>.json`) — main-sitter's per-head state. */
export interface HeadLedgerView {
  readonly kind: string
  readonly sha: string
  readonly handled: boolean
  readonly updatedAt?: string
  readonly failedAttempts: number
  /** The attempts behind the count, when their shape parsed. */
  readonly failedAttemptDetails?: readonly FailedAttemptView[]
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
  /** An OpenCode watcher lease is live with no stage marker — idle-polling or mid-claim, so /fix can't tell which task it drives. */
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
 * `.agentic-workflow.json` is two files: the user-scope `~/.agentic-workflow.json` and
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

/** A non-blocking complaint about a `workflows.<kind>` knob. These annotate a save, never fail it. */
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
 * `workflow/gate.ts` — never core's `*Any` shortcuts, which infer the gate from
 * wherever the task sits. A button knows its own column.
 */
export type GateAction = "approve-task" | "approve-plan" | "replan" | "ship" | "abandon" | "remove"

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
  /** ship only: the workflow kind, for the PR it opens. Defaults to engineering. */
  readonly kind?: string
}

/**
 * Which optional pieces of loop state the previewed prompt renders against.
 * These are the switches that make conditional blocks (`{{#task.id}}`,
 * `{{#worktree}}`, `{{#platform.ado}}`) fire or vanish — the point of the
 * preview is watching them do so, not reading the text once.
 */
/** The code platforms core supports — the one list every platform `<select>` renders from. */
export const PLATFORMS = ["github", "ado"] as const
export type Platform = (typeof PLATFORMS)[number]

export interface PreviewSample {
  /** Loop started from a backlog task → `{{#task.id}}` / `{{#acceptance}}` render. */
  readonly task: boolean
  /** Git isolation established → `{{#git}}` / `{{git.diffCmd}}` render. */
  readonly git: boolean
  /** Worktree isolation (implies git) → `{{#worktree}}` renders. */
  readonly worktree: boolean
  /** Code platform the prompt renders for → `{{#platform.ado}}` vs `{{#platform.github}}`. */
  readonly platform: Platform
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

// --- cross-run metrics -------------------------------------------------------

/**
 * Loop health rolled up across every run, so "is the loop converging or burning
 * iterations?" is answerable without reading `runs/*.md` by hand.
 *
 * Two conventions run through every type below, because the failure mode worth
 * designing against is a confident wrong number:
 *
 * 1. **The unit is the pass, not the file.** One `runs/<id>.md` holds several
 *    terminal summaries (a plan pass, then a build pass) — independent runs with
 *    their own cap and verdict stream. Averaging them together is meaningless,
 *    so every rate names the population it measured.
 * 2. **Missing data is never a zero.** Every rate is `number | null` and every
 *    excluded population gets its own counter. An unmeasurable metric and a
 *    genuine 0% must not render alike.
 */

/** One bucket of the iteration-burn histogram over `iterationsUsed / cap`. */
export interface BurnBucket {
  /** Inclusive lower bound of the ratio band. */
  readonly from: number
  /** Exclusive upper bound; the top bucket is closed at 1 (a capped pass). */
  readonly to: number
  readonly passes: number
}

export interface IterationBurn {
  /** Passes whose footer carried `iterations used: N/M` — the only valid denominator. */
  readonly passesMeasured: number
  /** Passes with a summary but no footer (older logs). Excluded, never counted as ratio 0. */
  readonly passesUnmeasured: number
  /** Mean `iterationsUsed / cap` over `passesMeasured`; null when that is 0. */
  readonly meanRatio: number | null
  readonly medianRatio: number | null
  /** Passes that ended at or above their cap. */
  readonly cappedPasses: number
  /** `cappedPasses / passesMeasured`; null when nothing was measurable. */
  readonly capTripRate: number | null
  readonly buckets: readonly BurnBucket[]
}

export interface FirstPassYield {
  /** Passes carrying at least one verdict-bearing check row — the denominator. */
  readonly passesMeasured: number
  /** Passes whose summary recorded no check row at all (a plan pass). Excluded. */
  readonly passesWithoutChecks: number
  /** Passes where every check row sits on the first iteration and every verdict is PASS. */
  readonly cleanPasses: number
  /** `cleanPasses / passesMeasured`; null when `passesMeasured` is 0. */
  readonly rate: number | null
}

/** Verdict tallies for one stage name, lens variants merged. */
export interface StageVerdicts {
  readonly stage: string
  readonly pass: number
  readonly fail: number
  readonly error: number
  /** Rows whose verdict cell read `none` — the check ran and declined to judge. */
  readonly none: number
}

/** Verdict transitions on the same stage+lens within one pass — the thrash signal. */
export interface VerdictFlips {
  /** FAIL→PASS: the loop recovered. */
  readonly failToPass: number
  /** PASS→FAIL: a later iteration regressed a check that had passed. */
  readonly passToFail: number
  /** FAIL→FAIL: a re-build that did not move the check. */
  readonly failToFail: number
  /** Passes containing at least one transition of any kind. */
  readonly passesWithFlips: number
}

/** Wall-clock roll-up for one stage, from the logs' parsed `wall-clock` cells. */
export interface StageDuration {
  readonly stage: string
  /** Rows with a parseable duration; rows rendered `—`/empty are excluded, not zeroed. */
  readonly rows: number
  readonly meanSeconds: number
  readonly medianSeconds: number
  readonly maxSeconds: number
}

/** Cache-hit ratio for one stage: `cacheRead / (input + cacheRead)`. */
export interface StageCache {
  readonly stage: string
  /** Sidecar samples for this stage that carried a `tokens` block. */
  readonly samples: number
  readonly input: number
  readonly cacheRead: number
  /** null when `input + cacheRead` is 0 — unmeasurable, not 0%. */
  readonly ratio: number | null
}

export interface CacheHit {
  /**
   * Runs whose `.metrics.json` sidecar carried at least one token-bearing sample.
   * Read against `runsTotal`: only the opencode driver observes tokens, so a low
   * number means this ratio describes a slice of the fleet, not all of it.
   */
  readonly runsCovered: number
  readonly samples: number
  readonly input: number
  readonly cacheRead: number
  /** Overall `cacheRead / (input + cacheRead)`; null when the denominator is 0. */
  readonly ratio: number | null
  readonly stages: readonly StageCache[]
}

/** Composed-prompt size for one stage, in characters. */
export interface StagePromptSize {
  readonly stage: string
  /** Sidecar samples for this stage that carried a `promptChars` value. */
  readonly samples: number
  readonly meanChars: number
  readonly medianChars: number
  readonly maxChars: number
  /** Samples where a context budget elided anything — "the budget is biting". */
  readonly elidedSamples: number
  readonly elidedChars: number
}

export interface PromptSize {
  /**
   * Runs whose sidecar carried at least one `promptChars` sample. Unlike
   * `cache.runsCovered` this covers BOTH hosts — prompt size is measured by the
   * server that composed the prompt, not inferred from token usage.
   */
  readonly runsCovered: number
  readonly samples: number
  readonly stages: readonly StagePromptSize[]
}

/** Cost/latency roll-up for one stage × model pairing, sidecar samples only. */
export interface StageModelStats {
  readonly stage: string
  readonly model: string
  readonly samples: number
  /** Samples that carried a `cost` — the only ones summed into `totalCost`. */
  readonly costSamples: number
  readonly totalCost: number
  readonly meanMs: number
  /** Mean 1-based iteration of this pairing's samples — "does the cheap model burn more retries". */
  readonly meanIteration: number
}

export interface ModelStats {
  /** Runs whose sidecar carried at least one model-bearing sample (opencode host only). */
  readonly runsCovered: number
  /** Samples with no `model` recorded — excluded from every row, never bucketed as a model. */
  readonly samplesWithoutModel: number
  readonly rows: readonly StageModelStats[]
}

/** One recurring review finding, grouped by normalized detail text. */
export interface FindingGroup {
  readonly axis: string
  readonly severity: string
  /** The first-seen original detail text (grouping normalizes trim/case). */
  readonly detail: string
  readonly count: number
  /** Stage labels the finding appeared under. */
  readonly stages: readonly string[]
}

export interface FindingsStats {
  /** Runs whose sidecar carried at least one structured finding. */
  readonly runsCovered: number
  readonly samplesWithFindings: number
  readonly bySeverity: Readonly<Record<string, number>>
  /** Most-recurring first, capped server-side. */
  readonly topFindings: readonly FindingGroup[]
}

/** Cross-run reliability of one tool, from the sidecars' per-stage tool tallies. */
export interface ToolStats {
  readonly tool: string
  readonly calls: number
  readonly errors: number
  /** `errors / calls`; null when `calls` is 0. */
  readonly errorRate: number | null
  /** Runs whose sidecar recorded at least one call of this tool. */
  readonly runsCovered: number
}

/**
 * Cross-run loop health. Sourced entirely from `runs/<id>.md` plus the
 * `runs/<id>.metrics.json` sidecars — no transcript joins, so every token number
 * here is observed rather than estimated (see `cache.runsCovered`).
 */
export interface MetricsResponse {
  /** Readable run-log files in `runs/` — the file-level denominator. Files listed but unreadable go to `skippedRuns` instead. */
  readonly runsTotal: number
  /** Files whose log parsed to at least one terminal summary. */
  readonly runsWithSummary: number
  /**
   * Terminal summaries across all files — the unit every pass-scoped metric
   * below counts. One file holds several, so this is >= `runsWithSummary` and is
   * NOT interchangeable with `runsTotal`.
   */
  readonly passesTotal: number
  /** Sidecars whose trailing entry is `open` — runs still accruing. */
  readonly runsInProgress: number
  /** Terminal outcome tallies, keyed by the log's own word (done/stopped/error, and anything newer). */
  readonly outcomes: Readonly<Record<string, number>>
  readonly burn: IterationBurn
  readonly firstPass: FirstPassYield
  readonly verdicts: readonly StageVerdicts[]
  readonly flips: VerdictFlips
  readonly durations: readonly StageDuration[]
  readonly cache: CacheHit
  /** Composed-prompt size per stage — the signal a context budget is (or isn't) needed. */
  readonly prompt: PromptSize
  /** Which model ran which stage, at what cost and retry burn — sidecar samples only. */
  readonly models: ModelStats
  /** Flakiest-tool signal: per-tool call/error totals across all sidecars, worst first. */
  readonly tools: readonly ToolStats[]
  /**
   * Sidecar-recorded stops split by the retryable flag: transient environment
   * faults the source may retry vs genuine stops. Sidecar population only —
   * the log-derived `outcomes` tally cannot make this distinction.
   */
  readonly stoppedRetryable: number
  readonly stoppedFinal: number
  /** Recurring review findings from the sidecars' structured verdicts. */
  readonly findings: FindingsStats
  /** Ids listed but unreadable — surfaced so a silent drop is visible in the UI. */
  readonly skippedRuns: readonly string[]
}

/** One monitored repo (from `--dir` / user-scope `hub.repos` resolution). */
export interface RepoInfo {
  readonly id: string
  readonly directory: string
  /** Present when the repo's config failed to load and it is served degraded on defaults. */
  readonly configError?: string
}

export interface ReposResponse {
  readonly repos: readonly RepoInfo[]
}

/** One scheduler event from `runs/events.jsonl`, passed through for display. */
export interface SchedulerEventView {
  readonly at: string
  readonly host: string
  readonly pid: number
  readonly type: string
  readonly kind?: string
  readonly id?: string
  readonly outcome?: string
  readonly retryable?: boolean
  readonly reasons?: readonly { readonly message: string; readonly actionable: boolean }[]
  readonly ageMinutes?: number
  readonly oldPid?: number
  readonly oldHost?: string
}

export interface SchedulerEventsResponse {
  /** Newest first, tail-capped server-side. */
  readonly events: readonly SchedulerEventView[]
}

/** A watcher diff, before the server tags it with its repo. */
export type HubEventBase =
  | { readonly type: "backlog" }
  | { readonly type: "run"; readonly id: string }
  | { readonly type: "active" }
  | { readonly type: "tokens"; readonly id: string }
  | { readonly type: "gate"; readonly taskId: string; readonly toStatus: string }
  /** `runs/events.jsonl` grew or rotated — refetch /api/scheduler. */
  | { readonly type: "sched" }
  /** `.agentic-workflow.json` changed — the server has already reloaded by the time this arrives. */
  | { readonly type: "config" }
  /** The monitored-repo set grew (a repo became loop-enabled) — refetch /api/repos. Tagged with the new repo's id. */
  | { readonly type: "repos" }

/** One live-update event on the `/api/events` SSE stream. */
export type HubEvent = HubEventBase & { readonly repo: string }
