import type { Client, Log, Shell } from "../host.js";
import { type Task, type TaskInput } from "./schema.js";
/**
 * Filesystem IO for the task backlog. **Impure**: reads via the host client
 * and moves files via the host shell (`$`), since the SDK has no file-write/move.
 * The folder a file lives in is its status; moves are how the driver advances a
 * task through its lifecycle.
 */
/** Anything with an id + on-disk path can be moved or annotated. */
type FileRef = {
    readonly id: string;
    readonly path: string;
};
export { STATUSES, type TaskStatus } from "./statuses.js";
import { type TaskStatus } from "./statuses.js";
/** All tasks in claim order: lowest priority number first, ties broken by id. Pure. */
export declare const selectOrder: (tasks: readonly Task[]) => Task[];
/** Pick the next task: lowest priority number, ties broken by id. Pure. */
export declare const selectNext: (tasks: readonly Task[]) => Task | null;
/** Marks a task as planned, awaiting approval — appended to its body by `appendPlan`. */
export declare const PLAN_HEADING = "## Implementation Plan";
/** Whether a task already has a plan persisted (appended at a prior approval gate). Pure. */
export declare const hasPlan: (task: Task) => boolean;
/**
 * Eligible for `/agentic-loop:engineering watch` to claim: planned, and never had ANY
 * "> BUILD started" note — not just "last pair unmatched" (that's
 * `wasInterrupted`, below). Any marker at all means another live LoopState
 * is driving it right now, or it crashed and needs manual recovery — a
 * watch session must never silently reclaim either case. Pure.
 */
export declare const isClaimable: (task: Task) => boolean;
/** The persisted plan text following `PLAN_HEADING`, or `undefined` if absent. Pure. */
export declare const extractPlan: (task: Task) => string | undefined;
/**
 * Planned and started at least once — no longer claimable by `/agentic-loop:engineering watch`,
 * but a human can force-resume it with `/agentic-loop:engineering recover <id>` once no live
 * loop is driving it (crashed runs, restarted plugins). Pure.
 */
export declare const isRecoverable: (task: Task) => boolean;
/**
 * Whether the task's last recorded BUILD run has no matching "finished" note —
 * i.e. the process likely died mid-build, possibly leaving a half-finished diff
 * in the working tree. Only BUILD is tracked: it's the sole stage that writes
 * code. Pure.
 */
export declare const wasInterrupted: (task: Task) => boolean;
/** A per-status roll-up of the backlog for `/agentic-loop:engineering status`. Pure. */
export interface BacklogSummary {
    readonly counts: Readonly<Record<TaskStatus, number>>;
    /** queued tasks awaiting the loop's PLAN stage (a watcher will claim them once no build work remains). */
    readonly awaitingPlan: readonly string[];
    /** plan-review tasks whose plan is parked for human review (/agentic-loop:engineering approve). */
    readonly gated: readonly string[];
    /** in-progress tasks parked and never started (a watcher will claim them). */
    readonly claimable: readonly string[];
    /** in-progress tasks whose body is claimable but whose claim marker is currently held. */
    readonly claimHeld: readonly string[];
    /** in-progress tasks whose last build looks interrupted (crashed — /agentic-loop:engineering recover). */
    readonly interrupted: readonly string[];
    /** in-review tasks awaiting a human diff review (/agentic-loop:engineering approve). */
    readonly awaitingReview: readonly string[];
}
/**
 * Roll up tasks-by-status into counts and actionable flag lists. `claimedIds`
 * (ids holding a claim marker, see `listClaimIds`) splits body-claimable tasks
 * into truly claimable vs claim-held, so status never reports a task "ready"
 * that no watcher can actually claim. Pure.
 */
export declare const summarizeBacklog: (byStatus: Readonly<Record<TaskStatus, readonly Task[]>>, claimedIds?: readonly string[]) => BacklogSummary;
/**
 * Pairing coverage across the active backlog (everything but completed/abandoned):
 * how many active tasks carry a `tracker` block vs the ids of those that don't.
 * Feeds the `loop_status` pairing view when project management is configured. Pure.
 */
export declare const pairingCoverage: (byStatus: Readonly<Record<TaskStatus, readonly Task[]>>) => {
    readonly paired: number;
    readonly unpaired: readonly string[];
};
/**
 * List and parse every task in a given status folder. Invalid files are
 * skipped (logged) rather than failing the whole pick. Returns `[]` when the
 * folder is absent.
 */
