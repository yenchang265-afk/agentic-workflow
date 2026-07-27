import type { Plugin } from "@opencode-ai/plugin"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"
import { DEFAULT_CONFIG, applyAdoPatEnv, loadConfig } from "./config.ts"
import {
  agentModel,
  enabledWorkflowKinds,
  ignoredUserConfigPaths,
  readRawConfigLayers,
  resolveUserConfigPath,
  unknownAgentModelKeys,
} from "@agentic-workflow/core/config"
import type { Config } from "./config.ts"
import * as driver from "./workflow/driver.ts"
import { failurePrompt, overrideCommandPrompt, readCommandPrompt, refusalPrompt } from "./command-prompt.ts"
import { sliceCommandPrompt } from "./command-slice.ts"
import { listWorktrees, pruneWorktrees } from "@agentic-workflow/core/workflow/git"
import { listSnapshotIds } from "@agentic-workflow/core/workflow/persist"
import { anyWorkflowActive, anyWorktreeWorkflowActive, findSessionDriving, getWorkflow, hasWorkflow, planStageTaskId } from "@agentic-workflow/core/workflow/state"
import { auditBacklog, formatAnomalies } from "@agentic-workflow/core/task/audit"
import { classifyBash, classifyEdit } from "@agentic-workflow/core/task/guard"
import { pinBash, pinEditPath } from "@agentic-workflow/core/workflow/worktree-guard"
import { chainedAdoAzWriteViolation, chainedAdoWriteBackstopViolation, chainedGithubPrMutation, chainedGitPushViolation } from "@agentic-workflow/core/task/write-backstop"
import { findByIdIn, isOrphanedPlanClaim, listClaimIds, listInProgress, listQueued, releaseOrphanedClaims, wasInterrupted } from "@agentic-workflow/core/task/store"

/** Tools that write files — guarded to the worktree while a worktree-mode loop drives. */
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"])

/**
 * The agent a verb spawns OUTSIDE the loop. `new` step 4 and `retask` step 4
 * invoke `workflow-plan-author` to write draft files before any loop exists, so
 * there is no StageDef for `modelFor` to resolve and no stage fire to carry a
 * model — `agentModels` is the only source. `plan` is deliberately absent: its
 * spawn IS the PLAN stage, already governed by `stageModels.plan`.
 */
const VERB_DRAFT_AGENT: Record<string, string> = { new: "workflow-plan-author", retask: "workflow-plan-author" }

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
const NON_STAGE_AGENTS = ["workflow-plan-author", "workflow-plan"] as const

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
  agent?: Record<string, { model?: string } | undefined>
}

