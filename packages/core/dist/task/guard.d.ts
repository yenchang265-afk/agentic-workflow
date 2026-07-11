/**
 * Backlog-mutation guard: classifies a tool call an *agent* is about to make
 * (Bash / Write / Edit) against the task backlog, so hosts can block direct
 * mutations of `<tasksDir>/` that bypass the MCP verbs' state machine.
 *
 * The folder a task file lives in IS its status — a raw `mv`/`mkdir`/`rm` or
 * an in-place Write can silently corrupt the lifecycle (stray folders, stage
 * skips). Both hosts enforce this with THIS code: the OpenCode plugin imports
 * it in `tool.execute.before`; the Claude Code plugin's PreToolUse hook
 * (plugins/claude/hooks/check-stage-guard.mjs) is esbuild-bundled from a
 * source that imports it (hooks/src/, built by scripts/build-hooks.mjs).
 *
 * This is heuristic defense-in-depth against degraded/confused models, not a
 * sandbox: string-matching a shell command cannot catch every spelling. The
 * deterministic layer (`moveTask` + `canTransition`) stays authoritative.
 * Pure.
 */
export interface GuardContext {
    /** Repo-relative backlog dir, e.g. "docs/tasks". */
    readonly tasksDir: string;
    /** Task id a live PLAN stage may write onto in `queued/`, if one is running. */
    readonly planTaskId?: string | null;
}
export type GuardVerdict = {
    readonly allow: true;
} | {
    readonly allow: false;
    readonly reason: string;
};
/** The backlog-relative remainder of `filePath` (e.g. "draft/a.md"), or null when outside the backlog. */
export declare const backlogRelPath: (filePath: string, tasksDir: string) => string | null;
/**
 * Edit-shaped tools (Write / Edit / MultiEdit / NotebookEdit) targeting a
 * single file path. Allowed inside the backlog: authoring drafts
 * (`draft/*.md` — the `loop-plan-author` inbox) and a live PLAN stage writing
 * the plan onto its own task in `queued/`. Everything else — status folders,
 * `runs/`, unknown dirs — is blocked.
 */
export declare const classifyEdit: (filePath: string, ctx: GuardContext) => GuardVerdict;
/**
 * Bash commands. A command that never references the backlog dir is allowed.
 * One that does is default-denied unless every pipeline segment either matches
 * the read-only allowlist or is a canonical-status `mkdir` (scaffolding), with no
 * output redirection and no `find -exec`-style escape — so `mv`, `rm`, `sed -i`,
 * `tee`, `>`, and any non-canonical `mkdir` into the backlog are blocked by
 * construction.
 */
export declare const classifyBash: (command: string, ctx: GuardContext) => GuardVerdict;
/** Route a tool call to the right classifier. Unknown tools are allowed (not this guard's concern). */
export declare const classifyMutation: (tool: string, args: {
    readonly filePath?: string | null;
    readonly command?: string | null;
}, ctx: GuardContext) => GuardVerdict;
/** Re-export for hosts that report which folders are protected. */
export declare const PROTECTED_STATUSES: readonly import("./statuses.js").TaskStatus[];
