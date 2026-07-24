import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import type { Client } from "./host.js"
import { CODE_PLATFORMS, type Config, type WorkflowTrigger } from "./workflow/state.js"
import type { StageDef } from "./manifest/schema.js"
import { TRACKER_SYSTEMS, type TrackerSystem } from "./task/schema.js"

/**
 * Loop configuration, layered from two optional files: a user-scope
 * `~/.agentic-workflow.json` (settings shared across every repo — e.g.
 * `ado.organization`, `ado.selfLogin`, `ado.pat`) under a repo-scope
 * `.agentic-workflow.json` at the repo root, which overrides it field by field.
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
export const CodePlatformSchema = z.enum(CODE_PLATFORMS)
export type CodePlatform = z.infer<typeof CodePlatformSchema>

/**
 * How the repo's project management is set up, so task authoring and the status
 * roll-up align with the team's tracker (Jira or Azure DevOps). Optional — unset
 * means the loop is tracker-agnostic (today's behavior; tasks may still carry an
 * ad-hoc `tracker` block). See docs/configuration.md.
 */
export const ProjectManagementSchema = z.object({
  /** The team's tracker. Becomes the default `tracker.system` for new tasks. */
  system: z.enum(TRACKER_SYSTEMS),
  /**
   * URL prefix a task's `tracker.key` is appended to, to build a deep link —
   * e.g. "https://acme.atlassian.net/browse/" (Jira) or
   * "https://dev.azure.com/acme/proj/_workitems/edit/" (Azure DevOps). Optional.
   */
  baseUrl: z.string().url("projectManagement.baseUrl must be a URL").optional(),
  /** Default issue/work-item type stamped on newly authored tasks. Optional. */
  defaultType: z.string().min(1).optional(),
})
export type ProjectManagement = z.infer<typeof ProjectManagementSchema>

/**
 * How a watching host schedules claims for a workflow kind — see the `WorkflowTrigger`
 * type in workflow/state.ts for semantics. Core validates shape only; cron
 * `schedule` syntax is validated by the host that honors it (the OpenCode
 * plugin), and the pull-only Claude host ignores the field entirely.
 */
export const WorkflowTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("poll"), intervalMinutes: z.number().positive().max(1440).optional() }),
  z.object({ type: z.literal("cron"), schedule: z.string().min(1) }),
  z.object({ type: z.literal("idle") }),
]) satisfies z.ZodType<WorkflowTrigger>

