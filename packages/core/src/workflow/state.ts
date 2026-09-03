/**
 * Loop state machine for the agentic loop:
 *
 *   plan → (park for plan review) · build → verify → review
 *
 * The types and state constructors here are **pure**. The transition logic
 * lives in `engine.ts`, interpreting a workflow kind's manifest (the engineering
 * pipeline above is `workflows/engineering/workflow.json`); the impure orchestration
 * lives in each host's driver.
 *
 * Task authoring happens **before** the loop, via the `/agentic-workflow:engineering new`
 * verb: it interviews the user into a draft task and `approve <id>`
 * parks it planless in `queued/`. The loop claims a queued task and enters at
 * `plan` via `startAtPlan` — the PLAN stage writes the task's
 * `## Implementation Plan` right before execution, so plans don't rot while a
 * task sits parked. PLAN never blocks on a human: it terminates with a `park`
 * action (the driver moves the task to `plan-review/` and the loop exits).
 * `/agentic-workflow:engineering approve <id>` is the human plan gate; the next claim
 * enters at `build` via `resumeAtBuild` with the approved plan as an artifact.
 *
 * Two check stages can fail and loop back, and both re-**build**: a VERIFY
 * FAIL re-builds with the failure threaded into the build prompt; a REVIEW
 * FAIL re-builds with the review feedback. Both share one iteration counter
 * and cap. If the plan itself is wrong, the cap stops the loop and a human
 * sends the task back to the PLAN stage via `/agentic-workflow:engineering replan <id>`.
 */

import type { CheckDef } from "../manifest/schema.js"
import type { CheckResult } from "./checks.js"
import type { TrackerSystem } from "../task/schema.js"
import type { Verdict } from "./verdict.js"

/** A stage name. Workflow kinds define their own stage sets in their manifests;
 *  the engineering loop's are `plan | build | verify | review`. */
export type Stage = string

/** The engineering loop's stages in order. `plan` terminates with a park, not an advance. */
export const STAGES: readonly Stage[] = ["plan", "build", "verify", "review"]

/** Link to the backlog task driving the loop, when started from one. */
export interface TaskRef {
  readonly id: string
  /** Current on-disk path of the task file (updated as it moves between folders). */
  readonly path: string
  /** Acceptance criteria threaded into the build/verify prompts. */
  readonly acceptance: readonly string[]
}

/** The git isolation for one loop's execution: work happens on `branch`, measured from `base`. */
export interface GitRef {
  /**
   * What this loop's work is measured FROM. A branch NAME in the two
   * branch-cutting modes; a **commit sha** when `onCurrentBranch` is set, where
   * base and branch would otherwise name the same ref and the diff be empty.
   * Read it as a ref, never as a branch, unless `onCurrentBranch` is absent.
   */
  readonly base: string
  readonly branch: string
  /**
   * Absolute path to this loop's dedicated worktree, when worktree isolation is
   * enabled (`worktreesDir` config). Absent ⇒ shared-tree mode: `branch` is
   * checked out in the main tree. Present ⇒ stages run pinned to this directory.
   */
  readonly worktree?: string
  /**
   * Set only when this loop is building on the branch the tree ALREADY had
   * checked out (`taskBranch: false`) — it cut nothing and moved nothing.
   *
   * It is the discriminant for the three behaviors that would otherwise read
   * `base` as a branch name. The sharpest is teardown: `checkoutBranch` falls
   * through to `git checkout -b <base>` when the ref doesn't resolve, so
   * returning "to base" here would create a branch literally named after a
   * commit and strand the human on it.
   */
  readonly onCurrentBranch?: true
}

/**
 * One counted iteration's outcome, kept so a re-build can see what earlier
 * attempts already tried. Short by construction — the full text of every pass is
 * in the run log.
 */
export interface AttemptRecord {
  readonly stage: Stage
  /** 0-based iteration the attempt ran in (rendered 1-based). */
  readonly iteration: number
  readonly verdict: Verdict
  /** The verdict's one-line reason, flattened and truncated by `advance`. */
  readonly reason?: string
}

