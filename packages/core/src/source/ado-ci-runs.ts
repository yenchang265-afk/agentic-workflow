import { z } from "zod"
import { acquireOrSweepMarker, releaseMarker, STALE_CLAIM_MINUTES } from "../claim-marker.js"
import type { Client, Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import type { AdoConfig } from "../workflow/state.js"
import { newestHeadVerdict, shortSha, type CiRun } from "./ci-runs.js"
import { loadHeadLedger, redHeadWorkItem, saveHeadLedger } from "./ci-runs-shared.js"
import { AdoBuildListSchema, adoList, normalizeAdoBuild } from "./ado-shared.js"
import type { AdoGateway } from "./ado-gateway.js"
import { withClaimMarker, type TerminalOutcome, type WorkSource } from "./types.js"

/**
 * The Azure DevOps CI-runs work source: the `gh`-backed `ci-runs.ts` mirrored
 * onto the Azure DevOps Build REST API. Selected at wiring time when config
 * `codePlatform` resolves to `"ado"` for a `ci-runs`-bound workflow kind
 * (main-sitter).
 *
 * Raw ADO builds are normalized (`normalizeAdoBuild`, `ado-shared.ts`) into the
 * same `CiRun` shape the GitHub source produces, so `newestHeadVerdict` judges
 * both platforms identically, and the ledger/claim/WorkItem mechanics are
 * shared verbatim via `ci-runs-shared.ts`.
 *
 * Transport is the `AdoGateway` port — the Azure DevOps MCP server, same rules
 * as `ado-pr.ts`. Unlike the PR sources, no `ado.selfLogin` is needed: CI status
 * isn't scoped to an identity, only to the watched branch.
 */

/** How many recent builds on the watched branch to judge. */
const BUILD_LOOKBACK = 30

interface AdoCiRunsDeps {
  readonly $: Shell
  readonly client: Client
  readonly directory: string
  readonly tasksDir: string
  readonly log: Log
  readonly loaded: LoadedManifest
  /** Claim-marker stale window (`staleClaimMinutes`, threaded from `buildWorkSources`); unset ⇒ the bare 15m constant. */
  readonly staleMinutes?: number
  /** Azure DevOps coordinates (config `ado`). */
  readonly ado: AdoConfig
  /** The Azure DevOps MCP gateway every call goes through. */
  readonly gateway: AdoGateway
  /** Config override of the manifest's watched branch (`workflows.<kind>.branch`). */
  readonly branch?: string
  /** Clock injection for ledger stamps; defaults to the real time. */
  readonly now?: () => string
}

export const makeAdoCiRunsSource = (deps: AdoCiRunsDeps): WorkSource => {
  const { $, client, directory, tasksDir, log, loaded, ado, gateway } = deps
  const binding = loaded.manifest.workSource
  if (binding.type !== "ci-runs") {
    throw new Error(`workflow kind "${loaded.manifest.kind}" does not use a ci-runs work source`)
  }
  const kind = loaded.manifest.kind
  const now = deps.now ?? (() => new Date().toISOString())
  const project = ado.project
  const claimsDir = `${directory}/${tasksDir}/runs/${kind}/.claims`
  const headMarker = (sha: string): string => `${claimsDir}/head-${shortSha(sha)}`
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
    workflowKind: kind,

    async claimNext() {
      const b = await branch()
      const out = await gateway.listBuilds({ project, branchName: `refs/heads/${b}`, top: BUILD_LOOKBACK })
      if (!out.ok) {
        return {
          item: null,
          skip: {
            message:
              `${kind}: Azure DevOps build list failed — ${out.error}. ` +
              `Is the Azure DevOps MCP server reachable with a token that has Build (read) scope, ` +
              `and are ado.organization/project correct?`,
            actionable: true,
          },
        }
      }
      let builds: z.infer<typeof AdoBuildListSchema>
      try {
        builds = AdoBuildListSchema.parse(adoList(out.data))
      } catch (err) {
        return {
          item: null,
          skip: { message: `${kind}: could not parse the ADO response — ${(err as Error).message}`, actionable: true },
        }
      }
      const runs: CiRun[] = builds.map(normalizeAdoBuild)
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
      // The stamped, sweep-aware helper — NEVER a bare mkdir/rmdir pair (the
      // CLAUDE.md atomic-helpers rule): a SIGKILL between claim and release
      // used to leave this marker on disk forever, and that head was never
      // remedied again without a human `rm -rf`.
      if (!(await acquireOrSweepMarker($, headMarker(judged.sha), deps.staleMinutes ?? STALE_CLAIM_MINUTES))) {
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
        await releaseMarker($, headMarker(judged.sha))
        return { item: null, skip: { message: `${kind}: ${b} moved during claim — retrying next poll`, actionable: false } }
      }
      // `branch -f` would silently discard prior remedy commits when the same
      // head is re-claimed (possible after head-ledger loss): if the branch
      // already contains the red head, earlier remedy work sits on top of it —
      // reuse the branch instead of resetting it.
      const already = await $`git -C ${directory} merge-base --is-ancestor ${judged.sha} ${remedyBranch}`.quiet().nothrow()
      if (already.exitCode !== 0) {
        const pin = await $`git -C ${directory} branch -f ${remedyBranch} ${judged.sha}`.quiet().nothrow()
        if (pin.exitCode !== 0) {
          await log("warn", `${kind}: could not pin ${remedyBranch} at ${shortSha(judged.sha)} — skipping`)
          await releaseMarker($, headMarker(judged.sha))
          return { item: null, skip: { message: `${kind}: could not pin the red head locally`, actionable: true } }
        }
      }
      return {
        item: withClaimMarker(
          redHeadWorkItem(loaded, "ado", b, judged.sha, judged.failing, { project, repository: ado.repository ?? "" }),
          headMarker(judged.sha),
        ),
        skip: null,
      }
    },

    async release(work) {
      const { sha } = work.ref as { sha: string }
      await releaseMarker($, headMarker(sha))
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
