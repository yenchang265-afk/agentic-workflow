import type { Log, Shell } from "../host.js";
import type { Config, LoopState } from "./state.js";
/**
 * Git isolation for one loop's execution. Host-agnostic: parameterized over
 * the host shell and logger, so both the OpenCode driver and the Claude Code
 * MCP server drive the exact same behavior.
 */
export declare const loopId: (state: LoopState) => string;
/** Absolute path to a task's dedicated worktree under the configured root. Pure. */
export declare const worktreePathFor: (directory: string, worktreesDir: string, id: string) => string;
/**
 * Isolate execution for this loop. Two modes:
 *
 * - **Worktree mode** (`config.worktreesDir` set): each loop gets its own
 *   `git worktree` on `feature/<id>`, cut from `base`. The human's checkout is
 *   never touched and concurrent drives are safe. If the worktree can't be
 *   created it **throws** — never falls back to shared-tree branch switching,
 *   which could clobber a concurrent drive's checked-out branch.
 * - **Shared-tree mode** (default): checks out `feature/<id>` in the main tree.
 *   Degrades to no isolation (with a warning) outside a git repo, on a
 *   detached HEAD, or when checkout fails.
 *
 * An existing branch (e.g. a recovered run's) is reused, never reset.
 *
 * `baseBranch` (optional) is the branch a fresh `feature/<id>` is cut from; when a
 * host resolves one it wins over the branch `directory` has checked out. Unset
 * ⇒ cut from `currentBranch(directory)` as before.
 */
export declare const ensureIsolation: ($: Shell, log: Log, directory: string, config: Config, state: LoopState, baseBranch?: string) => Promise<LoopState>;
/**
 * Tear down this loop's isolation. Worktree mode: remove the worktree if it's
 * clean (the branch is kept for human review); a dirty worktree or a failed
 * removal is left in place with a warning. Shared mode: return the main tree to
 * the branch it was on before the loop branched off.
 */
export declare const teardownIsolation: ($: Shell, log: Log, directory: string, state: LoopState) => Promise<void>;