const BaseConfigSchema = z.object({
  /** Max loop iterations before stopping on repeated verify/review failures. */
  maxIterations: z.number().int().positive().default(3),
  /** Repo-relative root of the task backlog; its subfolders are task statuses. */
  tasksDir: z.string().min(1).default("docs/tasks"),
  /**
   * On by default: keep `tasksDir` out of git the same way `worktreesDir`
   * does — an idempotent append to `<git-common-dir>/info/exclude` (a
   * per-clone, untracked list), never the shared, tracked `.gitignore`. The
   * loop skips its usual backlog auto-commit on every task move and instead
   * just re-asserts the exclude entry. Set to `false` to restore the old
   * behavior: every task move (approve, plan, ship, park, done, stop) is
   * committed as the audit trail. See docs/migration.md.
   */
  ignoreBacklog: z.boolean().default(true),
  /** Wall-clock cap on a single stage; a stage exceeding it fails the loop instead of hanging it. */
  stageTimeoutMinutes: z.number().int().positive().default(60),
  /**
   * Repo-relative (or absolute) directory for per-task git worktrees. Each
   * loop's BUILD/VERIFY/REVIEW runs against its own worktree instead of
   * switching branches in the shared checkout — the human's tree is never
   * touched and concurrent watch sessions become safe. Defaults to
   * `.workflow-worktrees`; set explicitly to `false` to opt back into shared-tree
   * branch switching. See docs/design/improvements/01.
   */
  worktreesDir: z.union([z.string().min(1), z.literal(false)]).default(".workflow-worktrees"),
  /** Optional shell command run inside a freshly created worktree (e.g. "npm ci"). */
  worktreeSetup: z.string().min(1).optional(),
  /**
   * Extra REVIEW lenses; each runs the review stage once more focused on that
   * lens, and the loop takes the worst verdict across all passes. Unset/[] →
   * a single review (today's behavior). See docs/design/improvements/04.
   */
  reviewLenses: z.array(z.string().min(1)).max(5).default([]),
  /**
   * Per-workflow-kind sections keyed by kind (a `workflows/<kind>/` manifest).
   * Engineering runs unless explicitly disabled; every other kind is opt-in
   * (`enabled: true`). Kind-specific knobs ride along and are validated by
   * the kind itself. See docs/configuration.md.
   */
  workflows: z
    .record(
      z.string(),
      z.looseObject({
        /**
         * Deliberately NOT defaulted: `enabledWorkflowKinds` discriminates on
         * `=== true` for non-engineering kinds, so a default would make every
         * mentioned kind opt-OUT and a knob-only section would silently start a
         * workflow. Engineering reads it as `!== false`, so undefined keeps it on.
         */
        enabled: z.boolean().optional(),
        /** Per-kind override of the global `codePlatform`. */
        codePlatform: CodePlatformSchema.optional(),
        /** How a watching host schedules claims for this kind (default: poll). */
        trigger: WorkflowTriggerSchema.optional(),
        /** Stage name → model override for that stage (host-specific string; wins over the manifest's per-stage `model`). */
        stageModels: z.record(z.string(), z.string().min(1)).optional(),
      }),
    )
    .default({}),
  /**
   * Which platform PR-shaped work sources talk to: `github` (the `gh` CLI, the
   * default) or `ado` (Azure DevOps via the `az` CLI with the azure-devops
   * extension). GitHub auth is delegated to `gh auth login`; ADO auth is a
   * Personal Access Token in the `AZURE_DEVOPS_EXT_PAT` env var, which the az
   * extension honors directly. Overridable per kind via
   * `workflows.<kind>.codePlatform`.
   */
  codePlatform: CodePlatformSchema.default("github"),
  /**
   * Azure DevOps coordinates; required when any effective platform is `ado`.
   *
   * Deliberately `looseObject`: the removed `access`/`customHeaders`/
   * `insecureSkipTlsVerify` keys must survive parsing so `deprecatedAdoKeys`
   * can name them in a warning. A strict object would strip them silently and
   * a user who set `access: "mcp"` would get az behavior with no explanation.
   */
  ado: z
    .looseObject({
      /** Organization URL, e.g. "https://dev.azure.com/acme". */
      organization: z.string().min(1),
      project: z.string().min(1),
      /** Repository name; omitted → all repositories in the project. */
      repository: z.string().min(1).optional(),
      /** The sitter's own login for comment/author filtering — a PAT can't resolve identity. */
      selfLogin: z.string().min(1).optional(),
      /**
       * The PAT in plaintext — a fallback for when AZURE_DEVOPS_EXT_PAT is unset
       * (the env var wins). Prefer the env var; if set here, keep
       * `.agentic-workflow.json` gitignored so the secret is never committed.
       * The az CLI's azure-devops extension reads this env var directly.
       */
      pat: z.string().min(1).optional(),
    })
    .optional(),
  /**
   * Project-management setup — the team's tracker and how tasks pair to it.
   * Drives task-authoring defaults and the pairing view in `workflow_status`.
   */
  projectManagement: ProjectManagementSchema.optional(),
})

const isAdo = (p: CodePlatform | undefined): boolean => p === "ado"

