import { z } from "zod"

/**
 * The declarative definition of one workflow kind: its stages, transition table,
 * work-source binding, and gate semantics. A workflow kind lives in
 * `workflows/<kind>/workflow.json` next to per-stage prompt templates
 * (`workflows/<kind>/stages/*.md`); the engine (`workflow/engine.ts`) interprets it.
 * Logic a manifest can't express hangs off named hooks resolved through
 * `registry.ts` (the TS escape hatch).
 */

/** What a stage transition does once the engine picks it. */
export const EffectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("fire"),
    /** The stage to fire next. */
    stage: z.string().min(1),
    /** Artifacts to drop before firing (stale feedback that judged an older build). */
    dropArtifacts: z.array(z.string().min(1)).default([]),
    /** Whether this transition consumes one iteration of the shared retry budget. */
    countIteration: z.boolean().default(false),
    /** Stop message when `countIteration` exhausts the budget. `{maxIterations}` interpolates. */
    capMessage: z.string().optional(),
  }),
  z.object({
    kind: z.literal("park"),
    /** Work-source status the item parks into (e.g. `plan-review`). */
    toStatus: z.string().min(1).optional(),
    message: z.string().min(1),
  }),
  z.object({
    kind: z.literal("done"),
    /** Work-source status the item lands in (e.g. `in-review`). */
    toStatus: z.string().min(1).optional(),
    message: z.string().min(1),
  }),
  z.object({
    kind: z.literal("stop"),
    message: z.string().min(1),
  }),
])
export type Effect = z.infer<typeof EffectSchema>

export const StageDefSchema = z.object({
  name: z.string().min(1),
  /** `work` stages complete on their own; `check` stages must record a verdict (missing ⇒ FAIL). */
  kind: z.enum(["work", "check"]),
  /** The OpenCode slash command this stage fires (e.g. `plan-task`). */
  command: z.string().min(1),
  /** The subagent persona backing the stage (e.g. `workflow-plan-author`). */
  agent: z.string().min(1),
  /**
   * Manifest-relative path of the stage's prompt template (e.g. `stages/build.md`).
   * Confined to one filename under `stages/` — manifests are user-authored and
   * hub-writable, so a free-form path would read arbitrary files at load time.
   */
  prompt: z
    .string()
    .regex(/^stages\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/, 'prompt must be a "stages/<name>.md" path inside the kind directory'),
  /** `worktree` stages run in the loop's isolated checkout and snapshot; `none` stages run in the main tree and don't. */
  isolation: z.enum(["worktree", "none"]).default("worktree"),
  /** Wall-clock cap override; defaults to `config.stageTimeoutMinutes`. */
  timeoutMinutes: z.number().int().positive().optional(),
  /**
   * Host-specific model this stage runs with (OpenCode: `provider/modelID`;
   * Claude Code: a Task-tool model). Unset ⇒ the host's default; config
   * `workflows.<kind>.stageModels.<name>` wins over this.
   */
  model: z.string().min(1).optional(),
  /**
   * Axes a `check` stage's verdict must cover, or none. When set, `workflow_verdict`
   * rejects a call whose `axes` array misses any of them, and the stage prompt
   * carries the payload contract — so a multi-axis review can't silently skip an
   * axis. Declared per stage rather than baked into the tool because one
   * `workflow_verdict` serves every check stage of every kind.
   */
  requiredAxes: z.array(z.string().min(1)).optional(),
  /** Bash-command globs this stage may run (enforced by the Claude Code stage guard). */
  bashAllowlist: z.array(z.string().min(1)).default([]),
  /** Extra bash globs merged into `bashAllowlist` for the resolved code platform (config `codePlatform`). */
  platformAllowlist: z.record(z.string(), z.array(z.string().min(1))).default({}),
})
export type StageDef = z.infer<typeof StageDefSchema>

/**
 * The bash globs a stage may run on the given code platform. For ado, a
 * non-`rest` access method looks up the composite key `"<platform>:<access>"`
 * (e.g. `"ado:az"`, `"ado:mcp"`); plain `"ado"` remains the rest/curl list.
 * A missing composite key yields only `bashAllowlist` — fail-closed. Pure.
 */
export const effectiveAllowlist = (def: StageDef, platform: string, access?: string): string[] => [
  ...def.bashAllowlist,
  ...(def.platformAllowlist[access && access !== "rest" ? `${platform}:${access}` : platform] ?? []),
]

const TransitionSchema = z.object({
  /** Taken when a `work` stage completes. */
  onDone: EffectSchema.optional(),
  /** Taken on a `check` stage's PASS verdict. */
  onPass: EffectSchema.optional(),
  /** Taken on a `check` stage's FAIL verdict — and when no verdict was recorded at all. */
  onFail: EffectSchema.optional(),
  /** Taken on a `check` stage's ERROR verdict (the check itself couldn't run). */
  onError: EffectSchema.optional(),
})
export type Transition = z.infer<typeof TransitionSchema>

