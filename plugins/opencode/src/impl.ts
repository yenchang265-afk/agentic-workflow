import type { Plugin } from "@opencode-ai/plugin"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"
import { DEFAULT_CONFIG, loadConfig } from "./config.ts"
import {
  CD_TWIN_PREFIX,
  agentModel,
  bashAllowlistExtras,
  bashAllowlistPrefixes,
  enabledWorkflowKinds,
  ignoredUserConfigPaths,
  readRawConfigLayers,
  resolveUserConfigPath,
  unknownAgentModelKeys,
  withCdTwins,
  withCommandPrefixes,
  worktreesDirFor,
} from "@agentic-workflow/core/config"
import type { Config } from "./config.ts"
import * as driver from "./workflow/driver.ts"
import { failurePrompt, overrideCommandPrompt, readCommandPrompt, refusalPrompt } from "./command-prompt.ts"
import { neutralizeArgumentMarkers, sliceCommandPrompt } from "./command-slice.ts"
import { splitVerb } from "./verb.ts"
import { listWorktrees, pruneWorktrees } from "@agentic-workflow/core/workflow/git"
import { listSnapshotIds } from "@agentic-workflow/core/workflow/persist"
import { anyWorkflowActive, anyWorktreeWorkflowActive, findSessionDriving, getWorkflow, hasWorkflow, planStageTaskId } from "@agentic-workflow/core/workflow/state"
import { auditBacklog, formatAnomalies } from "@agentic-workflow/core/task/audit"
import { classifyBash, classifyEdit } from "@agentic-workflow/core/task/guard"
import { pinBash, pinEditPath } from "@agentic-workflow/core/workflow/worktree-guard"
import { effectivePlatformTools, stageDef } from "@agentic-workflow/core/manifest/schema"
import { chainedFindMutation, chainedGithubPrMutation, chainedGitPushViolation, isAdoMcpTool, isAdoMcpToolOutOfStageScope, isAdoMcpWriteViolation } from "@agentic-workflow/core/task/write-backstop"
import { staleClaimMinutes } from "@agentic-workflow/core/claim-marker"
import { findByIdIn, isOrphanedPlanClaim, listClaimIds, listInProgress, listQueued, releaseOrphanedClaims, wasInterrupted } from "@agentic-workflow/core/task/store"

/** Tools that write files — guarded to the worktree while a worktree-mode loop drives. */
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"])
/**
 * Inspection tools whose target path counts as check-stage evidence
 * (@agentic-workflow/core/workflow/evidence). Read-only by construction — a
 * write tool's path is not evidence of having *looked* at anything.
 */
const READ_TOOLS = new Set(["read", "grep", "glob", "list"])
/**
 * OpenCode's structured ask (the TUI question dialog). Two things key off it and
 * must never disagree about what a question is: the refusal for any session a
 * loop is driving, and the record of a window opening/closing that the gate's
 * "plan it now?" enforcement runs on — hence one predicate rather than two
 * comparisons. See `tool.execute.before` / `tool.execute.after`.
 */
const isQuestionTool = (tool: string): boolean => tool === "question"
/**
 * Where a read tool carries its path, in probe order. Paths only — grep's
 * `pattern` is deliberately absent: a regex is not a path, and admitting one
 * would let an arbitrary search string corroborate a cited file by name.
 */
const READ_PATH_KEYS = ["filePath", "path"]

/**
 * The agent a verb spawns OUTSIDE the loop. `new` step 4 and `retask` step 4
 * invoke `workflow-task-author` to write draft files before any loop exists, so
 * there is no StageDef for `modelFor` to resolve and no stage fire to carry a
 * model — `agentModels` is the only source. `plan` is deliberately absent: its
 * spawn IS the PLAN stage, already governed by `stageModels.plan`, and it runs a
 * different agent (`workflow-plan-author`) for exactly that reason.
 */
const VERB_DRAFT_AGENT: Record<string, string> = { new: "workflow-task-author", retask: "workflow-task-author" }

/**
 * The line appended to a sliced command body naming the drafting model, or null
 * when nothing is configured (so a default install pays no tokens for the knob).
 *
 * Unlike a stage, this host cannot pass the model as a real parameter here: the
 * draft author is invoked by the model reading the command body, not by
 * `session.command`. Prose is the only channel — the same one the Claude host
 * uses throughout. Kept pure for impl.test.ts.
 */
export const draftModelNote = (config: Config, kind: string, verb: string): string | null => {
  if (kind !== "engineering") return null
  const agent = VERB_DRAFT_AGENT[verb]
  const model = agent ? agentModel(config, agent) : undefined
  return model
    ? `Invoke the \`${agent}\` subagent with the model \`${model}\` (config \`agentModels\`). ` +
        "This covers the drafting invocation only — a PLAN stage runs on `stageModels.plan`."
    : null
}

/**
 * The `agent.<name>.model` bindings `agentModels` implies.
 *
 * `agentModels` ONLY — deliberately no stage-derived inheritance. A stage fire
 * already carries its model as a real parameter (`session.command({ model })`),
 * so inheriting here would both duplicate that and re-open the cross-kind
 * ambiguity `resolveAgentModels` reports (`workflow-verify` backs a stage in
 * four kinds).
 *
 * The provider prefix is KEPT: opencode takes real `provider/model` ids, unlike
 * Claude Code's spawn tool (an alias enum) or Qwen's frontmatter (bare ids).
 *
 * Takes the RAW config rather than a parsed one because its caller is the
 * `config` hook, which runs during bootstrap where `loadConfig` cannot go. Pure.
 */
export const agentModelPatch = (raw: unknown): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {}
  if (typeof raw !== "object" || raw === null) return out
  const models = (raw as { agentModels?: unknown }).agentModels
  if (typeof models !== "object" || models === null || Array.isArray(models)) return out
  for (const [agent, model] of Object.entries(models as Record<string, unknown>)) {
    if (typeof model === "string" && model.trim()) out[agent] = model.trim()
  }
  return out
}

/**
 * Agents spawned OUTSIDE any stage, so no manifest names them and no StageDef
 * exists for `modelFor` to resolve — `agentModels` is their only source. Used to
 * tell a typo'd key from a legitimate one.
 */
const NON_STAGE_AGENTS = ["workflow-task-author", "workflow-plan"] as const

/** Every agent `agentModels` may legitimately name, across the enabled kinds. */
const knownAgentNames = (config: Config): string[] => {
  const names = new Set<string>(NON_STAGE_AGENTS)
  for (const kind of enabledWorkflowKinds(config)) {
    try {
      for (const def of driver.manifestFor(kind).manifest.stages) if (def.agent) names.add(def.agent)
    } catch {
      /* an unloadable kind is reported elsewhere */
    }
  }
  return [...names]
}

/** The slice of opencode's Config this plugin ever touches. */
interface AgentModelConfig {
  agent?: Record<string, { model?: string; permission?: { bash?: unknown } } | undefined>
}

/**
 * Apply the patch to a resolved opencode config IN PLACE, returning the agents
 * actually bound. `Hooks.config` returns void, so mutation is the only channel.
 *
 * The only keys ever written are `agent.<name>.model` (here) and
 * `agent.<name>.permission.bash.<glob>` (`applyBashAllowlistConfig` below) — a
 * new write anywhere else in the config needs the same one-key surgical shape.
 * A user's own `opencode.json` entry for an agent we do not name survives
 * untouched — and one we DO name loses, because naming it in `agentModels` is
 * the more specific, more recent instruction. Whole `AgentConfig` objects are
 * never replaced, so a user's `permission`/`tools`/`temperature` for that
 * agent are preserved. Pure apart from the mutation.
 */
export const applyAgentModels = (config: AgentModelConfig, patch: Readonly<Record<string, string>>): string[] => {
  const names = Object.keys(patch)
  if (names.length === 0) return []
  config.agent ??= {}
  const bound: string[] = []
  for (const name of names) {
    const existing = config.agent[name]
    const model = patch[name]!
    if (existing) existing.model = model
    else config.agent[name] = { model }
    bound.push(name)
  }
  return bound
}

