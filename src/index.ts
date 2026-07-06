import type { Plugin } from "@opencode-ai/plugin"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"
import { DEFAULT_CONFIG, loadConfig } from "./config.ts"
import type { Config } from "./config.ts"
import * as driver from "./loop/driver.ts"
import { listWorktrees, pruneWorktrees } from "@agentic-loop/core/loop/git"
import { listSnapshotIds } from "@agentic-loop/core/loop/persist"
import { findSessionDriving, getLoop, hasLoop } from "@agentic-loop/core/loop/state"
import { auditBacklog, formatAnomalies } from "@agentic-loop/core/task/audit"
import { classifyBash, classifyEdit } from "@agentic-loop/core/task/guard"
import { isOrphanedPlanClaim, listClaimIds, listInProgress, listQueued, releaseOrphanedClaims, wasInterrupted } from "@agentic-loop/core/task/store"

/** Tools that write files — guarded to the worktree while a worktree-mode loop drives. */
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"])

/**
 * agentic-loop
 *
 * opencode plugin that executes approved plans as an automatic loop:
 *
 *   build → verify → review
 *
 * Task authoring lives in the `/agent-loop-task` command: `new` interviews the
 * user into a draft, and the deterministic `approve <id>` parks it planless in
 * `queued/`. The loop plans right before execution: a claimed queued task runs
 * the PLAN stage, writes its `## Implementation Plan`, and parks in
 * `plan-review/`; `/agent-loop-task approve-plan <id>` releases it to
 * `in-progress/`, the build-ready queue. `/agent-loop task <id>` claims one
 * task (planning or building it as its folder dictates); `/agent-loop watch
 * [interval]` polls for work — on every `session.idle` event plus a
 * per-session interval timer. A verify or review FAIL re-builds within the
 * iteration cap. The control surface lives in `loop/driver.ts`; the pure
 * state machine in `loop/state.ts`.
 */
export const AgenticLoop: Plugin = async ({ client, directory, $ }) => {
  const service = "agentic-loop"

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
  // safe there. Fall back to defaults (and warn) on misconfig so a bad config
  // file degrades rather than breaking the plugin entirely.
  let configPromise: Promise<Config> | undefined
  const getConfig = (): Promise<Config> =>
    (configPromise ??= loadConfig(client, directory).catch(async (err) => {
      await log("warn", `using default config: ${(err as Error).message}`)
      return DEFAULT_CONFIG
    }))

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
    // /agent-loop recover resumes it at the exact stage).
    try {
      const tasks = await listInProgress(client, directory, config.tasksDir, log)
      const interrupted = tasks.filter(wasInterrupted).map((t) => t.id)
      if (interrupted.length) {
        await log(
          "warn",
          `interrupted loop task(s) in ${config.tasksDir}/in-progress: ${interrupted.join(", ")} — run /agent-loop recover <id> to resume`,
        )
      }
      const snapshots = await listSnapshotIds(client, directory, config.tasksDir)
      if (snapshots.length) {
        await log(
          "warn",
          `loop state snapshot(s) present: ${snapshots.join(", ")} — /agent-loop recover <id> resumes at the exact stage`,
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
      // Report-only here; /agent-loop doctor [fix] repairs.
      const anomalies = await auditBacklog(client, directory, config.tasksDir)
      for (const line of formatAnomalies(anomalies, config.tasksDir)) {
        await log("warn", `backlog anomaly: ${line} — /agent-loop doctor reports and repairs`)
      }
    } catch (err) {
      await log("warn", `startup task reconciliation failed: ${(err as Error).message}`)
    }

    // Worktree reconciliation: prune vanished registrations, then surface any
    // surviving loop worktrees (a crashed run's) so a human knows they exist —
    // never auto-delete (another process may own it; a crashed diff is evidence).
    if (config.worktreesDir) {
      try {
        await pruneWorktrees($, directory)
        const root = path.resolve(directory, config.worktreesDir)
        const stale = (await listWorktrees($, directory)).filter((w) => w.path.startsWith(root))
        for (const w of stale) {
          await log(
            "warn",
            `stale loop worktree ${w.path} (branch ${w.branch ?? "?"}) — /agent-loop recover will reuse it, or 'git worktree remove' it`,
          )
        }
      } catch (err) {
        await log("warn", `worktree reconciliation failed: ${(err as Error).message}`)
      }
    }
  }

  return {
    // Clear watch polling timers on plugin teardown so a reload doesn't leak
    // intervals firing into a dead instance.
    dispose: async () => {
      driver.disposeWatch()
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      await reconcileOnce()
      const { sessionID } = event.properties
      await driver.onIdle(deps, sessionID, await getConfig())
    },

    "command.execute.before": async (input) => {
      if (input.command === "agent-loop") {
        await reconcileOnce()
        await driver.handleCommand(deps, input.sessionID, input.arguments, await getConfig())
        return
      }
      if (input.command === "agent-loop-task") {
        await reconcileOnce()
        await driver.handleTaskCommand(deps, input.sessionID, input.arguments, await getConfig())
      }
    },

    "tool.execute.before": async (input, output) => {
      // Only trace tool calls while a loop is actively driving this session.
      if (hasLoop(input.sessionID)) {
        await log("info", `tool ${input.tool} starting (call ${input.callID})`)
      }
      // Backlog-mutation guard (always on, loop or no loop): the folder a task
      // file lives in IS its state — raw bash mv/mkdir/rm or a direct
      // write/edit under tasksDir bypasses the driver's state machine (a
      // degraded model's favorite corruption). classifyBash/classifyEdit
      // default-deny anything but reads, with carve-outs for authoring
      // draft/*.md and the live PLAN stage writing its own queued/ task.
      const config = await getConfig()
      const loop = getLoop(input.sessionID)
      const planTaskId = loop?.stage === "plan" ? (loop.task?.id ?? null) : null
      const guardCtx = { tasksDir: config.tasksDir, planTaskId }
      if (input.tool === "bash") {
        const cmd: unknown = output.args?.command
        if (typeof cmd === "string") {
          const verdict = classifyBash(cmd, guardCtx)
          if (!verdict.allow) throw new Error(verdict.reason)
        }
      } else if (EDIT_TOOLS.has(input.tool)) {
        const fp: unknown = output.args?.filePath ?? output.args?.path
        if (typeof fp === "string") {
          const verdict = classifyEdit(fp, guardCtx)
          if (!verdict.allow) throw new Error(verdict.reason)
        }
      }
      // Worktree pinning enforcement (best-effort): while a worktree-mode loop
      // drives this session, a file-writing tool must not touch an absolute
      // path outside the worktree. Relative paths and non-edit tools pass
      // through (bash pinning stays prompt-enforced — a documented residual).
      const wt = loop?.git?.worktree
      if (!wt || !EDIT_TOOLS.has(input.tool)) return
      const filePath: unknown = output.args?.filePath ?? output.args?.path
      if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return
      const rel = path.relative(wt, path.resolve(filePath))
      if (rel === "" || rel.startsWith("..")) {
        throw new Error(
          `agentic-loop: this loop is isolated to its worktree ${wt} — edit ${filePath} is outside it. ` +
            `Use an absolute path under the worktree.`,
        )
      }
    },

    tool: {
      loop_verdict: tool({
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
        },
        execute: async (args, ctx) =>
          driver.recordVerdict(ctx.sessionID, args.stage, {
            verdict: args.verdict,
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
            ...(args.criteria !== undefined ? { criteria: args.criteria } : {}),
          }),
      }),
    },
  }
}
