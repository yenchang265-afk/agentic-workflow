import { z } from "zod";
import type { Client } from "./host.js";
import { type Config } from "./loop/state.js";
import { type TrackerSystem } from "./task/schema.js";
/**
 * Loop configuration, layered from two optional files: a user-scope
 * `~/.agentic-loop.json` (settings shared across every repo — e.g.
 * `ado.organization`, `ado.selfLogin`, `ado.pat`) under a repo-scope
 * `.agentic-loop.json` at the repo root, which overrides it field by field.
 * The repo layer is read via the host client; the user layer sits outside the
 * project directory, so it is read with Node fs directly (precedent:
 * manifest/load.ts). Both files are optional; every field has a sane default.
 * Misconfiguration fails fast with a clear message rather than silently
 * falling back to defaults.
 *
 * Host-only fields (e.g. the OpenCode plugin's `watchIntervalMinutes`) live in
 * each host's extension of `ConfigSchema` — see the generic `parseConfigWith`/
 * `loadConfigWith` loaders below.
 */
/** Which code-management platform PR-shaped work sources talk to. */
export declare const CodePlatformSchema: z.ZodEnum<{
    github: "github";
    ado: "ado";
}>;
export type CodePlatform = z.infer<typeof CodePlatformSchema>;
/**
 * How the repo's project management is set up, so task authoring and the status
 * roll-up align with the team's tracker (Jira or Azure DevOps). Optional — unset
 * means the loop is tracker-agnostic (today's behavior; tasks may still carry an
 * ad-hoc `tracker` block). See docs/configuration.md.
 */
