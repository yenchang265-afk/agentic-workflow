import type { Shell } from "../host.js";
/** Whether `cwd` is inside a git work tree. */
export declare const isGitRepo: ($: Shell, cwd: string) => Promise<boolean>;
/** The currently checked-out branch name, or null (detached HEAD / not a repo). */
export declare const currentBranch: ($: Shell, cwd: string) => Promise<string | null>;
/** Whether the working tree has any uncommitted changes (staged or not). */
export declare const isDirty: ($: Shell, cwd: string) => Promise<boolean>;
/**
 * Check out `branch`, creating it from the current HEAD when it doesn't exist
 * yet (an existing branch — e.g. from a recovered run — is reused as-is,
 * never reset). Returns false when the checkout failed.
 */
export declare const checkoutBranch: ($: Shell, cwd: string, branch: string) => Promise<boolean>;
/**
 * Stage everything and commit. Returns false when there was nothing to commit
 * or the commit failed — callers treat both as "no checkpoint taken".
 */
export declare const commitAll: ($: Shell, cwd: string, message: string) => Promise<boolean>;
/**
 * Stage and commit only the given paths — used to commit backlog mutations
 * (task moves, persisted plans) without sweeping up unrelated working-tree
 * changes. Returns false when nothing was committed.
 */
export declare const commitPaths: ($: Shell, cwd: string, paths: readonly string[], message: string) => Promise<boolean>;
/** The committer identity configured for this tree, as `Name <email>`, or null. */
export declare const gitActor: ($: Shell, cwd: string) => Promise<string | null>;
/** Whether a local branch ref already exists. */
export declare const branchExists: ($: Shell, cwd: string, branch: string) => Promise<boolean>;
/**
 * Create a worktree at `wtPath` checked out to `branch`, cut from `base` (or
 * HEAD) when the branch doesn't exist yet. An existing branch is reused as-is,
 * never reset — same contract as `checkoutBranch`. Returns false on failure.
 */
export declare const addWorktree: ($: Shell, cwd: string, wtPath: string, branch: string, base?: string) => Promise<boolean>;
/**
 * Remove the worktree at `wtPath`. Deliberately no `--force`: a dirty worktree
 * (a checkpoint commit that failed) must survive for human inspection rather
 * than be silently discarded. The branch is never touched. Returns false when
 * the worktree was dirty/locked and thus left in place.
 */
export declare const removeWorktree: ($: Shell, cwd: string, wtPath: string) => Promise<boolean>;
/** Drop registrations for worktrees whose directories have vanished. Safe/no-op otherwise. */
export declare const pruneWorktrees: ($: Shell, cwd: string) => Promise<void>;
/** One registered worktree: its absolute path and checked-out branch (if any). */
export interface WorktreeEntry {
    readonly path: string;
    readonly branch: string | null;
}
/** Every registered worktree in the repo (including the main one). Empty on failure. */
export declare const listWorktrees: ($: Shell, cwd: string) => Promise<WorktreeEntry[]>;
/** The absolute path of the worktree checked out to `branch`, or null if none. */
export declare const worktreeForBranch: ($: Shell, cwd: string, branch: string) => Promise<string | null>;
/**
 * Idempotently exclude `rel` from git status via `<git-common-dir>/info/exclude`
 * — keeps a nested worktrees directory out of the human's `git status` without
 * touching the tracked `.gitignore`. Best-effort.
 */
export declare const ensureExcluded: ($: Shell, cwd: string, rel: string) => Promise<void>;