export interface WorkflowState {
  /** The workflow kind driving this state (a manifest's `kind`); absent ⇒ `engineering`. */
  readonly kind?: string
  /** The goal the loop is driving toward. */
  readonly goal: string
  /** The stage currently running or most recently completed. */
  readonly stage: Stage
  /** 0-based loop iteration; incremented on a counted re-fire (e.g. a verify-FAIL re-build). */
  readonly iteration: number
  /** Captured output text per completed stage, used to thread context forward.
   *  Also carries the approved plan under the `plan` key. */
  readonly artifacts: Readonly<Record<string, string>>
  /**
   * Per-stage structured verdict block (`verdictFeedbackBlock`) that `advance`
   * fused onto the head of that stage's artifact — the seam between the bounded
   * machine-readable channel and the unbounded prose.
   *
   * Recorded so a stage context budget can clamp the prose while leaving the
   * block, which carries the failed criteria and `file:line` findings, intact. A
   * missing entry (an older snapshot, a host that stopped prepending) only means
   * the whole artifact is subject to the budget.
   */
  readonly feedback?: Readonly<Record<string, string>>
  /**
   * Bounded ledger of what earlier counted iterations tried and how they failed.
   *
   * Without it a re-build sees the plan and the LATEST failure but nothing about
   * iteration N−1, so a weak model can oscillate between two wrong fixes until
   * the cap trips — and a capped run reports only that N iterations failed, not
   * that all N tried the same thing. This is the one thing plan 09 ADDS to the
   * prompt: a handful of lines is a far better use of the window than the
   * transcript the budgets take out.
   */
  readonly attempts?: readonly AttemptRecord[]
  /**
   * The human's pending rejection reason from the plan gate, re-derived from the
   * task file at claim time (`extractReplanReason`) — never persisted, since a
   * plan-stage snapshot is schema-invalidated by design. Present only on a
   * PLAN-entry state for a task whose last plan was rejected; the plan prompt
   * renders it as a structured section so the next pass addresses it instead of
   * digging through audit notes.
   */
  readonly replan?: { readonly reason: string }
  /**
   * Per-stage results of the check commands the DRIVER ran before firing that
   * stage (`workflow/checks.ts`). Absent ⇒ no checks are configured, which is
   * byte-identical to the behavior before they existed: no prompt section, no
   * evidence seed, no synthetic axis.
   *
   * Keyed by stage rather than held for the current one because the fire path
   * composes from state: an idempotent re-compose (`workflow_compose`, the
   * hub's prompt preview) must be able to REUSE the results, never re-run a
   * test suite to render a prompt.
   */
  readonly checks?: Readonly<Record<string, readonly CheckResult[]>>
  /** Set when the loop was started from a backlog task; absent only for defensive fallbacks. */
  readonly task?: TaskRef
  /**
   * The on-disk claim marker a scheduler-claimed, TASK-LESS drive holds (a
   * sitter's `.claims/pr-<n>` / `head-<sha>` / dependency marker), stamped by
   * the work source at claim time (`withClaimMarker`). Drivers restamp it at
   * every stage boundary via `refreshWorkClaim` — without the restamp a live
   * multi-stage drive eventually reads stale to a rival's sweep and the same PR
   * is driven twice. The TaskRef-backed twin is `task` + `refreshClaimStamp`.
   * Serialized into snapshots (persist.ts) so a recovered drive keeps restamping.
   */
  readonly claimMarkerDir?: string
  /**
   * Set ONLY on the throwaway state a driver registers for one focused PASS of a
   * fanned-out check stage, naming the driving session the pass belongs to.
   *
   * A pass gets its own session so that every per-session table (the recorded
   * verdict, the pass's axis requirement, its observed-evidence ledger) is
   * pass-scoped instead of stage-scoped — that is what lets passes run
   * concurrently at all. Registering it in this store is what makes the pass
   * subagent's `workflow_verdict` resolve to the PASS rather than walking up to
   * the driver.
   *
   * But a pass is not a loop, and queries that mean "which session is driving
   * this work" must not see it — `findSessionDriving` would otherwise return a
   * pass session for the task and a gate would refuse on a loop that does not
   * exist. Never persisted (the snapshot schema drops it) and never a terminal.
   */
  readonly passOf?: string
  /**
   * The git base/branch (and worktree) this loop's stages operate on. A PR-shaped
   * source pre-sets `{base, branch}` to name the PR's head to isolate ONTO; the
   * engineering loop leaves it unset until `ensureIsolation` creates `feature/<id>`.
   * Because a source can pre-set it, `git` being present does NOT imply isolation
   * was established — use `isolated` for that.
   */
  readonly git?: GitRef
  /**
   * True once `ensureIsolation` has actually established this loop's isolation
   * (created/entered its worktree or switched the shared tree onto its branch).
   * The driver gates every main-tree write (checkpoint commit, teardown branch
   * restore) on this — never on `git` alone — so a check-only stage that never
   * isolated (e.g. pr-sitter `triage` → "nothing actionable") leaves the human's
   * tree untouched.
   */
  readonly isolated?: boolean
  /**
   * Why an isolation-requiring stage is running WITHOUT isolation (detached
   * HEAD, shared-tree checkout failure). Set by `ensureIsolation` on its
   * degrade paths so hosts can surface the condition in the task's audit trail
   * instead of only a console warn — a degraded run otherwise looks identical
   * to an isolated one. Absent when isolation was established (or when running
   * outside a git repo, which is a legitimate mode, not a degrade).
   */
  readonly isolationWarning?: string
  /** The code platform the claiming work source talks to; absent ⇒ `github`. */
  readonly platform?: CodePlatform
  /**
   * Azure DevOps project/repository for this item, stamped at claim time so a
   * stage prompt can render them literally instead of instructing the agent to
   * derive them from `git remote get-url origin`. Only ever set when
   * `platform` is `"ado"`.
   */
  readonly ado?: AdoCoordinates
}