export const ConfigSchema = BaseConfigSchema.superRefine((c, ctx) => {
  const platforms = [c.codePlatform, ...Object.values(c.workflows).map((section) => section.codePlatform)]
  const wantsAdo = platforms.some(isAdo)
  if (wantsAdo && !c.ado) {
    ctx.addIssue({
      code: "custom",
      path: ["ado"],
      message: "codePlatform 'ado' requires an 'ado' section with organization and project",
    })
  }
  // A PAT carries no reliable email identity, so the sitter's own login must be
  // configured to filter its own PRs/comments.
  if (wantsAdo && c.ado && !c.ado.selfLogin) {
    ctx.addIssue({
      code: "custom",
      path: ["ado", "selfLogin"],
      message: "codePlatform 'ado' requires ado.selfLogin (a PAT cannot resolve the sitter's identity)",
    })
  }
})

/**
 * The workflow kinds this config activates, in claim-priority order: engineering
 * first (unless disabled), then any opted-in kinds in config order. Pure.
 */
export const enabledWorkflowKinds = (config: Config): string[] => {
  const sections = config.workflows
  const kinds: string[] = []
  if (sections["engineering"]?.enabled !== false) kinds.push("engineering")
  for (const [kind, section] of Object.entries(sections)) {
    if (kind !== "engineering" && section.enabled === true) kinds.push(kind)
  }
  return kinds
}

/** The code platform a workflow kind's PR source talks to: per-kind override, else the global default. Pure. */
export const platformFor = (config: Config, kind: string): CodePlatform =>
  config.workflows[kind]?.codePlatform ?? config.codePlatform ?? "github"

/**
 * Azure DevOps config keys that no longer do anything, in config order.
 *
 * ADO used to be reachable three ways (`ado.access`: `az` | `rest` | `mcp`);
 * it is now only ever the az CLI, so `access` is inert, and `customHeaders` /
 * `insecureSkipTlsVerify` went with the raw-fetch transport that was the only
 * thing reading them (the az CLI cannot consume either). Left in place they
 * would be config that lies about what it does, so hosts surface this as a
 * one-line warning — the same treatment `unknownStageModelKeys` gets, and for
 * the same reason: silently ignoring a key the user deliberately set reads as
 * "the setting doesn't work".
 *
 * Reported rather than rejected so an in-flight loop keeps running; the values
 * are ignored either way. Pure.
 */
export const DEPRECATED_ADO_KEYS = ["access", "customHeaders", "insecureSkipTlsVerify"] as const

export const deprecatedAdoKeys = (config: Config): string[] => {
  const ado = config.ado as Record<string, unknown> | undefined
  if (!ado) return []
  return DEPRECATED_ADO_KEYS.filter((key) => ado[key] !== undefined).map((key) => `ado.${key}`)
}

/** How a watching host schedules claims for a workflow kind: configured trigger, else poll. Pure. */
export const triggerFor = (config: Config, kind: string): WorkflowTrigger =>
  config.workflows[kind]?.trigger ?? { type: "poll" }

/**
 * The model a stage runs with: config `workflows.<kind>.stageModels.<stage>`, else
 * the manifest stage's `model`, else undefined (the host's default). Pure.
 */
export const modelFor = (config: Config, kind: string, def: StageDef): string | undefined =>
  config.workflows[kind]?.stageModels?.[def.name] ?? def.model

/**
 * The `stageModels` keys that name no stage of `kind` — a typo'd or
 * wrong-kind stage name resolves to `undefined` in `modelFor` and silently
 * runs the host default, which reads as "model selection doesn't work". The
 * record can't be validated at parse time (the manifest isn't loaded yet), so
 * hosts surface this as a warning once the kind's stages are known. Pure.
 */
export const unknownStageModelKeys = (config: Config, kind: string, stageNames: readonly string[]): string[] =>
  Object.keys(config.workflows[kind]?.stageModels ?? {}).filter((name) => !stageNames.includes(name))