/**
 * Apply the patch to a resolved opencode config IN PLACE, returning the agents
 * actually bound. `Hooks.config` returns void, so mutation is the only channel.
 *
 * The ONLY key ever written is `agent.<name>.model`. A user's own
 * `opencode.json` entry for an agent we do not name survives untouched — and
 * one we DO name loses, because naming it in `agentModels` is the more specific,
 * more recent instruction. Whole `AgentConfig` objects are never replaced, so a
 * user's `permission`/`tools`/`temperature` for that agent are preserved. Pure
 * apart from the mutation.
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
export const makeAgenticWorkflow: Plugin = async ({ client, directory, $ }) => {
  const service = "agentic-workflow"

  const log = (level: "info" | "warn" | "error", message: string) =>
    client.app.log({ body: { service, level, message } })

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
      config = await loadConfig(client, directory)
      lastGood = config
    } catch (err) {
      // A rejected config silently downgrading to defaults surfaces later as
      // "the kind I enabled is unknown", with the only clue buried in
      // opencode's log file. Toast it: the cause is one bad key, and the human
      // has no other way to connect the two.
      const message = `agentic-workflow: ignoring .agentic-workflow.json — ${(err as Error).message}`
      await log("warn", message)
      await client.tui.showToast({ body: { message, variant: "error" } }).catch(() => {})
      config = lastGood ?? DEFAULT_CONFIG
    }
    // Export ado.pat → AZURE_DEVOPS_EXT_PAT (when unset) so the sitter's
    // stage-agent curl calls inherit it; the env var always wins.
    applyAdoPatEnv(config)
    await warnIgnoredUserConfigOnce()
    await reportAgentModelsOnce(config)
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
  let reportedAgentModels = false
  const reportAgentModelsOnce = async (config: Config): Promise<void> => {
    if (reportedAgentModels) return
    reportedAgentModels = true
    if (agentModelsBound.length) {
      await log("info", `agentic-workflow: agentModels bound ${agentModelsBound.join(", ")} (takes effect until opencode restarts)`)
    }
    const unknown = unknownAgentModelKeys(config, knownAgentNames(config))
    if (unknown.length === 0) return
    await client.tui
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
    const inEffect = resolveUserConfigPath()
    const ignored = ignoredUserConfigPaths(inEffect)
    if (ignored.length === 0) return
    warnedIgnoredUserConfig = true
    await client.tui
      .showToast({
        body: {
          message: `agentic-workflow: ${ignored.join(" and ")} ${ignored.length > 1 ? "are" : "is"} NOT being read — the user-scope config in effect is ${inEffect}. Only one user-scope file loads; move your settings there.`,
          variant: "warning",
        },
      })
      .catch(() => {})
  }
  const getConfig = (): Promise<Config> => (configPromise ??= readConfig())

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
    if (config.worktreesDir) {
      try {
        await pruneWorktrees($, directory)
        const root = path.resolve(directory, config.worktreesDir)
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
        agentModelsBound = applyAgentModels(input as AgentModelConfig, agentModelPatch(readRawConfigLayers(directory)))
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
      // A user interrupt (ESC) surfaces as a MessageAbortedError, not a dedicated
      // event — route it to onInterrupt so watch mode stops and the loop halts
      // instead of the trailing session.idle re-claiming work. No reconcileOnce:
      // it's pointless here and would delay the critical synchronous unwatch.
      const interruptedSid = driver.abortedSessionID(event)
      if (interruptedSid) return void (await driver.onInterrupt(deps, interruptedSid))
      if (event.type !== "session.idle") return
      await reconcileOnce()
      const { sessionID } = event.properties
      await driver.onIdle(deps, sessionID, await getConfig())
    },

    "command.execute.before": async (input, output) => {
      // One command per workflow kind: /agentic-workflow:engineering, /agentic-workflow:pr-sitter, …
      const match = /^agentic-workflow:(.+)$/.exec(input.command)
      if (!match) return
      const kind = match[1]!
      // Re-read rather than trust the instance-lifetime cache: a kind enabled
      // in .agentic-workflow.json must work on the next command, not after the
      // next opencode restart.
      const config = await refreshConfig()
      if (!enabledWorkflowKinds(config).includes(kind)) {
        const enabled = enabledWorkflowKinds(config)
        const remedy = `Workflow kind "${kind}" is not enabled — enabled kinds: ${enabled.join(", ")}. Add {"workflows":{"${kind}":{"enabled":true}}} to .agentic-workflow.json in the project root, then re-run this command.`
        await client.tui.showToast({ body: { message: remedy, variant: "warning" } }).catch(() => {})
        // The command markdown renders whether or not the plugin handles it.
        // Left alone, the model reads a full description of the sitter's work
        // and improvises it — `gh` calls, manifest reads, guesses at what
        // `watch` means. Replace the template with the refusal.
        overrideCommandPrompt(output, refusalPrompt(`the workflow kind "${kind}" is not enabled.`, remedy))
        return
      }
      // The engineering gate verbs (approve / replan) are pure task-file moves
      // with no dependency on reconciliation — run the move FIRST, then
      // reconcile. On the first-ever command reconcileOnce() does heavy git/fs
      // work (claim sweeps, worktree prune, backlog audit); doing it before the
      // move delayed the move past opencode's command-hook window, so the model
      // read the task as "still in draft" until a retry (reconcile is guarded
      // to run once, so later attempts were fast — the "works after a few
      // tries" symptom). Move first keeps the gate deterministic on attempt 1.
      const verb = input.arguments.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
      // Trim the rendered body to the invoked verb BEFORE dispatching. The
      // template describes every verb, but the ones whose template survives
      // (new/retask/approve/replan/remove — handleCommand returns undefined so
      // the model does the work) are exactly the ones that pay for the other
      // ~190 lines, and those lines describe deterministic plugin work in the
      // imperative. Slicing first means the trim holds even if reconcile or
      // handleCommand throws; the `if (outcome)` override below still wins for
      // the report-and-stop verbs, which is the right precedence. Markers
      // missing or verb unknown -> keep the full body, never a partial one.
      const rendered = readCommandPrompt(output)
      const sliced = rendered === undefined ? undefined : sliceCommandPrompt(rendered, verb)
      // The drafting invocation has no stage behind it, so `agentModels` reaches it
      // only by riding the body the model reads. Appended after the slice so it
      // survives whichever half was kept, and emitted even when slicing was a
      // no-op (markers missing) — otherwise a broken template silently drops it.
      const draftNote = draftModelNote(config, kind, verb)
      const base = sliced ?? rendered
      if (base !== undefined && (sliced || draftNote)) {
        overrideCommandPrompt(output, draftNote ? `${base}\n\n${draftNote}` : base)
      }
      const gateFirst = kind === "engineering" && ["approve", "replan"].includes(verb)
      let outcome: string | undefined
      try {
        if (!gateFirst) await reconcileOnce()
        outcome = await driver.handleCommand(deps, input.sessionID, input.arguments, config, kind)
        if (gateFirst) await reconcileOnce()
      } catch (err) {
        // A crash here is the ONE path on which a report-and-stop verb's body
        // reaches the model. The slice above already wrote it to `output`, and
        // for those verbs that prose describes the plugin's deterministic work
        // in the imperative — take the watch lease, release orphaned claim
        // markers, audit and repair the backlog, read the manifests. The
        // `if (outcome)` override below is what normally replaces it, and a
        // throw skips straight past it, so the model is handed the plugin's job
        // as its instructions and improvises the loop by hand. That is exactly
        // the failure mode the not-enabled branch above already overrides for;
        // this is the same guard for the failure path. Wraps reconcileOnce too:
        // it is awaited on the same unguarded path, either side of the dispatch.
        const message = err instanceof Error ? err.message : String(err)
        // Override FIRST, then report. The prompt is the part that must not be
        // lost: a logger or TUI call that throws on its way out would take the
        // whole hook down and leave the sliced body standing.
        overrideCommandPrompt(output, failurePrompt(input.command, verb, message))
        await log("error", `command /${input.command} "${verb}" failed: ${message}`).catch(() => {})
        await client.tui
          .showToast({ body: { message: `agentic-workflow: /${input.command} ${verb} failed — ${message}`, variant: "error" } })
          .catch(() => {})
        return
      }
      // The command markdown renders to the model whether or not the plugin
      // handled the verb. For the report-and-stop verbs (claim/watch/status/…)
      // handleCommand did all the work and only toasted — but toasts are
      // invisible to the model, and the rendered template is a DESCRIPTION of
      // the loop, so the model reads it as information and never reports the
      // action. Feed the real outcome back in (same mechanism as the refusal
      // paths). Pass-through verbs (new/retask/approve/replan/remove) return
      // undefined here, so their markdown reaches the model untouched.
      if (outcome) {
        overrideCommandPrompt(
          output,
          `The agentic-workflow plugin already ran /agentic-workflow:${kind} "${verb}" for you. Result:\n\n${outcome}\n\n` +
            `Report exactly that result to the user and stop. Do NOT perform any work described in this command's body — the plugin already did it.`,
        )
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
      let resolutionFailed = false
      if (!loop && anyWorkflowActive() && (input.tool === "bash" || EDIT_TOOLS.has(input.tool))) {
        try {
          loop = (await driver.findDrivingWorkflow(client, input.sessionID))?.state
        } catch (err) {
          resolutionFailed = true
          await log("warn", `could not resolve driving session for ${input.sessionID}: ${(err as Error).message}`)
        }
      }
      // Per-loop precise carve-out when the session resolved to a loop; the store
      // scan only backstops sessions that could not be attributed to any loop.
      const planTaskId = loop ? (loop.stage === "plan" ? (loop.task?.id ?? null) : null) : planStageTaskId()
      const guardCtx = { tasksDir: config.tasksDir, planTaskId }
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
          if (chainedAdoWriteBackstopViolation(cmd) || chainedAdoAzWriteViolation(cmd)) {
            throw new Error(
              "agentic-workflow: blocked an Azure DevOps write — loops may only read, reply to a comment thread, " +
                "or create a DRAFT PR (curl: GET / POST …/threads… / POST …/pullrequests; az: reads, " +
                "invoke POST to a thread resource, az repos pr create --draft); " +
                "completing/abandoning/approving stays a human call.",
            )
          }
          if (loop && (chainedGithubPrMutation(cmd) || chainedGitPushViolation(cmd))) {
            throw new Error(
              "agentic-workflow: blocked a PR-state or protected-branch mutation — the loop never merges, closes, " +
                "approves, force-pushes, or pushes the default branch; those stay a human call.",
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
            .describe("One-sentence summary of why. Give it on every FAIL or ERROR so the next iteration knows what to fix."),
          criteria: tool.schema
            .array(
              tool.schema.object({
                criterion: tool.schema.string().describe("The acceptance criterion text, as given to you."),
                pass: tool.schema.boolean().describe("Whether this criterion is met, on observed evidence."),
              }),
            )
            .optional()
            .describe("Per-acceptance-criterion results, mirroring the criteria threaded into your stage prompt."),
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
        },
        execute: async (args, ctx) => {
          // Check stages run as subtasks: the call carries the CHILD session's
          // id, so resolve the driving session up the parent chain first — a
          // verdict recorded under the child id would be invisible to the drive.
          const drivingID = await driver.resolveDrivingSession(client, ctx.sessionID)
          const result = driver.recordVerdict(
            drivingID,
            args.stage,
            {
              verdict: args.verdict,
              ...(args.reason !== undefined ? { reason: args.reason } : {}),
              ...(args.criteria !== undefined ? { criteria: args.criteria } : {}),
              ...(args.axes !== undefined ? { axes: args.axes } : {}),
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
    },
  }
}