/** What the driver should do next. All state changes are returned, not applied. */
export type Action =
  | {
      readonly kind: "fire"
      readonly stage: Stage
      readonly arguments: string
      /** Characters the stage's context budget elided from `arguments`; absent ⇒ none. */
      readonly promptElided?: number
    }
  | {
      readonly kind: "done"
      readonly message: string
      readonly toStatus?: string
      /**
       * The final check stage's non-blocking (`suggestion`) findings, already
       * formatted one string per finding. They never reach a rebuild —
       * `verdictFeedbackBlock` filters to blocking findings on purpose — so
       * without this they exist only in the metrics sidecar while the human
       * who reviews the diff never sees them. Absent ⇒ none were recorded.
       */
      readonly suggestions?: readonly string[]
    }
  /** A gate stage finished: the driver validates its output, moves the item to `toStatus`, and the loop exits. */
  | { readonly kind: "park"; readonly message: string; readonly toStatus?: string }
  /**
   * The loop stopped incomplete. `retryable` marks a stop that a work source must
   * NOT record as a failed attempt — a transient `onError` stop (the stage reported
   * an ENVIRONMENT/tooling error the manifest asks to retry next poll), as opposed to
   * a genuine iteration-cap exhaustion. Absent ⇒ suppress (record the failed attempt),
   * preserving the cap and legacy behavior.
   */
  | { readonly kind: "stop"; readonly message: string; readonly retryable?: boolean }
  | { readonly kind: "noop" }

/**
 * The code-management platforms PR-shaped work sources can talk to — the single
 * source of truth. `ado` reaches Azure DevOps through its REST API with a PAT
 * (see `source/ado-pr.ts`), using the `ado` config section.
 */
export const CODE_PLATFORMS = ["github", "ado"] as const
export type CodePlatform = (typeof CODE_PLATFORMS)[number]

/**
 * What a ship gate publishes — the single source of truth for the mode set.
 *
 * A ship always moves the task to `completed/` and commits the backlog; this
 * chooses only what leaves the machine. `pr` is the default and today's
 * behavior; `push` sends the branch to `origin` and opens nothing; `local`
 * touches the network not at all, leaving the branch where it is.
 *
 * `local` and `push` are complete successes, not degraded ships — see
 * `publishMissed` in `workflow/gate.ts`, which warns only when the mode that
 * was ASKED for came up short. Either can be published later: shipping the
 * same (already `completed/`) task again with `publish: "pr"` lands in
 * `shipTask`'s idempotent retry arm.
 */