/**
 * The stage's `requiredAxes` that no configured review lens names — the axes
 * that go unreviewed once `reviewLenses` is on.
 *
 * Lens mode suppresses per-pass axis-coverage enforcement (a lens is told to
 * focus exclusively on its own lens, so demanding every axis from it would
 * reject every pass), which means turning lenses on silently downgrades the
 * review's guarantees. Like `unknownStageModelKeys`, this can't be checked at
 * parse time — the manifest isn't loaded yet — so hosts surface it as a warning
 * once the kind's stages are known, turning a silent downgrade into a message.
 * Empty when lenses are off, when the stage requires no axes, or when the lens
 * list already names every required axis. Pure.
 */
export const unreviewedAxes = (config: Config, def: StageDef): string[] => {
  const lenses = config.reviewLenses
  if (!lenses.length || !def.requiredAxes?.length) return []
  const named = new Set(lenses.map((l) => l.trim().toLowerCase()))
  return def.requiredAxes.filter((axis) => !named.has(axis.trim().toLowerCase()))
}

/**
 * A model string without its provider prefix ("anthropic/claude-sonnet-4-5" →
 * "claude-sonnet-4-5") — for hosts that take bare model ids (Claude Code's
 * Task tool), so a config written OpenCode-style works on both hosts. Pure.
 */
export const bareModel = (model: string): string =>
  model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model

/**
 * Build a tracker deep link from a task's `tracker.key` and the configured
 * `projectManagement.baseUrl` — the base URL with the key appended. Returns
 * undefined when no base URL is configured (link building is opt-in). Pure.
 */
export const trackerUrl = (pm: ProjectManagement | undefined, key: string): string | undefined =>
  pm?.baseUrl ? `${pm.baseUrl}${key}` : undefined

/** The default `tracker.system` for newly authored tasks, from the PM config. Pure. */
export const defaultTrackerSystem = (config: Config): TrackerSystem | undefined => config.projectManagement?.system

/**
 * Best-effort: export config `ado.pat` as `AZURE_DEVOPS_EXT_PAT` when that env
 * var is unset, so child processes this driver starts — the PR sitter's
 * stage-agent `curl` calls — can authenticate to Azure DevOps without a
 * separately-exported PAT. The env var always wins; this never overrides one.
 * Side-effecting by design; call once after loading config. On hosts where the
 * stage agents run in a different process than the driver (Claude Code), set
 * the env var in that environment — this can't cross the process boundary.
 */
export const applyAdoPatEnv = (config: { readonly ado?: { readonly pat?: string } }): void => {
  const pat = config.ado?.pat
  if (pat && !process.env.AZURE_DEVOPS_EXT_PAT) process.env.AZURE_DEVOPS_EXT_PAT = pat
}

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({})

const CONFIG_FILE = ".agentic-workflow.json"

/** Env override for the user-scope config path; set to "" to disable the layer (e.g. in CI). */
export const USER_CONFIG_ENV = "AGENTIC_WORKFLOW_USER_CONFIG"

/** New user-scope location, under the XDG config home: `<xdg>/agentic-workflow/agentic-workflow.json`. */
const USER_CONFIG_SUBPATH = ["agentic-workflow", "agentic-workflow.json"] as const
/** Pre-XDG location read as a fallback so existing installs keep working: `~/.agentic-workflow.json`. */
const LEGACY_USER_CONFIG_FILE = ".agentic-workflow.json"

/** $XDG_CONFIG_HOME when set to a non-blank value, else `~/.config`. */
const xdgConfigHome = (home: string): string => {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg && xdg.trim() ? xdg : path.join(home, ".config")
}

/**
 * Where the user-scope config lives: $AGENTIC_WORKFLOW_USER_CONFIG when set ("" →
 * layer disabled) wins. Otherwise `${XDG_CONFIG_HOME:-~/.config}/agentic-workflow/agentic-workflow.json`,
 * falling back on read to the pre-XDG `~/.agentic-workflow.json` when only that
 * exists (so existing installs keep working; the XDG path is the write target for
 * new installs). Returns null when the layer is disabled or no home resolves.
 */
