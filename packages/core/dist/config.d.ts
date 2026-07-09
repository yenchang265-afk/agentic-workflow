import { z } from "zod";
import type { Client } from "./host.js";
import { type Config } from "./loop/state.js";
import { type TrackerSystem } from "./task/schema.js";
/**
 * Loop configuration, read from `.agentic-loop.json` at the repo root via the
 * host client (no Node fs dependency). The file is optional; every field has
 * a sane default. Misconfiguration fails fast with a clear message rather than
 * silently falling back to defaults.
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
export declare const DEFAULT_CONFIG: Config;
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
export declare const parseConfigWith: <T>(schema: ConfigSchemaLike<T>, raw: unknown) => T;
/** Validate an already-parsed config object; throws a readable error on misconfig. */
export declare const parseConfig: (raw: unknown) => Config;
/** Load a host config from the repo root, falling back to the schema's defaults when the file is absent. */
export declare const loadConfigWith: <T>(schema: ConfigSchemaLike<T> & {
    parse(raw: unknown): T;
}, client: Client, directory: string) => Promise<T>;
/** Load config from the repo root, falling back to defaults when the file is absent. */
export declare const loadConfig: (client: Client, directory: string) => Promise<Config>;
export {};
