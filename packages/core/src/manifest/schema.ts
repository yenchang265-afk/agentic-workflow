import { z } from "zod"

/**
 * The declarative definition of one loop kind: its stages, transition table,
 * work-source binding, and gate semantics. A loop kind lives in
 * `loops/<kind>/loop.json` next to per-stage prompt templates
 * (`loops/<kind>/stages/*.md`); the engine (`loop/engine.ts`) interprets it.
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
  /** The subagent persona backing the stage (e.g. `loop-plan-author`). */
  agent: z.string().min(1),
  /** Manifest-relative path of the stage's prompt template (e.g. `stages/build.md`). */
  prompt: z.string().min(1),
  /** `worktree` stages run in the loop's isolated checkout and snapshot; `none` stages run in the main tree and don't. */
  isolation: z.enum(["worktree", "none"]).default("worktree"),
  /** Wall-clock cap override; defaults to `config.stageTimeoutMinutes`. */
  timeoutMinutes: z.number().int().positive().optional(),
  /** Bash-command globs this stage may run (enforced by the Claude Code stage guard). */
  bashAllowlist: z.array(z.string().min(1)).default([]),
})
export type StageDef = z.infer<typeof StageDefSchema>

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
  /** Claim pools walked in priority order: a status folder and the stage a claim from it enters at. */
  pools: z
    .array(
      z.object({
        status: z.string().min(1),
        entryStage: z.string().min(1),
        /** Registry ref of a claimability predicate (defaults to "any file in the folder"). */
        claimPredicate: z.string().min(1).optional(),
      }),
    )
    .min(1),
})

const GithubPrSourceSchema = z.object({
  type: z.literal("github-pr"),
  /** `gh pr list --search` query selecting the PRs this loop sits on. */
  query: z.string().min(1),
  /** The PR conditions that make an item claimable. */
  triggers: z.array(z.enum(["failing-checks", "changes-requested", "new-comments", "merge-conflict"])).min(1),
})

export const WorkSourceBindingSchema = z.discriminatedUnion("type", [BacklogSourceSchema, GithubPrSourceSchema])
export type WorkSourceBinding = z.infer<typeof WorkSourceBindingSchema>

export const LoopManifestSchema = z
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
export type LoopManifest = z.infer<typeof LoopManifestSchema>

/** The manifest plus its loaded per-stage prompt templates, keyed by stage name. */
export interface LoadedManifest {
  readonly manifest: LoopManifest
  readonly prompts: Readonly<Record<string, string>>
}

/** Find a stage definition by name; throws on an unknown stage (a manifest/state mismatch). */
export const stageDef = (manifest: LoopManifest, name: string): StageDef => {
  const def = manifest.stages.find((s) => s.name === name)
  if (!def) throw new Error(`loop kind "${manifest.kind}" has no stage "${name}"`)
  return def
}

/** Validate a raw manifest object; throws a readable error on schema failure. */
export const parseManifest = (raw: unknown): LoopManifest => {
  const result = LoopManifestSchema.safeParse(raw)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")
    throw new Error(`Invalid loop manifest: ${detail}`)
  }
  return result.data
}