export const SHIP_PUBLISH_MODES = ["pr", "push", "local"] as const
export type ShipPublish = (typeof SHIP_PUBLISH_MODES)[number]

/**
 * The Azure DevOps coordinates a claimed item carries, so `{{ado.project}}` /
 * `{{ado.repository}}` render literally into a stage prompt. Stamped at claim
 * time next to `platform` — a prompt that spells the project out needs no
 * `git remote get-url origin` parsing step, which is one less thing for the
 * agent to reason about (and get wrong) before its first tool call.
 */
export interface AdoCoordinates {
  readonly project: string
  readonly repository: string
}

/** Azure DevOps coordinates, required when any effective platform is `ado`. */
export interface AdoConfig {
  /** Organization URL, e.g. "https://dev.azure.com/acme". */
  readonly organization: string
  readonly project: string
  /** Repository name; omitted → all repositories in the project. */
  readonly repository?: string
  /**
   * The sitter's own login for comment/author filtering. **Required** for `ado`:
   * a PAT carries no reliable email identity, so it can't be resolved otherwise.
   * Enforced in `config.ts`.
   */
  readonly selfLogin?: string
  /**
   * The Personal Access Token, in plaintext — a fallback for when the
   * `AZURE_DEVOPS_EXT_PAT` env var is unset (the env var wins). Prefer the env
   * var; if you set this, keep `.agentic-workflow.json` gitignored so the secret is
   * never committed.
   */
  readonly pat?: string
  /** How the Azure DevOps MCP server is launched. Defaults cover the hosted service. */
  readonly mcp?: AdoMcpConfig
}

/**
 * Launch settings for the Azure DevOps MCP server — the only way this repo
 * reaches Azure DevOps. Every field has a working default; the section exists
 * for air-gapped installs (a local binary instead of `npx`), corporate TLS
 * (`env.NODE_EXTRA_CA_CERTS`), and multi-tenant orgs (`tenant`).
 */
export interface AdoMcpConfig {
  /** Launcher; defaults to "npx". */
  readonly command?: string
  /** Args before the org name; defaults to `["-y", "@azure-devops/mcp@<pinned>"]`. */
  readonly args?: readonly string[]
  /**
   * Credential mode. Defaults to `"pat"` — the server's own default is
   * `"interactive"`, which opens a browser and cannot work in a poller.
   */
  readonly authentication?: "pat" | "envvar" | "azcli" | "interactive"
  /** Tool domains to load; defaults to `["repositories", "pipelines"]`. */
  readonly domains?: readonly string[]
  /** Azure tenant id, for `interactive`/`azcli` against a multi-tenant org. */
  readonly tenant?: string
  /**
   * Extra environment for the spawned server — e.g. `NODE_EXTRA_CA_CERTS` or
   * `HTTPS_PROXY`. Not a place for secrets: put the PAT in `pat` (or the
   * `AZURE_DEVOPS_EXT_PAT` env var), which the hub knows to redact.
   */
  readonly env?: Readonly<Record<string, string>>
}

/** Project-management setup: the team's tracker and how tasks pair to it. */
export interface ProjectManagementConfig {
  /** The team's tracker; the default `tracker.system` for new tasks. */
  readonly system: TrackerSystem
  /** URL prefix a task's `tracker.key` is appended to, to build a deep link. */
  readonly baseUrl?: string
  /** Default issue/work-item type stamped on newly authored tasks. */
  readonly defaultType?: string
}

/**
 * How a watching host schedules claims for a workflow kind:
 * - `poll` — a standing timer every `intervalMinutes` (the default; unset
 *   interval falls back to the host's watch interval).
 * - `cron` — claims fire only when the 5-field cron `schedule` fires.
 * - `idle` — no timer; a new loop starts as soon as the watching session goes
 *   idle (continuous chaining). Sometimes described as "webhook-style"
 *   immediacy — no HTTP endpoint is involved.
 * Only hosts with a standing watch mode honor this (the OpenCode plugin); the
 * pull-only Claude host ignores it.
 */
