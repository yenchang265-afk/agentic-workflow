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
 * Task authoring happens **before** the loop, in the `/agent-loop-task`
 * command: `new` interviews the user into a draft task and `approve <id>`
 * parks it planless in `queued/`. The loop claims a queued task and enters at
 * `plan` via `startAtPlan` — the PLAN stage writes the task's
 * `## Implementation Plan` right before execution, so plans don't rot while a
 * task sits parked. PLAN never blocks on a human: it terminates with a `park`
 * action (the driver moves the task to `plan-review/` and the loop exits).
 * `/agent-loop-task approve-plan <id>` is the human plan gate; the next claim
 * enters at `build` via `resumeAtBuild` with the approved plan as an artifact.
 *
 * Two check stages can fail and loop back, and both re-**build**: a VERIFY
 * FAIL re-builds with the failure threaded into the build prompt; a REVIEW
 * FAIL re-builds with the review feedback. Both share one iteration counter
 * and cap. If the plan itself is wrong, the cap stops the loop and a human
 * sends the task back to the PLAN stage via `/agent-loop-task replan <id>`.
 */
import type { TrackerSystem } from "../task/schema.js";
/** A stage name. Loop kinds define their own stage sets in their manifests;
 *  the engineering loop's are `plan | build | verify | review`. */
export type Stage = string;
/** The engineering loop's stages in order. `plan` terminates with a park, not an advance. */
export declare const STAGES: readonly Stage[];
/** Link to the backlog task driving the loop, when started from one. */
export interface TaskRef {
    readonly id: string;
    /** Current on-disk path of the task file (updated as it moves between folders). */
    readonly path: string;
    /** Acceptance criteria threaded into the build/verify prompts. */
    readonly acceptance: readonly string[];
}
/** The git isolation for one loop's execution: work happens on `branch`, cut from `base`. */
export interface GitRef {
    readonly base: string;
    readonly branch: string;
    /**
     * Absolute path to this loop's dedicated worktree, when worktree isolation is
     * enabled (`worktreesDir` config). Absent ⇒ shared-tree mode: `branch` is
     * checked out in the main tree. Present ⇒ stages run pinned to this directory.
     */
    readonly worktree?: string;
}
export interface LoopState {
    /** The loop kind driving this state (a manifest's `kind`); absent ⇒ `engineering`. */
    readonly kind?: string;
    /** The goal the loop is driving toward. */
    readonly goal: string;
    /** The stage currently running or most recently completed. */
    readonly stage: Stage;
    /** 0-based loop iteration; incremented on a counted re-fire (e.g. a verify-FAIL re-build). */
    readonly iteration: number;
    /** Captured output text per completed stage, used to thread context forward.
     *  Also carries the approved plan under the `plan` key. */
    readonly artifacts: Readonly<Record<string, string>>;
    /** Set when the loop was started from a backlog task; absent only for defensive fallbacks. */
    readonly task?: TaskRef;
    /**
     * The git base/branch (and worktree) this loop's stages operate on. A PR-shaped
     * source pre-sets `{base, branch}` to name the PR's head to isolate ONTO; the
     * engineering loop leaves it unset until `ensureIsolation` creates `feature/<id>`.
     * Because a source can pre-set it, `git` being present does NOT imply isolation
     * was established — use `isolated` for that.
     */
    readonly git?: GitRef;
    /**
     * True once `ensureIsolation` has actually established this loop's isolation
     * (created/entered its worktree or switched the shared tree onto its branch).
     * The driver gates every main-tree write (checkpoint commit, teardown branch
     * restore) on this — never on `git` alone — so a check-only stage that never
     * isolated (e.g. pr-sitter `triage` → "nothing actionable") leaves the human's
     * tree untouched.
     */
    readonly isolated?: boolean;
    /** The code platform the claiming work source talks to; absent ⇒ `github`. */
    readonly platform?: CodePlatform;
}
/** What the driver should do next. All state changes are returned, not applied. */
export type Action = {
    readonly kind: "fire";
    readonly stage: Stage;
    readonly arguments: string;
} | {
    readonly kind: "done";
    readonly message: string;
    readonly toStatus?: string;
}
/** A gate stage finished: the driver validates its output, moves the item to `toStatus`, and the loop exits. */
 | {
    readonly kind: "park";
    readonly message: string;
    readonly toStatus?: string;
} | {
    readonly kind: "stop";
    readonly message: string;
} | {
    readonly kind: "noop";
};
/**
 * The code-management platforms PR-shaped work sources can talk to — the single
 * source of truth. `ado` reaches Azure DevOps through its REST API with a PAT
 * (see `source/ado-pr.ts`), using the `ado` config section.
 */
