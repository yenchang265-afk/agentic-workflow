import path from "node:path"
import { z } from "zod"
import type { Client } from "./host.js"
import { CODE_PLATFORMS, type Config, type WorkflowTrigger } from "./workflow/state.js"
import { CheckDefSchema, type CheckDef, type StageDef } from "./manifest/schema.js"
import type { StagePass } from "./workflow/verdict.js"
import { TRACKER_SYSTEMS, type TrackerSystem } from "./task/schema.js"
import {
  CONFIG_FILE,
  SHELL_BEARING_KEYS,
  ignoredUserConfigPaths,
  isPlainObject,
  mergeConfigLayers,
  rawAgentModel,
  readUserLayer,
  resolveUserConfigPath,
  spawnAlias,
} from "./config-layers.js"

/**
 * The layering plumbing and model-string normalization live in
 * `./config-layers.ts` — zod-free, so a bundled `PreToolUse` hook and
 * OpenCode's bootstrap `config` hook can share them without pulling zod in.
 * Re-exported here so every existing import site keeps working unchanged.
 */
export {
  CONFIG_FILE,
  SPAWN_ALIASES,
  USER_CONFIG_ENV,
  bareModel,
  ignoredUserConfigPaths,
  isPlainObject,
  mergeConfigLayers,
  rawAgentModel,
  readRawConfigLayers,
  readUserLayer,
  resolveAgentModels,
  resolveUserConfigPath,
  spawnAlias,
} from "./config-layers.js"
export type { KindStages, SpawnAlias } from "./config-layers.js"

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
         * Deliberately NOT defaulted: `enabledWorkflowKinds` reads it as
         * `!== false` for `engineering` (undefined keeps it on) and `=== true`
         * for opt-in kinds — every sitter — so a knob-only section never
         * silently starts one. A schema default would collapse both.
         */
        enabled: z.boolean().optional(),
        /** Per-kind override of the global `codePlatform`. */
        codePlatform: CodePlatformSchema.optional(),
        /** How a watching host schedules claims for this kind (default: poll). */
        trigger: WorkflowTriggerSchema.optional(),
        /** Stage name → model override for that stage (host-specific string; wins over the manifest's per-stage `model`). */
        stageModels: z.record(z.string(), z.string().min(1)).optional(),
        /**
         * Stage name → per-artifact character ceilings for that stage's composed
         * prompt; replaces the manifest stage's `context` map wholesale, mirroring
         * `stageModels` over `model`. Absent ⇒ the manifest's, else unbounded.
         *
         * Honored from the repo layer, unlike `worktreeSetup`: the value space is
         * positive integers — no shell, no path, no fs reach — so a merely-watched
         * repo can shrink its own prompts and nothing else. See `SHELL_BEARING_KEYS`.
         */
        stageContext: z.record(z.string(), z.record(z.string(), z.number().int().positive())).optional(),
        /**
         * Stage name → fan-out strategy, overriding the manifest stage's `fanout`.
         * `"axis"` runs the stage once per required axis; `"none"` turns a
         * manifest-declared fan-out back off.
         *
         * This is what makes fan-out reachable at all: the built-in kinds'
         * manifests ship inside the core package (manifest/dir.ts), so a user
         * cannot edit `fanout` there. Same direction as `stageModels`/`stageContext`
         * — config beats manifest. Value space is two literals: no shell, no path.
         */
        stageFanout: z.record(z.string(), z.enum(["axis", "none"])).optional(),
        /**
         * Stage name → the check commands the driver runs in that stage's work
         * tree before firing it; replaces the manifest stage's `checks`
         * wholesale, mirroring `stageModels` over `model`. This is the
         * test/typecheck/lint knob the config never had.
         *
         * Replace, not merge: declaring checks for `verify` means "these are my
         * project's checks", and merging would silently retain a shipped default
         * the user meant to displace.
         *
         * SHELL-BEARING: honored from the USER-scope config ONLY. A repo's
         * .agentic-workflow.json setting it is dropped with a warning
         * (SHELL_BEARING_WORKFLOW_KEYS) — a cloned repo must not be able to make
         * the driver execute an arbitrary command on first claim.
         */
        stageChecks: z.record(z.string(), z.array(CheckDefSchema)).optional(),
        /**
         * Changed diff lines past which a reviewer-role kind (review-sitter)
         * declines a PR instead of reviewing it. Unset ⇒
         * `DEFAULT_MAX_DIFF_LINES` (2000). Stated in the claimed item's goal, so
         * the fetch stage compares its measurement against a NUMBER — the
         * condition used to be the adjective "unreviewably large", which put a
         * control-flow decision on whatever the model felt that run.
         *
         * Honored from the repo layer, like `stageContext`: the value space is
         * positive integers — no shell, no path, no fs reach.
         */
        maxDiffLines: z.number().int().positive().optional(),
        /**
         * Replaces the bundled `osv-scanner --format json -L <target>` call for
         * this kind's JVM (maven/gradle) scans with your own CLI. `{{target}}`
         * (the lockfile path) and `{{ecosystem}}` are substituted; a command
         * naming neither runs verbatim, since a corporate scanner may scan the
         * whole repo. The npm path is unaffected. Output must be an osv-scanner
         * report OR a list of raw OSV records (`{vulns:[…]}` and friends) — see
         * docs/workflows/dep-sitter.md for the payload contract.
         *
         * SHELL-BEARING: honored from the USER-scope config ONLY. A repo's
         * .agentic-workflow.json setting it is dropped with a warning
         * (SHELL_BEARING_WORKFLOW_KEYS) — a cloned repo must not be able to make
         * the driver execute an arbitrary command on first claim.
         */
        scannerCommand: z.string().min(1).optional(),
      }),
    )
    .default({}),
  /**
   * Agent name → model, for spawns that are NOT stage runs: the draft authoring
   * `workflow-task-author` does in `new`/`retask`, and the ad-hoc `workflow-plan`.
   * (The loop's PLAN stage runs `workflow-plan-author`, which IS a stage and so
   * belongs to `stageModels.plan` instead.)
   * Those have no `StageDef`, so `modelFor` has nothing to resolve and no fire
   * payload carries a model for them. Deliberately separate from
   * `workflows.<kind>.stageModels`: folding drafting into `stageModels.plan`
   * would silently retarget the PLAN stage too, and vice versa.
   *
   * Top-level rather than per-kind because agent names are unique across kinds
   * and `workflow-plan` belongs to no kind at all.
   */
  agentModels: z.record(z.string(), z.string().min(1)).optional(),
  /**
   * Which platform PR-shaped work sources talk to: `github` (the `gh` CLI, the
   * default) or `ado` (Azure DevOps via its REST API). GitHub auth is delegated
   * to `gh auth login`; ADO auth is a Personal Access Token in the
   * `AZURE_DEVOPS_EXT_PAT` env var. Overridable per kind via
   * `workflows.<kind>.codePlatform`.
   *
   * `ado` is **experimental** — like the sitters that consume it, its config
   * shape (the `ado` section below) may still change. See docs/configuration.md.
   */
  codePlatform: CodePlatformSchema.default("github"),
  /**
   * Azure DevOps coordinates; required when any effective platform is `ado`.
   *
   * Deliberately `looseObject`: the removed `access` key must survive parsing
   * so `deprecatedAdoKeys` can name it in a warning. A strict object would
   * strip it silently and a user who set `access: "az"` would get REST
   * behavior with no explanation.
   */
  ado: z
    .looseObject({
      /**
       * Organization URL, e.g. "https://dev.azure.com/acme".
       *
       * Checked as an actual http(s) URL rather than a non-empty string: it is
       * interpolated into every REST URL and the PAT rides along in an
       * `Authorization` header, so a value that isn't a URL can only be a
       * mistake or a trick. Self-hosted ADO Server is why `http:` is allowed.
       */
      organization: z
        .string()
        .min(1)
        .refine(
          (v) => {
            try {
              return ["http:", "https:"].includes(new URL(v).protocol)
            } catch {
              return false
            }
          },
          { message: "must be an http(s) URL, e.g. https://dev.azure.com/acme" },
        ),
      project: z.string().min(1),
      /** Repository name; omitted → all repositories in the project. */
      repository: z.string().min(1).optional(),
      /** The sitter's own login for comment/author filtering — a PAT can't resolve identity. */
      selfLogin: z.string().min(1).optional(),
      /**
       * The PAT in plaintext — a fallback for when AZURE_DEVOPS_EXT_PAT is unset
       * (the env var wins). Prefer the env var; if set here, keep
       * `.agentic-workflow.json` gitignored so the secret is never committed.
       */
      pat: z.string().min(1).optional(),
      /**
       * Extra HTTP headers sent on every ADO REST call (e.g. a proxy auth or
       * routing header). Keys and values must be non-empty. The
       * `AGENTIC_WORKFLOW_ADO_HEADERS` env var (JSON) overrides these key by key.
       */
      customHeaders: z.record(z.string().min(1), z.string().min(1)).optional(),
      /**
       * Skip TLS certificate verification on every ADO REST call. Off by
       * default; only for a self-hosted ADO Server behind a self-signed or
       * internal-CA cert — never for the hosted `dev.azure.com` service.
       */
      insecureSkipTlsVerify: z.boolean().optional(),
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
 * Kinds still under development: every sitter. Their manifests, stage prompts,
 * and config keys may still change between releases, so none of them starts
 * without an explicit `workflows.<kind>.enabled: true` — a sitter acts on a
 * hosted surface (pull requests, dependencies, the default branch's CI), and
 * turning that on is the user's call to make, not a default to inherit.
 *
 * Exported so hosts can label them as experimental where a kind is listed
 * (the OpenCode `kinds` verb, the hub's kind checklist) rather than presenting
 * an unfinished kind as settled product.
 *
 * Note what this does NOT mean: an enabled sitter still only runs when a claim
 * or watch actually pulls it, and every terminal call (merge, approve, close)
 * stays human. See docs/design/threat-model.md T7-T11.
 */
export const EXPERIMENTAL_KINDS: readonly string[] = ["pr-sitter", "review-sitter", "dep-sitter", "main-sitter"]

/**
 * Kinds live without any configuration: `engineering` alone, and it may still
 * be turned off with `enabled: false`. Everything else — every sitter in
 * `EXPERIMENTAL_KINDS`, plus any local kind — stays opt-in via `enabled: true`.
 */
export const DEFAULT_ENABLED_KINDS: readonly string[] = ["engineering"]

/**
 * The kinds whose manifests and stage prompts SHIP with this package, in
 * `workflows/<kind>/`. Everything else found there is local — authored in the
 * hub's creator or by hand.
 *
 * The distinction matters because that directory is inside the core package:
 * one copy for the whole machine, shared by every repo the hub watches and by
 * both CLI hosts, and replaced wholesale by `npm ci`. So a writer with a
 * per-repo mental model (the hub's `?repo=`-scoped kind routes) must treat
 * these as read-only, or a save in one repo silently rewrites the workflow
 * every other repo runs. Derived from the two lists above rather than spelled
 * out again, so adding a kind cannot forget this.
 */
export const BUILTIN_WORKFLOW_KINDS: readonly string[] = [...DEFAULT_ENABLED_KINDS, ...EXPERIMENTAL_KINDS]

/**
 * The workflow kinds this config activates, in claim-priority order: the
 * default-on kinds first in `DEFAULT_ENABLED_KINDS` order, then any opted-in
 * kinds in config order. Pure.
 */
export const enabledWorkflowKinds = (config: Config): string[] => {
  const sections = config.workflows
  const kinds = DEFAULT_ENABLED_KINDS.filter((kind) => sections[kind]?.enabled !== false)
  for (const [kind, section] of Object.entries(sections)) {
    if (!DEFAULT_ENABLED_KINDS.includes(kind) && section.enabled === true) kinds.push(kind)
  }
  return kinds
}

/** The code platform a workflow kind's PR source talks to: per-kind override, else the global default. Pure. */
export const platformFor = (config: Config, kind: string): CodePlatform =>
  config.workflows[kind]?.codePlatform ?? config.codePlatform ?? "github"

/**
 * Azure DevOps config keys that no longer do anything, in config order.
 *
 * ADO used to be reachable three ways (`ado.access`: `az` | `rest` | `mcp`); it
 * is now only ever the REST API, so `access` is inert. Left in place it would
 * be config that lies about what it does, so hosts surface this as a one-line
 * warning — the same treatment `unknownStageModelKeys` gets, and for the same
 * reason: silently ignoring a key the user deliberately set reads as "the
 * setting doesn't work".
 *
 * Reported rather than rejected so an in-flight loop keeps running; the value
 * is ignored either way (REST is the sole transport). Pure.
 */
export const DEPRECATED_ADO_KEYS = ["access"] as const

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
 * Agents named in `agentModels` that this plugin does not ship — the same
 * silent-default trap `unknownStageModelKeys` closes, one layer over. A typo'd
 * agent name binds nothing, and the spawn runs the host default, which reads as
 * "the setting doesn't work".
 *
 * It matters more now than it did when `agentModels` was delivered as prose: the
 * binding is enforced, so the ONLY remaining reason a configured agent runs the
 * default model is that its key names no real agent. Pure.
 */
export const unknownAgentModelKeys = (config: Config, agentNames: readonly string[]): string[] =>
  Object.keys(config.agentModels ?? {}).filter((name) => !agentNames.includes(name))

/**
 * Configured models that cannot bind on Claude Code, as `[agent, model]` pairs.
 *
 * Claude Code's spawn tool takes an alias enum (`spawnAlias`), while the config
 * schema accepts any non-empty string because OpenCode needs real
 * `provider/model` ids. A value naming no known model family is therefore valid
 * config that this host cannot act on — and since an unmappable value is left
 * UNSTAMPED rather than passed through (passing it would fail the tool's schema
 * and error the whole spawn), the user needs telling. Pure.
 */
export const unbindableAgentModels = (config: Config): [string, string][] =>
  Object.entries(config.agentModels ?? {}).filter(([, model]) => spawnAlias(model) === null)

/**
 * The per-artifact character ceilings for a stage's composed prompt: config
 * `workflows.<kind>.stageContext.<stage>`, else the manifest stage's `context`,
 * else `{}` (unbounded — byte-identical to having no budgets at all).
 *
 * Replaces the manifest's map wholesale rather than merging into it, exactly as
 * `modelFor` replaces `model`. Note the deliberate asymmetry with the config
 * LAYERS, which `mergeConfigLayers` merges per artifact — repo over user is a
 * refinement of one setting, manifest-vs-config is an override of it. Pure.
 */
export const contextFor = (config: Config, kind: string, def: StageDef): Readonly<Record<string, number>> =>
  config.workflows[kind]?.stageContext?.[def.name] ?? def.context ?? {}

/**
 * The check commands a stage runs before it fires: config
 * `workflows.<kind>.stageChecks.<stage>`, else the manifest stage's `checks`,
 * else `[]` (no checks — byte-identical to before they existed).
 *
 * Replaces the manifest's list wholesale rather than merging into it, exactly as
 * `contextFor` replaces `context` and `modelFor` replaces `model`. Pure.
 */
export const checksFor = (config: Config, kind: string, def: StageDef): readonly CheckDef[] =>
  config.workflows[kind]?.stageChecks?.[def.name] ?? def.checks

/**
 * The `stageChecks` keys that name no stage of `kind` — the same silent-default
 * trap `unknownStageModelKeys` closes, and a worse one to hit: a typo'd stage
 * name runs NO checks, so the loop keeps taking the agent's word for it while
 * the config says otherwise. Not checkable at parse time (the manifest isn't
 * loaded yet), so hosts warn once the kind's stages are known. Pure.
 */
export const unknownStageCheckKeys = (config: Config, kind: string, stageNames: readonly string[]): string[] =>
  Object.keys(config.workflows[kind]?.stageChecks ?? {}).filter((name) => !stageNames.includes(name))

/**
 * The `stageContext` keys that name no stage of `kind`, as `stage` or
 * `stage.artifact` — the same silent-default trap `unknownStageModelKeys`
 * closes, in both dimensions: a typo'd stage never applies, and a typo'd
 * artifact inside a valid stage leaves that artifact unbounded. Neither is
 * checkable at parse time (the manifest isn't loaded yet), so hosts warn once
 * the kind's stages are known. Pure.
 */
export const unknownStageContextKeys = (config: Config, kind: string, stageNames: readonly string[]): string[] =>
  Object.entries(config.workflows[kind]?.stageContext ?? {}).flatMap(([stage, budgets]) =>
    stageNames.includes(stage)
      ? Object.keys(budgets ?? {})
          .filter((artifact) => !stageNames.includes(artifact))
          .map((artifact) => `${stage}.${artifact}`)
      : [stage],
  )

/**
 * The model a NON-stage spawn runs with: config `agentModels.<agent>`, else
 * undefined (the host's default). Mirrors `modelFor`'s shape, but keyed by agent
 * name because these spawns have no stage — see the `agentModels` doc. Pure.
 */
export const agentModel = (config: Config, agent: string): string | undefined =>
  rawAgentModel(config, agent) ?? undefined

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
 * The fan-out strategy a stage runs under: config
 * `workflows.<kind>.stageFanout.<stage>`, else the manifest stage's `fanout`,
 * else none. `"none"` in config turns a manifest-declared fan-out off. Pure.
 */
export const fanoutFor = (config: Config, kind: string, def: StageDef): "axis" | undefined => {
  const strategy = config.workflows[kind]?.stageFanout?.[def.name] ?? def.fanout
  return strategy === "axis" ? "axis" : undefined
}

/**
 * The focused passes a stage runs, in order — the single place both hosts ask
 * "how many times does this stage fire, and what is each pass told to cover?".
 *
 * Precedence, highest first:
 *  1. `reviewLenses`, on the stage named `review`. A config knob that predates
 *     fan-out and WINS, so an existing lens setup keeps behaving exactly as it
 *     does today rather than being silently reinterpreted on upgrade. Its
 *     `review`-only scope used to be hardcoded inside the OpenCode driver; it
 *     lives here now, named and documented, and deliberately does NOT generalize
 *     to other check stages (a sitter's triage stage is not a code review).
 *  2. `fanout: "axis"` (manifest or `stageFanout`) — one pass per `requiredAxes`
 *     entry, on any check stage of any kind.
 *  3. one unfocused pass — today's behavior, byte-identical.
 * Pure.
 */
export const stagePasses = (config: Config, kind: string, def: StageDef): readonly StagePass[] => {
  const single: readonly StagePass[] = [{ focus: null, mode: "single" }]
  if (def.kind !== "check") return single
  if (def.name === "review" && config.reviewLenses.length) {
    return config.reviewLenses.map((focus) => ({ focus, mode: "lens" as const }))
  }
  if (fanoutFor(config, kind, def) === "axis" && def.requiredAxes?.length) {
    return def.requiredAxes.map((focus) => ({ focus, mode: "axis" as const }))
  }
  return single
}

/**
 * The axes ONE pass's `workflow_verdict` call must cover.
 *
 * An `axis` pass is narrowed to its own axis — that is what lets a focused pass
 * be admitted instead of rejected for the four it was told not to review. The
 * stage-wide guarantee does not vanish with it: it moves to the accumulated
 * record, checked with `uncoveredAxes` when the stage advances. A `lens` pass
 * maps to no axis at all, so it is unenforced, exactly as before. Pure.
 */
export const passAxes = (def: StageDef, pass: StagePass): readonly string[] | undefined =>
  pass.mode === "axis" && pass.focus ? [pass.focus] : pass.mode === "lens" ? undefined : def.requiredAxes

/**
 * True when a configured `reviewLenses` is overriding a declared per-axis
 * fan-out — the user asked for two different multi-pass reviews and got the
 * lenses. Silence would make the `fanout` look broken, so hosts warn. Pure.
 */
export const fanoutOverriddenByLenses = (config: Config, kind: string, def: StageDef): boolean =>
  config.reviewLenses.length > 0 && def.name === "review" && fanoutFor(config, kind, def) === "axis"

/**
 * The `stageFanout` keys that name no stage of `kind` — the same silent-default
 * trap `unknownStageModelKeys` closes: a typo'd stage name resolves to "no
 * fan-out" and reads as "the setting doesn't work". Not checkable at parse time
 * (the manifest isn't loaded yet), so hosts warn once the stages are known. Pure.
 */
export const unknownStageFanoutKeys = (config: Config, kind: string, stageNames: readonly string[]): string[] =>
  Object.keys(config.workflows[kind]?.stageFanout ?? {}).filter((name) => !stageNames.includes(name))

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
 * Keys INSIDE a `workflows.<kind>` section whose value is shell the loop
 * executes verbatim — the nested sibling of SHELL_BEARING_KEYS, same rule and
 * same reason. `dropShellBearingRepoKeys` deletes whole TOP-LEVEL keys and
 * cannot see one level down, so this is a sibling rather than a generalization
 * into a path walker: two small obviously-correct functions beat one clever one.
 */
const SHELL_BEARING_WORKFLOW_KEYS = ["scannerCommand", "stageChecks"] as const

/**
 * Drop shell-bearing keys from each `workflows.<kind>` section of the repo
 * layer, warning per (kind, key). Never mutates its input.
 *
 * Only sound because `mergeConfigLayers` merges `workflows.<kind>` per key: a
 * repo section setting `severityFloor` beside a dropped `scannerCommand` keeps
 * its severityFloor AND the user layer's scannerCommand. A shallow merge would
 * silently eat one of them.
 */
const dropShellBearingWorkflowKeys = async (repoRaw: unknown, client: Client): Promise<unknown> => {
  if (!isPlainObject(repoRaw)) return repoRaw
  const workflows = repoRaw["workflows"]
  if (!isPlainObject(workflows)) return repoRaw

  const cleanedKinds: Record<string, unknown> = {}
  let dropped = false
  for (const [kind, section] of Object.entries(workflows)) {
    if (!isPlainObject(section)) {
      cleanedKinds[kind] = section
      continue
    }
    let out = section
    for (const key of SHELL_BEARING_WORKFLOW_KEYS) {
      if (!(key in out)) continue
      const { [key]: _dropped, ...rest } = out
      out = rest
      dropped = true
      try {
        await client.app.log({
          body: {
            service: "agentic-workflow",
            level: "warn",
            message: `${CONFIG_FILE} sets "workflows.${kind}.${key}" — ignored: shell-bearing keys are honored from the user-scope config only. Move it to your user config (~/.agentic-workflow.json).`,
          },
        })
      } catch {
        /* the drop matters, the log is best-effort */
      }
    }
    cleanedKinds[kind] = out
  }
  return dropped ? { ...repoRaw, workflows: cleanedKinds } : repoRaw
}

/**
 * Keys inside the `ado` section that decide WHERE an authenticated request goes
 * and HOW it is secured. The third sibling of the two drops above, same rule for
 * a different asset: not shell the repo can run, but the user's Personal Access
 * Token it can aim.
 *
 * `ado-pr.ts` resolves the PAT as `env AZURE_DEVOPS_EXT_PAT ?? ado.pat` and
 * sends it as `Authorization: Basic` to `${ado.organization}/…`. Because layers
 * merge per key, a cloned repo supplying only `organization` keeps the user's
 * PAT underneath it — and `pr-sitter`/`review-sitter` poll on the first watch
 * tick, so nobody has to run anything for the token to leave. `customHeaders`
 * rides the same request and `insecureSkipTlsVerify` disables certificate
 * verification for it.
 *
 * `project`, `repository` and `selfLogin` are NOT here: they describe this repo
 * and nothing else, and dropping them would make the rule unusable rather than
 * safe. An ADO user who kept `organization` in their repo file gets a loud
 * warning naming the move; the section is experimental and says so.
 */
const ADO_USER_LAYER_ONLY_KEYS = ["organization", "pat", "customHeaders", "insecureSkipTlsVerify"] as const

/** Drop destination/credential keys from the repo layer's `ado` section, warning per key. Never mutates its input. */
const dropAdoRepoKeys = async (repoRaw: unknown, client: Client): Promise<unknown> => {
  if (!isPlainObject(repoRaw)) return repoRaw
  const ado = repoRaw["ado"]
  if (!isPlainObject(ado)) return repoRaw

  let out = ado
  let dropped = false
  for (const key of ADO_USER_LAYER_ONLY_KEYS) {
    if (!(key in out)) continue
    const { [key]: _dropped, ...rest } = out
    out = rest
    dropped = true
    try {
      await client.app.log({
        body: {
          service: "agentic-workflow",
          level: "warn",
          message: `${CONFIG_FILE} sets "ado.${key}" — ignored: the Azure DevOps destination and credentials are honored from the user-scope config only, so a cloned repo cannot aim your PAT at a host it chooses. Move it to your user config (~/.agentic-workflow.json).`,
        },
      })
    } catch {
      /* the drop matters, the log is best-effort */
    }
  }
  return dropped ? { ...repoRaw, ado: out } : repoRaw
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
  repoRaw = await dropShellBearingWorkflowKeys(repoRaw, client)
  repoRaw = await dropAdoRepoKeys(repoRaw, client)

  if (userRaw === undefined && repoRaw === undefined) return schema.parse({}) // both absent/empty → defaults
  const label = userRaw === undefined ? CONFIG_FILE : `${CONFIG_FILE} (merged with ${userPath})`
  return parseConfigWith(schema, mergeConfigLayers(userRaw ?? {}, repoRaw ?? {}), label)
}

/** Load config (user layer under repo layer), falling back to defaults when both files are absent. */
export const loadConfig = (client: Client, directory: string, opts?: LoadConfigOptions): Promise<Config> =>
  loadConfigWith(ConfigSchema, client, directory, opts)
