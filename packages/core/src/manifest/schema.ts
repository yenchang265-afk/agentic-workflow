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
    /**
     * End the run early once this many CONSECUTIVE counted attempts on the same
     * stage failed with an identical structural fingerprint (same failed
     * criteria, same blocking findings — `failureFingerprint`). Opt-in per
     * arm; requires `countIteration`. A run that fails the same way twice is
     * not converging, and the third identical pass costs a full BUILD+check
     * only to reach the cap message this one reaches now.
     */
    stallAfter: z.number().int().min(2).optional(),
    /** Stop message for the stall; `{stallAfter}` and `{maxIterations}` interpolate. Falls back to `capMessage`. */
    stallMessage: z.string().optional(),
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

/**
 * The shape a manifest value must have to be usable as a filesystem path
 * segment. Manifests are user-authored AND hub-writable, so any field that ends
 * up joined into a path needs the same rail `stage.prompt` has: `kind` becomes
 * a directory under `workflows/` and `<tasksDir>/runs/`, and each `status`
 * becomes `<tasksDir>/<status>/`. Core's own store deliberately does not guard
 * the status argument — "any status folder a kind's manifest declares" — which
 * is exactly why the manifest has to.
 */
const SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/
const SlugSchema = (label: string) =>
  z.string().regex(SLUG_RE, `${label} must be a lowercase slug (letters, digits and dashes) — it becomes a filesystem path segment`)

/**
 * Most axes a `fanout: "axis"` stage may fan out over. Each axis is a full
 * subagent pass with its own stage timeout, so the axis list is a direct
 * multiplier on an unattended loop's cost and wall-clock — an unbounded one is a
 * footgun the manifest should refuse, not a preference. 8 leaves headroom over
 * the engineering loop's five; a config lens list caps its own multiplier at 5.
 */
export const FANOUT_MAX = 8

/**
 * One check command the DRIVER runs for a stage. Shared by the manifest's
 * per-stage `checks` and the config's `workflows.<kind>.stageChecks`, so the two
 * layers cannot drift into different shapes.
 */