export declare const listByStatus: (client: Client, directory: string, tasksDir: string, status: TaskStatus, log?: Log) => Promise<Task[]>;
/** List and parse every task in `queued/` — approved, awaiting the loop's PLAN stage. */
export declare const listQueued: (client: Client, directory: string, tasksDir: string, log?: Log) => Promise<Task[]>;
/** List and parse every task in `in-progress/` — the pool `/agentic-loop:engineering watch` claims from. */
export declare const listInProgress: (client: Client, directory: string, tasksDir: string, log?: Log) => Promise<Task[]>;
/**
 * Resolve a specific task by id within a status folder, or null if missing/invalid.
 *
 * Reads the REAL filesystem through the shell (`$ cat <abs path>`), NOT the host
 * client. On opencode the file client is served by a watcher-backed index that lags
 * the real FS after a shell `mv` (see `moveTask`), and it resolves a hand-built
 * relative read path differently from a listed one — so right after the loop moves a
 * task into a folder, a client-based lookup can read the plainly-present file back as
 * missing and every gate toasts "no task found". The shell has neither problem: it
 * operates on the real absolute path, exactly as `moveTask`/`claimTask` already do.
 * Hand-building `<id>.md` is safe HERE because it goes to the shell, not the client.
 *
 * Only ever called on human-triggered / one-off / loop-terminal paths (gates, replan,
 * ship, recover, start, findAnyStatus), never per-poll — the scheduler enumerates
 * unknown ids via `listByStatus` and tolerates lag by retrying each tick — so one
 * `cat` per call is free.
 */
export declare const findByIdIn: ($: Shell, directory: string, tasksDir: string, status: TaskStatus, id: string, log?: Log) => Promise<Task | null>;
/**
 * Atomically claim a task for execution. A plain (non-recursive) `mkdir` of
 * the marker either succeeds — claim won — or fails because another watcher
 * on this filesystem already holds it. Closes the window between listing
 * claimable tasks and appending the `> BUILD started` note.
 */
export declare const claimTask: ($: Shell, task: FileRef) => Promise<boolean>;
/** Release a task's claim marker, if present. Best-effort. */
export declare const releaseClaim: ($: Shell, task: FileRef) => Promise<void>;
/**
 * A claim marker older than this, on a task with no BUILD note and no live
 * loop, is treated as orphaned — its claimer died between `claimTask` and the
 * first "BUILD started" note. Must exceed the worst-case claim→BUILD-note
 * window, including a slow `worktreeSetup` (e.g. npm ci).
 */
export declare const STALE_CLAIM_MINUTES = 15;
/**
 * Whether a `FileRef`'s claim marker exists and is older than `minutes`.
 * `find -mmin +N` prints the path only when strictly older (GNU and BSD).
 * Any failure — marker absent, or a `find` without `-mmin` semantics — reads
 * as "not stale", degrading safely to "marker stays held".
 */
export declare const claimOlderThan: ($: Shell, task: FileRef, minutes: number) => Promise<boolean>;
/** Ids currently holding a claim marker in a status folder's `.claims/`. `[]` when absent. */
export declare const listClaimIds: ($: Shell, directory: string, tasksDir: string, status?: TaskStatus) => Promise<string[]>;
/**
 * An orphaned claim: the task body never recorded a BUILD (still claimable),
 * no live loop is driving it, and the marker has aged past the crash window.
 * Only such markers may be released without racing a live claimer. Pure.
 */
export declare const isOrphanedClaim: (task: Task, opts: {
    readonly drivenByLiveLoop: boolean;
    readonly markerStale: boolean;
}) => boolean;
/**
 * The `queued/` variant of `isOrphanedClaim`: a queued task is planless by
 * definition (no `isClaimable` gate applies) and its PLAN stage never writes
 * code, so a stale, undriven marker is always safe to release — a died PLAN
 * left at most a partial plan on the task file, which the next PLAN pass
 * overwrites. Pure.
 */
export declare const isOrphanedPlanClaim: (_task: Task, opts: {
    readonly drivenByLiveLoop: boolean;
    readonly markerStale: boolean;
}) => boolean;
/** Result of walking the claim candidates: the winner, and the ids whose markers stayed held. */
export interface ClaimAttempt {
    readonly claimed: Task | null;
    readonly heldIds: readonly string[];
}
/**
 * Try candidates (already in `selectOrder`) until one claim wins — a single
 * held marker must not block the tasks queued behind it. A failed claim whose
 * marker looks orphaned is released and retried ONCE; failing the retry means
 * another instance raced us — treat as held and move on.
 */
