import type { Plugin } from "@opencode-ai/plugin"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"
import { DEFAULT_CONFIG, applyAdoPatEnv, loadConfig } from "./config.ts"
import { enabledLoopKinds } from "@agentic-loop/core/config"
import type { Config } from "./config.ts"
import * as driver from "./loop/driver.ts"
import { listWorktrees, pruneWorktrees } from "@agentic-loop/core/loop/git"
import { listSnapshotIds } from "@agentic-loop/core/loop/persist"
import { anyLoopActive, anyWorktreeLoopActive, findSessionDriving, getLoop, hasLoop, planStageTaskId } from "@agentic-loop/core/loop/state"
import { auditBacklog, formatAnomalies } from "@agentic-loop/core/task/audit"
import { classifyBash, classifyEdit } from "@agentic-loop/core/task/guard"
import { classifyWorktreeBash, isUnderTasksDir } from "@agentic-loop/core/loop/worktree-guard"
import { chainedAdoAzWriteViolation, chainedAdoWriteBackstopViolation, chainedGithubPrMutation, chainedGitPushViolation } from "@agentic-loop/core/task/write-backstop"
import { findByIdIn, isOrphanedPlanClaim, listClaimIds, listInProgress, listQueued, releaseOrphanedClaims, wasInterrupted } from "@agentic-loop/core/task/store"

/** Tools that write files — guarded to the worktree while a worktree-mode loop drives. */
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"])

/**
 * agentic-loop
 *
 * opencode plugin that executes approved plans as an automatic loop:
 *
 *   build → verify → review
 *
 * One command per loop kind: `/agentic-loop:engineering` carries the backlog
 * lifecycle — `new <idea>` interviews the user into a draft, the deterministic
 * unified `approve <id>` parks it planless in `queued/`, the loop plans right
 * before execution (a claimed queued task runs the PLAN stage, writes its
 * `## Implementation Plan`, and parks in `plan-review/`), `approve <id>`
 * again releases it to `in-progress/`, the build-ready queue. `plan <id>`
 * plans one approved task now; `claim` pulls the next item once; `watch
 * [interval]` polls for work — on every `session.idle` event plus a
 * per-session interval timer. Other kinds (`/agentic-loop:pr-sitter`) get the
 * minimal watcher verb set, scoped to their kind. A verify or review FAIL re-builds within the
 * iteration cap. The control surface lives in `loop/driver.ts`; the pure
 * state machine in `loop/state.ts`.
 *
 * This module transitively imports `@agentic-loop/core`'s built `dist/`, so
 * it is loaded DYNAMICALLY by the plugin entry (`index.ts`) — a stale or
 * missing core build must surface as the entry's fail-loud fallback, not
 * kill the whole plugin silently at import time.
 */