export declare const ProjectManagementSchema: z.ZodObject<{
    system: z.ZodEnum<{
        jira: "jira";
        "azure-devops": "azure-devops";
    }>;
    baseUrl: z.ZodOptional<z.ZodString>;
    defaultType: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type ProjectManagement = z.infer<typeof ProjectManagementSchema>;
export declare const ConfigSchema: z.ZodObject<{
    maxIterations: z.ZodDefault<z.ZodNumber>;
    tasksDir: z.ZodDefault<z.ZodString>;
    stageTimeoutMinutes: z.ZodDefault<z.ZodNumber>;
    worktreesDir: z.ZodOptional<z.ZodString>;
    worktreeSetup: z.ZodOptional<z.ZodString>;
    reviewLenses: z.ZodDefault<z.ZodArray<z.ZodString>>;
    loops: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        /** Per-kind override of the global `codePlatform`. */
        codePlatform: z.ZodOptional<z.ZodEnum<{
            github: "github";
            ado: "ado";
        }>>;
    }, z.core.$loose>>>;
    codePlatform: z.ZodDefault<z.ZodEnum<{
        github: "github";
        ado: "ado";
    }>>;
    ado: z.ZodOptional<z.ZodObject<{
        organization: z.ZodString;
        project: z.ZodString;
        repository: z.ZodOptional<z.ZodString>;
        selfLogin: z.ZodOptional<z.ZodString>;
        pat: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    projectManagement: z.ZodOptional<z.ZodObject<{
        system: z.ZodEnum<{
            jira: "jira";
            "azure-devops": "azure-devops";
        }>;
        baseUrl: z.ZodOptional<z.ZodString>;
        defaultType: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * The loop kinds this config activates, in claim-priority order: engineering
 * first (unless disabled), then any opted-in kinds in config order. Pure.
 */
export declare const enabledLoopKinds: (config: Config) => string[];
/** The code platform a loop kind's PR source talks to: per-kind override, else the global default. Pure. */
export declare const platformFor: (config: Config, kind: string) => CodePlatform;
/**
 * Build a tracker deep link from a task's `tracker.key` and the configured
 * `projectManagement.baseUrl` — the base URL with the key appended. Returns
 * undefined when no base URL is configured (link building is opt-in). Pure.
 */
export declare const trackerUrl: (pm: ProjectManagement | undefined, key: string) => string | undefined;
/** The default `tracker.system` for newly authored tasks, from the PM config. Pure. */
export declare const defaultTrackerSystem: (config: Config) => TrackerSystem | undefined;
/**
 * Best-effort: export config `ado.pat` as `AZURE_DEVOPS_EXT_PAT` when that env
 * var is unset, so child processes this driver starts — the PR sitter's
 * stage-agent `curl` calls — can authenticate to Azure DevOps without a
 * separately-exported PAT. The env var always wins; this never overrides one.
 * Side-effecting by design; call once after loading config. On hosts where the
 * stage agents run in a different process than the driver (Claude Code), set
 * the env var in that environment — this can't cross the process boundary.
 */
export declare const applyAdoPatEnv: (config: {
    readonly ado?: {
        readonly pat?: string;
    };
}) => void;
export declare const DEFAULT_CONFIG: Config;
/** Env override for the user-scope config path; set to "" to disable the layer (e.g. in CI). */
export declare const USER_CONFIG_ENV = "AGENTIC_LOOP_USER_CONFIG";
/**
 * Where the user-scope config lives: $AGENTIC_LOOP_USER_CONFIG when set ("" →
 * layer disabled), else `~/.agentic-loop.json`. Returns null when the layer is
 * disabled or no home directory can be resolved.
 */
export declare const resolveUserConfigPath: () => string | null;
/**
 * Field-level deep merge of raw config layers (override wins): plain objects
 * merge per key recursively; arrays, scalars, and null replace wholesale —
 * null is not a delete operator, it simply fails schema validation downstream.
 * Layers merge BEFORE the zod parse so schema defaults apply only to the
 * combined view (a repo file omitting `maxIterations` cannot clobber a
 * user-scope `maxIterations`). Pure.
 */
export declare const mergeConfigLayers: (base: unknown, override: unknown) => unknown;
/** A zod schema whose parse produces some host's config shape. */
type ConfigSchemaLike<T> = {
    safeParse(raw: unknown): {
        success: true;
        data: T;
    } | {
        success: false;
        error: z.ZodError;
    };
};
/** Validate an already-parsed config object against a host schema; throws a readable error on misconfig. */
export declare const parseConfigWith: <T>(schema: ConfigSchemaLike<T>, raw: unknown, label?: string) => T;
/** Validate an already-parsed config object; throws a readable error on misconfig. */
export declare const parseConfig: (raw: unknown) => Config;
export interface LoadConfigOptions {
    /**
     * Absolute path of the user-scope config file. `null` disables the layer;
     * undefined → `resolveUserConfigPath()`. Tests must pass an explicit value
     * so a developer's real `~/.agentic-loop.json` never leaks in.
     */
    readonly userConfigPath?: string | null;
}
/**
 * Read and JSON-parse the user-scope layer with Node fs (it lives outside the
 * project directory, beyond the host client's reach). Absent or unreadable →
 * undefined (layer not present); malformed JSON or a non-object top level →
 * throw naming the offending file, never a silent skip — this layer may carry
 * `ado.pat`/`selfLogin`, and dropping it would surface later as a baffling
 * validation error. Exported for consumers of user-scope-only sections (the
 * hub reads its `hub` section exclusively from this layer).
 */
export declare const readUserLayer: (userPath: string) => unknown;
/**
 * Load a host config by layering the user-scope file (if any) under the repo's
 * `.agentic-loop.json` (repo wins field by field), falling back to the
 * schema's defaults when both are absent.
 */
export declare const loadConfigWith: <T>(schema: ConfigSchemaLike<T> & {
    parse(raw: unknown): T;
}, client: Client, directory: string, opts?: LoadConfigOptions) => Promise<T>;
/** Load config (user layer under repo layer), falling back to defaults when both files are absent. */
export declare const loadConfig: (client: Client, directory: string, opts?: LoadConfigOptions) => Promise<Config>;
export {};