export declare const claimFirst: ($: Shell, candidates: readonly Task[], opts: {
    readonly isDriving: (id: string) => boolean;
    readonly staleMinutes?: number;
    readonly log?: Log;
    /** Orphan predicate — defaults to `isOrphanedClaim`; use `isOrphanedPlanClaim` for `queued/` candidates. */
    readonly isOrphaned?: typeof isOrphanedClaim;
}) => Promise<ClaimAttempt>;
/**
 * Startup sweep: release claim markers left behind by dead runs. Two shapes —
 * a marker whose task body is still claimable (crashed between `claimTask`
 * and the BUILD note), and a marker with no task file at all (crashed between
 * `moveTask`'s `mv` and `rmdir`). Both only when stale and not live-driven.
 * Returns the released ids.
 */
export declare const releaseOrphanedClaims: ($: Shell, inProgress: readonly Task[], claimIds: readonly string[], inProgressDir: string, opts: {
    readonly isDriving: (id: string) => boolean;
    readonly staleMinutes?: number;
    /** Orphan predicate — defaults to `isOrphanedClaim`; use `isOrphanedPlanClaim` when sweeping `queued/`. */
    readonly isOrphaned?: typeof isOrphanedClaim;
}) => Promise<string[]>;
/**
 * Whether a task may move from `from` to `to`. Tasks advance exactly one
 * stage at a time — no skipping — with two escapes: any non-terminal stage
 * may be abandoned directly (cancellation isn't a forward skip), and a
 * replan sends `plan-review` or `in-progress` back to `queued` (the plan was
 * rejected or the loop capped out — the PLAN stage runs again). `completed`
 * and `abandoned` are terminal: nothing moves out of them. Pure.
 */
export declare const canTransition: (from: TaskStatus, to: TaskStatus) => boolean;
/** The status folder a task file currently lives in, derived from its path. */
export declare const statusOf: (task: FileRef) => TaskStatus;
/**
 * Move a task file into a new status folder. Returns its new absolute path.
 * Enforces the lifecycle order via `canTransition` — throws rather than
 * skipping a stage.
 */
export declare const moveTask: ($: Shell, task: FileRef, toStatus: TaskStatus) => Promise<string>;
/**
 * Rescue a stray task file (found by `auditBacklog` outside every status
 * folder — e.g. `docs/tasks/run/x.md`) back into `draft/`, the human-review
 * inbox. Deliberately bypasses `canTransition`: `statusOf` throws on unknown
 * folders, and a rescue is a repair, not a lifecycle move — `moveTask` stays
 * strict. Refuses to clobber an existing draft; returns the new path.
 */
export declare const rescueStray: ($: Shell, directory: string, tasksDir: string, relPath: string) => Promise<{
    id: string;
    path: string;
}>;
/** Append a blockquote note to a task file in place. Secrets redacted. Best-effort. */
export declare const appendNote: ($: Shell, task: FileRef, note: string, log?: Log) => Promise<void>;
/**
 * Render an audit event note: the event text with a timestamp-and-actor
 * suffix. The suffix comes last so marker greps (`> BUILD started`, …) keep
 * matching. Pure.
 */
export declare const auditNote: (text: string, at: Date, actor?: string | null) => string;
/**
 * Append a stage's captured output to the loop's run log,
 * `<tasksDir>/runs/<id>.md` — the durable record of what each stage actually
 * said (verdict evidence, review findings), which the in-memory artifacts
 * are not. Best-effort.
 */
export declare const appendRunLog: ($: Shell, directory: string, tasksDir: string, id: string, header: string, text: string, log?: Log) => Promise<void>;
/** Append a plan under `PLAN_HEADING` to a task file in place. Secrets redacted. Best-effort. */
export declare const appendPlan: ($: Shell, task: FileRef, plan: string, log?: Log) => Promise<void>;
/** Where a newly written task lands. Defaults to `draft/`, the human-review inbox. */
export interface WriteLocation {
    readonly directory: string;
    readonly tasksDir?: string;
    readonly status?: TaskStatus;
}
/**
 * Create a task file programmatically from *inside the plugin runtime* (a
 * future in-plugin sync adapter — see docs/design/explore-task-fetch-and-pr-gating.md).
 * Needs an opencode `client` and Bun `$`, so it can't run as a plain terminal
 * command. For creating a task today, use `/agentic-loop:engineering new <idea>` — the
 * `loop-plan-author` subagent, which runs inside OpenCode; see the
 * `task-backlog-management` skill. Serializes + validates via `buildTaskFile`,
 * picks a non-colliding filename against what's already in the folder, and
 * writes it. Returns the new task's id and absolute path.
 */
export declare const writeTask: ($: Shell, client: Client, loc: WriteLocation, input: TaskInput) => Promise<{
    id: string;
    path: string;
}>;