const BacklogSourceSchema = z.object({
  type: z.literal("backlog"),
  /** The status-folder set, in forward lifecycle order. */
  statuses: z.array(z.string().min(1)).min(1),
  /**
   * Gate statuses no transition ever targets — work arrives there because a
   * *human* authored it (engineering's `draft/`), not because a stage parked it.
   * `gateStatuses()` derives the rest from the transition table; these can't be
   * derived, so a kind declares them. They are gates, not pools: listing a
   * status here never makes it claimable.
   */
  humanGates: z.array(z.string().min(1)).default([]),
  /** Claim pools walked in priority order: a status folder and the stage a claim from it enters at. */
  pools: z
    .array(
      z.object({
        status: z.string().min(1),
        entryStage: z.string().min(1),
        /** Registry ref of a claimability predicate (defaults to "any file in the folder"). */
        claimPredicate: z.string().min(1).optional(),
        /**
         * Never auto-claimed by claim/watch — only explicit verbs (e.g.
         * `plan <id>`) claim from it. Still listed so its folder counts feed
         * skip reasons and its `.claims/` markers stay visible to the hub
         * board/doctor.
         */
        manual: z.boolean().default(false),
      }),
    )
    .min(1),
})

/**
 * The hosted pull-request work source, on **either** GitHub or Azure DevOps —
 * the binding names the kind of work item, not the forge. Which client backs
 * it (`gh` vs the ADO REST API) is resolved from config `codePlatform` at
 * wiring time, not here. The legacy spelling `"github-pr"` is still accepted
 * in manifests and normalized on load (`manifest/load.ts`).
 */
const PullRequestSourceSchema = z.object({
  type: z.literal("pull-request"),
  /**
   * `gh pr list --search` query selecting the PRs this loop sits on. GitHub
   * only — ADO has no server-side PR search, so this is ignored there and
   * `role` drives a client-side identity filter over the active-PR list instead.
   */
  query: z.string().min(1),
  /** The PR conditions that make an item claimable. */
  triggers: z
    .array(z.enum(["failing-checks", "changes-requested", "new-comments", "merge-conflict", "review-requested"]))
    .min(1),
  /**
   * The kind's role on the PRs it claims: `author` kinds (pr-sitter) sit on
   * their own PRs and may push; `reviewer` kinds (review-sitter) sit on PRs
   * whose review is wanted from them and only ever comment. On ADO — where
   * there is no server-side search query — the role picks the client-side
   * identity filter: `createdBy` for `author`, reviewer membership for
   * `reviewer`.
   */
  role: z.enum(["author", "reviewer"]).default("author"),
})

/**
 * The dependency-scan work source (dep-sitter): claimable units of work are
 * vulnerable or outdated dependencies reported by the package manager
 * (`npm audit` / `npm outdated`), grouped per direct dependency and deduped
 * by a per-dependency ledger under `<tasksDir>/runs/<kind>/`.
 */
const DependencyScanSourceSchema = z.object({
  type: z.literal("dependency-scan"),
  /** Semver impact classes the kind upgrades unattended; anything larger is skipped and logged (majors stay a human call). */
  autoFix: z.array(z.enum(["patch", "minor"])).min(1).default(["patch", "minor"]),
  /** Minimum advisory severity that makes a vulnerable dependency claimable. */
  severityFloor: z.enum(["low", "moderate", "high", "critical"]).default("high"),
  /** Also claim non-vulnerable but outdated dependencies within the autoFix classes (npm only). */
  includeOutdated: z.boolean().default(false),
  /**
   * Which package ecosystem to scan: `npm` (native `npm audit`), `maven` /
   * `gradle` (OSV-Scanner over pom.xml / the Gradle lockfile), or `auto`
   * (detect every ecosystem the repo declares and merge their candidates —
   * monorepos work).
   */
  ecosystem: z.enum(["auto", "npm", "maven", "gradle"]).default("auto"),
})

/**
 * The CI-runs work source (main-sitter): claimable units of work are red CI
 * runs on the watched branch (`gh run list`), deduped by a per-head ledger
 * under `<tasksDir>/runs/<kind>/`; a later green run on the same head retires
 * the item before it is ever claimed.
 */
const CiRunsSourceSchema = z.object({
  type: z.literal("ci-runs"),
  /** The branch whose CI this loop sits on; unset ⇒ the remote default branch, resolved at poll time. */
  branch: z.string().min(1).optional(),
  /** Workflow file names to watch; empty ⇒ every workflow on the branch. */
  workflows: z.array(z.string().min(1)).default([]),
})

export const WorkSourceBindingSchema = z.discriminatedUnion("type", [
  BacklogSourceSchema,
  PullRequestSourceSchema,
  DependencyScanSourceSchema,
  CiRunsSourceSchema,
])
export type WorkSourceBinding = z.infer<typeof WorkSourceBindingSchema>

