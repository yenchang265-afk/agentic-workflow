import { z } from "zod";
import type { Client } from "./host.js";
import type { Config } from "./loop/state.js";
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
export declare const ConfigSchema: z.ZodObject<{
    maxIterations: z.ZodDefault<z.ZodNumber>;
    tasksDir: z.ZodDefault<z.ZodString>;
    stageTimeoutMinutes: z.ZodDefault<z.ZodNumber>;
    worktreesDir: z.ZodOptional<z.ZodString>;
    worktreeSetup: z.ZodOptional<z.ZodString>;
    reviewLenses: z.ZodDefault<z.ZodArray<z.ZodString>>;
    loops: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$loose>>>;
}, z.core.$strip>;
/**
 * The loop kinds this config activates, in claim-priority order: engineering
 * first (unless disabled), then any opted-in kinds in config order. Pure.
 */
export declare const enabledLoopKinds: (config: Config) => string[];
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
