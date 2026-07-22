/**
 * Loop state machine for the agentic loop:
 *
 *   plan → (park for plan review) · build → verify → review
 *
 * The types and state constructors here are **pure**. The transition logic
 * lives in `engine.ts`, interpreting a loop kind's manifest (the engineering
 * pipeline above is `loops/engineering/loop.json`); the impure orchestration
 * lives in each host's driver.
 *
 * Task authoring happens **before** the loop, via the `/agentic-loop:engineering new`
 * verb: it interviews the user into a draft task and `approve <id>`
 * parks it planless in `queued/`. The loop claims a queued task and enters at
 * `plan` via `startAtPlan` — the PLAN stage writes the task's
 * `## Implementation Plan` right before execution, so plans don't rot while a
 * task sits parked. PLAN never blocks on a human: it terminates with a `park`
 * action (the driver moves the task to `plan-review/` and the loop exits).
 * `/agentic-loop:engineering approve <id>` is the human plan gate; the next claim
 * enters at `build` via `resumeAtBuild` with the approved plan as an artifact.
 *
 * Two check stages can fail and loop back, and both re-**build**: a VERIFY
 * FAIL re-builds with the failure threaded into the build prompt; a REVIEW
 * FAIL re-builds with the review feedback. Both share one iteration counter
 * and cap. If the plan itself is wrong, the cap stops the loop and a human
 * sends the task back to the PLAN stage via `/agentic-loop:engineering replan <id>`.
 */

import type { TrackerSystem } from "../task/schema.js"

/** A stage name. Loop kinds define their own stage sets in their manifests;
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

/** The git isolation for one loop's execution: work happens on `branch`, cut from `base`. */
export interface GitRef {
  readonly base: string
  readonly branch: string
  /**
   * Absolute path to this loop's dedicated worktree, when worktree isolation is
   * enabled (`worktreesDir` config). Absent ⇒ shared-tree mode: `branch` is
   * checked out in the main tree. Present ⇒ stages run pinned to this directory.
   */
  readonly worktree?: string
}

export interface LoopState {
  /** The loop kind driving this state (a manifest's `kind`); absent ⇒ `engineering`. */
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
  /** Set when the loop was started from a backlog task; absent only for defensive fallbacks. */
  readonly task?: TaskRef
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
   * How stage agents talk to ADO, stamped at claim time from `ado.access` so a
   * mid-loop config flip can't contradict the rendered prompt or the frozen
   * stage allowlist. Absent (github, or a pre-`access` snapshot) ⇒ `rest` —
   * legacy states were claimed under the curl-only regime and their stage
   * markers allowlist curl, so rendering az/mcp commands there would
   * contradict the marker.
   */
  readonly platformAccess?: AdoAccessMethod
}

/** What the driver should do next. All state changes are returned, not applied. */
export type Action =
  | { readonly kind: "fire"; readonly stage: Stage; readonly arguments: string }
  | { readonly kind: "done"; readonly message: string; readonly toStatus?: string }
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
 * How Azure DevOps is reached: the `az` CLI (the default), raw REST over
 * `curl`/fetch with a PAT, or an Azure DevOps MCP server. Selects the command
 * examples rendered into stage prompts, the stage bash allowlist, AND the
 * driver's own data transport — under `az` the poll sources and ship gate
 * shell the az CLI too (`source/ado-az.ts`); under `rest` they fetch REST with
 * the PAT. `mcp` covers only the stage agents (an MCP server is unreachable
 * from the host process), so its driver side polls REST+PAT.
 */
export const ADO_ACCESS_METHODS = ["az", "rest", "mcp"] as const
export type AdoAccessMethod = (typeof ADO_ACCESS_METHODS)[number]

