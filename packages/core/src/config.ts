import { z } from "zod"
import type { Client } from "./host.js"
import { CODE_PLATFORMS, type Config } from "./loop/state.js"

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
export const CodePlatformSchema = z.enum(CODE_PLATFORMS)
export type CodePlatform = z.infer<typeof CodePlatformSchema>

const BaseConfigSchema = z.object({
  /** Max loop iterations before stopping on repeated verify/review failures. */
  maxIterations: z.number().int().positive().default(3),
  /** Repo-relative root of the task backlog; its subfolders are task statuses. */
  tasksDir: z.string().min(1).default("docs/tasks"),
  /** Wall-clock cap on a single stage; a stage exceeding it fails the loop instead of hanging it. */
  stageTimeoutMinutes: z.number().int().positive().default(60),
  /**
   * Repo-relative (or absolute) directory for per-task git worktrees. When set,
   * each loop's BUILD/VERIFY/REVIEW runs against its own worktree instead of
   * switching branches in the shared checkout — the human's tree is never
   * touched and concurrent watch sessions become safe. Unset → today's
   * shared-tree branch switching. See docs/design/improvements/01.
   */
  worktreesDir: z.string().min(1).optional(),
  /** Optional shell command run inside a freshly created worktree (e.g. "npm ci"). */
  worktreeSetup: z.string().min(1).optional(),
  /**
   * Extra REVIEW lenses; each runs the review stage once more focused on that
   * lens, and the loop takes the worst verdict across all passes. Unset/[] →
   * a single review (today's behavior). See docs/design/improvements/04.
   */
  reviewLenses: z.array(z.string().min(1)).max(5).default([]),
  /**
   * Per-loop-kind sections keyed by kind (a `loops/<kind>/` manifest).
   * Engineering runs unless explicitly disabled; every other kind is opt-in
   * (`enabled: true`). Kind-specific knobs ride along and are validated by
   * the kind itself. See docs/configuration.md.
   */
  loops: z
    .record(
      z.string(),
      z.looseObject({
        enabled: z.boolean().default(true),
        /** Per-kind override of the global `codePlatform`. */
        codePlatform: CodePlatformSchema.optional(),
      }),
    )
    .default({}),
  /**
   * Which platform PR-shaped work sources talk to: `github` (the `gh` CLI,
   * the default) or `ado` (Azure DevOps via the `az` CLI's `azure-devops`
   * extension). Overridable per kind via `loops.<kind>.codePlatform`. Auth is
   * delegated to the CLI (`gh auth login` / `az devops login` or
   * `AZURE_DEVOPS_EXT_PAT`), never handled here.
   */
  codePlatform: CodePlatformSchema.default("github"),
  /** Azure DevOps coordinates; required when any effective platform is `ado`. */
  ado: z
    .object({
      /** Organization URL, e.g. "https://dev.azure.com/acme". */
      organization: z.string().min(1),
      project: z.string().min(1),
      /** Repository name; omitted → the az CLI's configured default. */
      repository: z.string().min(1).optional(),
      /** The sitter's own login for comment filtering when `az` can't resolve identity (PAT-only auth). */
      selfLogin: z.string().min(1).optional(),
    })
    .optional(),
})

export const ConfigSchema = BaseConfigSchema.superRefine((c, ctx) => {
  const wantsAdo =
    c.codePlatform === "ado" || Object.values(c.loops).some((section) => section.codePlatform === "ado")
  if (wantsAdo && !c.ado) {
    ctx.addIssue({
      code: "custom",
      path: ["ado"],
      message: "codePlatform 'ado' requires an 'ado' section with organization and project",
    })
  }
})

/**
 * The loop kinds this config activates, in claim-priority order: engineering
 * first (unless disabled), then any opted-in kinds in config order. Pure.
 */
export const enabledLoopKinds = (config: Config): string[] => {
  const sections = config.loops
  const kinds: string[] = []
  if (sections["engineering"]?.enabled !== false) kinds.push("engineering")
  for (const [kind, section] of Object.entries(sections)) {
    if (kind !== "engineering" && section.enabled === true) kinds.push(kind)
  }
  return kinds
}

/** The code platform a loop kind's PR source talks to: per-kind override, else the global default. Pure. */
export const platformFor = (config: Config, kind: string): CodePlatform =>
  config.loops[kind]?.codePlatform ?? config.codePlatform ?? "github"

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({})

const CONFIG_FILE = ".agentic-loop.json"

/** A zod schema whose parse produces some host's config shape. */
type ConfigSchemaLike<T> = { safeParse(raw: unknown): { success: true; data: T } | { success: false; error: z.ZodError } }

/** Validate an already-parsed config object against a host schema; throws a readable error on misconfig. */
export const parseConfigWith = <T>(schema: ConfigSchemaLike<T>, raw: unknown): T => {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")
    throw new Error(`Invalid ${CONFIG_FILE}: ${detail}`)
  }
  return result.data
}

/** Validate an already-parsed config object; throws a readable error on misconfig. */
export const parseConfig = (raw: unknown): Config => parseConfigWith(ConfigSchema, raw)

/** Load a host config from the repo root, falling back to the schema's defaults when the file is absent. */
export const loadConfigWith = async <T>(
  schema: ConfigSchemaLike<T> & { parse(raw: unknown): T },
  client: Client,
  directory: string,
): Promise<T> => {
  const res = await client.file.read({ query: { path: CONFIG_FILE, directory } })
  const content = res.data?.content
  if (!content) return schema.parse({}) // absent/empty → defaults
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch (err) {
    throw new Error(`Invalid ${CONFIG_FILE}: not valid JSON (${(err as Error).message})`)
  }
  return parseConfigWith(schema, json)
}

/** Load config from the repo root, falling back to defaults when the file is absent. */
export const loadConfig = (client: Client, directory: string): Promise<Config> =>
  loadConfigWith(ConfigSchema, client, directory)