export const CheckDefSchema = z.object({
  /** Names the synthetic axis finding, and must be unique within a stage. */
  name: z.string().min(1),
  /** Shell, run verbatim (`{ raw }`) in the stage's work tree. */
  command: z.string().min(1),
  /** Work-tree-relative subdirectory; defaults to the work tree root. */
  cwd: z.string().min(1).optional(),
  /**
   * Wall-clock cap for THIS command; unset ⇒ config `checkTimeoutMinutes`.
   *
   * Exists because one cap across a stage's checks is set by the slowest one,
   * which leaves every faster check effectively unbounded: a repo running a
   * 20-second lint beside a 25-minute integration suite has to raise the global
   * cap to 25, and a lint that then hangs burns 25 minutes instead of failing
   * fast. Per check, each keeps a bound that fits it.
   */
  timeoutMinutes: z.number().int().positive().optional(),
})
export type CheckDef = z.infer<typeof CheckDefSchema>

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
  /**
   * Commands the DRIVER runs in the stage's work tree before firing it. Their
   * exit codes are established fact for the stage: rendered into the prompt,
   * seeded as observed evidence, and floored into the verdict via a synthetic
   * axis. Run driver-side, so they bypass `bashAllowlist` entirely — the agent
   * never issues them. Config `workflows.<kind>.stageChecks.<name>` replaces
   * this list wholesale.
   *
   * Trusted authoring surface, at the same level as `bashAllowlist`:
   * `defaultWorkflowsDir()` resolves manifests from the core package's install
   * location, not from the watched repo, so a merely-cloned repo cannot inject
   * one. "Trusted" here means AUTHORED, not unreachable — the hub writes into
   * that directory and `AGENTIC_WORKFLOW_WORKFLOWS_DIR` can repoint it. The
   * config half is shell a repo could ship, so it is dropped from the repo
   * layer (`SHELL_BEARING_WORKFLOW_KEYS`).
   */
  checks: z.array(CheckDefSchema).default([]),
  /**
   * Whether a PASS on this `check` stage must cite the work behind it. When set,
   * `workflow_verdict` rejects a PASS with no `evidence` array, and — on a host
   * that records its stage's tool calls — one whose citations match nothing the
   * stage actually ran or read (`workflow/evidence.ts`).
   *
   * Opt-in per stage rather than implied by `kind: "check"`, because not every
   * check is a *doing* check: a triage stage that classifies a PR from its
   * fetched metadata legitimately runs no commands, and turning the gate on
   * everywhere would deadlock it. Default `false` leaves every existing kind
   * byte-identical.
   */
  requireEvidence: z.boolean().default(false),
  /**
   * Whether this `check` stage's commands are DISCOVERED from the approved plan
   * when neither config `stageChecks` nor `checks` supplies any
   * (`workflow/discovered-checks.ts`).
   *
   * Opt-in per stage, the pattern `requireEvidence` set. It carries no predicate
   * and no command on purpose: a per-ecosystem command table baked in here would
   * be wrong for every repo it did not anticipate, and a wrong default here is
   * not inert — a missing runner exits 127 ⇒ ERROR ⇒ the stage's `onError` arm.
   * What it turns on is a channel, capped by this stage's own `bashAllowlist`.
   */
  discoverChecks: z.boolean().default(false),
  /**
   * Whether this `work` stage's prompt carries the plan-structure contract
   * (`planContractBlock`): ordered steps naming file paths, a `### Verification`
   * subsection mapping each acceptance criterion to its proof, and an explicit
   * `### Out of Scope`. On the kinds that opt in, `runPark` also refuses to park
   * a plan with no Verification subsection — the one clause of the contract a
   * deterministic gate can check without regexing prose quality.
   *
   * Opt-in per stage (the pattern `requireEvidence` set): only a stage that
   * writes a plan for a human gate wants it, and default `false` leaves every
   * existing kind byte-identical.
   */
  planContract: z.boolean().default(false),
  /**
   * Whether this `work` stage's prompt also carries the plan-visualization
   * block (`planVisualizationBlock`): an agent-judged instruction to include
   * mermaid diagram(s) inside the written plan when the change's shape —
   * state/lifecycle transitions, cross-package flow, concurrency, data-shape
   * changes — is what the human plan gate has to judge. Never enforced by any
   * gate: a diagram forced onto a mechanical plan is review noise, so the
   * prompt states the heuristic and the author decides.
   *
   * Requires `planContract` (the diagram lives inside the plan document the
   * contract defines). Default `false` leaves every existing kind
   * byte-identical; config `workflows.<kind>.planVisualization` wins over this.
   */
  planVisualization: z.boolean().default(false),
  /**
   * How this `check` stage's single pass expands into several focused passes.
   *
   * `"axis"` runs the stage once per entry in `requiredAxes`, SEQUENTIALLY, each
   * pass told to review and report exactly one axis. The passes' verdicts merge
   * worst-wins, and their union restores the complete axis coverage that one
   * pass would otherwise have had to supply in a single call — which is why
   * per-pass coverage narrows to the pass's own axis while the STAGE still
   * cannot advance with an axis uncovered (verdict.ts `uncoveredAxes`). That is
   * the whole difference from a config LENS list (`stageFanout` given an array),
   * whose free-text angles map to no axis, so per-pass enforcement is off and
   * the stage-wide check survives only if the lenses name every required axis.
   *
   * Unset ⇒ one unfocused pass, byte-identical to having no fan-out at all.
   * A one-member enum rather than a boolean so call sites name the strategy
   * (`def.fanout === "axis"`) and a second strategy stays a non-breaking edit.
   * Config `workflows.<kind>.stageFanout.<name>` wins over this.
   */
  fanout: z.enum(["axis"]).optional(),
  /**
   * Per-artifact character ceilings for this stage's composed prompt, keyed by the
   * artifact's producing stage (`plan`, `build`, `verify`, `review`). Unset ⇒
   * unbounded, which is byte-identical to having no budgets at all.
   *
   * A budget is a property of the CONSUMING stage, not the producing one: BUILD can
   * afford a large plan while REVIEW wants the build transcript trimmed hard, and the
   * same artifact is read by several stages with different needs. Config
   * `workflows.<kind>.stageContext.<name>` replaces this map wholesale.
   */
  context: z.record(z.string(), z.number().int().positive()).optional(),
  /** Bash-command globs this stage may run (enforced by the Claude Code stage guard). */
  bashAllowlist: z.array(z.string().min(1)).default([]),
  /** Extra bash globs merged into `bashAllowlist` for the resolved code platform (config `codePlatform`). */
  platformAllowlist: z.record(z.string(), z.array(z.string().min(1))).default({}),
  /**
   * MCP tool names (unprefixed) this stage may call on the resolved code
   * platform — the tool-level counterpart of `platformAllowlist`.
   *
   * On `ado` this is the whole surface: Azure DevOps is reached only through
   * the Azure DevOps MCP server, so the ado `platformAllowlist` is empty and
   * this list is what the stage may do. It is also the single source the agent
   * `tools:` frontmatter is GENERATED from — hand-authoring that per host is
   * exactly how a prompt drifts from the allowlist governing it.
   */
  platformTools: z.record(z.string(), z.array(z.string().min(1))).default({}),
})
export type StageDef = z.infer<typeof StageDefSchema>

