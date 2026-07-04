import type { Plugin } from "@opencode-ai/plugin"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"
import { DEFAULT_CONFIG, loadConfig } from "./config.ts"
import * as driver from "./loop/driver.ts"
import { listWorktrees, pruneWorktrees } from "./loop/git.ts"
import { listSnapshotIds } from "./loop/persist.ts"
import { getLoop, hasLoop } from "./loop/state.ts"
import { listInProgress, wasInterrupted } from "./task/store.ts"

/** Tools that write files — guarded to the worktree while a worktree-mode loop drives. */
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit"])

/**
 * agentic-loop
 *
 * opencode plugin that drives the engineering workflow as an automatic loop:
 *
 *   plan → build → verify → review
 *
 * `/loop <goal>` starts it; the plugin runs plan, pauses for a human
 * plan-approval gate (`/loop go`), then runs build → verify → review
 * to completion. A verify FAIL re-plans; a review FAIL re-builds — both
 * within the iteration cap. The control surface lives in `loop/driver.ts`;
 * the pure state machine in `loop/state.ts`.
 *
 * A free-text `/loop <goal>` doesn't queue that automatic run directly — the
 * command's own turn first decides (per its prompt) whether the goal needs a
 * live `interview-me` pass, then calls the `loop_begin` tool below to
 * actually queue it. That keeps `interview-me`'s live-user requirement out
 * of the unattended `session.idle`-driven stage loop entirely.
 */
export const AgenticLoop: Plugin = async ({ client, directory, $ }) => {
  const service = "agentic-loop"

  const log = (level: "info" | "warn" | "error", message: string) =>
    client.app.log({ body: { service, level, message } })

  // Everything the driver needs from the host, bundled once. `$` (Bun shell) is
  // used to move task files between status folders.
  const deps: driver.Deps = { client, $, directory, log }

  // Load loop config once; fall back to defaults (and warn) on misconfig so a bad
  // config file degrades rather than breaking the plugin entirely.
  let config = DEFAULT_CONFIG
  try {
    config = await loadConfig(client, directory)
  } catch (err) {
    await log("warn", `using default config: ${(err as Error).message}`)
  }

  // Startup reconciliation: a restart mid-BUILD leaves a task in in-progress/
  // with an unmatched "BUILD started" note that no watcher will ever claim.
  // Surface those instead of letting them sit stuck forever.
  try {
    const tasks = await listInProgress(client, directory, config.tasksDir, log)
    const interrupted = tasks.filter(wasInterrupted).map((t) => t.id)
    if (interrupted.length) {
      await log(
        "warn",
        `interrupted loop task(s) in ${config.tasksDir}/in-progress: ${interrupted.join(", ")} — run /loop recover <id> to resume`,
      )
    }
    // A leftover state snapshot is the strongest "this died mid-run" signal —
    // /loop recover will resume it at the exact stage it reached.
    const snapshots = await listSnapshotIds(client, directory, config.tasksDir)
    if (snapshots.length) {
      await log(
        "warn",
        `loop state snapshot(s) present: ${snapshots.join(", ")} — /loop recover <id> resumes at the exact stage`,
      )
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
          `stale loop worktree ${w.path} (branch ${w.branch ?? "?"}) — /loop recover will reuse it, or 'git worktree remove' it`,
        )
      }
    } catch (err) {
      await log("warn", `worktree reconciliation failed: ${(err as Error).message}`)
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const { sessionID } = event.properties
      await driver.onIdle(deps, sessionID, config)
    },

    "command.execute.before": async (input) => {
      if (input.command !== "loop") return
      await driver.handleCommand(deps, input.sessionID, input.arguments, config)
    },

    "tool.execute.before": async (input, output) => {
      // Only trace tool calls while a loop is actively driving this session.
      if (hasLoop(input.sessionID)) {
        await log("info", `tool ${input.tool} starting (call ${input.callID})`)
      }
      // Worktree pinning enforcement (best-effort): while a worktree-mode loop
      // drives this session, a file-writing tool must not touch an absolute
      // path outside the worktree. Relative paths and non-edit tools pass
      // through (bash pinning stays prompt-enforced — a documented residual).
      const wt = getLoop(input.sessionID)?.git?.worktree
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
      loop_begin: tool({
        description:
          "Start the /loop pipeline queued by a /loop <goal> command, once the goal is ready — " +
          "either judged unambiguous per the interview-me skill's own criteria, or confirmed via a " +
          "live interview-me exchange with the user. Call exactly once, at the end of that command's " +
          "own turn, with the final goal text (the confirmed restatement if an interview ran). Never " +
          "call this from inside the automatic plan/build/verify/review stages.",
        args: {
          goal: tool.schema.string().min(1).describe("The final goal text to start the loop with."),
        },
        execute: async (args, ctx) => driver.beginAfterClarification(deps, ctx.sessionID, args.goal),
      }),

      loop_verdict: tool({
        description:
          "Record the VERIFY or REVIEW stage's machine-readable verdict for the running loop. This tool " +
          "call is the loop's ONLY trusted verdict channel — a PASS/FAIL written in plain text is ignored. " +
          "Call exactly once, at the end of the check stage's turn, after gathering the evidence. Only the " +
          "stage the loop is currently running may record; calls from any other stage or session are ignored.",
        args: {
          stage: tool.schema.enum(["verify", "review"]).describe("Which check stage this verdict belongs to."),
          verdict: tool.schema
            .enum(["PASS", "FAIL", "ERROR"])
            .describe(
              "PASS only on observed evidence; FAIL when criteria are unmet; ERROR only when the check itself " +
                "could not run at all (broken environment, missing test runner) — never for failing tests.",
            ),
        },
        execute: async (args, ctx) => driver.recordVerdict(ctx.sessionID, args.stage, args.verdict),
      }),
    },
  }
}
