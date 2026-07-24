import { z } from "zod"
import type { Client, Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import type { AdoConfig } from "../workflow/state.js"
import { newestHeadVerdict, shortSha, type CiRun } from "./ci-runs.js"
import { loadHeadLedger, redHeadWorkItem, saveHeadLedger } from "./ci-runs-shared.js"
import { AdoBuildListSchema, normalizeAdoBuild } from "./ado-shared.js"
import { azInvokeArgs, azToHttp, execAz, type AzExec } from "./ado-az.js"
import type { ClaimSkipReason, TerminalOutcome, WorkSource } from "./types.js"

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
 * Transport is the az CLI (same as `ado-pr.ts`), which carries its own auth —
 * the pre-provisioned `AZURE_DEVOPS_EXT_PAT`, or an interactive `az login`.
 * Unlike the PR sources, no `ado.selfLogin` is needed — CI status isn't scoped
 * to an identity, only to the watched branch.
 */

interface AdoCiRunsDeps {
  readonly $: Shell
  readonly client: Client
  readonly directory: string
  readonly tasksDir: string
  readonly log: Log
  readonly loaded: LoadedManifest
  /** Azure DevOps coordinates (config `ado`). */
  readonly ado: AdoConfig
  /** az CLI runner; defaults to the real CLI. Tests script this instead of touching the network. */
  readonly azExec?: AzExec
  /** Config override of the manifest's watched branch (`workflows.<kind>.branch`). */
  readonly branch?: string
  /** Clock injection for ledger stamps; defaults to the real time. */
  readonly now?: () => string
}

export const makeAdoCiRunsSource = (deps: AdoCiRunsDeps): WorkSource => {
  const { $, client, directory, tasksDir, log, loaded, ado } = deps
  const binding = loaded.manifest.workSource
  if (binding.type !== "ci-runs") {
    throw new Error(`workflow kind "${loaded.manifest.kind}" does not use a ci-runs work source`)
  }
  const kind = loaded.manifest.kind
  const now = deps.now ?? (() => new Date().toISOString())
  const org = ado.organization.replace(/\/+$/, "")
  const claimsDir = `${directory}/${tasksDir}/runs/${kind}/.claims`
  let resolvedBranch: string | null = null

  // Every data call shells the az CLI, which carries its own auth (see ado-az.ts).
  const az = deps.azExec ?? execAz

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
      // No credential pre-check: the az CLI owns auth (AZURE_DEVOPS_EXT_PAT or
      // an interactive `az login`), so testing for a PAT here would refuse to
      // claim in a working `az login` environment. A genuinely broken one
      // surfaces as the failed list call below, with the CLI's own message.
      const b = await branch()
      const out = azToHttp(
        await az(
          azInvokeArgs({
            area: "build",
            resource: "builds",
            organization: org,
            routeParameters: { project: ado.project },
            queryParameters: { branchName: `refs/heads/${b}`, $top: "30", queryOrder: "queueTimeDescending" },
          }),
        ),
      )
      if (!out.ok) {
        return {
          item: null,
          skip: {
            message:
              `${kind}: Azure DevOps build list failed (az CLI) — ${out.statusText}. ` +
              `Is the az CLI installed with the azure-devops extension and authenticated ` +
              `(AZURE_DEVOPS_EXT_PAT with Build (read) scope, or \`az login\`), and are ` +
              `ado.organization/project correct?`,
            actionable: true,
          } satisfies ClaimSkipReason,
        }
      }
      let builds: z.infer<typeof AdoBuildListSchema>
      try {
        const json = JSON.parse(out.body || "{}") as { value?: unknown }
        builds = AdoBuildListSchema.parse(json.value ?? [])
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
      // `branch -f` would silently discard prior remedy commits when the same
      // head is re-claimed (possible after head-ledger loss): if the branch
      // already contains the red head, earlier remedy work sits on top of it —
      // reuse the branch instead of resetting it.
      const already = await $`git -C ${directory} merge-base --is-ancestor ${judged.sha} ${remedyBranch}`.quiet().nothrow()
      if (already.exitCode !== 0) {
        const pin = await $`git -C ${directory} branch -f ${remedyBranch} ${judged.sha}`.quiet().nothrow()
        if (pin.exitCode !== 0) {
          await log("warn", `${kind}: could not pin ${remedyBranch} at ${shortSha(judged.sha)} — skipping`)
          await $`rmdir ${`${claimsDir}/head-${shortSha(judged.sha)}`}`.quiet().nothrow()
          return { item: null, skip: { message: `${kind}: could not pin the red head locally`, actionable: true } }
        }
      }
      return { item: redHeadWorkItem(loaded, "ado", b, judged.sha, judged.failing), skip: null }
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
