import { z } from "zod"
import type { Client, Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import type { AdoConfig } from "../workflow/state.js"
import { attentionTriggers, loadLedger, saveLedger, type PrSnapshot, type PrTrigger } from "./ledger.js"
import { fetchHead, makeClaimMarkers, prWorkItem, terminalLedgerUpdate } from "./pr-shared.js"
import { azInvokeArgs, azToHttp, execAz, type AzExec } from "./ado-az.js"
import {
  AdoPolicySchema,
  AdoPrListSchema,
  AdoThreadsSchema,
  failingPolicyNames,
  flattenThreadComments,
  newerThan,
  sameLogin,
  stripRef,
} from "./ado-shared.js"
import type { ClaimSkipReason, TerminalOutcome, WorkSource } from "./types.js"

/**
 * The Azure DevOps PR work source: the `gh`-backed `github-pr.ts` mirrored onto
 * Azure DevOps. Selected at wiring time when config `codePlatform` resolves to
 * `"ado"` for a `pull-request`-bound workflow kind.
 *
 * Raw ADO output is normalized into the same `PrSnapshot` shape the ledger
 * judges (`conflicts` → `CONFLICTING`, a negative reviewer vote →
 * `CHANGES_REQUESTED`), so the dedup decision (`attentionTriggers`) and the
 * claim/fetch/terminal mechanics (`pr-shared.ts`) are shared verbatim.
 *
 * Every call goes through the `az` CLI's `devops invoke` REST passthrough (see
 * `ado-az.ts`), which carries its own auth — the pre-provisioned
 * `AZURE_DEVOPS_EXT_PAT` that the azure-devops extension honors, or an
 * interactive `az login`. Because the CLI owns auth, this source never handles
 * the PAT itself and never gates a claim on one being set; a broken
 * environment surfaces as a failed list call, with the CLI's own message.
 *
 * A PAT carries no reliable email identity, so the sitter's own login is
 * config-supplied (`ado.selfLogin`, required for this platform — enforced in
 * `config.ts`). Unlike GitHub's `statusCheckRollup`, check state comes from a
 * per-PR `policy/evaluations` call, and comments from the `pullRequestThreads`
 * resource.
 */

/** The post-run PR re-read — validated so a type-confused body degrades to the
 *  snapshot fallback like a parse failure, never flows on as a trusted head. */
const AdoFreshPrSchema = z.object({
  lastMergeSourceCommit: z.object({ commitId: z.string().optional() }).optional(),
  repository: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
})

/**
 * Active-PR list paging. ADO caps `$top` at 100 and offers no server-side
 * search, so the identity/role filter runs client-side over the whole set —
 * every page must be fetched or work goes silently unseen. `PR_MAX_PAGES` is a
 * runaway guard, not a policy: hitting it is warned about, never passed off as
 * the complete set.
 */
const PR_PAGE_SIZE = 100
const PR_MAX_PAGES = 10

interface AdoPrDeps {
  readonly $: Shell
  readonly client: Client
  readonly directory: string
  readonly tasksDir: string
  readonly log: Log
  readonly loaded: LoadedManifest
  /** Azure DevOps coordinates (config `ado`); `selfLogin` is required for this platform. */
  readonly ado: AdoConfig
  /** az CLI runner; defaults to the real CLI. Tests script this instead of touching the network. */
  readonly azExec?: AzExec
  /** Clock injection for ledger stamps; defaults to the real time. */
  readonly now?: () => string
}

export const makeAdoPrSource = (deps: AdoPrDeps): WorkSource => {
  const { $, client, directory, tasksDir, log, loaded, ado } = deps
  const binding = loaded.manifest.workSource
  if (binding.type !== "pull-request") {
    throw new Error(`workflow kind "${loaded.manifest.kind}" does not use a pull-request work source`)
  }
  const kind = loaded.manifest.kind
  const role = binding.role
  const now = deps.now ?? (() => new Date().toISOString())
  const org = ado.organization.replace(/\/+$/, "")
  const login = ado.selfLogin ?? ""

  const markers = makeClaimMarkers($, directory, tasksDir, kind)

  // Every data call shells the az CLI, which carries its own auth. `az devops
  // invoke` is a REST passthrough, so responses arrive in the same JSON
  // envelopes the service returns and share `ado-shared.ts`'s schema parsing.
  const az = deps.azExec ?? execAz

  /** One page of the active-PR list. */
  const listPrsPage = (skip: number): Promise<{ ok: boolean; status: number; statusText: string; body: string }> =>
    az(
      azInvokeArgs({
        area: "git",
        resource: "pullrequests",
        organization: org,
        routeParameters: {
          project: ado.project,
          ...(ado.repository ? { repositoryId: ado.repository } : {}),
        },
        queryParameters: { "searchCriteria.status": "active", $top: String(PR_PAGE_SIZE), $skip: String(skip) },
      }),
    ).then(azToHttp)

  /** Names of blocking policies currently failing on the PR (ADO's nearest equivalent of failing checks). */
  const failingPolicies = async (projectId: string, pr: number): Promise<string[]> => {
    if (!projectId) return []
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${pr}`
    const out = azToHttp(
      await az(
        azInvokeArgs({
          area: "policy",
          resource: "evaluations",
          organization: org,
          routeParameters: { project: ado.project },
          queryParameters: { artifactId },
        }),
      ),
    )
    if (!out.ok) return []
    try {
      const json = JSON.parse(out.body || "{}") as { value?: unknown }
      return failingPolicyNames(AdoPolicySchema.parse(json.value ?? []))
    } catch {
      return []
    }
  }

  /** Non-system PR thread comments, flattened to `{ author, at }`, from the `pullRequestThreads` resource. */
  const threadComments = async (repositoryId: string, pr: number): Promise<{ author: string; at: string }[]> => {
    if (!repositoryId) return []
    const out = azToHttp(
      await az(
        azInvokeArgs({
          area: "git",
          resource: "pullRequestThreads",
          organization: org,
          routeParameters: { project: ado.project, repositoryId, pullRequestId: String(pr) },
        }),
      ),
    )
    if (!out.ok) return []
    try {
      const threads = AdoThreadsSchema.parse(JSON.parse(out.body || "{}"))
      return flattenThreadComments(threads.value ?? [])
    } catch {
      return []
    }
  }

  return {
    workflowKind: kind,

    async claimNext() {
      // No credential pre-check: the az CLI owns auth (AZURE_DEVOPS_EXT_PAT or
      // an interactive `az login`), so testing for a PAT here would refuse to
      // claim in a perfectly working `az login` environment. A genuinely broken
      // one surfaces as a failed list call below, carrying the CLI's own message.
      if (!login) {
        // A PAT can't resolve the sitter's own identity; config.ts enforces this,
        // and this is the defensive guard for direct construction.
        return {
          item: null,
          skip: {
            message:
              `${kind}: could not resolve the sitter's own ADO identity (a PAT cannot) — ` +
              `set ado.selfLogin in .agentic-workflow.json so the sitter claims only the PRs its role names.`,
            actionable: true,
          } satisfies ClaimSkipReason,
        }
      }
      // Page with `$skip` until a short page arrives. ADO has no server-side
      // search, so the `role` identity filter runs client-side over the WHOLE
      // set — stopping at the first 100 made a PR at position 140 that needed
      // attention permanently invisible, with no error and no warning.
      const prs: z.infer<typeof AdoPrListSchema> = []
      let truncated = false
      for (let page = 0; page < PR_MAX_PAGES; page++) {
        const out = await listPrsPage(page * PR_PAGE_SIZE)
        if (!out.ok) {
          return {
            item: null,
            skip: {
              message:
                `${kind}: Azure DevOps pull-request list failed (az CLI) — ${out.statusText}. ` +
                `Is the az CLI installed with the azure-devops extension and authenticated ` +
                `(AZURE_DEVOPS_EXT_PAT with Code (read) scope, or \`az login\`), and are ` +
                `ado.organization/project correct?`,
              actionable: true,
            } satisfies ClaimSkipReason,
          }
        }
        let batch: z.infer<typeof AdoPrListSchema>
        try {
          const json = JSON.parse(out.body || "{}") as { value?: unknown }
          batch = AdoPrListSchema.parse(json.value ?? [])
        } catch (err) {
          return {
            item: null,
            skip: { message: `${kind}: could not parse the ADO response — ${(err as Error).message}`, actionable: true },
          }
        }
        prs.push(...batch)
        if (batch.length < PR_PAGE_SIZE) break
        // A full last page means there may be more behind it.
        if (page === PR_MAX_PAGES - 1) truncated = true
      }
      if (truncated) {
        await log(
          "warn",
          `${kind}: the active-PR list hit the ${PR_MAX_PAGES * PR_PAGE_SIZE}-PR ceiling — results are TRUNCATED ` +
            `and a PR needing attention may be invisible to this sitter. Scope the sitter to a single repository ` +
            `(ado.repository) so the set fits.`,
        )
      }
      const heldIds: string[] = []
      for (const pr of prs.sort((a, b) => a.pullRequestId - b.pullRequestId)) {
        if (pr.isDraft) continue
        // Fork PRs are skipped for every role: an author-role kind can't push the
        // head branch, and a reviewer-role kind would execute untrusted fork code
        // in its assess worktree (threat model T10).
        if (pr.forkSource != null) continue
        // ADO has no server-side search query, so the manifest's `role` picks the
        // client-side identity filter: author-role kinds claim their own PRs
        // (parity with gh's author:@me); reviewer-role kinds claim other people's
        // PRs on which selfLogin is listed as a reviewer whose vote is still
        // pending — vote 0 is ADO's "review not cast yet", the nearest mirror of
        // GitHub's review-requested:@me dropping a PR once the review is submitted.
        if (role === "reviewer") {
          if (sameLogin(pr.createdBy?.uniqueName ?? "", login)) continue
          const mine = (pr.reviewers ?? []).find((r) => sameLogin(r.uniqueName, login))
          if (!mine || mine.vote !== 0) continue
        } else if (!sameLogin(pr.createdBy?.uniqueName ?? "", login)) {
          continue
        }
        const number = pr.pullRequestId
        const headRefOid = pr.lastMergeSourceCommit?.commitId ?? ""
        // No head SHA yet (merge evaluation queued / never run): the snapshot
        // isn't ready — a "" head would poison the ledger's dedup. Next poll.
        if (!headRefOid) continue
        const ledger = await loadLedger(client, directory, tasksDir, kind, number, now())
        const watermark = ledger.lastCommentAtHandled ?? ""
        const enabled = binding.triggers
        const repositoryId = pr.repository?.id || pr.repository?.name || ""
        const comments = enabled.includes("new-comments") ? await threadComments(repositoryId, number) : []
        const snapshot: PrSnapshot = {
          number,
          title: pr.title,
          headRefName: stripRef(pr.sourceRefName),
          baseRefName: stripRef(pr.targetRefName),
          headRefOid,
          mergeable: (pr.mergeStatus ?? "").toLowerCase() === "conflicts" ? "CONFLICTING" : "MERGEABLE",
          reviewDecision: (pr.reviewers ?? []).some((r) => r.vote < 0) ? "CHANGES_REQUESTED" : "",
          failingChecks: enabled.includes("failing-checks")
            ? await failingPolicies(pr.repository?.project?.id ?? "", number)
            : [],
          newComments: comments.filter((c) => !sameLogin(c.author, login) && newerThan(c.at, watermark)),
        }
        const triggers = attentionTriggers(snapshot, ledger, binding.triggers)
        if (triggers.length === 0) continue
        if (!(await markers.claim(number))) {
          heldIds.push(`pr-${number}`)
          continue
        }
        if (!(await fetchHead($, directory, snapshot.headRefName))) {
          await log("warn", `${kind}: could not fetch ${snapshot.headRefName} for PR #${number} — skipping`)
          await markers.release(number)
          continue
        }
        return { item: prWorkItem(loaded, "ado", snapshot, triggers), skip: null }
      }
      if (heldIds.length) {
        return {
          item: null,
          skip: { message: `${kind}: claim marker held for ${heldIds.join(", ")}`, actionable: true },
        }
      }
      return {
        item: null,
        skip: { message: `${kind}: no PRs need attention (${prs.length} active in the project)`, actionable: false },
      }
    },

    async release(work) {
      const { snapshot } = work.ref as { snapshot: PrSnapshot }
      await markers.release(snapshot.number)
    },

    async onTerminal(work, outcome: TerminalOutcome) {
      const { snapshot, triggers } = work.ref as { snapshot: PrSnapshot; triggers: PrTrigger[] }
      const ledger = await loadLedger(client, directory, tasksDir, kind, snapshot.number, now())
      // Re-read the PR head: after a publish it is the sitter's own push, and
      // recording it as handled is exactly what prevents self-triggering. A
      // failure here leaves a stale ledger head, which turns the sitter's own
      // push into a fresh trigger — so this goes over the same az transport as
      // every other data call rather than a second one that could fail alone.
      const fresh = azToHttp(
        await az(
          azInvokeArgs({
            area: "git",
            resource: "pullrequests",
            organization: org,
            routeParameters: { project: ado.project, pullRequestId: String(snapshot.number) },
          }),
        ),
      )
      let head = snapshot.headRefOid
      let repositoryId = ""
      if (fresh.ok) {
        try {
          const data = AdoFreshPrSchema.parse(JSON.parse(fresh.body))
          head = data.lastMergeSourceCommit?.commitId ?? head
          repositoryId = data.repository?.id ?? data.repository?.name ?? ""
        } catch {
          /* keep snapshot values */
        }
      }
      let lastCommentAt = ledger.lastCommentAtHandled ?? ""
      if (repositoryId) {
        for (const c of await threadComments(repositoryId, snapshot.number)) {
          if (newerThan(c.at, lastCommentAt)) lastCommentAt = c.at
        }
      }
      const updated = terminalLedgerUpdate(ledger, outcome, triggers, snapshot.headRefOid, head, lastCommentAt, now())
      // A retryable stop returns the ledger unchanged (C2) — skip the write so the head stays claimable.
      if (updated !== ledger) await saveLedger($, directory, tasksDir, kind, updated)
      await markers.release(snapshot.number)
    },
  }
}