export type WorkflowTrigger =
  | { readonly type: "poll"; readonly intervalMinutes?: number }
  | { readonly type: "cron"; readonly schedule: string }
  | { readonly type: "idle" }

/** Per-workflow-kind settings under the config's `workflows.<kind>` section. */
export interface WorkflowKindConfig {
  /**
   * Absent means "not opted in" for every kind but engineering (which reads it
   * as `!== false`). Never defaulted — see the schema note in config.ts.
   */
  readonly enabled?: boolean
  /** Per-kind override of the global `codePlatform`. */
  readonly codePlatform?: CodePlatform
  /** Per-kind override of the global `prBase` — the branch this kind's PRs target. */
  readonly prBase?: string
  /** How a watching host schedules claims for this kind (default: poll). */
  readonly trigger?: WorkflowTrigger
  /** Stage name → model that stage runs with (host-specific string); wins over the manifest stage's `model`. */
  readonly stageModels?: Readonly<Record<string, string>>
  /** Stage name → per-artifact character ceilings for that stage's composed prompt; replaces the manifest stage's `context`. */
  readonly stageContext?: Readonly<Record<string, Readonly<Record<string, number>>>>
  /** Stage name → fan-out strategy for that stage; wins over the manifest stage's `fanout`. `"none"` turns one off. */
  readonly stageFanout?: Readonly<Record<string, "axis" | "none" | readonly string[]>>
  /** Stage name → how many of that stage's focused passes may run at once. Default 1 (sequential). OpenCode only. */
  readonly stageConcurrency?: Readonly<Record<string, number>>
  /** Stage name → check commands the driver runs before that stage; replaces the manifest stage's `checks`. SHELL-BEARING (user-scope only). */
  readonly stageChecks?: Readonly<Record<string, readonly CheckDef[]>>
  /**
   * Whether a check stage with no configured and no manifest checks may take
   * them from the approved plan; wins over the manifest stage's
   * `discoverChecks`. Declared rather than left to the index signature below,
   * which types every undeclared key `unknown`.
   */
  readonly discoverChecks?: boolean
  /** Changed-diff-line ceiling a reviewer-role kind declines above; unset ⇒ `DEFAULT_MAX_DIFF_LINES`. */
  readonly maxDiffLines?: number
  /** Whether the kind's plan-writing stage is prompted to include mermaid diagrams when the change shape warrants; wins over the manifest stage's `planVisualization`. */
  readonly planVisualization?: boolean
  /** Kind-specific knobs (e.g. the PR sitter's `query`) — validated by the kind. */
  readonly [key: string]: unknown
}

export interface Config {
  readonly maxIterations: number
  /** Repo-relative root of the task backlog (folders are statuses). */
  readonly tasksDir: string
  /** On by default: exclude `tasksDir` via `.git/info/exclude` instead of auto-committing it. `false` ⇒ commit every task move (the old behavior). */
  readonly ignoreBacklog: boolean
  /** Wall-clock cap on a single stage before the loop gives up on it. */
  readonly stageTimeoutMinutes: number
  /** Wall-clock cap on ONE driver-run check command; checks run outside the stage cap on both hosts. */
  readonly checkTimeoutMinutes: number
  /** Per-task worktree root; `false` ⇒ shared-tree branch switching (opt-out). */
  readonly worktreesDir: string | false
  /** Shell command run in a fresh worktree after creation. */
  readonly worktreeSetup?: string
  /** Shell command fired after a terminal loop event (park/done/stop/error) — SHELL-BEARING, user scope only. See config.ts. */
  readonly notifyCommand?: string
  /** Which terminal events fire `notifyCommand`; absent ⇒ all. */
  readonly notifyEvents?: readonly ("park" | "done" | "stop" | "error" | "stage")[]
  /** Branch-name prefix the engineering loop cuts its work branch with (`<prefix><id>`); `false` ⇒ build on the branch already checked out. */
  readonly taskBranch: string | false
  /** Global code platform for PR-shaped work sources; per-kind override via `workflows.<kind>.codePlatform`. */
  readonly codePlatform?: CodePlatform
  /** What a ship gate publishes by default; overridable per ship. Unset ⇒ `pr`. */
  readonly shipPublish?: ShipPublish
  /**
   * The branch this repo's PRs target; per-kind override via
   * `workflows.<kind>.prBase`. Unset ⇒ ask the platform for its default branch
   * (NOT a literal `main`). Not `ensureIsolation`'s `baseBranch`, which is what a
   * run cuts FROM.
   */
  readonly prBase?: string
  /**
   * Extra branches no loop stage may `git push`, ADDED to the permanent
   * main/master/HEAD floor the write backstop always enforces. Separate from
   * `prBase`: where PRs target and what agents may not push are different
   * policies that merely coincide by default.
   */
  readonly protectedBranches?: readonly string[]
  /** Azure DevOps coordinates; required when any effective platform is `ado`. */
  readonly ado?: AdoConfig
  /** Per-workflow-kind sections; engineering is on unless explicitly disabled, other kinds are opt-in. */
  readonly workflows: Readonly<Record<string, WorkflowKindConfig>>
  /** Agent name → model, for spawns that are not stage runs (draft authoring, ad-hoc plan). See the schema note in config.ts. */
  readonly agentModels?: Readonly<Record<string, string>>
  /** Project-management setup; drives task-authoring defaults and the status pairing view. */
  readonly projectManagement?: ProjectManagementConfig
}

