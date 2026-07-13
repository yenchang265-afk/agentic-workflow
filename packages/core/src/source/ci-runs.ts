import { z } from "zod"
import type { Client, Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import { loadHeadLedger, redHeadWorkItem, saveHeadLedger, shortSha } from "./ci-runs-shared.js"
import type { ClaimSkipReason, TerminalOutcome, WorkSource } from "./types.js"

export { shortSha }

/**
 * The CI-runs work source (main-sitter): a claimable unit of work is the
 * watched branch's CURRENT head when its completed CI runs conclude red
 * (`gh run list`). Only the newest head is ever considered — a red run on an
 * older commit is moot once a newer push exists, and a green re-run on the
 * same head retires it naturally because the latest run per workflow is what
 * gets judged. A head with runs still in flight is left alone: racing live CI
 * would diagnose a moving target.
 *
 * Dedup rides a per-head ledger under `<tasksDir>/runs/<kind>/head-<sha>.json`
 * — a diagnosed (or failed) head is never re-claimed; the next human push
 * makes a new head and a fresh judgement. The ledger, claim-marker shape, and
 * WorkItem builder are shared with the Azure DevOps sibling (`ado-ci-runs.ts`)
 * via `ci-runs-shared.ts`; `newestHeadVerdict` below judges both platforms
 * identically once their raw output is normalized into `CiRun`.
 *
 * At claim the source fetches the branch and pins a local `<kind>/<sha>`
 * branch to the red head, pre-setting `state.git` so the standard isolation
 * path checks the failing commit out in the loop's worktree. The remedy lands
 * on that branch as a draft fix/revert PR — the watched branch itself is NEVER
 * pushed.
 */

const RunListSchema = z.array(
  z.object({
    headSha: z.string().default(""),
    status: z.string().default(""),
    conclusion: z.string().nullish(),
    workflowName: z.string().default(""),
    createdAt: z.string().default(""),
  }),
)
export type CiRun = z.infer<typeof RunListSchema>[number]

const FAILING = new Set(["failure", "timed_out"])

/**
 * Judge the branch's newest head from its recent runs: the verdict is `red`
 * when the latest completed run of any watched workflow failed, `pending`
 * when anything on that head is still in flight, `green` otherwise. Pure.
 */
export const newestHeadVerdict = (
  runs: readonly CiRun[],
  workflows: readonly string[],
): { sha: string; verdict: "red" | "green" | "pending"; failing: string[] } | null => {
  const watched = workflows.length ? runs.filter((r) => workflows.includes(r.workflowName)) : runs
  const sorted = [...watched].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  const sha = sorted[0]?.headSha
  if (!sha) return null
  const onHead = sorted.filter((r) => r.headSha === sha)
  if (onHead.some((r) => r.status !== "completed")) return { sha, verdict: "pending", failing: [] }
  const latestPerWorkflow = new Map<string, CiRun>()
  for (const r of onHead) {
    if (!latestPerWorkflow.has(r.workflowName)) latestPerWorkflow.set(r.workflowName, r)
  }
  const failing = [...latestPerWorkflow.values()]
    .filter((r) => FAILING.has((r.conclusion ?? "").toLowerCase()))
    .map((r) => r.workflowName)
    .filter(Boolean)
  return { sha, verdict: failing.length ? "red" : "green", failing }
}

interface CiRunsDeps {
  readonly $: Shell
  readonly client: Client
  readonly directory: string
  readonly tasksDir: string
  readonly log: Log
  readonly loaded: LoadedManifest
  /** Config override of the manifest's watched branch (`loops.<kind>.branch`). */
  readonly branch?: string
  /** Clock injection for ledger stamps; defaults to the real time. */
  readonly now?: () => string
}

export const makeCiRunsSource = (deps: CiRunsDeps): WorkSource => {
  const { $, client, directory, tasksDir, log, loaded } = deps
  const binding = loaded.manifest.workSource
  if (binding.type !== "ci-runs") {
    throw new Error(`loop kind "${loaded.manifest.kind}" does not use a ci-runs work source`)
  }
  const kind = loaded.manifest.kind
  const now = deps.now ?? (() => new Date().toISOString())
  const claimsDir = `${directory}/${tasksDir}/runs/${kind}/.claims`
  let resolvedBranch: string | null = null

  const branch = async (): Promise<string> => {
    if (resolvedBranch) return resolvedBranch
    const configured = deps.branch ?? binding.branch
    if (configured) {
      resolvedBranch = configured
      return resolvedBranch
    }
    // The remote default branch, read from origin/HEAD; "main" when unset.
    const out = await $`git -C ${directory} symbolic-ref refs/remotes/origin/HEAD`.quiet().nothrow()
    const ref = out.exitCode === 0 ? out.stdout.toString().trim() : ""
    resolvedBranch = ref.replace(/^refs\/remotes\/origin\//, "") || "main"
    return resolvedBranch
  }

  return {
    loopKind: kind,

    async claimNext() {
      const b = await branch()
      const fields = "headSha,status,conclusion,workflowName,createdAt"
      const out = await $`gh run list --branch ${b} --limit 30 --json ${fields}`.cwd(directory).quiet().nothrow()
      if (out.exitCode !== 0) {
        return {
          item: null,
          skip: {
            message: `${kind}: gh run list failed — ${out.stderr.toString().trim() || "is gh authenticated?"}`,
            actionable: true,
          } satisfies ClaimSkipReason,
        }
      }
      let runs: z.infer<typeof RunListSchema>
      try {
        runs = RunListSchema.parse(JSON.parse(out.stdout.toString() || "[]"))
      } catch (err) {
        return {
          item: null,
          skip: { message: `${kind}: could not parse gh output — ${(err as Error).message}`, actionable: true },
        }
      }
      const judged = newestHeadVerdict(runs, binding.workflows)
      if (!judged) {
        return { item: null, skip: { message: `${kind}: no CI runs on ${b} yet`, actionable: false } }
      }
      if (judged.verdict !== "red") {
        return {
          item: null,
          skip: { message: `${kind}: ${b} is ${judged.verdict} at ${shortSha(judged.sha)}`, actionable: false },
        }
      }
      const ledger = await loadHeadLedger(client, directory, tasksDir, kind, judged.sha, now())
      if (ledger.handled || ledger.failedAttempts.length) {
        return {
          item: null,
          skip: {
            message: `${kind}: red head ${shortSha(judged.sha)} already handled — waiting for a new push`,
            actionable: false,
          },
        }
      }
      await $`mkdir -p ${claimsDir}`.quiet().nothrow()
      const marker = await $`mkdir ${`${claimsDir}/head-${shortSha(judged.sha)}`}`.quiet().nothrow()
      if (marker.exitCode !== 0) {
        return {
          item: null,
          skip: { message: `${kind}: claim marker held for head-${shortSha(judged.sha)}`, actionable: true },
        }
      }
      // Pin the red head to a local branch for isolation. If the branch tip
      // moved since the poll, a newer push exists — release and let the next
      // poll judge the new head instead.
      const remedyBranch = `${kind}/${shortSha(judged.sha)}`
      await $`git -C ${directory} fetch origin ${b}`.quiet().nothrow()
      const tip = await $`git -C ${directory} rev-parse ${`refs/remotes/origin/${b}`}`.quiet().nothrow()
      if (tip.exitCode !== 0 || tip.stdout.toString().trim() !== judged.sha) {
        await log("info", `${kind}: ${b} moved past ${shortSha(judged.sha)} — re-judging on the next poll`)
        await $`rmdir ${`${claimsDir}/head-${shortSha(judged.sha)}`}`.quiet().nothrow()
        return { item: null, skip: { message: `${kind}: ${b} moved during claim — retrying next poll`, actionable: false } }
      }
      const pin = await $`git -C ${directory} branch -f ${remedyBranch} ${judged.sha}`.quiet().nothrow()
      if (pin.exitCode !== 0) {
        await log("warn", `${kind}: could not pin ${remedyBranch} at ${shortSha(judged.sha)} — skipping`)
        await $`rmdir ${`${claimsDir}/head-${shortSha(judged.sha)}`}`.quiet().nothrow()
        return { item: null, skip: { message: `${kind}: could not pin the red head locally`, actionable: true } }
      }
      return { item: redHeadWorkItem(loaded, "github", b, judged.sha, judged.failing), skip: null }
    },

    async release(work) {
      const { sha } = work.ref as { sha: string }
      await $`rmdir ${`${claimsDir}/head-${shortSha(sha)}`}`.quiet().nothrow()
    },

    async onTerminal(work, outcome: TerminalOutcome) {
      const { sha } = work.ref as { sha: string }
      const ledger = await loadHeadLedger(client, directory, tasksDir, kind, sha, now())
      // A retryable stop (transient onError / interrupt) leaves the ledger untouched so
      // the next poll re-claims this head; only done and a genuine (cap) stop update it.
      const updated =
        outcome.kind === "done"
          ? { ...ledger, handled: true, updatedAt: now() }
          : outcome.retryable
            ? ledger
            : { ...ledger, failedAttempts: [...ledger.failedAttempts, { at: now() }], updatedAt: now() }
      if (updated !== ledger) await saveHeadLedger($, directory, tasksDir, kind, updated)
      await $`rmdir ${`${claimsDir}/head-${shortSha(sha)}`}`.quiet().nothrow()
    },
  }
}