export const resolveUserConfigPath = (): string | null => {
  const env = process.env[USER_CONFIG_ENV]
  if (env !== undefined) return env === "" ? null : env
  const home = os.homedir()
  if (!home) return null
  const primary = path.join(xdgConfigHome(home), ...USER_CONFIG_SUBPATH)
  if (fs.existsSync(primary)) return primary
  const legacy = path.join(home, LEGACY_USER_CONFIG_FILE)
  if (fs.existsSync(legacy)) return legacy
  return primary
}

/**
 * User-scope config files that EXIST but are not the one being read.
 *
 * Exactly one user-scope file is ever loaded — the layering is user-under-repo,
 * not user-under-user — so a second one is dead weight that looks live. Two
 * ways to land here, both silent and both indistinguishable from "my setting
 * doesn't work":
 *
 * - **Shadowed:** once the XDG file exists (the hub's Config tab writes it),
 *   `~/.agentic-workflow.json` is ignored WHOLESALE, not merged under it.
 * - **Misnamed:** the two locations use different file names — dotted
 *   `~/.agentic-workflow.json` but undotted `…/agentic-workflow/agentic-workflow.json`.
 *   Writing the repo-style dotted name into the XDG dir resolves to nothing.
 *
 * Callers report these; a config that is quietly not read is the hardest
 * possible misconfig to diagnose from the symptom. Pure apart from `fs.existsSync`.
 */
export const ignoredUserConfigPaths = (chosen: string | null): string[] => {
  if (chosen === null) return [] // layer explicitly disabled — nothing is "ignored"
  const home = os.homedir()
  if (!home) return []
  const candidates = [
    path.join(home, LEGACY_USER_CONFIG_FILE),
    path.join(xdgConfigHome(home), ...USER_CONFIG_SUBPATH),
    // The repo-style dotted name inside the XDG dir: the intuitive guess, and
    // it is never read at any layer.
    path.join(xdgConfigHome(home), USER_CONFIG_SUBPATH[0], CONFIG_FILE),
  ]
  return candidates.filter((p) => p !== chosen && fs.existsSync(p))
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * Field-level deep merge of raw config layers (override wins): plain objects
 * merge per key recursively; arrays, scalars, and null replace wholesale —
 * null is not a delete operator, it simply fails schema validation downstream.
 * Layers merge BEFORE the zod parse so schema defaults apply only to the
 * combined view (a repo file omitting `maxIterations` cannot clobber a
 * user-scope `maxIterations`). Pure.
 */
export const mergeConfigLayers = (base: unknown, override: unknown): unknown => {
  if (override === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfigLayers(base[key], value) : value
  }
  return out
}

/** A zod schema whose parse produces some host's config shape. */
type ConfigSchemaLike<T> = { safeParse(raw: unknown): { success: true; data: T } | { success: false; error: z.ZodError } }

/** Validate an already-parsed config object against a host schema; throws a readable error on misconfig. */
export const parseConfigWith = <T>(schema: ConfigSchemaLike<T>, raw: unknown, label: string = CONFIG_FILE): T => {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")
    throw new Error(`Invalid ${label}: ${detail}`)
  }
  return result.data
}

/** Validate an already-parsed config object; throws a readable error on misconfig. */
export const parseConfig = (raw: unknown): Config => parseConfigWith(ConfigSchema, raw)

