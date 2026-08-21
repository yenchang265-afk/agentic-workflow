import path from "node:path"
import { z } from "zod"
import type { Client } from "./host.js"
import { CODE_PLATFORMS, SHIP_PUBLISH_MODES, type Config, type ShipPublish, type WorkflowTrigger } from "./workflow/state.js"
import { CheckDefSchema, effectiveAllowlist, type CheckDef, type StageDef } from "./manifest/schema.js"
import type { StagePass } from "./workflow/verdict.js"
import { TRACKER_SYSTEMS, type TrackerSystem } from "./task/schema.js"
import {
  CONFIG_FILE,
  SHELL_BEARING_KEYS,
  bashAllowlistExtras,
  bashAllowlistPrefixes,
  ignoredUserConfigPaths,
  isPlainObject,
  mergeConfigLayers,
  rawAgentModel,
  readUserLayer,
  resolveUserConfigPath,
  spawnAlias,
  withCommandPrefixes,
} from "./config-layers.js"

/**
 * The layering plumbing and model-string normalization live in
 * `./config-layers.ts` — zod-free, so a bundled `PreToolUse` hook and
 * OpenCode's bootstrap `config` hook can share them without pulling zod in.
 * Re-exported here so every existing import site keeps working unchanged.
 */
export {
  CD_TWIN_PREFIX,
  CONFIG_FILE,
  SPAWN_ALIASES,
  USER_CONFIG_ENV,
  bareModel,
  bashAllowlistExtras,
  bashAllowlistPrefixes,
  ignoredUserConfigPaths,
  isPlainObject,
  mergeConfigLayers,
  rawAgentModel,
  readRawConfigLayers,
  readUserLayer,
  resolveAgentModels,
  resolveUserConfigPath,
  spawnAlias,
  stripCommandPrefix,
  withCdTwins,
  withCommandPrefixes,
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
 * No host declares a field of its own today — the last one, OpenCode's
 * `watchIntervalMinutes`, is retired (`RETIRED_CONFIG_KEYS`). Should one need
 * to again, it belongs in that host's extension of `ConfigSchema` rather than
 * here — see the generic `parseConfigWith`/`loadConfigWith` loaders below,
 * which exist for exactly that. A host may still add a REFINEMENT without a
 * field, as OpenCode does for cron schedules it alone can run.
 */

/** Which code-management platform PR-shaped work sources talk to. */
export const CodePlatformSchema = z.enum(CODE_PLATFORMS)
export type CodePlatform = z.infer<typeof CodePlatformSchema>

/** What a ship gate publishes: open a draft PR, push the branch only, or nothing. */
export const ShipPublishSchema = z.enum(SHIP_PUBLISH_MODES)
export type { ShipPublish }

/**
 * A git ref name, enforced HERE rather than surfacing as an opaque git failure
 * later: these values are concatenated into `git checkout -b`, `git push` and
 * `gh pr create --base`.
 *
 * Shared by `taskBranch` (a PREFIX, which legitimately ends in `/`) and `prBase`
 * (a whole ref, which must not) — hence the trailing-slash rule lives on the
 * caller, not here.
 */
export const GitRefNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, "must start with a letter or digit and use only letters, digits, . _ - /")
  .refine((p) => !p.includes("..") && !p.includes("//") && !p.endsWith(".lock"), {
    message: "must not contain '..' or '//', or end in '.lock' (git ref-format)",
  })

/**
 * A ref a pull request TARGETS. Accepts the `refs/heads/`-qualified form a human
 * may copy out of a git or ADO UI and normalizes it away, so config values,
 * `--base=` and the recorded run base all reach `shipPr` bare and no platform arm
 * can double-prefix.
 */