export const makeAgenticLoop: Plugin = async ({ client, directory, $ }) => {
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
    (configPromise ??= loadConfig(client, directory)
      .catch(async (err) => {
        await log("warn", `using default config: ${(err as Error).message}`)
        return DEFAULT_CONFIG
      })
      // Export ado.pat → AZURE_DEVOPS_EXT_PAT (when unset) so the sitter's
      // stage-agent curl calls inherit it; the env var always wins.
      .then((config) => {
        applyAdoPatEnv(config)
        return config
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
    // the recover verb resumes it at the exact stage).
    try {
      const tasks = await listInProgress(client, directory, config.tasksDir, log)
      const interrupted = tasks.filter(wasInterrupted).map((t) => t.id)
      if (interrupted.length) {
        await log(
          "warn",
          `interrupted loop task(s) in ${config.tasksDir}/in-progress: ${interrupted.join(", ")} — run /agentic-loop:engineering recover <id> to resume`,
        )
      }
      const snapshots = await listSnapshotIds(client, directory, config.tasksDir)
      if (snapshots.length) {
        await log(
          "warn",
          `loop state snapshot(s) present: ${snapshots.join(", ")} — /agentic-loop:engineering recover <id> resumes at the exact stage`,
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
        await log("warn", `backlog anomaly: ${line} — /agentic-loop:engineering doctor reports and repairs`)
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
              `stale loop worktree ${w.path} (branch ${w.branch ?? "?"}) — no in-progress/in-review task ${id}; /agentic-loop:engineering recover will reuse it, or 'git worktree remove' it`,
            )
          }
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

    "command.execute.before": async (input) => {
      // One command per loop kind: /agentic-loop:engineering, /agentic-loop:pr-sitter, …
      const match = /^agentic-loop:(.+)$/.exec(input.command)
      if (!match) return
      const kind = match[1]!
      const config = await getConfig()
      if (!enabledLoopKinds(config).includes(kind)) {
        await client.tui
          .showToast({
            body: { message: `Unknown loop kind "${kind}" — enabled: ${enabledLoopKinds(config).join(", ")}.`, variant: "warning" },
          })
          .catch(() => {})
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
      const gateFirst = kind === "engineering" && ["approve", "replan"].includes(verb)
      if (!gateFirst) await reconcileOnce()
      await driver.handleCommand(deps, input.sessionID, input.arguments, config, kind)
      if (gateFirst) await reconcileOnce()
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
      // Stage commands run as subtasks, so tool calls arrive with the CHILD
      // session's id — getLoop misses and every per-loop guard below would be
      // silently skipped (the worktree pinning was dead code for stage
      // subagents). Walk the parentID chain to the driving loop, like
      // loop_verdict does; the walk only runs while some loop is live.
      let loop = getLoop(input.sessionID)
      let resolutionFailed = false
      if (!loop && anyLoopActive() && (input.tool === "bash" || EDIT_TOOLS.has(input.tool))) {
        try {
          loop = (await driver.findDrivingLoop(client, input.sessionID))?.state
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
              "agentic-loop: blocked an Azure DevOps write — loops may only read, reply to a comment thread, " +
                "or create a DRAFT PR (curl: GET / POST …/threads… / POST …/pullrequests; az: reads, " +
                "invoke POST to a thread resource, az repos pr create --draft); " +
                "completing/abandoning/approving stays a human call.",
            )
          }
          if (loop && (chainedGithubPrMutation(cmd) || chainedGitPushViolation(cmd))) {
            throw new Error(
              "agentic-loop: blocked a PR-state or protected-branch mutation — the loop never merges, closes, " +
                "approves, force-pushes, or pushes the default branch; those stay a human call.",
            )
          }
          // Worktree bash pin: the session's real cwd is the MAIN tree (the
          // engine only conveys the worktree as prompt text), so a command
          // without the `cd <wt> && ` prefix silently runs outside the
          // isolation. Same fail-closed contract as the edit pin below.
          const bashWt = loop?.git?.worktree
          if (bashWt) {
            const pinVerdict = classifyWorktreeBash(cmd, bashWt)
            if (!pinVerdict.allow) throw new Error(pinVerdict.reason)
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
      if (resolutionFailed && (EDIT_TOOLS.has(input.tool) || input.tool === "bash") && anyWorktreeLoopActive()) {
        // Fail CLOSED on "can't tell": a worktree-isolated loop is live but this
        // session couldn't be attributed to (or cleared of) it — refusing the edit
        // beats risking a silent write to the human's main tree.
        throw new Error(
          "agentic-loop: a worktree-isolated loop is active but this session could not be attributed " +
            "(session lookup failed) — refusing the edit rather than risking a write outside the worktree.",
        )
      }
      const wt = loop?.git?.worktree
      if (!wt || !EDIT_TOOLS.has(input.tool)) return
      const filePath: unknown = output.args?.filePath ?? output.args?.path
      // Fail CLOSED under isolation. A relative path resolves against the session's
      // cwd — the MAIN tree, not the worktree — so it would silently dirty the human's
      // checkout while the loop believes it is isolated; and an edit-shaped tool whose
      // path we can't read (e.g. a multi-file `patch` payload) is unguardable. Both are
      // refused rather than passed through.
      if (typeof filePath !== "string") {
        throw new Error(
          `agentic-loop: this loop is isolated to its worktree ${wt}, but ${input.tool}'s target path could not be ` +
            `determined — pass an absolute path under the worktree.`,
        )
      }
      if (!path.isAbsolute(filePath)) {
        throw new Error(
          `agentic-loop: this loop is isolated to its worktree ${wt} — "${filePath}" is a relative path that resolves ` +
            `against the main tree. Use an absolute path under the worktree.`,
        )
      }
      const rel = path.relative(wt, path.resolve(filePath))
      if (rel === "" || rel.startsWith("..")) {
        throw new Error(
          `agentic-loop: this loop is isolated to its worktree ${wt} — edit ${filePath} is outside it. ` +
            `Use an absolute path under the worktree.`,
        )
      }
      // The worktree carries a checkout-time frozen copy of the backlog; an
      // edit there rides the feature branch and resurrects the task file in
      // the wrong status folder on merge.
      if (isUnderTasksDir(filePath, wt, config.tasksDir)) {
        throw new Error(
          `agentic-loop: task files are driver-owned and live on the main tree — the loop records notes and ` +
            `moves itself; do not edit the worktree's frozen ${config.tasksDir} copy.`,
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
        execute: async (args, ctx) => {
          // Check stages run as subtasks: the call carries the CHILD session's
          // id, so resolve the driving session up the parent chain first — a
          // verdict recorded under the child id would be invisible to the drive.
          const drivingID = await driver.resolveDrivingSession(client, ctx.sessionID)
          return driver.recordVerdict(drivingID, args.stage, {
            verdict: args.verdict,
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
            ...(args.criteria !== undefined ? { criteria: args.criteria } : {}),
          })
        },
      }),
    },
  }
}
