import type { Client, Log, Shell } from "../host.js";
import type { LoadedManifest } from "../manifest/schema.js";
import type { Task } from "../task/schema.js";
import type { ClaimSkipReason, WorkSource } from "./types.js";
/**
 * The backlog-folder work source: claimable units of work are markdown task
 * files in the manifest's status folders (`workSource.pools`, walked in
 * priority order — for engineering: build-ready `in-progress/` beats planless
 * `queued/`). Claims stay atomic via the store's `.claims/` mkdir markers;
 * orphaned markers (a claimer that died) are released and retried inline.
 */
/** A task's goal text: title headline plus its body, if any. Pure. */
export declare const taskGoal: (task: Task) => string;
interface BacklogDeps {
    readonly $: Shell;
    readonly client: Client;
    readonly directory: string;
    readonly tasksDir: string;
    readonly log: Log;
    readonly loaded: LoadedManifest;
    /** Whether a live loop in this host instance is already driving the task id. */
    readonly isDriving: (id: string) => boolean;
}
/**
 * Compute why a poll claimed nothing, from what the claim walk saw across the
 * pools. Held markers win (they block otherwise-ready work); then empty
 * backlog; then started-but-unclaimed (recover); then the no-plan fallback.
 * Pure. The strings are engineering-flavored (this is the engineering
 * backlog's skip reporter); a future backlog-backed kind with different
 * folders should supply its own.
 */
export declare const claimSkipReason: (inProgressCount: number, claimableCount: number, queuedCount: number, startedIds: readonly string[], heldIds: readonly string[]) => ClaimSkipReason;
export declare const makeBacklogSource: (deps: BacklogDeps) => WorkSource;
export {};