/**
 * The bash globs a stage may run on the given code platform: the stage's own
 * `bashAllowlist` plus that platform's extras. An unknown platform key yields
 * only `bashAllowlist` — fail-closed. Pure.
 */
export const effectiveAllowlist = (def: StageDef, platform: string): string[] => [
  ...def.bashAllowlist,
  ...(def.platformAllowlist[platform] ?? []),
]

/**
 * The MCP tools a stage may call on the given code platform. An unknown
 * platform yields none — fail-closed, same rule as `effectiveAllowlist`. Pure.
 */
export const effectivePlatformTools = (def: StageDef, platform: string): string[] => [
  ...(def.platformTools[platform] ?? []),
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
  /**
   * Taken on a `check` stage's FAIL whose record carries `planDefect: true` —
   * the stage judged the APPROVED PLAN unimplementable, not the build wrong.
   * Opt-in: a kind that declares none routes such a FAIL through `onFail` as
   * before. Engineering points it at a stop naming `replan`, because a rebuild
   * against a plan that cannot pass only burns the iteration budget.
   */
  onPlanDefect: EffectSchema.optional(),
})
export type Transition = z.infer<typeof TransitionSchema>

const BacklogSourceSchema = z.object({
  type: z.literal("backlog"),
  /** The status-folder set, in forward lifecycle order. */
  statuses: z.array(SlugSchema("status")).min(1),
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
        // The same rail as `statuses`: a pool status is joined into
        // `<tasksDir>/<status>/` by every walker (listByStatus, findByIdIn,
        // the hub doctor's claim sweep) and the hub creator writes free-text
        // pool lines into manifests — an unvalidated one is a path escape.
        status: SlugSchema("pools[].status"),
        entryStage: z.string().min(1),
        /** Registry ref of a claimability predicate (defaults to "any file in the folder"). */
        claimPredicate: z.string().min(1).optional(),
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
    kind: SlugSchema("kind"),
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
      const statuses = new Set(m.workSource.statuses)
      for (const pool of m.workSource.pools) {
        if (!names.has(pool.entryStage)) {
          ctx.addIssue({ code: "custom", message: `pool "${pool.status}" enters unknown stage "${pool.entryStage}"` })
        }
        // A pool over a folder outside the declared status set is at best a
        // typo that polls a folder that never exists ("nothing to claim",
        // forever, silently) — refuse it like humanGates.
        if (!statuses.has(pool.status)) {
          ctx.addIssue({ code: "custom", message: `pool status "${pool.status}" is not one of workSource.statuses` })
        }
      }
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
      for (const artifact of Object.keys(stage.context ?? {})) {
        // Checkable here, unlike the config layer's `stageContext` (the manifest
        // isn't loaded when config parses). A typo would otherwise resolve to
        // "unbounded" and read as "budgets don't work".
        if (!names.has(artifact)) {
          ctx.addIssue({ code: "custom", message: `stage "${stage.name}" budgets unknown artifact "${artifact}"` })
        }
      }
      if (stage.kind === "work" && stage.requiredAxes?.length) {
        // Only a verdict can carry axes, and only check stages record one.
        ctx.addIssue({ code: "custom", message: `work stage "${stage.name}" cannot set requiredAxes (no verdict to carry them)` })
      }
      if (stage.kind === "work" && stage.checks.length) {
        // Checks exist to FLOOR a verdict, and only check stages record one —
        // on a work stage they would run, cost a test suite, and bind nothing.
        ctx.addIssue({ code: "custom", message: `work stage "${stage.name}" cannot set checks (no verdict to floor)` })
      }
      const checkNames = new Set(stage.checks.map((c) => c.name))
      if (checkNames.size !== stage.checks.length) {
        // The name keys both the prompt line and the synthetic axis finding, so
        // a duplicate silently collapses two results into one.
        ctx.addIssue({ code: "custom", message: `stage "${stage.name}" has duplicate check names` })
      }
      if (stage.kind === "work" && stage.discoverChecks) {
        // Same rule as `checks`: discovery only produces checks, and a work
        // stage has no verdict for them to floor.
        ctx.addIssue({ code: "custom", message: `work stage "${stage.name}" cannot set discoverChecks (no verdict to floor)` })
      }
      if (stage.discoverChecks && !stage.bashAllowlist.length) {
        // The allowlist IS the admission gate for a discovered command, so an
        // empty one silently refuses every one of them — the flag would read as
        // on while the feature is dead.
        ctx.addIssue({ code: "custom", message: `stage "${stage.name}" sets discoverChecks with an empty bashAllowlist (every discovered command would be refused)` })
      }
      if (stage.kind === "work" && stage.requireEvidence) {
        // Only a verdict carries evidence, and only check stages record one.
        ctx.addIssue({ code: "custom", message: `work stage "${stage.name}" cannot set requireEvidence (no verdict to carry it)` })
      }
      if (stage.kind === "check" && stage.planContract) {
        // The contract governs a WRITTEN plan; a check stage writes none, so the
        // flag would append a demand nothing can satisfy.
        ctx.addIssue({ code: "custom", message: `check stage "${stage.name}" cannot set planContract (it writes no plan)` })
      }
      if (stage.kind === "check" && stage.planVisualization) {
        ctx.addIssue({ code: "custom", message: `check stage "${stage.name}" cannot set planVisualization (it writes no plan)` })
      }
      if (stage.planVisualization && !stage.planContract) {
        // The diagram lives inside the `## Implementation Plan` document the
        // contract defines; without the contract there is no plan structure for
        // the visualization instruction to attach to.
        ctx.addIssue({
          code: "custom",
          message: `stage "${stage.name}" sets planVisualization without planContract (the diagram lives inside the contract's plan document)`,
        })
      }
      if (stage.fanout && stage.kind !== "check") {
        ctx.addIssue({ code: "custom", message: `work stage "${stage.name}" cannot set fanout (there is no verdict to fan out)` })
      }
      if (stage.fanout === "axis" && !stage.requiredAxes?.length) {
        // The axis list IS the pass list; without one the stage would fan out
        // over nothing and silently run as a single pass.
        ctx.addIssue({
          code: "custom",
          message: `stage "${stage.name}" sets fanout "axis" but declares no requiredAxes — there is nothing to fan out over`,
        })
      }
      if (stage.fanout === "axis" && (stage.requiredAxes?.length ?? 0) > FANOUT_MAX) {
        ctx.addIssue({
          code: "custom",
          message:
            `stage "${stage.name}" fans out over ${stage.requiredAxes?.length} axes — at most ${FANOUT_MAX} ` +
            "(each axis is a full subagent pass)",
        })
      }
      for (const effect of [t.onDone, t.onPass, t.onFail, t.onError, t.onPlanDefect]) {
        if (effect?.kind === "fire" && !names.has(effect.stage)) {
          ctx.addIssue({ code: "custom", message: `transition fires unknown stage "${effect.stage}"` })
        }
        if (effect?.kind === "fire" && effect.countIteration && !effect.capMessage) {
          ctx.addIssue({ code: "custom", message: `counted fire to "${effect.stage}" needs a capMessage` })
        }
        if (effect?.kind === "fire" && effect.stallAfter !== undefined && !effect.countIteration) {
          ctx.addIssue({ code: "custom", message: `stallAfter on the fire to "${effect.stage}" needs countIteration — a stall is counted attempts failing alike` })
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
 * Whether a stage's verdict must account for the task's acceptance criteria
 * (`criteriaIssue`): a check stage with no `requiredAxes`. An axis-bearing
 * stage (engineering REVIEW) grades the CODE per axis — its completeness gate
 * is axis coverage, and demanding per-criterion entries from every focused
 * fan-out pass would reject passes that legitimately saw only their own axis.
 * A stage this predicate matches is also always pass-mode "single"
 * (`stagePasses`: lenses are `review`-only and review has axes; axis fan-out
 * needs `requiredAxes`), so the contract composed once per stage cannot
 * contradict a focused pass's suffix. The requirement still gates nothing when
 * the task carries no acceptance (`CriteriaContext.acceptance` empty — every
 * sitter kind). Pure.
 */
export const stageRequiresCriteria = (def: StageDef): boolean => def.kind === "check" && !def.requiredAxes?.length

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