/** Construct a WorkflowState entering execution at build, for a claimed
 *  in-progress task whose plan was approved via `/agentic-workflow:engineering approve`. */
export const resumeAtBuild = (goal: string, task: TaskRef, plan: string): WorkflowState => ({
  goal,
  stage: "build",
  iteration: 0,
  artifacts: { plan },
  task,
})

/** Construct a WorkflowState entering at the PLAN stage, for a claimed `queued/`
 *  task. `priorPlan` carries a rejected/capped plan on a replan so the new
 *  plan addresses why the old one failed instead of repeating it; `replanReason`
 *  carries the human's rejection reason alongside it (see `extractReplanReason`). */
export const startAtPlan = (goal: string, task: TaskRef, priorPlan?: string, replanReason?: string): WorkflowState => ({
  goal,
  stage: "plan",
  iteration: 0,
  artifacts: priorPlan ? { plan: priorPlan } : {},
  ...(replanReason ? { replan: { reason: replanReason } } : {}),
  task,
})

// --- In-memory store (lost on opencode restart; see README known limitations) ---

const store = new Map<string, WorkflowState>()

export const getWorkflow = (sessionID: string): WorkflowState | undefined => store.get(sessionID)
/**
 * The session whose live loop is driving the given task id, if any (this plugin
 * instance only).
 *
 * Pass sessions (`passOf`) are skipped: they carry the driving loop's task ref
 * so the pass subagent resolves against the right work, but they are one stage
 * pass, not a loop. Returning one would answer "which session drives this task"
 * with a session that vanishes when the pass ends.
 */
export const findSessionDriving = (taskId: string): string | undefined => {
  for (const [sessionID, state] of store) if (state.task?.id === taskId && !state.passOf) return sessionID
  return undefined
}
/** Task id of the loop currently in its PLAN stage, if any — the only task a
 *  direct queued/ write is carved out for. Session-independent so a PLAN
 *  subagent (own sessionID, absent from the store) still resolves it. */
export const planStageTaskId = (): string | null => {
  for (const state of store.values()) if (state.stage === "plan" && state.task?.id) return state.task.id
  return null
}
/** Whether any loop is live in this instance — cheap pre-check before a parent-chain walk. */
export const anyWorkflowActive = (): boolean => store.size > 0
/** Whether any live loop runs in worktree isolation — drives fail-closed edit handling
 *  when a tool call's session can't be attributed to (or cleared of) a driving loop. */
export const anyWorktreeWorkflowActive = (): boolean => {
  for (const state of store.values()) if (state.git?.worktree) return true
  return false
}
export const setWorkflow = (sessionID: string, state: WorkflowState): void => void store.set(sessionID, state)
export const clearWorkflow = (sessionID: string): boolean => store.delete(sessionID)
export const hasWorkflow = (sessionID: string): boolean => store.has(sessionID)