/**
 * Append the user's `bashAllowlistExtra` globs — and the `bashAllowlistPrefix`
 * derivations of everything the agent already grants — to every sentinel-guarded
 * agent's bash permission map IN PLACE, returning the agents extended.
 *
 * OpenCode evaluates permissions LAST-match-wins over the map in key order, so
 * where a rule lands is what it means: the generated frontmatter puts the
 * `"*": deny` sentinel first and the manifest allows after it, and a key added
 * to the merged config here appends at the END of that map — after the
 * sentinel, which is the only position where an extra glob actually wins.
 * (Verified against the live host: a hand-written `opencode.json` agent entry
 * also lands after the frontmatter's rules; this hook's write lands last of
 * all.) Why extras exist at all: a command-rewriting proxy (rtk-style) mutates
 * the command in `tool.execute.before` BEFORE the host evaluates permissions,
 * so every allowlisted command reaches the matcher in a shape (`rtk <cmd>`) no
 * shipped glob matches and the stage starves into ERROR.
 *
 * Scope is by SHAPE, not by roster: only a map-shaped bash permission whose
 * first-listed rule is the `"*": deny` sentinel is touched. That reaches every
 * sentinel-guarded stage agent of every kind (hub-scaffolded checkers
 * included) without a bootstrap manifest read, and deliberately skips
 * `bash: allow` (build — extras are a no-op) and `bash: deny` (plan — extras
 * would widen a total denial that is the stage's contract). Worktree `cd * && `
 * twins are derived exactly when the map already carries twins: their presence
 * is the generated frontmatter's own record that the stage runs worktree-pinned.
 * An extra whose key already exists is left alone — an explicit user value,
 * even a deny, is not ours to flip.
 *
 * The PREFIX half needs no manifest either, for the same reason: the map's own
 * `allow` keys ARE this stage's declared allowlist, so deriving from them gives
 * per-stage precision for free — a user-added kind's agent included. `rtk npm
 * test` is admitted for a stage granted `npm test*`, and `rtk npm publish` still
 * is not, which is the whole difference from a blanket `"rtk *"` extra. The
 * sentinel and existing `cd * && ` keys are skipped as sources (`withCommandPrefixes`),
 * and extras are prefixed too — a project's own runner is as rewritten as a
 * shipped one.
 */
export const applyBashAllowlistConfig = (
  config: AgentModelConfig,
  extras: readonly string[],
  prefixes: readonly string[] = [],
): string[] => {
  if (extras.length === 0 && prefixes.length === 0) return []
  const extended: string[] = []
  for (const [name, agent] of Object.entries(config.agent ?? {})) {
    const bash = agent?.permission?.bash
    if (typeof bash !== "object" || bash === null || Array.isArray(bash)) continue
    const map = bash as Record<string, unknown>
    if (map["*"] !== "deny") continue
    const wantsTwins = Object.keys(map).some((key) => key.startsWith(CD_TWIN_PREFIX))
    const granted = Object.entries(map)
      .filter(([key, value]) => key !== "*" && value === "allow")
      .map(([key]) => key)
    // Filtered against the map BEFORE twinning: a granted key is only a
    // derivation source, so its own (already present) twin is never re-derived.
    const additions = withCommandPrefixes([...granted, ...extras], prefixes).filter((glob) => !(glob in map))
    const globs = wantsTwins ? withCdTwins(additions) : additions
    let touched = false
    for (const glob of globs) {
      if (glob in map) continue
      map[glob] = "allow"
      touched = true
    }
    if (touched) extended.push(name)
  }
  return extended.sort()
}

/**
 * agentic-workflow
 *
 * opencode plugin that executes approved plans as an automatic loop:
 *
 *   build → verify → review
 *
 * One command per workflow kind: `/agentic-workflow:engineering` carries the backlog
 * lifecycle — `new <idea>` interviews the user into a draft, the deterministic
 * unified `approve <id>` parks it planless in `queued/`, the loop plans right
 * before execution (a claimed queued task runs the PLAN stage, writes its
 * `## Implementation Plan`, and parks in `plan-review/`), `approve <id>`
 * again releases it to `in-progress/`, the build-ready queue. `plan <id>`
 * plans one approved task now; `claim` pulls the next item once; `watch
 * [interval]` polls for work — on every `session.idle` event plus a
 * per-session interval timer. Other kinds (`/agentic-workflow:pr-sitter`) get the
 * minimal watcher verb set, scoped to their kind. A verify or review FAIL re-builds within the
 * iteration cap. The control surface lives in `workflow/driver.ts`; the pure
 * state machine in `workflow/state.ts`.
 *
 * This module transitively imports `@agentic-workflow/core`'s built `dist/`, so
 * it is loaded DYNAMICALLY by the plugin entry (`index.ts`) — a stale or
 * missing core build must surface as the entry's fail-loud fallback, not
 * kill the whole plugin silently at import time.
 */
// How long a client call on a hook path may run before the hook gives up on
// it. opencode's Plugin.trigger awaits every hook with NO try/catch, and the
// SDK's fetch disables its own timeout (`req.timeout = false`) — so an await
// that rejects OR never settles kills the whole command BEFORE Session.prompt,
// silently: no turn, no error, no log line. The user's command just vanishes
// and a retry "works". Every await a hook performs must therefore be guarded
// and, where it can hang (any client call), time-boxed.
const CONFIG_READ_TIMEOUT_MS = 10_000
const LOG_TIMEOUT_MS = 5_000
const RECONCILE_TIMEOUT_MS = 30_000

/**
 * Whether this verb's task-file move runs BEFORE the startup reconcile rather
 * than after it — see the call site for why the order is load-bearing.
 *
 * Exported as a predicate rather than left inline because the membership IS the
 * rule: a verb that moves a task deterministically and does not depend on the
 * sweep belongs here, and one dropped from the list fails the way the original
 * bug did — the move lands after opencode's command-hook window, so on the first
 * command of a session the model reads pre-move state and a retry "fixes" it.
 */
export const gateMovesFirst = (kind: string, verb: string): boolean => kind === "engineering" && ["approve", "replan", "retask"].includes(verb)

/**
 * Reject with a timeout error when `promise` takes longer than `ms`; settle
 * with it otherwise. Never cancels: the abandoned promise finishes in the
 * background (its handlers are attached here, so a late rejection is not an
 * unhandled one) — safe for the callers in this module, which each tolerate
 * late completion (see call sites).
 */
/**
 * Deadlines for the model-callable tools. OpenCode imposes NONE of its own: a
 * tool whose `execute` never settles leaves the tool call `running` forever and
 * the model's turn wedged behind it, which is exactly how a `workflow_gate` on
 * an approved draft became an unrecoverable spinner. Every tool here must
 * therefore answer — in words the model can act on, or with a throw it can
 * retry on, but never with silence.
 *
 * The gate tools get the longer cap because they do the shell work; their `$` is
 * separately capped lower (`GATE_SHELL_TIMEOUT_MS`), so in the failure this was
 * built for the shell bound fires first and the gate still reports what it did.
 * This is the backstop for everything else — above all the `client.session.get`
 * walk `workflow_verdict`/`workflow_blocked` make, which is a fetch back into
 * the server with no timeout of its own.
 */
const GATE_TOOL_TIMEOUT_MS = 90_000
const VERDICT_TOOL_TIMEOUT_MS = 30_000

/** Distinguishes "the deadline passed" from any value a tool could return. */
const TIMED_OUT = Symbol("timed-out")

/**
 * Resolve `promise`, or `TIMED_OUT` once `ms` passes. Rejections propagate
 * unchanged — a tool that deliberately throws (a rejected verdict) must keep
 * throwing. Nothing is cancelled; the abandoned promise keeps a handler so a
 * late rejection is never unhandled.
 */
const withinDeadline = <T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err as Error)
      },
    )
  })

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })

export const makeAgenticWorkflow: Plugin = async ({ client, directory, $ }) => {
  const service = "agentic-workflow"

  // Total: never rejects, never hangs. This is also `deps.log`, so every await
  // on it across the driver inherits the guarantee — a logger that can take
  // its awaiter down turns every error handler into a second failure point
  // (the handler reports over the same broken channel that just failed).
  const log = (level: "info" | "warn" | "error", message: string): Promise<void> =>
    withTimeout(Promise.resolve(client.app.log({ body: { service, level, message } })), LOG_TIMEOUT_MS, "app.log").then(
      () => undefined,
      () => undefined,
    )

  // Everything the driver needs from the host, bundled once. `$` (Bun shell) is
  // used to move task files between status folders.
  const deps: driver.Deps = { client, $, directory, log }

  // Load loop config lazily, on the first hook invocation. The plugin
  // initializer runs inside opencode's instance bootstrap, and any `client`
  // call made from it (file.read, app.log, …) is a request back into the same
  // still-bootstrapping instance — a circular wait that hangs opencode startup
  // forever. Hooks only fire after bootstrap completes, so client calls are
  // safe there. Fall back to the last good config (and warn) on misconfig so a
  // bad config file degrades rather than breaking the plugin entirely.
  let configPromise: Promise<Config> | undefined
  let lastGood: Config | undefined
  const readConfig = async (): Promise<Config> => {
    let config: Config
    try {
      // Time-boxed: this runs on every command's hook path, and a stalled
      // server turns an untimed read into a silently killed command (see
      // withTimeout). A timeout lands in the catch below — degraded config,
      // working command. A late completion only resolves an abandoned promise.
      config = await withTimeout(loadConfig(client, directory), CONFIG_READ_TIMEOUT_MS, ".agentic-workflow.json read")
      lastGood = config
    } catch (err) {
      // A rejected config silently downgrading to defaults surfaces later as
      // "the kind I enabled is unknown", with the only clue buried in
      // opencode's log file. Toast it: the cause is one bad key, and the human
      // has no other way to connect the two. Fire-and-forget: a toast is a
      // client call too, and awaiting one on this path re-opens the hang the
      // timeout above just closed.
      const message = `agentic-workflow: ignoring .agentic-workflow.json — ${(err as Error).message}`
      await log("warn", message)
      void client.tui.showToast({ body: { message, variant: "error" } }).catch(() => {})
      config = lastGood ?? DEFAULT_CONFIG
    }
    // Both are best-effort REPORTING, and both do filesystem work and client
    // calls — so neither may decide whether this function resolves. They sat
    // outside the try, and `getConfig` caches the promise: one rejection here
    // (an EACCES resolving the user-scope path, say) was cached for the life of
    // the process, and `tool.execute.before` awaits it for EVERY tool in EVERY
    // session — so every read, bash and edit in the whole instance was denied
    // with a config-read error until restart.
    try {
      await warnIgnoredUserConfigOnce()
      await reportAgentModelsOnce(config)
    } catch (err) {
      await log("warn", `agentic-workflow: config reporting failed (the config itself is fine): ${(err as Error).message}`)
    }
    return config
  }

  // Only ONE user-scope file is ever read, so a second one is dead weight that
  // looks live — its settings just never apply, which reads as "the feature is
  // broken", not "the file is ignored". Core logs it; the log file is not where
  // someone chasing this looks, so toast it too. Once per session: the cause is
  // a stale file on disk, and repeating it on every command is noise.
  // Agents the `config` hook bound a model for. That hook runs during bootstrap
  // and cannot log or toast (any client call there is the circular wait), so it
  // parks the result and the first command reports it. Without this the user has
  // no way to tell whether the binding took — the failure mode the whole change
  // exists to remove.
  let agentModelsBound: string[] = []
  let allowlistExtrasBound: string[] = []
  // `bashAllowlistPrefix`, parked by the same bootstrap hook. The bash guard
  // needs it to strip a rewriting proxy's prefix before the write backstops
  // classify a segment; empty (an unset key, or a `config` hook that threw)
  // leaves those checks exactly as they were.
  let commandPrefixes: readonly string[] = []
  // Bound from config alongside `commandPrefixes`, and for the same reason: the
  // bash guard runs in `tool.execute.before`, which has no config to read. Empty
  // leaves the write backstop on its permanent main/master/HEAD floor.
  let protectedBranches: readonly string[] = []
  let reportedAgentModels = false
  const reportAgentModelsOnce = async (config: Config): Promise<void> => {
    if (reportedAgentModels) return
    reportedAgentModels = true
    if (agentModelsBound.length) {
      await log("info", `agentic-workflow: agentModels bound ${agentModelsBound.join(", ")} (takes effect until opencode restarts)`)
    }
    if (allowlistExtrasBound.length) {
      await log(
        "info",
        `agentic-workflow: bash allowlist config (extras${commandPrefixes.length ? `, prefixes ${commandPrefixes.join(", ")}` : ""}) ` +
          `appended to ${allowlistExtrasBound.join(", ")} (takes effect until opencode restarts)`,
      )
    }
    const unknown = unknownAgentModelKeys(config, knownAgentNames(config))
    if (unknown.length === 0) return
    void client.tui
      .showToast({
        body: {
          message:
            `agentic-workflow: agentModels names ${unknown.map((k) => `"${k}"`).join(", ")}, which ` +
            `${unknown.length > 1 ? "are" : "is"} not an agent this plugin ships — ` +
            `${unknown.length > 1 ? "those entries bind" : "that entry binds"} nothing.`,
          variant: "warning",
        },
      })
      .catch(() => {})
  }

  let warnedIgnoredUserConfig = false
  const warnIgnoredUserConfigOnce = async (): Promise<void> => {
    if (warnedIgnoredUserConfig) return
    // Flag first, unconditionally: the check is a one-shot, not "retry until
    // it warns" — leaving the flag unset when nothing is ignored re-ran the
    // filesystem resolution on every command, on the hook path where any
    // throw kills the command (see withTimeout).
    warnedIgnoredUserConfig = true
    const inEffect = resolveUserConfigPath()
    const ignored = ignoredUserConfigPaths(inEffect)
    if (ignored.length === 0) return
    void client.tui
      .showToast({
        body: {
          message: `agentic-workflow: ${ignored.join(" and ")} ${ignored.length > 1 ? "are" : "is"} NOT being read — the user-scope config in effect is ${inEffect}. Only one user-scope file loads; move your settings there.`,
          variant: "warning",
        },
      })
      .catch(() => {})
  }
  // The cache holds a PROMISE, so a rejected one would be cached too — and the
  // tool guard awaits it unconditionally for every tool in every session, loop
  // or not. Drop it on rejection so the next call re-reads instead of denying
  // the whole instance's tooling until opencode restarts.
  const getConfig = (): Promise<Config> =>
    (configPromise ??= readConfig().catch((err: unknown) => {
      configPromise = undefined
      throw err
    }))

  // Re-read the config for a user-typed command. The cache above lives for the
  // whole opencode instance and nothing invalidates it, so enabling a workflow
  // kind mid-session left its command rejected as "unknown kind" until a
  // restart — with the toast naming the kind, not the staleness. Commands are
  // human-paced, so one file read per command is cheap; the session.idle path
  // keeps the cache, since it fires far too often to pay this.
  const refreshConfig = (): Promise<Config> => (configPromise = readConfig())

  // Startup reconciliation runs on the FIRST hook, not during plugin init — any
  // `client` call from the initializer is a circular wait into the still-
  // bootstrapping instance and hangs opencode (same reason config loads lazily
  // above). Guarded to run exactly once.
  let reconciled = false
  const reconcileOnce = async (): Promise<void> => {
    if (reconciled) return
    reconciled = true
    const config = await getConfig()
    // A restart mid-BUILD leaves a task in in-progress/ with an unmatched
    // "BUILD started" note that no watcher will ever claim — surface those, plus
    // any leftover state snapshot (the strongest "this died mid-run" signal;
    // the recover verb resumes it at the exact stage).
    try {
      const tasks = await listInProgress(client, directory, config.tasksDir, log)
      const interrupted = tasks.filter(wasInterrupted).map((t) => t.id)
      if (interrupted.length) {
        await log(
          "warn",
          `interrupted loop task(s) in ${config.tasksDir}/in-progress: ${interrupted.join(", ")} — run /agentic-workflow:engineering recover <id> to resume`,
        )
      }
      const snapshots = await listSnapshotIds(client, directory, config.tasksDir)
      if (snapshots.length) {
        await log(
          "warn",
          `loop state snapshot(s) present: ${snapshots.join(", ")} — /agentic-workflow:engineering recover <id> resumes at the exact stage`,
        )
      }
      // Claim-marker sweep: a run that died between claiming and its first
      // "BUILD started" note leaves a marker that silently blocks every future
      // watch claim of that task. Release the stale ones; keep anything a live
      // loop drives or that may still be inside the claim→BUILD window.
      const claimIds = await listClaimIds($, directory, config.tasksDir)
      if (claimIds.length) {
        const released = await releaseOrphanedClaims($, tasks, claimIds, path.join(directory, config.tasksDir, "in-progress"), {
          isDriving: (id) => findSessionDriving(id) !== undefined,
          staleMinutes: staleClaimMinutes(config.stageTimeoutMinutes),
        })
        if (released.length) {
          await log(
            "warn",
            `released orphaned claim marker(s): ${released.join(", ")} — a prior run died before BUILD started; watch will re-claim`,
          )
        }
        const stillHeld = claimIds.filter((id) => !released.includes(id))
        if (stillHeld.length) await log("info", `claim marker(s) held: ${stillHeld.join(", ")}`)
      }
      // Same sweep for queued/ — a run that died mid-PLAN leaves a marker that
      // blocks every future plan claim of that task. PLAN writes no code, so a
      // stale, undriven marker is always safe to release.
      const planClaimIds = await listClaimIds($, directory, config.tasksDir, "queued")
      if (planClaimIds.length) {
        const queued = await listQueued(client, directory, config.tasksDir, log)
        const released = await releaseOrphanedClaims($, queued, planClaimIds, path.join(directory, config.tasksDir, "queued"), {
          isDriving: (id) => findSessionDriving(id) !== undefined,
          isOrphaned: isOrphanedPlanClaim,
          // PLAN writes nothing durable until it parks, so its whole runtime
          // must fit inside the window — see staleClaimMinutes.
          staleMinutes: staleClaimMinutes(config.stageTimeoutMinutes),
        })
        if (released.length) {
          await log("warn", `released orphaned plan-claim marker(s): ${released.join(", ")} — a prior run died mid-PLAN; watch will re-claim`)
        }
      }
      // Structural anomaly sweep: stray folders, task files outside every
      // status folder, duplicate ids — damage a confused agent can cause.
      // Report-only here; the doctor verb repairs.
      const anomalies = await auditBacklog(client, directory, config.tasksDir)
      for (const line of formatAnomalies(anomalies, config.tasksDir)) {
        await log("warn", `backlog anomaly: ${line} — /agentic-workflow:engineering doctor reports and repairs`)
      }
    } catch (err) {
      await log("warn", `startup task reconciliation failed: ${(err as Error).message}`)
    }

    // Worktree reconciliation: prune vanished registrations, then surface the
    // surviving loop worktrees. A worktree whose task is still in-progress or
    // in-review is the NORMAL post-run state (kept until the ship gate releases
    // it) — only one with no such task is worth a warning. Never auto-delete
    // (another process may own it; a crashed diff is evidence).
    const worktreesDir = worktreesDirFor(config, "engineering")
    if (worktreesDir) {
      try {
        await pruneWorktrees($, directory)
        const root = path.resolve(directory, worktreesDir)
        const kept = (await listWorktrees($, directory)).filter((w) => w.path.startsWith(root))
        for (const w of kept) {
          const id = path.basename(w.path)
          const active =
            (await findByIdIn($, directory, config.tasksDir, "in-progress", id)) ??
            (await findByIdIn($, directory, config.tasksDir, "in-review", id))
          if (active) {
            await log("info", `loop worktree ${w.path} (branch ${w.branch ?? "?"}) kept for task ${id} — released when it ships`)
          } else {
            await log(
              "warn",
              `stale loop worktree ${w.path} (branch ${w.branch ?? "?"}) — no in-progress/in-review task ${id}; /agentic-workflow:engineering recover will reuse it, or 'git worktree remove' it`,
            )
          }
        }
      } catch (err) {
        await log("warn", `worktree reconciliation failed: ${(err as Error).message}`)
      }
    }
  }

  // reconcileOnce for the command hook: time-boxed and contained. A hung sweep
  // (git/fs over a slow mount) must not swallow the command, and a failed one
  // must not discard a gate move that already succeeded — the sweep is
  // maintenance, not part of the verb's work. On timeout the abandoned sweep
  // finishes in the background; that overlap is safe: `reconciled` is already
  // set (no second sweep), and releaseOrphanedClaims frees markers only after
  // releaseMarkerIfStale re-judges staleness atomically, so a claim the verb
  // places while the sweep drains survives it.
  const reconcileTimely = async (): Promise<void> => {
    try {
      await withTimeout(reconcileOnce(), RECONCILE_TIMEOUT_MS, "startup reconciliation")
    } catch (err) {
      const message = `agentic-workflow: startup reconciliation failed — ${(err as Error).message}; run "doctor" to audit the backlog`
      await log("warn", message)
      void client.tui.showToast({ body: { message, variant: "warning" } }).catch(() => {})
    }
  }

  /**
   * The Azure DevOps MCP tools the loop's CURRENT stage may call, from its
   * manifest. Resolved per call rather than cached: a loop advances stages
   * in place, and a cached list would hand the next stage this one's budget.
   */
  const adoStageTools = (state: { kind?: string; stage: string }): string[] => {
    try {
      const loaded = driver.manifestFor(state.kind ?? "engineering")
      return effectivePlatformTools(stageDef(loaded.manifest, state.stage), "ado")
    } catch {
      // An unreadable manifest must not open the gate: no manifest, no tools.
      return []
    }
  }

  /** Whether the loop's current stage is a check stage (VERIFY/REVIEW-shaped, read-only). */
  const stageIsCheck = (state: { kind?: string; stage: string }): boolean => {
    try {
      const loaded = driver.manifestFor(state.kind ?? "engineering")
      return stageDef(loaded.manifest, state.stage).kind === "check"
    } catch {
      // An unreadable manifest never started a loop; nothing to gate.
      return false
    }
  }

  return {
    /**
     * Bind `agentModels` as a real opencode setting rather than as prose.
     *
     * The drafting author and the ad-hoc planner are spawned by the MODEL
     * reading a command body, not by the driver, so `session.command({ model })`
     * — the deterministic channel every stage fire uses — is out of reach for
     * them. Setting the agent's default model here reaches them anyway, and
     * without asking the model to cooperate.
     *
     * Reads the config layers off disk instead of `getConfig()`: this hook IS
     * opencode's bootstrap, and any `client` call from here is a request back
     * into the still-bootstrapping instance — the circular wait documented on
     * `readConfig` above. `readRawConfigLayers` is fs-only and never throws.
     *
     * Consequence worth knowing: this runs ONCE per instance, so an
     * `agentModels` change needs an opencode restart to take effect. The prose
     * it replaces was re-read per command.
     */
    config: async (input) => {
      try {
        const raw = readRawConfigLayers(directory)
        agentModelsBound = applyAgentModels(input as AgentModelConfig, agentModelPatch(raw))
        // Same seam, same timing constraint: `bashAllowlistExtra` and the
        // `bashAllowlistPrefix` derivations must land in the merged config's
        // agent permission maps AFTER the frontmatter's rules (last-match-wins),
        // and this hook is the only writer that appends there. See
        // applyBashAllowlistConfig.
        commandPrefixes = bashAllowlistPrefixes(raw)
        protectedBranches = Array.isArray(raw.protectedBranches) ? (raw.protectedBranches as readonly string[]) : []
        allowlistExtrasBound = applyBashAllowlistConfig(input as AgentModelConfig, bashAllowlistExtras(raw), commandPrefixes)
      } catch {
        /* a convenience binding must never break bootstrap */
      }
    },

    // Clear watch polling timers on plugin teardown so a reload doesn't leak
    // intervals firing into a dead instance.
    dispose: async () => {
      driver.disposeWatch()
    },

    event: async ({ event }) => {
      // Contained: opencode awaits event hooks the same unguarded way it does
      // command hooks (see withTimeout), so a rejection escaping here is an
      // unhandled one with zero log output. Nothing on this path may reject.
      try {
        // A user interrupt (ESC) surfaces as a MessageAbortedError, not a dedicated
        // event — route it to onInterrupt so watch mode stops and the loop halts
        // instead of the trailing session.idle re-claiming work. No reconcileOnce:
        // it's pointless here and would delay the critical synchronous unwatch.
        const interruptedSid = driver.abortedSessionID(event)
        if (interruptedSid) return void (await driver.onInterrupt(deps, interruptedSid))
        // A question opening or settling. The plugin cannot ORIGINATE one, but
        // these events are how it learns the model put a gate follow-up to the
        // human — and how it knows not to hand the session to a drive while a
        // window is up. Recorded before the idle handling below, never instead of
        // it: the two event kinds are disjoint.
        if (driver.noteQuestionEvent(event)) return
        if (event.type !== "session.idle") return
        await reconcileTimely()
        const { sessionID } = event.properties
        const config = await getConfig()
        // Do NOT await the drive. `onIdle` is the entry to the whole
        // build → verify → review chain (stageTimeoutMinutes defaults to 60,
        // maxIterations to 3), so awaiting it here parks this event handler for
        // hours — and the ESC path above lives in the same handler, i.e. the one
        // event that must get through while a loop runs was queued behind it.
        //
        // Safe against re-entrancy: `onIdle` reaches `driving.add(sessionID)` with
        // no intervening await, so the idle events the drive's own stage commands
        // generate still short-circuit on `driving.has`.
        void driver.onIdle(deps, sessionID, config).catch(async (err: unknown) => {
          await log("error", `idle drive failed for ${sessionID}: ${(err as Error).message}`)
        })
      } catch (err) {
        await log("error", `event hook failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },

    "command.execute.before": async (input, output) => {
      // One command per workflow kind: /agentic-workflow:engineering, /agentic-workflow:pr-sitter, …
      const match = /^agentic-workflow:(.+)$/.exec(input.command)
      if (!match) return
      const kind = match[1]!
      // ONE try around everything after the prefix match. opencode's
      // Plugin.trigger awaits this hook with no try/catch of its own (see
      // withTimeout), so any rejection that escapes — the config refresh, the
      // kind check, the slice, the dispatch — kills the command before
      // Session.prompt with zero log output: the user's command vanishes and
      // the retry "works" (the one-shot guards it tripped over are now set).
      // That was the live bug: every first invocation swallowed. The catch is
      // the only visible channel a dead command has, so it must see everything.
      let verb = ""
      try {
        // Re-read rather than trust the instance-lifetime cache: a kind enabled
        // in .agentic-workflow.json must work on the next command, not after the
        // next opencode restart.
        const config = await refreshConfig()
        if (!enabledWorkflowKinds(config).includes(kind)) {
          const enabled = enabledWorkflowKinds(config)
          const remedy = `Workflow kind "${kind}" is not enabled — enabled kinds: ${enabled.join(", ")}. Add {"workflows":{"${kind}":{"enabled":true}}} to .agentic-workflow.json in the project root, then re-run this command.`
          void client.tui.showToast({ body: { message: remedy, variant: "warning" } }).catch(() => {})
          // The command markdown renders whether or not the plugin handles it.
          // Left alone, the model reads a full description of the sitter's work
          // and improvises it — `gh` calls, manifest reads, guesses at what
          // `watch` means. Replace the template with the refusal.
          overrideCommandPrompt(output, refusalPrompt(`the workflow kind "${kind}" is not enabled.`, remedy))
          return
        }
        // The engineering verbs whose task-file move is deterministic (approve /
        // replan / retask) put that move first, with no dependency on
        // reconciliation — run the move, THEN reconcile. On the first-ever command
        // reconcileOnce() does heavy git/fs work (claim sweeps, worktree prune,
        // backlog audit); doing it before the move delayed the move past
        // opencode's command-hook window, so the model read the task as "still in
        // draft" until a retry (reconcile is guarded to run once, so later
        // attempts were fast — the "works after a few tries" symptom). Move first
        // keeps the gate deterministic on attempt 1.
        // (replan additionally chains a re-plan claim after its move — cheap fs
        // ops, and the fresh claim survives the sweep, which frees stale markers
        // only.)
        //
        // `retask` belongs here for a sharper version of the same reason: its
        // markdown PASSES THROUGH to the model on success, and that markdown says
        // to resolve the id in `draft/` only and to declare the id wrong if it is
        // not there. A move that lands after the window therefore does not merely
        // read as stale — the model authoritatively tells the user a valid id does
        // not exist.
        verb = splitVerb(input.arguments).verb
        // Trim the rendered body to the invoked verb BEFORE dispatching. The
        // template describes every verb, but the ones whose template survives
        // (new, and retask when its placement succeeded — handleCommand returns
        // undefined so the model does the work) are exactly the ones that pay for the other
        // ~190 lines, and those lines describe deterministic plugin work in the
        // imperative. Slicing first means the trim holds even if reconcile or
        // handleCommand throws; the `if (outcome)` override below still wins for
        // the report-and-stop verbs, which is the right precedence. Markers
        // missing or verb unknown -> keep the full body, never a partial one.
        // Defuse marker-shaped lines the ARGUMENT substituted into the body
        // first — without this, a pasted spec quoting the marker syntax denied
        // the whole slice and the model got all ~230 lines (command-slice.ts).
        const renderedRaw = readCommandPrompt(output)
        const rendered = renderedRaw === undefined ? undefined : neutralizeArgumentMarkers(renderedRaw, input.arguments)
        const sliced = rendered === undefined ? undefined : sliceCommandPrompt(rendered, verb)
        // The drafting invocation has no stage behind it, so `agentModels` reaches it
        // only by riding the body the model reads. Appended after the slice so it
        // survives whichever half was kept, and emitted even when slicing was a
        // no-op (markers missing) — otherwise a broken template silently drops it.
        const draftNote = draftModelNote(config, kind, verb)
        // `??` here treated an EMPTY slice as a usable one: a verb block that
        // tidies to nothing, plus a configured drafting model, replaced the entire
        // command body with the model sentence — no task, no prohibitions, no
        // usage. An empty slice is not a slice; fall back like a missing one.
        const base = sliced || rendered
        if (base !== undefined && (sliced || draftNote)) {
          overrideCommandPrompt(output, draftNote ? `${base}\n\n${draftNote}` : base)
        }
        // reconcileTimely, not reconcileOnce: the sweep is maintenance, so a
        // hung or failed sweep degrades to a toast instead of reaching the
        // catch — which would discard a gate move that already succeeded and
        // report the verb as failed.
        const gateFirst = gateMovesFirst(kind, verb)
        if (!gateFirst) await reconcileTimely()
        const outcome = await driver.handleCommand(deps, input.sessionID, input.arguments, config, kind)
        if (gateFirst) await reconcileTimely()
        // The command markdown renders to the model whether or not the plugin
        // handled the verb. For the report-and-stop verbs (claim/watch/status/…)
        // handleCommand did all the work and only toasted — but toasts are
        // invisible to the model, and the rendered template is a DESCRIPTION of
        // the loop, so the model reads it as information and never reports the
        // action. Feed the real outcome back in (same mechanism as the refusal
        // paths). Pass-through verbs (new, and retask on successful placement)
        // return undefined here, so their markdown reaches the model untouched.
        if (outcome) {
          overrideCommandPrompt(
            output,
            `The agentic-workflow plugin already ran /agentic-workflow:${kind} "${verb}" for you. Result:\n\n${outcome}\n\n` +
              `Report exactly that result to the user. Do NOT perform any work described in this command's BODY — the plugin already did it. ` +
              `The one exception is a \`NEXT STEP\` line inside the result above: that is the plugin talking, and it asks for the one thing ` +
              `only you can do (put a question to the user). Follow it if present, then stop.`,
          )
        }
      } catch (err) {
        // A crash is the ONE path on which a report-and-stop verb's body
        // reaches the model. The slice above (when it ran) wrote it to
        // `output`, and for those verbs that prose describes the plugin's
        // deterministic work in the imperative — take the watch lease, release
        // orphaned claim markers, audit and repair the backlog, read the
        // manifests. The `if (outcome)` override above is what normally
        // replaces it, and a throw skips straight past it, so the model is
        // handed the plugin's job as its instructions and improvises the loop
        // by hand. That is exactly the failure mode the not-enabled branch
        // above already overrides for; this is the same guard for the failure
        // path.
        const message = err instanceof Error ? err.message : String(err)
        // Override FIRST, then report — and never await a TUI call on the way
        // out. The prompt is the part that must not be lost, and the hook must
        // still RESOLVE for it to matter: a hanging toast here would swallow
        // the command with the failure prompt already written.
        overrideCommandPrompt(output, failurePrompt(input.command, verb, message))
        await log("error", `command /${input.command} "${verb}" failed: ${message}`)
        void client.tui
          .showToast({ body: { message: `agentic-workflow: /${input.command} ${verb} failed — ${message}`, variant: "error" } })
          .catch(() => {})
      }
    },

    "tool.execute.before": async (input, output) => {
      // Only trace tool calls while a loop is actively driving this session.
      if (hasWorkflow(input.sessionID)) {
        await log("info", `tool ${input.tool} starting (call ${input.callID})`)
      }
      // Backlog-mutation guard (always on, loop or no loop): the folder a task
      // file lives in IS its state — raw bash mv/mkdir/rm or a direct
      // write/edit under tasksDir bypasses the driver's state machine (a
      // degraded model's favorite corruption). classifyBash/classifyEdit
      // default-deny anything but reads, with carve-outs for authoring
      // draft/*.md and the live PLAN stage writing its own queued/ task.
      const config = await getConfig()
      // Stage commands run as subtasks, so tool calls arrive with the CHILD
      // session's id — getWorkflow misses and every per-loop guard below would be
      // silently skipped (the worktree pinning was dead code for stage
      // subagents). Walk the parentID chain to the driving loop, like
      // workflow_verdict does; the walk only runs while some loop is live.
      let loop = getWorkflow(input.sessionID)
      // The DRIVING session's id, not this call's — the evidence ledger is keyed
      // by the loop, and a stage subagent's calls arrive under a child id.
      let drivingID: string | null = loop ? input.sessionID : null
      let resolutionFailed = false
      // Read tools are resolved too (they were not before): a REVIEW stage's work
      // is almost entirely reading, so leaving them out would make its evidence
      // ledger look empty and reject every honest PASS.
      if (
        !loop &&
        anyWorkflowActive() &&
        (input.tool === "bash" ||
          isQuestionTool(input.tool) ||
          EDIT_TOOLS.has(input.tool) ||
          READ_TOOLS.has(input.tool) ||
          isAdoMcpTool(input.tool))
      ) {
        try {
          const found = await driver.findDrivingWorkflow(client, input.sessionID)
          loop = found?.state
          drivingID = found?.sessionID ?? null
        } catch (err) {
          resolutionFailed = true
          await log("warn", `could not resolve driving session for ${input.sessionID}: ${(err as Error).message}`)
        }
      }
      // Per-loop precise carve-out when the session resolved to a loop; the store
      // scan only backstops sessions that could not be attributed to any loop.
      const planTaskId = loop ? (loop.stage === "plan" ? (loop.task?.id ?? null) : null) : planStageTaskId()
      const guardCtx = { tasksDir: config.tasksDir, planTaskId }
      // No stage may ask the human. A drive is unattended between the plan gate
      // and the ship gate — the question dialog opened by a stage subagent
      // stalls it on someone who is not watching, and on a `watch` worker there
      // is no one to watch at all. The shipped agents also deny `question` in
      // their frontmatter (permission + tools), but this is the layer that does
      // not depend on an OpenCode config key behaving as documented, and the
      // only one that covers a user-added kind's stage agent. Scoped to driven
      // sessions: an ad-hoc /plan subagent outside a loop still asks freely.
      //
      // The refusal names the alternative, which is why no stage prompt says
      // this: a message the model reads at the moment it errs beats a line of
      // prose carried in every stage's context forever.
      //
      // Fails OPEN when the session can't be attributed (the API is down): a
      // shipped stage agent has no `question` tool to call in the first place,
      // so the only thing a fail-closed arm would add here is refusing an
      // ad-hoc /plan's legitimate ask because an unrelated loop is live.
      if (loop && isQuestionTool(input.tool)) {
        throw new Error(
          `agentic-workflow: the ${loop.stage.toUpperCase()} stage cannot ask the user — the loop drives unattended ` +
            `between the plan gate and the ship gate, so a question here stalls the run on someone who may not be at ` +
            `the terminal. Resolve it from the code, or record the uncertainty where the loop can act on it: a FAIL/ERROR ` +
            `verdict (check stages) or workflow_blocked (work stages). A human sees your reasoning at the next gate.`,
        )
      }
      // A window opening — the PRIMARY signal behind the task gate's "plan it
      // now?" enforcement, and this plugin's own seam rather than a host event
      // name it has to keep guessing right. Strictly AFTER the deny above: a
      // refused stage ask never reached the human, so it must leave no trace that
      // could satisfy an armed ask or hold `onIdle` off the session. Recorded
      // under the calling session, never a driving ancestor — see
      // `noteQuestionToolCall`.
      //
      // Any OTHER tool starting is proof a window is DOWN, since a question
      // blocks the turn until it is answered: the valve against a
      // `tool.execute.after` that never fires — see `noteOtherToolCall`.
      if (isQuestionTool(input.tool)) driver.noteQuestionToolCall(input.sessionID, input.callID)
      else driver.noteOtherToolCall(input.sessionID)
      // Azure DevOps MCP guard. With ADO reached only through the MCP server,
      // OpenCode's bash allowlist says nothing about it — `tool.execute.before`
      // is the ONLY enforcement point this host has, so both checks live here.
      // Two of them, both fail-closed: what the loop may ever write, and what
      // THIS stage's manifest granted.
      if (loop?.platform === "ado" && isAdoMcpTool(input.tool)) {
        const args = (output.args ?? {}) as Record<string, unknown>
        if (isAdoMcpWriteViolation(input.tool, args)) {
          throw new Error(
            "agentic-workflow: blocked an Azure DevOps write — loops may only read, post a comment thread or reply, " +
              "or create a DRAFT pull request (isDraft: true); completing, abandoning, approving, voting, reviewer " +
              "changes, branch creation, and pipeline runs stay a human call.",
          )
        }
        const granted = adoStageTools(loop)
        if (isAdoMcpToolOutOfStageScope(input.tool, granted)) {
          throw new Error(
            `agentic-workflow: the ${loop.stage} stage may not call ${input.tool} — its manifest grants ` +
              `${granted.length ? granted.join(", ") : "no ADO tools"}. Add it to platformTools in ` +
              `workflows/<kind>/workflow.json if the stage genuinely needs it.`,
          )
        }
      }
      if (input.tool === "bash") {
        const cmd: unknown = output.args?.command
        if (typeof cmd === "string") {
          const verdict = classifyBash(cmd, guardCtx)
          if (!verdict.allow) throw new Error(verdict.reason)
          // Write backstops (segment-aware — allowlist globs compile with dotAll
          // `*` so they can never exclude trailing flags like `-X DELETE`). The
          // Claude host enforces these in its PreToolUse hook; without this the
          // OpenCode host had no backstop at all. ADO is always on (the PAT must
          // never make a write beyond thread replies / PR creation); the gh/push
          // rules apply only while a loop drives this session, so a human's
          // manual `gh pr merge` in a non-loop session is untouched.
          // The prefixes are passed so a rewriting proxy cannot launder a
          // mutation past classifiers that anchor on the bare tool name — and,
          // as a side effect, so this guard no longer depends on whether that
          // proxy's plugin ran before or after ours in `tool.execute.before`.
          if (loop && (chainedGithubPrMutation(cmd, commandPrefixes) || chainedGitPushViolation(cmd, commandPrefixes, protectedBranches))) {
            throw new Error(
              "agentic-workflow: blocked a PR-state or protected-branch mutation — the loop never merges, closes, " +
                "approves, force-pushes, or pushes the default branch; those stay a human call.",
            )
          }
          // Check stages are read-only, but `find` is an execution/write
          // primitive their allowlist's `find *` glob can never narrow —
          // `find . -exec rm {} +` is a single segment with none of the
          // substitution characters the guard rejects. The Claude host folds
          // this into its PreToolUse `commandAllowed`; OpenCode's frontmatter
          // allowlist can't express a flag exclusion, so the deny lives here.
          if (loop && stageIsCheck(loop) && chainedFindMutation(cmd, commandPrefixes)) {
            throw new Error(
              `agentic-workflow: blocked a mutating find (-exec/-execdir/-ok/-okdir/-delete/-fprint*/-fls) — ` +
                `the ${loop.stage} stage is read-only; locate files with plain find and report instead of mutating.`,
            )
          }
          // Worktree bash pin: the session's real cwd is the MAIN tree (the
          // engine only conveys the worktree as prompt text), so a command
          // without the `cd <wt> && ` prefix silently runs outside the
          // isolation. Same fail-closed contract as the edit pin below.
          // The pin CORRECTS the command in place rather than refusing it: an
          // agent that forgot the prefix would otherwise burn an iteration
          // rediscovering it. Only an explicit escape still throws.
          const bashWt = loop?.git?.worktree
          if (bashWt) {
            const pinVerdict = pinBash(cmd, bashWt)
            if (pinVerdict.action === "block") throw new Error(pinVerdict.reason)
            if (pinVerdict.action === "rewrite") output.args.command = pinVerdict.value
          }
        }
      } else if (EDIT_TOOLS.has(input.tool)) {
        const fp: unknown = output.args?.filePath ?? output.args?.path
        if (typeof fp === "string") {
          const verdict = classifyEdit(fp, guardCtx)
          if (!verdict.allow) throw new Error(verdict.reason)
        }
      }
      // Proof-of-work ledger for check stages. Recorded HERE — after every guard
      // that can throw above, before the first return below — so it holds what the
      // stage will actually run, never a command a guard refused. `recordVerdict`
      // reads it back and rejects a PASS the stage did no work for
      // (@agentic-workflow/core/workflow/evidence). Bash records the EFFECTIVE
      // command: the worktree pin may have rewritten it, and what runs is what counts.
      if (drivingID && loop?.stage) {
        if (input.tool === "bash" && typeof output.args?.command === "string") {
          driver.noteEvidence(drivingID, { command: output.args.command })
        } else if (READ_TOOLS.has(input.tool)) {
          const reads = READ_PATH_KEYS.map((k) => output.args?.[k]).filter((v): v is string => typeof v === "string" && v.trim() !== "")
          if (reads.length) driver.noteEvidence(drivingID, { reads })
        }
      }
      // Worktree pinning enforcement: while a worktree-mode loop drives this
      // session, a file-writing tool must not touch anything outside the
      // worktree, and bash is pinned by classifyWorktreeBash above — the same
      // fail-closed stance for both tool shapes.
      if (resolutionFailed && (EDIT_TOOLS.has(input.tool) || input.tool === "bash") && anyWorktreeWorkflowActive()) {
        // Fail CLOSED on "can't tell": a worktree-isolated loop is live but this
        // session couldn't be attributed to (or cleared of) it — refusing the edit
        // beats risking a silent write to the human's main tree.
        throw new Error(
          "agentic-workflow: a worktree-isolated loop is active but this session could not be attributed " +
            "(session lookup failed) — refusing the edit rather than risking a write outside the worktree.",
        )
      }
      // NOTE: unlike the Claude host this reads only the loop's worktree, with no
      // per-stage isolation flag — OpenCode's state carries no equivalent of the
      // marker's `workflowWorktree`/`worktree` split. In practice the driver sets
      // `git.worktree` only once it has isolated, so an unisolated stage sees no
      // worktree and no pin; the asymmetry is that a stage which runs unisolated
      // AFTER a worktree exists (a replan bounce back to PLAN) would have its
      // write relocated here rather than refused.
      const wt = loop?.git?.worktree
      if (!wt || !EDIT_TOOLS.has(input.tool)) return
      const filePath: unknown = output.args?.filePath ?? output.args?.path
      // An edit-shaped tool whose path we can't read (e.g. a multi-file `patch`
      // payload) is unguardable — still fail CLOSED there. Everything else the
      // pin CORRECTS: a relative path resolves against the session's cwd (the
      // MAIN tree, not the worktree) and a main-tree absolute path is the
      // "agent keeps editing the current branch" symptom; both are mechanical
      // misses with exactly one sensible worktree equivalent.
      if (typeof filePath !== "string") {
        throw new Error(
          `agentic-workflow: this loop is isolated to its worktree ${wt}, but ${input.tool}'s target path could not be ` +
            `determined — pass an absolute path under the worktree.`,
        )
      }
      const pinned = pinEditPath(filePath, wt, directory, config.tasksDir)
      if (pinned.action === "block") throw new Error(pinned.reason)
      if (pinned.action === "rewrite") {
        if (output.args.filePath !== undefined) output.args.filePath = pinned.value
        else output.args.path = pinned.value
      }
    },

    // The question tool returned, so its window is closed however it ended. This
    // is the close half of the pair `tool.execute.before` opens, and it is the
    // one an answered question travels on — the driver only needs to know the
    // window is down, not what was answered.
    //
    // Deliberately does nothing else: this fires on EVERY tool completion, so no
    // config read and no client call belong here. And it is not the only way a
    // window can close — whether it fires when `execute` throws is not something
    // the plugin can pin — which is why the `question.*` events remain a second
    // source and why ESC/`stop` clear the session's windows outright.
    "tool.execute.after": async (input) => {
      if (isQuestionTool(input.tool)) driver.noteQuestionToolSettled(input.sessionID, input.callID)
    },

    tool: {
      workflow_verdict: tool({
        description:
          "Record a check stage's machine-readable verdict for the running loop (engineering: verify/review; pr-sitter: triage/verify). This tool " +
          "call is the loop's ONLY trusted verdict channel — a PASS/FAIL written in plain text is ignored. " +
          "Call exactly once, at the end of the check stage's turn, after gathering the evidence. Only the " +
          "stage the loop is currently running may record; calls from any other stage or session are ignored.",
        args: {
          stage: tool.schema
            .string()
            .describe("Which check stage this verdict belongs to (must be the loop's currently running check stage)."),
          verdict: tool.schema
            .enum(["PASS", "FAIL", "ERROR"])
            .describe(
              "PASS only on observed evidence; FAIL when criteria are unmet; ERROR only when the check itself " +
                "could not run at all (broken environment, missing test runner) — never for failing tests.",
            ),
          reason: tool.schema
            .string()
            .max(500)
            .optional()
            .describe(
              "One-sentence summary of why. REQUIRED on FAIL unless a criterion marked not met or a blocking finding " +
                "names the problem — a FAIL that names nothing to fix is REJECTED.",
            ),
          criteria: tool.schema
            .array(
              tool.schema.object({
                criterion: tool.schema.string().describe("The acceptance criterion text, as given to you."),
                pass: tool.schema.boolean().describe("Whether this criterion is met, on observed evidence."),
              }),
            )
            .optional()
            .describe(
              "Per-acceptance-criterion results, mirroring the criteria threaded into your stage prompt. REQUIRED for a " +
                "PASS on a stage given acceptance criteria: one entry per criterion, in the order given — a PASS with " +
                "missing/incomplete criteria, or one marking any criterion not met, is REJECTED (record FAIL instead).",
            ),
          axes: tool.schema
            .array(
              tool.schema.object({
                axis: tool.schema.string().describe("The review axis this result covers (e.g. correctness, security)."),
                verdict: tool.schema
                  .enum(["PASS", "FAIL", "ERROR"])
                  .describe(
                    "This axis's own verdict. ERROR only when the axis genuinely could not be assessed; " +
                      "an axis with no findings is a clean PASS.",
                  ),
                findings: tool.schema
                  .array(
                    tool.schema.object({
                      severity: tool.schema
                        .enum(["critical", "important", "suggestion"])
                        .describe("critical/important block the stage; suggestion never does."),
                      detail: tool.schema.string().describe("What is wrong and what should change."),
                      location: tool.schema.string().optional().describe('"file:line" this finding is anchored to.'),
                    }),
                  )
                  .optional(),
              }),
            )
            .optional()
            .describe(
              "Per-axis results. REQUIRED on a stage whose prompt lists required axes (engineering review: all five) — " +
                "a call missing an axis is REJECTED, and partial submissions are not accumulated across calls.",
            ),
          evidence: tool.schema
            .array(
              tool.schema.object({
                kind: tool.schema
                  .enum(["command", "file"])
                  .describe('"command" — something you ran; "file" — a path (or "path:line") you read.'),
                ref: tool.schema.string().describe("The command line as you issued it, or the path you read."),
                result: tool.schema
                  .string()
                  .max(300)
                  .optional()
                  .describe('What you observed (e.g. "42 passed, 0 failed"). Audit trail only — never matched.'),
              }),
            )
            .optional()
            .describe(
              "Proof of work. REQUIRED for a PASS on a stage whose prompt carries the PROOF OF WORK contract " +
                "(engineering verify/review): this session's real commands and file reads are recorded independently, " +
                "and a PASS citing nothing — or nothing matching what actually ran — is REJECTED. At least one citation " +
                "must be work YOU did this pass: check commands the loop pre-ran are established fact, not your proof. " +
                "FAIL/ERROR need none.",
            ),
        },
        execute: async (args, ctx) => {
          // Check stages run as subtasks: the call carries the CHILD session's
          // id, so resolve the driving session up the parent chain first — a
          // verdict recorded under the child id would be invisible to the drive.
          // Bounded: that walk is a `client.session.get` per hop, i.e. a fetch
          // back into the server with no timeout of its own, and a stage whose
          // verdict channel never returns burns the whole stage for nothing.
          // Throwing (not returning) keeps the contract below — a string reads
          // as success, and an unrecorded verdict must visibly fail so it retries.
          const resolved = await withinDeadline(driver.resolveDrivingSession(client, ctx.sessionID), VERDICT_TOOL_TIMEOUT_MS)
          if (resolved === TIMED_OUT) {
            throw new Error(
              `agentic-workflow: could not resolve the driving session within ${VERDICT_TOOL_TIMEOUT_MS / 1000}s — the verdict was NOT recorded. Call this tool again.`,
            )
          }
          const drivingID = resolved
          const result = driver.recordVerdict(
            drivingID,
            args.stage,
            {
              verdict: args.verdict,
              ...(args.reason !== undefined ? { reason: args.reason } : {}),
              ...(args.criteria !== undefined ? { criteria: args.criteria } : {}),
              ...(args.axes !== undefined ? { axes: args.axes } : {}),
              ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
            },
            // deps only so an out-of-stage verdict can be audited on the task file
            deps,
          )
          // Throw, don't return: a plain string result reads as success to the
          // model, and a rejected verdict must visibly fail so it calls again.
          if (!result.accepted) throw new Error(result.message)
          return result.message
        },
      }),

      workflow_blocked: tool({
        description:
          "Report that the WORK stage now running cannot do its work at all — the approved plan is impossible or wrong as " +
          "written, not merely hard. This is NOT a verdict on the work (a work stage may never record one) and NOT a way " +
          "to skip a hard task: it stops the loop and sends the task back to a human for replanning. Call it instead of " +
          "implementing something different from the approved plan. Only the work stage the loop is currently running may " +
          "call it; anything else is ignored.",
        args: {
          stage: tool.schema
            .string()
            .describe("The loop's currently running work stage (engineering: build)."),
          reason: tool.schema
            .string()
            .max(500)
            .describe("One or two sentences on what makes the plan impossible, concrete enough for a human to replan from."),
        },
        execute: async (args, ctx) => {
          // Same parent-chain walk as workflow_verdict: stage agents run as
          // subtasks, so the call arrives under the CHILD session id and a signal
          // recorded there would be invisible to the drive. Bounded and thrown on
          // for the same reasons.
          const resolved = await withinDeadline(driver.resolveDrivingSession(client, ctx.sessionID), VERDICT_TOOL_TIMEOUT_MS)
          if (resolved === TIMED_OUT) {
            throw new Error(
              `agentic-workflow: could not resolve the driving session within ${VERDICT_TOOL_TIMEOUT_MS / 1000}s — nothing was recorded. Call this tool again.`,
            )
          }
          const drivingID = resolved
          const result = driver.recordBlocked(drivingID, args.stage, args.reason)
          // Throw on rejection for the same reason as the verdict tool: a plain
          // string reads as success to the model.
          if (!result.accepted) throw new Error(result.message)
          return result.message
        },
      }),

      /**
       * The two gate moves an INTERACTIVE authoring turn needs to act on the
       * answer it just collected.
       *
       * This host has no MCP server and guards every write under `docs/tasks/`,
       * so a `new`/`retask` turn that asks "approve this draft?" with the
       * `question` tool had no way to honour a yes — it could only tell the user
       * to type the command, which is the ask made pointless. Both refuse when a
       * loop is driving the calling session (a stage agent must never move the
       * human's gates), and both fail closed when that cannot be determined.
       */
      workflow_gate: tool({
        description:
          "Move a task through the human gate the user just approved in a question you asked (draft → queued, or a parked plan → build-ready). " +
          "Call this ONLY to act on an explicit answer the user gave you this turn — never to advance work on your own initiative. " +
          "Stage agents may not call it: a loop driving your session refuses the move.",
        args: {
          id: tool.schema.string().describe("The task id the user approved. Required — never guess one."),
          publish: tool.schema
            .enum(["pr", "push", "local"])
            .optional()
            .describe(
              'Only meaningful when this gate SHIPS an in-review task, and only when the user chose it: "pr" pushes the branch and opens a draft PR, "push" pushes and opens nothing, "local" leaves the branch on this machine. Omit it to use the repo\'s configured shipPublish — never send a value the user did not ask for.',
            ),
          base: tool.schema
            .string()
            .optional()
            .describe(
              'The branch a shipped task\'s pull request should TARGET, e.g. "release/2.4". Only meaningful when this gate SHIPS, and only when the user named a branch. Omit it and the gate uses the base the run was cut from, then the repo\'s prBase, then the platform default — never send a value the user did not ask for.',
            ),
        },
        execute: async (args, ctx) => {
          const done = await withinDeadline(driver.gateFromAgent(deps, ctx.sessionID, args.id, await getConfig(), args.publish, args.base), GATE_TOOL_TIMEOUT_MS)
          if (done !== TIMED_OUT) return done
          await log("warn", `workflow_gate on "${args.id}" exceeded ${GATE_TOOL_TIMEOUT_MS}ms — answering the model; the move may still complete`)
          // Safe to invite a retry: approving a task that already moved takes the
          // `alreadyDone` arm and reports "nothing to do" instead of moving twice.
          return (
            `The gate move for "${args.id}" is taking longer than ${GATE_TOOL_TIMEOUT_MS / 1000}s, so this call is answering without it. ` +
            `It may well have landed. Call this tool once more with the same id — a repeat approve on a task that already moved is a no-op — ` +
            `and if it is slow again, tell the user to run \`/agentic-workflow:engineering status\` and check the opencode log for a shell command that timed out.`
          )
        },
      }),

      workflow_plan: tool({
        description:
          "Run the PLAN stage on an approved (queued/) task now, parking the plan in plan-review/ for the human's gate. " +
          "Call this ONLY to act on an explicit 'plan it now' answer the user gave you this turn. " +
          "Stage agents may not call it: a loop driving your session refuses it.",
        args: {
          id: tool.schema.string().describe("The queued task id to plan. Required — never guess one."),
        },
        execute: async (args, ctx) => {
          const done = await withinDeadline(driver.planFromAgent(deps, ctx.sessionID, args.id, await getConfig()), GATE_TOOL_TIMEOUT_MS)
          if (done !== TIMED_OUT) return done
          await log("warn", `workflow_plan on "${args.id}" exceeded ${GATE_TOOL_TIMEOUT_MS}ms — answering the model; the claim may still be taken`)
          // No retry invited here, unlike the gate: this call claims the task and
          // queues a drive on the user's own session, and a second one racing the
          // first is worse than a slow first.
          return (
            `Starting the PLAN pass on "${args.id}" is taking longer than ${GATE_TOOL_TIMEOUT_MS / 1000}s, so this call is answering without it. ` +
            `Do NOT call this tool again. Tell the user to run \`/agentic-workflow:engineering status\` to see whether the plan pass started.`
          )
        },
      }),

      workflow_replan: tool({
        description:
          "Reject a parked plan and immediately re-plan the task with the user's reason (plan-review/ → queued/, then a fresh PLAN pass that parks a revised plan). " +
          "Call this ONLY to act on an explicit 'replan it' answer the user gave you this turn, with the reason THEY gave. " +
          "Stage agents may not call it: a loop driving your session refuses it.",
        args: {
          id: tool.schema.string().describe("The plan-review task id to send back to planning. Required — never guess one."),
          reason: tool.schema.string().describe("The user's reason for rejecting the plan, in their words. It is threaded into the next PLAN pass."),
        },
        execute: async (args, ctx) => {
          const done = await withinDeadline(
            driver.replanFromAgent(deps, ctx.sessionID, args.id, args.reason, await getConfig()),
            GATE_TOOL_TIMEOUT_MS,
          )
          if (done !== TIMED_OUT) return done
          await log("warn", `workflow_replan on "${args.id}" exceeded ${GATE_TOOL_TIMEOUT_MS}ms — answering the model; the rejection may still land`)
          // No retry invited, for workflow_plan's reason and one more: a repeat
          // rejection of a task already back in queued/ is not a no-op — it would
          // be refused, and the chained PLAN drive it queues claims this session.
          return (
            `Rejecting the plan for "${args.id}" is taking longer than ${GATE_TOOL_TIMEOUT_MS / 1000}s, so this call is answering without it. ` +
            `Do NOT call this tool again. Tell the user to run \`/agentic-workflow:engineering status\` to see where the task sits.`
          )
        },
      }),
    },
  }
}