export const WorkflowManifestSchema = z
  .object({
    kind: z.string().min(1),
    version: z.literal(1),
    description: z.string().min(1),
    workSource: WorkSourceBindingSchema,
    stages: z.array(StageDefSchema).min(1),
    /** Stage name → transition effects. Every stage must have an entry. */
    transitions: z.record(z.string(), TransitionSchema),
    /** Shared retry budget for `countIteration` fires; defaults to `config.maxIterations`. */
    maxIterations: z.number().int().positive().optional(),
    /** Named escape hooks resolved via `registry.ts`. */
    hooks: z
      .object({
        /** Stage name → registry ref of a prompt-context augmenter. */
        compose: z.record(z.string(), z.string().min(1)).default({}),
        /** Stage name → registry ref of a pre-transition validator (may veto a park/done). */
        validateBeforeTransition: z.record(z.string(), z.string().min(1)).default({}),
      })
      .default({ compose: {}, validateBeforeTransition: {} }),
  })
  .superRefine((m, ctx) => {
    const names = new Set(m.stages.map((s) => s.name))
    if (names.size !== m.stages.length) {
      ctx.addIssue({ code: "custom", message: "duplicate stage names" })
    }
    if (m.workSource.type === "backlog") {
      for (const pool of m.workSource.pools) {
        if (!names.has(pool.entryStage)) {
          ctx.addIssue({ code: "custom", message: `pool "${pool.status}" enters unknown stage "${pool.entryStage}"` })
        }
      }
      const statuses = new Set(m.workSource.statuses)
      for (const gate of m.workSource.humanGates) {
        if (!statuses.has(gate)) {
          ctx.addIssue({ code: "custom", message: `humanGates lists "${gate}", which is not one of workSource.statuses` })
        }
      }
    }
    for (const stage of m.stages) {
      const t = m.transitions[stage.name]
      if (!t) {
        ctx.addIssue({ code: "custom", message: `stage "${stage.name}" has no transitions entry` })
        continue
      }
      if (stage.kind === "work" && !t.onDone) {
        ctx.addIssue({ code: "custom", message: `work stage "${stage.name}" needs transitions.onDone` })
      }
      if (stage.kind === "check" && (!t.onPass || !t.onFail || !t.onError)) {
        ctx.addIssue({ code: "custom", message: `check stage "${stage.name}" needs onPass, onFail, and onError` })
      }
      if (stage.kind === "work" && stage.requiredAxes?.length) {
        // Only a verdict can carry axes, and only check stages record one.
        ctx.addIssue({ code: "custom", message: `work stage "${stage.name}" cannot set requiredAxes (no verdict to carry them)` })
      }
      for (const effect of [t.onDone, t.onPass, t.onFail, t.onError]) {
        if (effect?.kind === "fire" && !names.has(effect.stage)) {
          ctx.addIssue({ code: "custom", message: `transition fires unknown stage "${effect.stage}"` })
        }
        if (effect?.kind === "fire" && effect.countIteration && !effect.capMessage) {
          ctx.addIssue({ code: "custom", message: `counted fire to "${effect.stage}" needs a capMessage` })
        }
      }
    }
  })
export type WorkflowManifest = z.infer<typeof WorkflowManifestSchema>

/** The manifest plus its loaded per-stage prompt templates, keyed by stage name. */
export interface LoadedManifest {
  readonly manifest: WorkflowManifest
  readonly prompts: Readonly<Record<string, string>>
}

/** Find a stage definition by name; throws on an unknown stage (a manifest/state mismatch). */
export const stageDef = (manifest: WorkflowManifest, name: string): StageDef => {
  const def = manifest.stages.find((s) => s.name === name)
  if (!def) throw new Error(`workflow kind "${manifest.kind}" has no stage "${name}"`)
  return def
}

/**
 * The statuses a kind holds work at for a human: every `park`/`done` effect's
 * `toStatus` across the transition table, plus a backlog kind's declared
 * `humanGates` (gates nothing transitions *into* — see that field's doc). These
 * are the dashboard's gate columns ("the loop wants you"): for the engineering
 * kind this derives ["plan-review", "in-review"] and adds "draft". Callers
 * treat the result as a set — the order is not meaningful. Pure.
 */
export const gateStatuses = (manifest: WorkflowManifest): string[] => {
  const out = new Set<string>()
  for (const t of Object.values(manifest.transitions)) {
    for (const effect of [t.onDone, t.onPass, t.onFail, t.onError]) {
      if ((effect?.kind === "park" || effect?.kind === "done") && effect.toStatus) out.add(effect.toStatus)
    }
  }
  if (manifest.workSource.type === "backlog") for (const g of manifest.workSource.humanGates) out.add(g)
  return [...out]
}

/** Validate a raw manifest object; throws a readable error on schema failure. */
export const parseManifest = (raw: unknown): WorkflowManifest => {
  const result = WorkflowManifestSchema.safeParse(raw)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")
    throw new Error(`Invalid loop manifest: ${detail}`)
  }
  return result.data
}