/** Azure DevOps coordinates, required when any effective platform is `ado`. */
export interface AdoConfig {
  /** Organization URL, e.g. "https://dev.azure.com/acme". */
  readonly organization: string
  readonly project: string
  /** How stage agents talk to ADO: `az` CLI (default), `rest` (curl + PAT), or `mcp`. */
  readonly access?: AdoAccessMethod
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
   * var; if you set this, keep `.agentic-loop.json` gitignored so the secret is
   * never committed.
   */
  readonly pat?: string
  /**
   * Extra HTTP headers attached to every ADO REST call the driver makes (the PR
   * work source and the ship gate) — e.g. `Proxy-Authorization` or a routing
   * header for a corporate proxy in front of Azure DevOps. Merged over the
   * built-in `Authorization`/`Accept`/`Content-Type` headers, so a key here can
   * override one of those (rarely wanted, but yours to decide). The
   * `AGENTIC_LOOP_ADO_HEADERS` env var (a JSON object) overrides this key by
   * key, mirroring how `AZURE_DEVOPS_EXT_PAT` overrides `pat`.
   */
  readonly customHeaders?: Readonly<Record<string, string>>
  /**
   * Skip TLS certificate verification on every ADO REST call the driver makes
   * (the PR/CI-runs work sources and the ship gate). Off by default — only for
   * a self-hosted Azure DevOps Server behind a self-signed or internal-CA
   * certificate the runtime doesn't trust; never enable this against the
   * hosted `dev.azure.com` service. Scoped to these calls only (a dedicated
   * `undici` dispatcher), so it never weakens TLS for unrelated requests
   * (GitHub, npm, …) in the same process.
   */
  readonly insecureSkipTlsVerify?: boolean
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
 * How a watching host schedules claims for a loop kind:
 * - `poll` — a standing timer every `intervalMinutes` (the default; unset
 *   interval falls back to the host's watch interval).
 * - `cron` — claims fire only when the 5-field cron `schedule` fires.
 * - `idle` — no timer; a new loop starts as soon as the watching session goes
 *   idle (continuous chaining). Sometimes described as "webhook-style"
 *   immediacy — no HTTP endpoint is involved.
 * Only hosts with a standing watch mode honor this (the OpenCode plugin); the
 * pull-only Claude host ignores it.
 */
export type LoopTrigger =
  | { readonly type: "poll"; readonly intervalMinutes?: number }
  | { readonly type: "cron"; readonly schedule: string }
  | { readonly type: "idle" }

/** Per-loop-kind settings under the config's `loops.<kind>` section. */
export interface LoopKindConfig {
  /**
   * Absent means "not opted in" for every kind but engineering (which reads it
   * as `!== false`). Never defaulted — see the schema note in config.ts.
   */
  readonly enabled?: boolean
  /** Per-kind override of the global `codePlatform`. */
  readonly codePlatform?: CodePlatform
  /** How a watching host schedules claims for this kind (default: poll). */
  readonly trigger?: LoopTrigger
  /** Stage name → model that stage runs with (host-specific string); wins over the manifest stage's `model`. */
  readonly stageModels?: Readonly<Record<string, string>>
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
  /** Per-task worktree root; `false` ⇒ shared-tree branch switching (opt-out). */
  readonly worktreesDir: string | false
  /** Shell command run in a fresh worktree after creation. */
  readonly worktreeSetup?: string
  /** Extra REVIEW lenses; each runs one more focused review pass. */
  readonly reviewLenses: readonly string[]
  /** Global code platform for PR-shaped work sources; per-kind override via `loops.<kind>.codePlatform`. */
  readonly codePlatform?: CodePlatform
  /** Azure DevOps coordinates; required when any effective platform is `ado`. */
  readonly ado?: AdoConfig
  /** Per-loop-kind sections; engineering is on unless explicitly disabled, other kinds are opt-in. */
  readonly loops: Readonly<Record<string, LoopKindConfig>>
  /** Project-management setup; drives task-authoring defaults and the status pairing view. */
  readonly projectManagement?: ProjectManagementConfig
}

/** Construct a LoopState entering execution at build, for a claimed
 *  in-progress task whose plan was approved via `/agentic-loop:engineering approve`. */
export const resumeAtBuild = (goal: string, task: TaskRef, plan: string): LoopState => ({
  goal,
  stage: "build",
  iteration: 0,
  artifacts: { plan },
  task,
})

/** Construct a LoopState entering at the PLAN stage, for a claimed `queued/`
 *  task. `priorPlan` carries a rejected/capped plan on a replan so the new
 *  plan addresses why the old one failed instead of repeating it. */
export const startAtPlan = (goal: string, task: TaskRef, priorPlan?: string): LoopState => ({
  goal,
  stage: "plan",
  iteration: 0,
  artifacts: priorPlan ? { plan: priorPlan } : {},
  task,
})

// --- In-memory store (lost on opencode restart; see README known limitations) ---

const store = new Map<string, LoopState>()

export const getLoop = (sessionID: string): LoopState | undefined => store.get(sessionID)
/** The session whose live loop is driving the given task id, if any (this plugin instance only). */
export const findSessionDriving = (taskId: string): string | undefined => {
  for (const [sessionID, state] of store) if (state.task?.id === taskId) return sessionID
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
export const anyLoopActive = (): boolean => store.size > 0
/** Whether any live loop runs in worktree isolation — drives fail-closed edit handling
 *  when a tool call's session can't be attributed to (or cleared of) a driving loop. */
export const anyWorktreeLoopActive = (): boolean => {
  for (const state of store.values()) if (state.git?.worktree) return true
  return false
}
export const setLoop = (sessionID: string, state: LoopState): void => void store.set(sessionID, state)
export const clearLoop = (sessionID: string): boolean => store.delete(sessionID)
export const hasLoop = (sessionID: string): boolean => store.has(sessionID)