export interface LoadConfigOptions {
  /**
   * Absolute path of the user-scope config file. `null` disables the layer;
   * undefined → `resolveUserConfigPath()`. Tests must pass an explicit value
   * so a developer's real `~/.agentic-workflow.json` never leaks in.
   */
  readonly userConfigPath?: string | null
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
export const readUserLayer = (userPath: string): unknown => {
  let content: string
  try {
    content = fs.readFileSync(userPath, "utf8")
  } catch {
    return undefined
  }
  if (!content.trim()) return undefined
  let json: unknown
  try {
    json = JSON.parse(content)
  } catch (err) {
    throw new Error(`Invalid ${userPath}: not valid JSON (${(err as Error).message})`)
  }
  if (!isPlainObject(json)) throw new Error(`Invalid ${userPath}: top level must be a JSON object`)
  return json
}

/**
 * Config keys whose value is shell the loop executes verbatim (isolate.ts runs
 * `worktreeSetup` via raw interpolation). The repo layer rides along with any
 * cloned repo, so honoring these from `.agentic-workflow.json` would let a
 * merely-watched repo run arbitrary shell on first claim — npm-postinstall
 * class risk, silently. They are honored from the user-scope layer only.
 */
const SHELL_BEARING_KEYS = ["worktreeSetup"] as const

/** Drop shell-bearing keys from the repo layer, warning loudly per key. */
const dropShellBearingRepoKeys = async (repoRaw: unknown, client: Client): Promise<unknown> => {
  if (!isPlainObject(repoRaw)) return repoRaw
  let out = repoRaw
  for (const key of SHELL_BEARING_KEYS) {
    if (!(key in out)) continue
    const { [key]: _dropped, ...rest } = out
    out = rest
    try {
      await client.app.log({
        body: {
          service: "agentic-workflow",
          level: "warn",
          message: `${CONFIG_FILE} sets "${key}" — ignored: shell-bearing keys are honored from the user-scope config only. Move it to your user config (~/.agentic-workflow.json).`,
        },
      })
    } catch {
      /* the drop matters, the log is best-effort */
    }
  }
  return out
}

/**
 * Load a host config by layering the user-scope file (if any) under the repo's
 * `.agentic-workflow.json` (repo wins field by field), falling back to the
 * schema's defaults when both are absent.
 */
export const loadConfigWith = async <T>(
  schema: ConfigSchemaLike<T> & { parse(raw: unknown): T },
  client: Client,
  directory: string,
  opts?: LoadConfigOptions,
): Promise<T> => {
  const userPath = opts?.userConfigPath === undefined ? resolveUserConfigPath() : opts.userConfigPath
  const userRaw = userPath ? readUserLayer(userPath) : undefined

  // A user-scope file sitting at a path nobody reads is invisible: the setting
  // it holds simply never applies, with nothing to distinguish that from the
  // feature being broken. Say so.
  for (const ignored of ignoredUserConfigPaths(userPath)) {
    await client.app
      .log({
        body: {
          service: "agentic-workflow",
          level: "warn",
          message: `${ignored} is NOT being read — the user-scope config in effect is ${userPath}. Only one user-scope file is loaded (they are not merged with each other); move the settings you want into ${userPath}.`,
        },
      })
      .catch(() => {
        /* the load matters, the warning is best-effort */
      })
  }

  const res = await client.file.read({ query: { path: CONFIG_FILE, directory } })
  const content = res.data?.content
  let repoRaw: unknown
  if (content) {
    try {
      repoRaw = JSON.parse(content)
    } catch (err) {
      throw new Error(`Invalid ${CONFIG_FILE}: not valid JSON (${(err as Error).message})`)
    }
  }
  repoRaw = await dropShellBearingRepoKeys(repoRaw, client)

  if (userRaw === undefined && repoRaw === undefined) return schema.parse({}) // both absent/empty → defaults
  const label = userRaw === undefined ? CONFIG_FILE : `${CONFIG_FILE} (merged with ${userPath})`
  return parseConfigWith(schema, mergeConfigLayers(userRaw ?? {}, repoRaw ?? {}), label)
}

/** Load config (user layer under repo layer), falling back to defaults when both files are absent. */
export const loadConfig = (client: Client, directory: string, opts?: LoadConfigOptions): Promise<Config> =>
  loadConfigWith(ConfigSchema, client, directory, opts)