export declare const CODE_PLATFORMS: readonly ["github", "ado"];
export type CodePlatform = (typeof CODE_PLATFORMS)[number];
/** Azure DevOps coordinates, required when any effective platform is `ado`. */
export interface AdoConfig {
    /** Organization URL, e.g. "https://dev.azure.com/acme". */
    readonly organization: string;
    readonly project: string;
    /** Repository name; omitted → all repositories in the project. */
    readonly repository?: string;
    /**
     * The sitter's own login for comment/author filtering. **Required** for `ado`:
     * a PAT carries no reliable email identity, so it can't be resolved otherwise.
     * Enforced in `config.ts`.
     */
    readonly selfLogin?: string;
}
/** Project-management setup: the team's tracker and how tasks pair to it. */
export interface ProjectManagementConfig {
    /** The team's tracker; the default `tracker.system` for new tasks. */
    readonly system: TrackerSystem;
    /** URL prefix a task's `tracker.key` is appended to, to build a deep link. */
    readonly baseUrl?: string;
    /** Default issue/work-item type stamped on newly authored tasks. */
    readonly defaultType?: string;
}
/** Per-loop-kind settings under the config's `loops.<kind>` section. */
export interface LoopKindConfig {
    readonly enabled: boolean;
    /** Per-kind override of the global `codePlatform`. */
    readonly codePlatform?: CodePlatform;
    /** Kind-specific knobs (e.g. the PR sitter's `query`) — validated by the kind. */
    readonly [key: string]: unknown;
}
export interface Config {
    readonly maxIterations: number;
    /** Repo-relative root of the task backlog (folders are statuses). */
    readonly tasksDir: string;
    /** Wall-clock cap on a single stage before the loop gives up on it. */
    readonly stageTimeoutMinutes: number;
    /** Per-task worktree root; unset ⇒ shared-tree branch switching. */
    readonly worktreesDir?: string;
    /** Shell command run in a fresh worktree after creation. */
    readonly worktreeSetup?: string;
    /** Extra REVIEW lenses; each runs one more focused review pass. */
    readonly reviewLenses: readonly string[];
    /** Global code platform for PR-shaped work sources; per-kind override via `loops.<kind>.codePlatform`. */
    readonly codePlatform?: CodePlatform;
    /** Azure DevOps coordinates; required when any effective platform is `ado`. */
    readonly ado?: AdoConfig;
    /** Per-loop-kind sections; engineering is on unless explicitly disabled, other kinds are opt-in. */
    readonly loops: Readonly<Record<string, LoopKindConfig>>;
    /** Project-management setup; drives task-authoring defaults and the status pairing view. */
    readonly projectManagement?: ProjectManagementConfig;
}
/** Construct a LoopState entering execution at build, for a claimed
 *  in-progress task whose plan was approved via `/agent-loop-task approve-plan`. */
export declare const resumeAtBuild: (goal: string, task: TaskRef, plan: string) => LoopState;
/** Construct a LoopState entering at the PLAN stage, for a claimed `queued/`
 *  task. `priorPlan` carries a rejected/capped plan on a replan so the new
 *  plan addresses why the old one failed instead of repeating it. */
export declare const startAtPlan: (goal: string, task: TaskRef, priorPlan?: string) => LoopState;
export declare const getLoop: (sessionID: string) => LoopState | undefined;
/** The session whose live loop is driving the given task id, if any (this plugin instance only). */
export declare const findSessionDriving: (taskId: string) => string | undefined;
export declare const setLoop: (sessionID: string, state: LoopState) => void;
export declare const clearLoop: (sessionID: string) => boolean;
export declare const hasLoop: (sessionID: string) => boolean;