export const PrBaseSchema = z
  .string()
  .transform((v) => v.replace(/^refs\/heads\//, ""))
  .pipe(GitRefNameSchema.refine((p) => !p.endsWith("/"), { message: "must name a branch, not a prefix — drop the trailing '/'" }))

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
   * Wall-clock cap on ONE driver-run check command (`workflow/checks.ts`).
   * Separate from `stageTimeoutMinutes` because checks run OUTSIDE that cap on
   * both hosts — OpenCode's stage timer races the model session, and the Claude
   * host tests its deadline in `workflow_advance` while checks run back in
   * `workflow_stage`. A timed-out check reports exit 124, which `classifyExit`
   * reads as ERROR: the loop stops once for a human instead of re-firing a
   * BUILD that will hang again.
   */
  checkTimeoutMinutes: z.number().int().positive().default(10),
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
   * Shell command fired after a terminal loop event — a plan parking for the
   * plan gate, a finished run reaching the ship gate, a stop, an error. The
   * gates go quiet when nobody is watching the terminal: the park lands as a
   * toast and scrollback, and a `watch` worker accumulates finished work
   * silently. This is the one knob that turns those into a push — a
   * `notify-send`, a `curl` to a chat webhook, an `osascript` — without the
   * hub having to be open.
   *
   * Runs as `sh -c <command>` with the event in env vars: `AW_EVENT`
   * (park | done | stop | error), `AW_KIND` (workflow kind), `AW_TASK` (task
   * id, may be empty), `AW_MESSAGE` (the one-line terminal message). Bounded
   * (10s) and best-effort: a slow or failing notifier logs a warning and
   * never changes the terminal outcome.
   *
   * SHELL-BEARING: honored from the USER-scope config ONLY, exactly like
   * `worktreeSetup` — a cloned repo must not be able to run arbitrary shell
   * on the first park (`SHELL_BEARING_KEYS`).
   */
  notifyCommand: z.string().min(1).optional(),
  /**
   * Which terminal events fire `notifyCommand`. Absent ⇒ all of them. Not
   * shell-bearing (the value space is four literals), so a repo may narrow —
   * but never widen — what its contributors get pinged about.
   */
  notifyEvents: z.array(z.enum(["park", "done", "stop", "error"])).optional(),
  /**
   * Branch-name PREFIX the engineering loop cuts its work branch with
   * (`<prefix><id>`), or `false` — "cut nothing; run BUILD/VERIFY/REVIEW on the
   * branch the working tree already has checked out", for the human who is
   * already on the branch this work belongs on. `false` implies shared-tree
   * mode (`worktreesDirFor`): git refuses `worktree add` for a branch that is
   * already checked out in the main tree, so the two cannot both hold.
   *
   * Honored for the `engineering` kind only — see `taskBranchFor`.
   *
   * The value is concatenated with a workflow id and handed to `git checkout -b`
   * and `git push`, so ref-format is enforced HERE rather than surfacing as an
   * opaque git failure three stages into a run.
   */
  taskBranch: z.union([GitRefNameSchema, z.literal(false)]).default("feature/"),
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
        /** Per-kind override of the global `prBase` — the branch this kind's PRs target. */
        prBase: PrBaseSchema.optional(),
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
         * manifest-declared fan-out back off; a LIST of focus strings runs the
         * stage once per entry, each told to focus on that angle alone.
         *
         * This is what makes fan-out reachable at all: the built-in kinds'
         * manifests ship inside the core package (manifest/dir.ts), so a user
         * cannot edit `fanout` there. Same direction as `stageModels`/`stageContext`
         * — config beats manifest. Value space is two literals or a string list:
         * no shell, no path.
         *
         * The list form absorbed the top-level `reviewLenses`
         * (`RETIRED_CONFIG_KEYS`). Two mechanisms for "run this check stage as
         * several focused passes" could not both be right, and the global one
         * was the weaker: it applied to the stage named `review` alone — one
         * stage of one kind — and it WON over a declared fan-out, so the better
         * configuration silently lost and both hosts carried a warning whose only
         * job was to report that. Here the same lenses reach any check stage of
         * any kind, and cannot shadow anything.
         *
         * Lens passes still buy less than `"axis"` does: a free-text angle maps
         * to no axis, so per-pass axis coverage cannot be enforced against it
         * (`passAxes`), and the stage-wide check survives only when the list
         * between its entries names every required axis (`enforcesAxisCoverage`).
         * Capped at 5, as `reviewLenses` was.
         */
        stageFanout: z
          .record(z.string(), z.union([z.enum(["axis", "none"]), z.array(z.string().min(1)).max(5)]))
          .optional(),
        /**
         * Stage name → how many of that stage's focused passes may run at once.
         * Absent ⇒ a per-axis fan-out runs all its passes at once, everything
         * else runs one at a time (see `concurrencyFor` for why).
         *
         * A fanned-out check stage's passes are independent by construction —
         * each is a read-only review of the same work tree, told to cover its own
         * axis or lens and not the others, merged worst-wins — so running them
         * concurrently is a latency win, not a semantic change. Set it to clamp
         * the COST: N passes in flight means N concurrent model sessions against
         * the user's rate limit, and `1` takes a fanned-out stage back to serial.
         *
         * Value space is positive integers — no shell, no path — so, like
         * `stageContext`, this is safe to honor from the repo layer. Capped at
         * the stage's pass count; a value on a single-pass stage is inert.
         */
        stageConcurrency: z.record(z.string(), z.number().int().positive()).optional(),
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
         * Turn the manifest's per-stage `discoverChecks` off (or on) for this
         * kind — whether a check stage with no configured and no manifest checks
         * may take them from the approved plan's `agentic-checks` block.
         *
         * NOT shell-bearing, deliberately: the value space is one boolean, and
         * enabling it grants a repo nothing it does not already have, because
         * every discovered command must pass the stage's own `bashAllowlist`,
         * which its agent already runs against unconditionally. The shell-bearing
         * boundary stays on `stageChecks`, which is arbitrary shell.
         */
        discoverChecks: z.boolean().optional(),
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
         * Whether the kind's plan-writing stage is prompted to include mermaid
         * diagram(s) in the plan when the change's shape warrants it
         * (`planVisualizationBlock`) — agent-judged, never gate-enforced. Wins
         * over the manifest stage's `planVisualization`, in both directions;
         * this is what makes the opt-in reachable at all, since the built-in
         * kinds' manifests ship inside the core package (same rationale as
         * `stageFanout`). Kind-level rather than stage-keyed because at most
         * one stage per kind carries `planContract`, which the block requires.
         *
         * Honored from the repo layer, like `stageContext`: the value space is
         * one boolean — no shell, no path, no fs reach.
         */
        planVisualization: z.boolean().optional(),
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
   * Extra bash globs appended to every allowlisted stage's grants, after the
   * manifest's `bashAllowlist`. The per-project/per-user escape hatch the
   * manifests cannot carry: a project-specific test runner, or a
   * command-rewriting proxy (an rtk-style token saver) whose rewritten shape
   * (`rtk <cmd>`) matches no shipped glob and would otherwise starve every
   * check stage into ERROR.
   *
   * Bare globs only — worktree `cd * && ` twins are derived where a host needs
   * them (`withCdTwins`), the same rule the manifests follow. Applies to every
   * stage that declares an allowlist (check stages and allowlisted work stages
   * like pr-sitter publish); a stage declaring none stays unrestricted and gets
   * nothing. Top-level rather than per-kind for the same reason as
   * `agentModels`: the environment it describes is host-wide, not per-kind.
   *
   * These globs widen the T2 scope boundary — that is their entire purpose —
   * so breadth is the operator's call. For a rewriting proxy prefer
   * `bashAllowlistPrefix` below, which widens nothing; reach for `"rtk *"` here
   * only for what the proxy RENAMES (`cat x` → `rtk read x`), which no
   * derivation can predict.
   */
  bashAllowlistExtra: z.array(z.string().min(1)).default([]),
  /**
   * Command prefixes a rewriting proxy puts in front of the command a stage
   * asked for (an rtk-style token saver: `git status` → `rtk git status`),
   * applied BEFORE either host evaluates its allowlist — so every shipped glob
   * misses and the stage starves on the deny sentinel.
   *
   * Each prefix re-expresses the globs the stage ALREADY declares
   * (`withCommandPrefixes`): with `["rtk"]`, a stage granted `npm test*` also
   * accepts `rtk npm test`, and still refuses `rtk npm publish`. That is the
   * difference from a `"rtk *"` extra, which accepts both. It grants no command
   * a stage could not already run, so unlike `bashAllowlistExtra` it does not
   * widen the T2 boundary at all.
   *
   * Prefixes are also stripped before the write backstops classify a segment
   * (`stripCommandPrefix`): those anchor on the bare tool name, so without it
   * `rtk git push --force origin main` reads as no violation.
   *
   * Bare command heads only — no `*`, no shell metacharacters; a malformed entry
   * is dropped rather than admitted. Multi-word prefixes are fine (`rtk proxy`).
   */
  bashAllowlistPrefix: z.array(z.string().min(1)).default([]),
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
   * What the ship gate publishes when a human approves an `in-review/` task:
   * `pr` (the default — push the branch and open a draft PR), `push` (push the
   * branch, open nothing), or `local` (touch the network not at all).
   *
   * Every mode still moves the task to `completed/` and commits the backlog;
   * this chooses only what leaves the machine. A `push` or `local` ship is a
   * complete success, not a degraded one — no warning is raised for doing
   * exactly what was asked.
   *
   * Overridable per ship (`approve <id> --pr|--push|--local`, the hosts'
   * `publish` tool argument, the hub's Ship dialog), and reversible: shipping
   * the same task again with `publish: "pr"` finds it in `completed/` and lands
   * in `shipTask`'s idempotent retry arm, which pushes and opens the PR then.
   *
   * Global only — deliberately not overridable per kind. The ship gate is
   * task-backed and reached by the `engineering` kind alone (no sitter has a
   * ship gate at all), so a `workflows.<kind>.shipPublish` would be a knob that
   * can never fire. Same reasoning as `taskBranch` above.
   */
  shipPublish: ShipPublishSchema.default("pr"),
  /**
   * The branch a pull request this repo opens should TARGET — set it when your
   * team integrates somewhere other than the repo's default branch, e.g.
   * `release/2.4`.
   *
   * NOT `ensureIsolation`'s `baseBranch`, which is the opposite half: what a run
   * cuts FROM, in the host's own tree. The two coincide by default and diverge
   * the moment either is set, which is why they are not named alike.
   *
   * Deliberately undefaulted. Unset does NOT mean `main` — it means "ask the
   * platform for its default branch", which is right for a `master` or `develop`
   * repo too. It also sits BELOW the base the run recorded (`extractRunBase`),
   * because that is the ref REVIEW graded `git diff <base>...<branch>` against:
   * retargeting a PR away from it shows reviewers a different change than the one
   * approved at the in-review gate. Use `--base=<ref>` to retarget deliberately.
   *
   * Overridable per kind — unlike `shipPublish` — because `dep-sitter` and
   * `main-sitter` open PRs of their own from their publish stages, and wanting
   * feature work on `release/2.4` while dependency bumps go to `main` is ordinary.
   */
  prBase: PrBaseSchema.optional(),
  /**
   * Extra branches no loop stage may `git push`, on top of the permanent
   * `main`/`master`/`HEAD` floor — for a team whose integration branch is
   * `release/2.4` rather than the repo default.
   *
   * Additive only: the floor cannot be configured away. A config that could
   * unprotect `main` is a config that can be wrong about the one branch that
   * matters, and the failure is silent until something has already been pushed.
   *
   * Deliberately separate from `prBase`. "Where PRs target" and "what agents
   * may not push" are different policies that merely coincide by default — an
   * integration branch the loop IS allowed to push is a legitimate setup, and
   * folding the two would make one value mean three things.
   *
   * TOP-LEVEL, and not per kind. It shipped declared one level down, inside the
   * `workflows.<kind>` record — which parses, so nothing failed, while every
   * reader (`discovered-checks.ts`, the Claude host's stage marker) asks for the
   * top-level key and got `undefined` forever. A push protection that silently
   * protects nothing is worse than one that was never configured, so the shape
   * the docs describe is the shape the schema now has, in exactly one place.
   */
  protectedBranches: z.array(GitRefNameSchema).default([]),
  /**
   * Azure DevOps coordinates; required when any effective platform is `ado`.
   *
   * Deliberately `looseObject`: the removed transport keys (`access`,
   * `customHeaders`, `insecureSkipTlsVerify`) must survive parsing so
   * `deprecatedAdoKeys` can name them in a warning. A strict object would strip
   * them silently, and a user who set `insecureSkipTlsVerify: true` would get
   * certificate verification with no explanation of why their setting vanished.
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
       * How the Azure DevOps MCP server is launched. Every field has a working
       * default; the section exists for air-gapped installs, corporate TLS, and
       * multi-tenant orgs.
       */
      mcp: z
        .strictObject({
          command: z.string().min(1).optional(),
          args: z.array(z.string()).optional(),
          /**
           * Defaults to "pat". The server's own default is "interactive", which
           * opens a browser — unusable from a polling loop, so it is not ours.
           */
          authentication: z.enum(["pat", "envvar", "azcli", "interactive"]).optional(),
          domains: z.array(z.string().min(1)).optional(),
          tenant: z.string().min(1).optional(),
          /** Extra child env (NODE_EXTRA_CA_CERTS, HTTPS_PROXY). Not for secrets. */
          env: z.record(z.string().min(1), z.string()).optional(),
        })
        .optional(),
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

/**
 * Opt-in kinds the config writes a section for WITHOUT deciding `enabled` —
 * config that can never take effect, and the one shape of it a diagnostic can
 * name without false positives.
 *
 * The kind sections are deliberately loose objects ("knobs ride along and are
 * validated by the kind itself"), so a blanket unknown-key warner would flag
 * every custom kind's own knobs. But `enabled` is core's, and its absence on an
 * opt-in kind is never what the author meant: they typed a section — knobs, or
 * a typo like `"enable": true` — for a kind that will silently never run, and
 * nothing anywhere said so. An explicit `enabled: false` is a parked section
 * and stays silent. Pure.
 */
export const unenabledConfiguredKinds = (config: { readonly workflows: Readonly<Record<string, { readonly enabled?: boolean }>> }): string[] =>
  Object.entries(config.workflows)
    .filter(([kind, section]) => !DEFAULT_ENABLED_KINDS.includes(kind) && section.enabled === undefined)
    .map(([kind]) => kind)
    .sort()

/** The code platform a workflow kind's PR source talks to: per-kind override, else the global default. Pure. */
export const platformFor = (config: Config, kind: string): CodePlatform =>
  config.workflows[kind]?.codePlatform ?? config.codePlatform ?? "github"

/**
 * What one ship publishes: the human's explicit per-ship choice, else the
 * repo's `shipPublish`, else `pr` (the behavior every ship had before the key
 * existed). Pure.
 *
 * The precedence lives here alone so a flag, an MCP tool argument and a hub
 * radio button cannot each decide it differently — the same reason `platformFor`
 * exists rather than a `??` chain at every call site.
 */
export const shipPublishFor = (config: Config, override?: ShipPublish): ShipPublish => override ?? config.shipPublish ?? "pr"

/** The branch a kind's pull requests target: per-kind override, else the global default. Pure. */
export const prBaseFor = (config: Config, kind: string): string | undefined => config.workflows[kind]?.prBase ?? config.prBase

/**
 * The base ref one ship's PR should target, or `undefined` to let the platform
 * name its own default branch. Pure.
 *
 * Highest first: the human's explicit `--base=<ref>`; the base the run itself was
 * cut from (`extractRunBase`); the configured `prBase`. `undefined` is the
 * documented hand-off to `shipPr`, which alone can do the I/O the remaining rungs
 * need (`gh repo view` / the ADO gateway, then the current branch, then `main`).
 *
 * The recorded base outranks config because it is the ref REVIEW measured the
 * diff against — a PR opened onto anything else shows reviewers a change nobody
 * approved. `--base=` outranks both because retargeting is exactly what it is for.
 *
 * The precedence lives here alone so a flag, an MCP tool argument and a hub text
 * field cannot each decide it differently — the same reason `shipPublishFor` and
 * `platformFor` exist rather than a `??` chain at every call site.
 */
export const shipBaseFor = (config: Config, kind: string, from: { readonly override?: string; readonly recorded?: string } = {}): string | undefined =>
  from.override ?? from.recorded ?? prBaseFor(config, kind)

/** The typed-verb flags that override `shipPublish` for a single ship. */
export const SHIP_PUBLISH_FLAGS: Readonly<Record<string, ShipPublish>> = { "--pr": "pr", "--push": "push", "--local": "local" }

/** The typed-verb flag that overrides `prBase` for a single ship. Takes its value inline — see `parseGateOptions`. */
export const SHIP_BASE_FLAG = "--base"

/** The task-gate flag that arms the plan gate's auto-approve (`approve <id> --auto-plan`). */
export const AUTO_PLAN_FLAG = "--auto-plan"

export type GateOptionParse =
  | { readonly ok: true; readonly publish?: ShipPublish; readonly base?: string; readonly autoPlan?: boolean; readonly rest: readonly string[] }
  | { readonly ok: false; readonly message: string }

/**
 * The overrides carried by a typed gate verb's words, plus the bare words left
 * over. Pure.
 *
 * Every host parses the same flags through this one function, because a flag that
 * means `local` on one host and nothing on another is worse than no flag at all:
 * the ship still happens, so the human reads "completed" and only finds out later
 * that a branch they meant to keep local was pushed.
 *
 * An unrecognized dash-word is a REFUSAL, not something to ignore. The hosts
 * forward every dash-word here rather than filtering to the ones they know, so a
 * typo (`--localy`, `--push-only`) fails loudly instead of silently shipping under
 * the configured default — which is exactly the outcome the human was typing a
 * flag to avoid. Two different modes at once is refused for the same reason: there
 * is no defensible way to pick one.
 *
 * `--base` takes its value INLINE (`--base=release/2.4`) and the space-separated
 * form is refused rather than supported. A value-consuming flag would have to be
 * taught to four independently-maintained parsers, two of them bundled hooks that
 * cannot import this file (`plugins/claude/hooks/gate-parse.mjs` and its generated
 * qwen twin) — and every one of them picks the task id as the first BARE word, so
 * a missed lesson does not error, it silently ships `release/2.4` as the id. In
 * the `=` form the whole token starts with `-`, so those parsers forward it
 * untouched and need no lesson at all.
 *
 * `rest` is the id-bearing remainder. Callers MUST take the id from it rather than
 * re-scanning the raw words, so flag values can never be mistaken for one.
 */
export const parseGateOptions = (words: readonly string[]): GateOptionParse => {
  let publish: ShipPublish | undefined
  let base: string | undefined
  let autoPlan: boolean | undefined
  const rest: string[] = []
  for (const word of words) {
    if (!word.startsWith("-")) {
      rest.push(word)
      continue
    }
    if (word === AUTO_PLAN_FLAG) {
      autoPlan = true
      continue
    }
    if (word === SHIP_BASE_FLAG) return { ok: false, message: `"${SHIP_BASE_FLAG}" needs its value inline — pass ${SHIP_BASE_FLAG}=<branch>.` }
    if (word.startsWith(`${SHIP_BASE_FLAG}=`)) {
      const raw = word.slice(SHIP_BASE_FLAG.length + 1)
      const parsed = PrBaseSchema.safeParse(raw)
      if (!parsed.success) return { ok: false, message: `Invalid ${SHIP_BASE_FLAG}=${raw} — ${parsed.error.issues[0]?.message ?? "not a branch name"}.` }
      if (base && base !== parsed.data) return { ok: false, message: `Conflicting base branches: ${base} and ${parsed.data} — pass one.` }
      base = parsed.data
      continue
    }
    const mode = SHIP_PUBLISH_FLAGS[word]
    if (!mode) return { ok: false, message: `Unknown option "${word}" — expected ${Object.keys(SHIP_PUBLISH_FLAGS).join(", ")}, ${SHIP_BASE_FLAG}=<branch>, ${AUTO_PLAN_FLAG}.` }
    if (publish && publish !== mode) return { ok: false, message: `Conflicting publish options: --${publish} and --${mode} — pass one.` }
    publish = mode
  }
  return { ok: true, rest, ...(publish ? { publish } : {}), ...(base ? { base } : {}), ...(autoPlan ? { autoPlan } : {}) }
}

/**
 * The branch-name prefix a kind's loop cuts with, or null when `taskBranch:
 * false` says to build on the branch already checked out. Pure.
 *
 * `taskBranch` is honored for `engineering` alone; every other kind keeps
 * `feature/`, for two independent reasons that both make an override a
 * regression rather than a feature:
 *
 *  - `pr-sitter` and `main-sitter` PRE-SET `state.git` from their work source (a
 *    PR's own head branch, a remedy branch named after the red commit). That
 *    branch is externally determined — the loop does not choose it and cannot.
 *  - `dep-sitter`'s publish stage pins the literal `git push origin feature/*`
 *    in its manifest bash allowlist, and those manifests ship read-only inside
 *    the core package. Any other prefix makes its own guard deny its push.
 */
export const taskBranchPrefix = (config: Config, kind: string): string | null =>
  kind !== "engineering" ? "feature/" : config.taskBranch === false ? null : config.taskBranch

/** The branch a kind's loop cuts for `id`, or null in current-branch mode. Pure. */
export const taskBranchFor = (config: Config, kind: string, id: string): string | null => {
  const prefix = taskBranchPrefix(config, kind)
  return prefix === null ? null : `${prefix}${id}`
}

/**
 * The effective worktree root for a kind. `taskBranch: false` wins over
 * `worktreesDir`: git refuses `worktree add` for a branch already checked out
 * in the main tree, so a current-branch loop cannot also have a worktree.
 *
 * FORCED rather than rejected in the schema, because `worktreesDir` has a
 * truthy DEFAULT — a `superRefine` would fail a user who wrote only
 * `taskBranch: false` and blame a key they never set. (Seeing whether
 * `worktreesDir` was explicitly written needs the pre-default raw object, i.e.
 * `z.preprocess`, which returns a `ZodPipe` and would destroy both
 * `ConfigSchema.shape` — what the hub's `knownTopLevelKeys` enumerates — and
 * `.safeExtend`, which the OpenCode host's config depends on.) The override is
 * never silent: `ensureIsolation` logs once when it drops a configured value.
 */
export const worktreesDirFor = (config: Config, kind: string): string | false =>
  taskBranchPrefix(config, kind) === null ? false : config.worktreesDir

/**
 * Azure DevOps config keys that no longer do anything, in config order.
 *
 * ADO is now reached ONLY through the Azure DevOps MCP server, so every key
 * that configured the old raw-REST transport is inert:
 *
 * - `access` — ADO was once reachable three ways (`az` | `rest` | `mcp`).
 * - `customHeaders` — the MCP server offers no per-request header seam. Use
 *   `ado.mcp.env` for proxy settings instead.
 * - `insecureSkipTlsVerify` — there is no per-request dispatcher to inject; the
 *   server does its own HTTPS. `ado.mcp.env.NODE_EXTRA_CA_CERTS` covers an
 *   internal CA, which is the closest remaining equivalent.
 *
 * Left in place these would be config that lies about what it does, so hosts
 * surface them as a one-line warning — the same treatment
 * `unknownStageModelKeys` gets, and for the same reason: silently ignoring a
 * key the user deliberately set reads as "the setting doesn't work".
 *
 * Reported rather than rejected so an in-flight loop keeps running. Pure.
 */
export const DEPRECATED_ADO_KEYS = ["access", "customHeaders", "insecureSkipTlsVerify"] as const

export const deprecatedAdoKeys = (config: Config): string[] => {
  const ado = config.ado as Record<string, unknown> | undefined
  if (!ado) return []
  return DEPRECATED_ADO_KEYS.filter((key) => ado[key] !== undefined).map((key) => `ado.${key}`)
}

/**
 * Top-level config keys that no longer exist, mapped to what replaces them.
 *
 * The sibling of `DEPRECATED_ADO_KEYS` one level up, and it needs its own
 * reader for a structural reason: `ado` is a `looseObject`, so a stale key
 * inside it survives parsing and can be named from the parsed config. A
 * TOP-LEVEL key cannot — zod strips what the schema does not declare — so by
 * the time anyone holds a `Config` the value is simply gone. `retiredConfigKeys`
 * therefore reads the RAW merged layer, before parsing.
 *
 * Warned about rather than accepted, because the alternative is the failure
 * mode this codebase keeps re-learning: a key the user deliberately set is
 * silently ignored, the behavior reverts to a default, and nothing anywhere
 * says so — which reads as "the setting doesn't work" rather than "that setting
 * is gone, here is the one to use".
 *
 * - `watchIntervalMinutes` — a global default watch cadence, when the two rungs
 *   above it already covered every use: `watch <interval>` per session, and
 *   `workflows.<kind>.trigger.intervalMinutes` persistently and per kind. It
 *   also applied ONE cadence to every watched kind, which a repo running a
 *   `dep-sitter` beside an `engineering` loop never wants.
 */
export const RETIRED_CONFIG_KEYS: Readonly<Record<string, string>> = {
  watchIntervalMinutes:
    'use `watch <interval>` for one session (e.g. `watch 30s`), or "workflows.<kind>.trigger": {"type":"poll","intervalMinutes":N} to set it per kind and persist it',
  reviewLenses:
    'move the same list to the stage it applies to — "workflows": {"engineering": {"stageFanout": {"review": ["security", "..."]}}} — or prefer "review": "axis", which covers every required axis and enforces it per pass',
}

/**
 * Retired top-level keys present in a RAW config layer, paired with what
 * replaces each, in `RETIRED_CONFIG_KEYS` order.
 *
 * Takes the raw merged layer rather than a `Config` (see above), so it is safe
 * to call on an unvalidated `JSON.parse` — including from the bare-node hook and
 * OpenCode bootstrap contexts `readRawConfigLayers` serves.
 *
 * Returns the pair rather than a pre-joined sentence so a caller never has to
 * take the string back apart to render it: the replacement text contains em
 * dashes of its own, so any separator a formatter picked would be ambiguous to
 * re-split. Pure.
 */
export const retiredConfigKeys = (raw: unknown): { readonly key: string; readonly replacement: string }[] => {
  if (!isPlainObject(raw)) return []
  return Object.entries(RETIRED_CONFIG_KEYS)
    .filter(([key]) => raw[key] !== undefined)
    .map(([key, replacement]) => ({ key, replacement }))
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
 * Whether a stage's prompt carries the plan-visualization block: config
 * `workflows.<kind>.planVisualization`, else the manifest stage's
 * `planVisualization`. Only meaningful on a stage that sets `planContract`
 * (the schema refuses the manifest flag without it, and callers gate the
 * config override on it too — the block's diagram lives inside the contract's
 * plan document). Pure.
 */
export const planVisualizationFor = (config: Config, kind: string, def: StageDef): boolean =>
  def.planContract && (config.workflows[kind]?.planVisualization ?? def.planVisualization)

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
 * else `discovered` (from the approved plan — see `workflow/discovered-checks.ts`),
 * else `[]` (no checks — byte-identical to before they existed).
 *
 * Replaces the manifest's list wholesale rather than merging into it, exactly as
 * `contextFor` replaces `context` and `modelFor` replaces `model`.
 *
 * A PRESENT config entry wins even when it is empty: `{ verify: [] }` means "my
 * project's checks, and there are none", which must also suppress discovery or
 * the explicit opt-out would not be one. `discovered` is defaulted so the
 * callers that predate discovery keep today's behavior. Pure.
 */
export const checksFor = (
  config: Config,
  kind: string,
  def: StageDef,
  discovered: readonly CheckDef[] = [],
): readonly CheckDef[] => {
  const configured = configuredChecks(config, kind, def)
  if (configured) return configured
  if (def.checks.length) return def.checks
  return discovered
}

/**
 * The stage's config-declared checks, or undefined when the user declared none.
 *
 * Separate from `checksFor` because PRESENT-but-empty is meaningful and an
 * empty array is not distinguishable from "nothing" once merged: `{ verify: [] }`
 * is the explicit "run nothing, and discover nothing" opt-out. Pure.
 */
export const configuredChecks = (config: Config, kind: string, def: StageDef): readonly CheckDef[] | undefined =>
  config.workflows[kind]?.stageChecks?.[def.name]

/**
 * Whether a check stage may take its commands from the approved plan: config
 * `workflows.<kind>.discoverChecks`, else the manifest stage's `discoverChecks`.
 * Config wins so a user can turn the channel off for a shipped manifest they
 * cannot edit — the same direction as `planVisualizationFor`. Pure.
 */
export const discoverChecksFor = (config: Config, kind: string, def: StageDef): boolean =>
  config.workflows[kind]?.discoverChecks ?? def.discoverChecks

/**
 * The bash globs a stage's own agent is actually judged against — the manifest's
 * list plus the platform's, plus `bashAllowlistExtra`, plus a
 * `<prefix> <glob>` twin per configured `bashAllowlistPrefix`. Pure.
 *
 * One composition, asked once, because the two places that need it are the
 * ENFORCEMENT seam (the Claude/Qwen stage marker, OpenCode's `config` hook) and
 * the REPORT that explains a refusal (`doctor`'s deny-log aggregate) — and a
 * report judged against a different list than the seam gives advice that cannot
 * work. That is precisely what it did: doctor omitted the prefix twins, so a
 * denial under a configured `bashAllowlistPrefix` was diagnosed as needing the
 * prefix the operator had already configured.
 *
 * The empty-base rule is load-bearing and not an optimization: a stage that
 * declares NO allowlist is unrestricted (engineering's plan/build write code
 * freely), and appending extras there would restrict it to just the extras.
 * `[]` therefore means "unrestricted", never "nothing is allowed" — a caller
 * reading it as a boundary is reading it wrong.
 */
export const stageBashGlobs = (def: StageDef, platform: string, config: unknown): string[] => {
  const base = effectiveAllowlist(def, platform)
  // `withCommandPrefixes` dedupes, so an extra already in the base is not repeated.
  return base.length ? withCommandPrefixes([...base, ...bashAllowlistExtras(config)], bashAllowlistPrefixes(config)) : []
}

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
 * Budget keys that name no artifact but are still honored by the engine:
 * `goal` clamps the task goal `promptContextWithStats` renders. Kept out of the
 * unknown-key warning below, or every legitimate `stage.goal` would read as a
 * typo.
 */
const RESERVED_CONTEXT_KEYS: ReadonlySet<string> = new Set(["goal"])

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
          .filter((artifact) => !stageNames.includes(artifact) && !RESERVED_CONTEXT_KEYS.has(artifact))
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
 * The fan-out strategy a stage runs under, discriminated: config
 * `workflows.<kind>.stageFanout.<stage>`, else the manifest stage's `fanout`,
 * else undefined (one unfocused pass). `"none"` in config turns a
 * manifest-declared fan-out off.
 *
 * Returns a TAGGED result rather than the raw value, because the two forms are
 * not interchangeable downstream: an axis fan-out can be enforced per pass and a
 * lens list cannot (`passAxes`). This used to return `"axis" | undefined`, and a
 * caller comparing `=== "axis"` would silently read a lens list as "no fan-out".
 * Pure.
 */
export type FanoutStrategy = { readonly mode: "axis" } | { readonly mode: "lens"; readonly lenses: readonly string[] }

export const fanoutFor = (config: Config, kind: string, def: StageDef): FanoutStrategy | undefined => {
  const strategy = config.workflows[kind]?.stageFanout?.[def.name] ?? def.fanout
  if (Array.isArray(strategy)) return strategy.length ? { mode: "lens", lenses: strategy } : undefined
  return strategy === "axis" ? { mode: "axis" } : undefined
}

/**
 * The stage's `requiredAxes` that no configured lens names — the axes that go
 * unreviewed once a stage's `stageFanout` is a lens list.
 *
 * Lens mode suppresses per-pass axis-coverage enforcement (a lens is told to
 * focus exclusively on its own angle, so demanding every axis from it would
 * reject every pass), which means choosing lenses over `"axis"` downgrades the
 * review's guarantees. This list is also the exact condition
 * `enforcesAxisCoverage` uses: empty ⇒ the lenses between them span the stage's
 * axes, so the stage-wide coverage check is satisfiable and stays on. Like
 * `unknownStageModelKeys`, it can't be checked at parse time — the manifest
 * isn't loaded yet — so hosts surface it as a warning once the kind's stages are
 * known, turning a silent downgrade into a message.
 *
 * That message is the whole reason this is worth computing. A ONE-entry lens
 * list is the shape most likely to be written by hand, and it is a coverage
 * REGRESSION rather than the enhancement it reads as: the default single pass is
 * admitted against all five axes, while `["security"]` is admitted against none.
 * Both installers used to offer exactly that, described as "extra REVIEW passes".
 *
 * Empty when the stage runs no lenses, when it requires no axes, or when the
 * lens list already names every required axis. Pure.
 */
export const unreviewedAxes = (config: Config, kind: string, def: StageDef): string[] => {
  const strategy = fanoutFor(config, kind, def)
  if (strategy?.mode !== "lens" || !def.requiredAxes?.length) return []
  const named = new Set(strategy.lenses.map((l) => l.trim().toLowerCase()))
  return def.requiredAxes.filter((axis) => !named.has(axis.trim().toLowerCase()))
}

/**
 * The focused passes a stage runs, in order — the single place both hosts ask
 * "how many times does this stage fire, and what is each pass told to cover?".
 *
 * One knob decides it now. `stageFanout.<stage>` is either `"axis"` (one pass
 * per `requiredAxes` entry), a list of focus strings (one pass each), or absent
 * (a single unfocused pass — byte-identical to having no fan-out at all).
 *
 * The global `reviewLenses` that used to outrank all of this is retired
 * (`RETIRED_CONFIG_KEYS`): it reached one stage of one kind, it beat a declared
 * fan-out, and nothing but a host warning said so. Pure.
 */
export const stagePasses = (config: Config, kind: string, def: StageDef): readonly StagePass[] => {
  const single: readonly StagePass[] = [{ focus: null, mode: "single" }]
  if (def.kind !== "check") return single
  const strategy = fanoutFor(config, kind, def)
  if (strategy?.mode === "lens") return strategy.lenses.map((focus) => ({ focus, mode: "lens" as const }))
  if (strategy?.mode === "axis" && def.requiredAxes?.length) {
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
 * maps to no axis at all, so it is unenforced. Pure.
 */
export const passAxes = (def: StageDef, pass: StagePass): readonly string[] | undefined =>
  pass.mode === "axis" && pass.focus ? [pass.focus] : pass.mode === "lens" ? undefined : def.requiredAxes

/**
 * Whether a stage's ACCUMULATED record must cover every `requiredAxes` entry
 * when the stage advances — the stage-wide guarantee that per-pass admission
 * cannot give once passes are focused, since each pass is only ever asked about
 * its own part.
 *
 * Three regimes, and the third is the point:
 *  - `single` — false. One pass is already admitted against every required axis,
 *    so the accumulated check would be the same test run twice.
 *  - `axis` — true. This is the guarantee fan-out exists to restore.
 *  - `lens` — true ONLY when the configured lenses between them name every
 *    required axis (`unreviewedAxes` empty).
 *
 * That condition is what makes the lens case honest rather than hostile. Lenses
 * are free text: a `["security", "test-adequacy"]` setup is never going to
 * report `readability`, and demanding it would ERROR every run — which is why
 * the enforcement is switched off for lenses wholesale, and why `requiredAxes`
 * then stopped being required at every level at once. Tying it to the lens list
 * gives the axes back to anyone whose lenses do span them, costs nothing to
 * anyone whose lenses don't (they keep the documented trade-off, and the host
 * warning already names the axes they are giving up), and needs no new config
 * surface to opt into. Pure.
 */
export const enforcesAxisCoverage = (config: Config, kind: string, def: StageDef): boolean => {
  if (!def.requiredAxes?.length) return false
  const passes = stagePasses(config, kind, def)
  if (passes.some((p) => p.mode === "axis")) return true
  if (!passes.some((p) => p.mode === "lens")) return false
  return unreviewedAxes(config, kind, def).length === 0
}

/**
 * The `stageFanout` keys that name no stage of `kind` — the same silent-default
 * trap `unknownStageModelKeys` closes: a typo'd stage name resolves to "no
 * fan-out" and reads as "the setting doesn't work". Not checkable at parse time
 * (the manifest isn't loaded yet), so hosts warn once the stages are known. Pure.
 */
export const unknownStageFanoutKeys = (config: Config, kind: string, stageNames: readonly string[]): string[] =>
  Object.keys(config.workflows[kind]?.stageFanout ?? {}).filter((name) => !stageNames.includes(name))

/**
 * How many of a stage's focused passes may be in flight at once: config
 * `workflows.<kind>.stageConcurrency.<stage>`, else the default for the passes
 * that actually run.
 *
 * That default is `passCount` for ANY fan-out — per-axis or lens — and 1 for a
 * stage that runs a single pass. A fan-out is a request for N focused passes
 * over one frozen work tree: they are read-only, each told to cover its own axis
 * or lens and not the others, and merged worst-wins, so serializing them buys
 * nothing and costs a five-pass review five reviews of latency. Turning the
 * fan-out on IS the request; making it parallel a second, separate knob meant
 * the feature shipped slow by default.
 *
 * Lens passes used to be carved out of that and left serial, so that a setup
 * predating the fan-out kept behaving exactly as it had. That carve-out went
 * with the key it protected: lenses are now a `stageFanout` value
 * (`RETIRED_CONFIG_KEYS`), so reaching them at all means writing the fan-out
 * knob afresh, and there is no older behavior left to preserve. One rule for
 * every focused pass beats two that differ only by history.
 *
 * An explicit `stageConcurrency` still wins, and now clamps as well as opts in:
 * `1` is how a rate-limited user takes a fanned-out stage back to one pass at a
 * time, so it must not read as "unset".
 *
 * Clamped to `passCount` because concurrency beyond the number of passes buys
 * nothing and would make the pool's own bookkeeping lie, and floored at 1 so a
 * stage always makes progress. A single-pass stage is therefore always 1,
 * whatever the config says. Pure.
 */
export const concurrencyFor = (config: Config, kind: string, def: StageDef, passCount: number): number => {
  // The passes' MODE, not `fanoutFor`: only a stage that actually runs focused
  // passes should inherit the parallel default.
  const fannedOut = stagePasses(config, kind, def).some((p) => p.mode !== "single")
  const configured = config.workflows[kind]?.stageConcurrency?.[def.name] ?? (fannedOut ? passCount : 1)
  return Math.max(1, Math.min(configured, passCount))
}

/**
 * The `stageConcurrency` keys that name no stage of `kind` — the same
 * silent-default trap `unknownStageFanoutKeys` closes, and a worse one to hit
 * here: a typo'd stage runs at the default concurrency instead, so the setting
 * reads as "it doesn't work" rather than "that stage does not exist" — whether
 * the user was opting a lens setup in or clamping a fan-out down. Pure.
 */
export const unknownStageConcurrencyKeys = (config: Config, kind: string, stageNames: readonly string[]): string[] =>
  Object.keys(config.workflows[kind]?.stageConcurrency ?? {}).filter((name) => !stageNames.includes(name))

/**
 * Stages this config asks to run concurrently — used by hosts that cannot honor
 * it, so the knob never silently does nothing.
 *
 * Only the OpenCode driver owns its pass loop and can run passes concurrently.
 * On the Claude/Qwen hosts the ORCHESTRATOR spawns the pass subagents while the
 * MCP server keeps one armed pass, one stage marker and one evidence ledger —
 * all three read by the PreToolUse/SubagentStop hooks — so a pass has no
 * identity to attribute a verdict, a marker or a tool call to. Pure.
 */
export const concurrentStages = (config: Config, kind: string, stageNames: readonly string[]): string[] =>
  Object.entries(config.workflows[kind]?.stageConcurrency ?? {})
    .filter(([name, n]) => stageNames.includes(name) && (n ?? 1) > 1)
    .map(([name]) => name)

/**
 * Build a tracker deep link from a task's `tracker.key` and the configured
 * `projectManagement.baseUrl` — the base URL with the key appended. Returns
 * undefined when no base URL is configured (link building is opt-in). Pure.
 */
export const trackerUrl = (pm: ProjectManagement | undefined, key: string): string | undefined =>
  pm?.baseUrl ? `${pm.baseUrl}${key}` : undefined

/** The default `tracker.system` for newly authored tasks, from the PM config. Pure. */
export const defaultTrackerSystem = (config: Config): TrackerSystem | undefined => config.projectManagement?.system

// `applyAdoPatEnv` used to live here: it exported `ado.pat` into
// `process.env.AZURE_DEVOPS_EXT_PAT` so child `curl` processes could
// authenticate. Nothing shells out to Azure DevOps any more — the PAT is handed
// only to the MCP server's own child env by `adoMcpSpawn` — so broadcasting the
// secret to every child process was pure exposure with no consumer. Deleted.

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
 * `adoMcpSpawn` resolves the PAT as `env AZURE_DEVOPS_EXT_PAT ?? ado.pat` and
 * hands it to the Azure DevOps MCP server it launches against
 * `ado.organization`. Because layers merge per key, a cloned repo supplying
 * only `organization` keeps the user's PAT underneath it — and
 * `pr-sitter`/`review-sitter` poll on the first watch tick, so nobody has to
 * run anything for the token to leave. `mcp` is dropped for the same reason
 * one step further along: it names the COMMAND that gets spawned, so a repo
 * that could set it could run anything with the token in its environment.
 *
 * `project`, `repository` and `selfLogin` are NOT here: they describe this repo
 * and nothing else, and dropping them would make the rule unusable rather than
 * safe. An ADO user who kept `organization` in their repo file gets a loud
 * warning naming the move; the section is experimental and says so.
 */
// `mcp` names the command that gets SPAWNED, so a cloned repo must not be able
// to choose it — that would be arbitrary code execution from a config file.
const ADO_USER_LAYER_ONLY_KEYS = ["organization", "pat", "mcp"] as const

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
  const merged = mergeConfigLayers(userRaw ?? {}, repoRaw ?? {})
  // A retired top-level key is INVISIBLE after this line — zod strips what the
  // schema does not declare — so it is named here, against the raw merged layer,
  // while the value still exists. Warned rather than rejected so an in-flight
  // loop keeps running, exactly like `deprecatedAdoKeys`.
  for (const { key, replacement } of retiredConfigKeys(merged)) {
    await client.app
      .log({
        body: {
          service: "agentic-workflow",
          level: "warn",
          message: `${label} sets "${key}", which no longer exists — it is ignored. Instead: ${replacement}.`,
        },
      })
      .catch(() => {
        /* the load matters, the warning is best-effort */
      })
  }
  const parsed = parseConfigWith(schema, merged, label)
  // Config that can never take effect gets its diagnostic at load: an opt-in
  // kind's section without `enabled` — a typo'd `"enable": true` included —
  // otherwise leaves the sitter off with the config file claiming otherwise
  // and no surface anywhere saying so.
  const sections = (parsed as { workflows?: Record<string, { enabled?: boolean }> }).workflows
  if (sections) {
    for (const kind of unenabledConfiguredKinds({ workflows: sections })) {
      await client.app
        .log({
          body: {
            service: "agentic-workflow",
            level: "warn",
            message:
              `${label} configures "workflows.${kind}" without "enabled" — that kind is opt-in, so its section takes no effect. ` +
              `Add "enabled": true to run it (or "enabled": false to park the section and silence this).`,
          },
        })
        .catch(() => {
          /* the load matters, the warning is best-effort */
        })
    }
  }
  return parsed
}

/** Load config (user layer under repo layer), falling back to defaults when both files are absent. */
export const loadConfig = (client: Client, directory: string, opts?: LoadConfigOptions): Promise<Config> =>
  loadConfigWith(ConfigSchema, client, directory, opts)
