import type { Client, Log, Shell } from "../host.js";
import type { LoadedManifest } from "../manifest/schema.js";
import type { WorkSource } from "../source/types.js";
import type { Task } from "../task/schema.js";
import type { Config, LoopState, TaskRef } from "./state.js";
/**
 * Host-agnostic orchestration helpers shared by the two drivers — the
 * OpenCode plugin (`plugins/opencode/src/loop/driver.ts`) and the Claude Code
 * MCP server (`plugins/claude/mcp-server/src/server.ts`). Each was hand-
 * porting these between the two files; this module is the single copy,
 * parameterized over the `host.ts` interfaces.
 */
/** A task's goal text: title headline plus its body, if any. Pure. */
export declare const taskGoal: (task: Task) => string;
/** The reference a loop state carries for its backing task file. Pure. */
export declare const taskRef: (task: Task, filePath: string) => TaskRef;
/** The working directory a loop's stages operate in: its worktree, else the main tree. Pure. */
export declare const loopWorkTree: (directory: string, state: LoopState) => string;
/** BUILD-entry state for an approved in-progress task (plan persisted on the file). Pure. */
export declare const buildEntryState: (task: Task) => LoopState;
/** PLAN-entry state for a queued (planless) task. Pure. */
export declare const planEntryState: (task: Task) => LoopState;
/**
 * A lazily-loading manifest cache keyed by loop kind. Eager kinds (usually
 * just "engineering") are loaded up front so a broken default manifest fails
 * at startup, not on first claim.
 */
export declare const makeManifestCache: (loopsDir: string, eager?: readonly string[]) => ((kind: string) => LoadedManifest);
/** Everything `buildWorkSources` needs from the host. */
export interface WorkSourceDeps {
    readonly $: Shell;
    readonly client: Client;
    readonly directory: string;
    readonly log: Log;
    /** Whether a live loop in this process is already driving the task id. */
    readonly isDriving: (id: string) => boolean;
}
/**
 * The work sources the scheduler polls, in claim-priority order (config
 * order). An `only` kind restricts the poll to that one kind (the claim/watch
 * kind filter). A typo'd or unavailable `loops.<kind>` (the config schema is
 * an open record) must not throw here — that would abort the whole build and
 * take every OTHER enabled source (engineering included) down with it, so no
 * work ever gets claimed. Skip-and-warn the bad kind instead.
 */
export declare const buildWorkSources: (deps: WorkSourceDeps, config: Config, manifestFor: (kind: string) => LoadedManifest, only?: string) => WorkSource[];
