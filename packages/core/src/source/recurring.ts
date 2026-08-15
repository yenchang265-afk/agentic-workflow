import { acquireOrSweepMarker, releaseMarker, STALE_CLAIM_MINUTES } from "../claim-marker.js"
import type { Client, Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import { describeSchedule, nextDueAt, scheduleError } from "../recurring/schedule.js"
import type { RecurringDef } from "../recurring/schema.js"
import {
  listRecurring,
  loadRecurringLedger,
  recurringMarker,
  saveRecurringLedger,
  type RecurringLedger,
} from "../recurring/store.js"
import { currentBranch, defaultBranchName } from "../workflow/git.js"
import type { CodePlatform, WorkflowState } from "../workflow/state.js"
import { withClaimMarker, type ClaimSkipReason, type TerminalOutcome, type WorkItem, type WorkSource } from "./types.js"

/**
 * The recurring work source: claimable units of work are human-authored
 * definitions under `<recurringDir>/` whose own schedule says they are due.
 *
 * This is the first source in the codebase whose claimable identity is FIXED
 * and re-claimed forever. Every other source derives its work from live
 * external state — a red CI head, a vulnerable package, an open PR — and its
 * ledger exists to make sure a given occurrence is handled exactly once. Here
 * the ledger does the opposite job: it records when the identity last ran, so
 * the schedule can decide when it should run AGAIN.
 *
 * There is no human gate anywhere in the cycle (the manifest has no `park`
 * transition), so a definition goes plan → build → verify → review → publish
 * unattended and lands as a draft PR, exactly like a sitter's output. What a
 * human decides is whether to merge that PR — and whether the definition keeps
 * running at all (`paused`).
 */

/**
 * A cycle-scoped branch name.
 *
 * **This is load-bearing, not cosmetic.** `ensureIsolation` derives an unset
 * branch from the goal's first line, and `addWorktree`/`checkoutBranch` reuse an
 * existing branch AS-IS, never resetting it. A recurring definition's goal is
 * identical on every cycle by design, so a derived name would be the SAME name
 * every time — and cycle 2 would resume on cycle 1's branch, on top of commits
 * that may already be merged. dep-sitter escapes this only because its goal
 * embeds a target version, minting a fresh slug per target.
 *
 * The run token is the claim instant, compacted: sortable, readable in
 * `git branch`, and unique per cycle at second resolution (two cycles of one
 * definition cannot start in the same second — the claim marker serializes them).
 */
export const recurringRunToken = (now: string): string => now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")

/** The branch one cycle of `id` runs on. Pure. */
export const recurringBranch = (id: string, now: string): string => `recurring/${id}-${recurringRunToken(now)}`

/**
 * The goal text one cycle drives toward: the definition's title as the
 * headline, then its body, then its acceptance criteria as prose.
 *
 * Acceptance rides in the GOAL rather than in `state.task.acceptance` because
 * this source sets no `state.task` at all — a fabricated `TaskRef` pointing
 * outside the backlog would reach engineering-specific read sites (audit-note
 * appends, gate moves) that assume a real task file in a status folder. Every
 * sitter already runs with empty `CriteriaContext.acceptance` and folds its
 * constraints into the goal the same way. Pure.
 */
export const recurringGoal = (def: RecurringDef): string => {
  const criteria = def.acceptance.length
    ? `\n\nThis cycle is done when:\n${def.acceptance.map((a) => `- ${a}`).join("\n")}`
    : ""
  return (
    `${def.title}\n\n${def.body}${criteria}\n\n` +
    `This is a RECURRING work order (${describeSchedule(def.schedule)}) — it runs again on its own schedule, ` +
    `so scope this cycle to what is true NOW rather than trying to make the change permanent for all future runs. ` +
    `Finish by pushing the branch and opening a DRAFT pull request; never merge it.`
  )
}

interface RecurringSourceDeps {
  readonly $: Shell
  readonly client: Client
  readonly directory: string
  readonly recurringDir: string
  readonly log: Log
  readonly loaded: LoadedManifest
  /** Claim-marker stale window (`staleClaimMinutes`, threaded from `buildWorkSources`); unset ⇒ the bare 15m constant. */
  readonly staleMinutes?: number
  /** The resolved code platform (`platformFor(config, kind)`) stamped onto entry state; defaults to `github`. */
  readonly platform?: CodePlatform
  /** Clock injection for ledger stamps and due-checks; defaults to the real time. */
  readonly now?: () => string
}

export const makeRecurringSource = (deps: RecurringSourceDeps): WorkSource => {
  const { $, client, directory, recurringDir, log, loaded } = deps
  if (loaded.manifest.workSource.type !== "recurring-task") {
    throw new Error(`workflow kind "${loaded.manifest.kind}" does not use a recurring-task work source`)
  }
  const kind = loaded.manifest.kind
  const now = deps.now ?? (() => new Date().toISOString())
  const platform: CodePlatform = deps.platform ?? "github"
  const marker = (id: string): string => recurringMarker(directory, recurringDir, id)
  const claim = (id: string): Promise<boolean> =>
    acquireOrSweepMarker($, marker(id), deps.staleMinutes ?? STALE_CLAIM_MINUTES)

  const workItem = async (def: RecurringDef, at: string): Promise<WorkItem> => {
    // Cut from the repo's default branch when we can name it, else whatever is
    // checked out — the same base every sitter's PR is measured against.
    const base = (await defaultBranchName($, directory)) ?? (await currentBranch($, directory)) ?? "HEAD"
    const state: WorkflowState = {
      kind,
      goal: recurringGoal(def),
      stage: loaded.manifest.stages[0]?.name ?? "plan",
      iteration: 0,
      artifacts: {},
      // Pre-set, never derived — see `recurringBranch`.
      git: { base, branch: recurringBranch(def.id, at) },
      platform,
    }
    return {
      id: def.id,
      workflowKind: kind,
      title: def.title,
      entryStage: state.stage,
      state,
      claimMessage: `Watch: claimed recurring "${def.title}" (${describeSchedule(def.schedule)})`,
      ref: { id: def.id },
    }
  }

  return {
    workflowKind: kind,

    async claimNext() {
      const at = now()
      const clock = new Date(Date.parse(at))
      const defs = await listRecurring(client, directory, recurringDir, log)
      if (defs.length === 0) {
        return {
          item: null,
          skip: { message: `${kind}: no recurring definitions in ${recurringDir}/`, actionable: false },
        }
      }

      const due: { def: RecurringDef; dueAt: Date }[] = []
      let paused = 0
      for (const def of defs) {
        if (def.paused) {
          paused += 1
          continue
        }
        // A broken schedule is reported, never silently skipped forever: it is
        // the one failure mode a human cannot see from the outside (the
        // definition simply never runs).
        const broken = scheduleError(def.schedule)
        if (broken) {
          await log("warn", `${kind}: ${def.id} has an unusable schedule — ${broken}`)
          continue
        }
        const ledger = await loadRecurringLedger(client, directory, recurringDir, def.id, at)
        const dueAt = nextDueAt(def.schedule, ledger.lastRunAt, clock)
        if (dueAt && dueAt.getTime() <= clock.getTime()) due.push({ def, dueAt })
      }

      // Longest-overdue first, so a backlog of due items drains in the order
      // they came due rather than alphabetically.
      due.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.def.id.localeCompare(b.def.id))

      const held: string[] = []
      for (const { def } of due) {
        if (!(await claim(def.id))) {
          held.push(def.id)
          continue
        }
        return { item: withClaimMarker(await workItem(def, at), marker(def.id)), skip: null }
      }

      if (held.length) {
        return { item: null, skip: { message: `${kind}: claim marker held for ${held.join(", ")}`, actionable: true } }
      }
      const pausedNote = paused ? `, ${String(paused)} paused` : ""
      return {
        item: null,
        skip: {
          message: `${kind}: nothing due (${String(defs.length)} defined${pausedNote})`,
          actionable: false,
        } satisfies ClaimSkipReason,
      }
    },

    async release(work) {
      const { id } = work.ref as { id: string }
      await releaseMarker($, marker(id))
    },

    async onTerminal(work, outcome: TerminalOutcome) {
      const { id } = work.ref as { id: string }
      const at = now()
      const ledger = await loadRecurringLedger(client, directory, recurringDir, id, at)
      // A retryable stop (transient onError, human ESC) leaves the ledger
      // untouched, so this definition is still due on the very next poll — the
      // same contract every sitter's ledger has. Anything else advances
      // `lastRunAt`: a cycle that genuinely ran, even one the iteration cap
      // stopped, must wait for its next scheduled occurrence rather than
      // re-firing on every tick.
      if (outcome.kind !== "done" && outcome.retryable) {
        await releaseMarker($, marker(id))
        return
      }
      const done = outcome.kind === "done"
      const updated: RecurringLedger = {
        ...ledger,
        lastRunAt: at,
        lastOutcome: done ? "done" : outcome.kind === "error" ? "error" : "stop",
        lastMessage: outcome.message,
        consecutiveFailures: done ? 0 : ledger.consecutiveFailures + 1,
        updatedAt: at,
      }
      await saveRecurringLedger($, directory, recurringDir, updated)
      if (!done) {
        await log(
          "warn",
          `${kind}: ${id} cycle ended ${outcome.kind} (${String(updated.consecutiveFailures)} in a row) — ` +
            `it keeps its schedule; pause it if the failure is persistent.`,
        )
      }
      await releaseMarker($, marker(id))
    },
  }
}
