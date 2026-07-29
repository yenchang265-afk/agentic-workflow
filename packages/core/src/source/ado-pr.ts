import { z } from "zod"
import type { Client, Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import type { AdoConfig } from "../workflow/state.js"
import { attentionTriggers, emptyLedger, loadLedger, saveLedger, type PrSnapshot, type PrTrigger } from "./ledger.js"
import { fetchHead, makeClaimMarkers, prWorkItem, terminalLedgerUpdate } from "./pr-shared.js"
import {
  AdoBuildListSchema,
  AdoPrListSchema,
  AdoThreadListSchema,
  adoList,
  failingPipelineNames,
  flattenThreadComments,
  newerThan,
  sameLogin,
  stripRef,
} from "./ado-shared.js"
import type { AdoGateway, AdoResult } from "./ado-gateway.js"
import type { ClaimSkipReason, TerminalOutcome, WorkSource } from "./types.js"

/**
 * The Azure DevOps PR work source: the `gh`-backed `github-pr.ts` mirrored onto
 * the Azure DevOps MCP server. Selected at wiring time when config
 * `codePlatform` resolves to `"ado"` for a `pull-request`-bound workflow kind.
 *
 * Raw ADO output is normalized into the same `PrSnapshot` shape the ledger
 * judges (`conflicts` → `CONFLICTING`, a negative reviewer vote →
 * `CHANGES_REQUESTED`), so the dedup decision (`attentionTriggers`) and the
 * claim/fetch/terminal mechanics (`pr-shared.ts`) are shared verbatim.
 *
 * Transport is the `AdoGateway` port — every call goes through the Azure DevOps
 * MCP server, never raw REST. A PAT carries no reliable email identity, so the
 * sitter's own login stays config-supplied (`ado.selfLogin`, required for this
 * platform — enforced in `config.ts`).
 *
 * Unlike GitHub's `statusCheckRollup`, check state comes from the PR's
 * validation PIPELINE runs. That is narrower than the branch policies this
 * source used to read: see `failingPipelineNames` for exactly what is no longer
 * visible.
 */

/**
 * Active-PR list paging. ADO caps a page at 100 and offers no server-side
 * search, so the identity/role filter runs client-side over the whole set —
 * every page must be fetched or work goes silently unseen. `PR_MAX_PAGES` is a
 * runaway guard, not a policy: hitting it is warned about, never passed off as
 * the complete set.
 */
const PR_PAGE_SIZE = 100
const PR_MAX_PAGES = 10

/** How many recent validation builds to consider when judging a PR's checks. */
const PR_BUILD_LOOKBACK = 30

interface AdoPrDeps {
  readonly $: Shell
  readonly client: Client
  readonly directory: string
  readonly tasksDir: string
  readonly log: Log
  readonly loaded: LoadedManifest
  /** Azure DevOps coordinates (config `ado`); `selfLogin` is required for this platform. */
  readonly ado: AdoConfig
  /** The Azure DevOps MCP gateway every call goes through. */
  readonly gateway: AdoGateway
  /**
   * A specific PR id to claim, from `claim <pr>`. When set, `claimNext` fetches
   * that one PR directly (bypassing the role/identity filter and the dedup
   * ledger) and drives it even with no outstanding attention signal. The fork
   * skip (threat model T10) still holds.
   */
  readonly target?: number
  /** Clock injection for ledger stamps; defaults to the real time. */
  readonly now?: () => string
  /**
   * Changed-diff-line ceiling a reviewer-role kind declines above (config
   * `workflows.<kind>.maxDiffLines`); unset ⇒ `DEFAULT_MAX_DIFF_LINES`. Stated in
   * the goal so the fetch stage compares against a NUMBER rather than deciding
   * what "unreviewably large" means on its own.
   */
  readonly maxDiffLines?: number
}

type AdoPr = z.infer<typeof AdoPrListSchema>[number]

export const makeAdoPrSource = (deps: AdoPrDeps): WorkSource => {
  const { $, client, directory, tasksDir, log, loaded, ado, gateway } = deps
  const binding = loaded.manifest.workSource
  if (binding.type !== "pull-request") {
    throw new Error(`workflow kind "${loaded.manifest.kind}" does not use a pull-request work source`)
  }
  const kind = loaded.manifest.kind
  const role = binding.role
  const now = deps.now ?? (() => new Date().toISOString())
  const project = ado.project
  const login = ado.selfLogin ?? ""
  /** Rendered literally into the ADO stage prompts, so no agent parses a git remote. */
  const coords = { project, repository: ado.repository ?? "" }

  const markers = makeClaimMarkers($, directory, tasksDir, kind)

  /** The repository identifier per-PR calls address, preferring the PR's own over the configured one. */
  const repoIdOf = (pr: AdoPr): string => pr.repository?.id || pr.repository?.name || ado.repository || ""

  /** One page of the active-PR list. */
  const listPrsPage = (skip: number): Promise<AdoResult> =>
    gateway.listPullRequests({
      project,
      ...(ado.repository ? { repositoryId: ado.repository } : {}),
      status: "active",
      top: PR_PAGE_SIZE,
      skip,
    })

  /**
   * Fetch one PR by id. The MCP tool requires a repository, unlike the
   * project-wide REST route this replaced, so without `ado.repository` the id is
   * resolved against the active list instead — same result, one extra call, and
   * it keeps `claim <pr>` working for a project-scoped sitter.
   */
  const fetchPr = async (number: number): Promise<{ pr: AdoPr } | { error: string }> => {
    if (ado.repository) {
      const out = await gateway.getPullRequest({ project, repositoryId: ado.repository, pullRequestId: number })
      if (!out.ok) return { error: out.error }
      try {
        return { pr: AdoPrListSchema.element.parse(out.data) }
      } catch (err) {
        return { error: `could not parse the ADO response for PR #${number} — ${(err as Error).message}` }
      }
    }
    const out = await gateway.listPullRequests({ project, status: "active", top: PR_PAGE_SIZE })
    if (!out.ok) return { error: out.error }
    try {
      const found = AdoPrListSchema.parse(adoList(out.data)).find((p) => p.pullRequestId === number)
      return found ? { pr: found } : { error: `PR #${number} is not in the project's active pull requests` }
    } catch (err) {
      return { error: `could not parse the ADO response for PR #${number} — ${(err as Error).message}` }
    }
  }

  /**
   * Names of the PR's failing validation pipelines. ADO queues PR validation
   * against the merge ref; some org setups validate the source branch instead,
   * so that is the fallback — narrowed to the PR's own head so another branch's
   * runs can't be misread as this PR's.
   */
  const failingPipelines = async (pr: AdoPr): Promise<string[]> => {
    const number = pr.pullRequestId
    const head = pr.lastMergeSourceCommit?.commitId ?? ""
    const parse = (out: AdoResult): z.infer<typeof AdoBuildListSchema> => {
      if (!out.ok) return []
      try {
        return AdoBuildListSchema.parse(adoList(out.data))
      } catch {
        return []
      }
    }

    const merged = parse(
      await gateway.listBuilds({ project, branchName: `refs/pull/${number}/merge`, top: PR_BUILD_LOOKBACK }),
    )
    if (merged.length > 0) return failingPipelineNames(merged)

    const source = parse(
      await gateway.listBuilds({ project, branchName: pr.sourceRefName, top: PR_BUILD_LOOKBACK }),
    )
    return failingPipelineNames(head ? source.filter((b) => b.sourceVersion === head) : source)
  }

  /** Non-system PR thread comments, flattened to `{ author, at }`. */
  const threadComments = async (repositoryId: string, pr: number): Promise<{ author: string; at: string }[]> => {
    if (!repositoryId) return []
    const out = await gateway.listPullRequestThreads({ project, repositoryId, pullRequestId: pr })
    if (!out.ok) return []
    try {
      return flattenThreadComments(AdoThreadListSchema.parse(adoList(out.data)))
    } catch {
      return []
    }
  }

  /** Normalize one ADO PR into the ledger's `PrSnapshot` (checks + comments are per-PR calls). */
  const buildSnapshot = async (pr: AdoPr, watermark: string): Promise<PrSnapshot> => {
    const number = pr.pullRequestId
    const enabled = binding.triggers
    const comments = enabled.includes("new-comments") ? await threadComments(repoIdOf(pr), number) : []
    return {
      number,
      title: pr.title,
      headRefName: stripRef(pr.sourceRefName),
      baseRefName: stripRef(pr.targetRefName),
      headRefOid: pr.lastMergeSourceCommit?.commitId ?? "",
      mergeable: (pr.mergeStatus ?? "").toLowerCase() === "conflicts" ? "CONFLICTING" : "MERGEABLE",
      reviewDecision: pr.reviewers.some((r) => r.vote < 0) ? "CHANGES_REQUESTED" : "",
      failingChecks: enabled.includes("failing-checks") ? await failingPipelines(pr) : [],
      newComments: comments.filter((c) => !sameLogin(c.author, login) && newerThan(c.at, watermark)),
    }
  }

  /**
   * Claim one explicitly-named PR (`claim <pr>`), overriding the poller's
   * heuristics: fetch it directly, skip the role/identity filter and the dedup
   * ledger, and drive it even with no outstanding attention signal. The fork
   * skip is a security invariant (T10), so it still refuses.
   */
  const claimSpecific = async (target: number): ReturnType<WorkSource["claimNext"]> => {
    const found = await fetchPr(target)
    if ("error" in found) {
      return {
        item: null,
        skip: { message: `${kind}: PR #${target} not found or not accessible — ${found.error}`, actionable: true },
      }
    }
    const pr = found.pr
    // Fork PRs are refused for every role even when named (threat model T10).
    if (pr.forkSource != null) {
      return {
        item: null,
        skip: { message: `${kind}: PR #${target} is from a fork — refusing to claim it (untrusted head, threat model T10).`, actionable: true },
      }
    }
    if (!pr.lastMergeSourceCommit?.commitId) {
      return {
        item: null,
        skip: { message: `${kind}: PR #${target} has no evaluated head commit yet — try again once its merge is evaluated.`, actionable: true },
      }
    }
    // Watermark "" surfaces every non-self comment, and an empty ledger surfaces
    // every raw signal — a forced claim ignores what prior polls handled.
    const snapshot = await buildSnapshot(pr, "")
    const triggers = attentionTriggers(snapshot, emptyLedger(target, now()), binding.triggers)
    if (!(await markers.claim(target))) {
      return { item: null, skip: { message: `${kind}: claim marker held for pr-${target}`, actionable: true } }
    }
    if (!(await fetchHead($, directory, snapshot.headRefName))) {
      await markers.release(target)
      return {
        item: null,
        skip: { message: `${kind}: could not fetch ${snapshot.headRefName} for PR #${target} — skipping`, actionable: true },
      }
    }
    return { item: prWorkItem(loaded, "ado", snapshot, triggers, { ...(deps.maxDiffLines != null ? { maxDiffLines: deps.maxDiffLines } : {}) }, coords), skip: null }
  }

  return {
    workflowKind: kind,

    async claimNext() {
      if (deps.target != null) return claimSpecific(deps.target)
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
      // Page with `skip` until a short page arrives. ADO has no server-side
      // search, so the `role` identity filter runs client-side over the WHOLE
      // set — stopping at the first 100 made a PR at position 140 that needed
      // attention permanently invisible, with no error and no warning.
      const prs: AdoPr[] = []
      let truncated = false
      for (let page = 0; page < PR_MAX_PAGES; page++) {
        const out = await listPrsPage(page * PR_PAGE_SIZE)
        if (!out.ok) {
          return {
            item: null,
            skip: {
              message:
                `${kind}: Azure DevOps pull-request list failed — ${out.error}. ` +
                `Is the Azure DevOps MCP server reachable with a token that has Code (read) scope, ` +
                `and are ado.organization/project correct?`,
              actionable: true,
            } satisfies ClaimSkipReason,
          }
        }
        let batch: AdoPr[]
        try {
          batch = AdoPrListSchema.parse(adoList(out.data))
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
          if (sameLogin(pr.createdBy.uniqueName, login)) continue
          const mine = pr.reviewers.find((r) => sameLogin(r.uniqueName, login))
          if (!mine || mine.vote !== 0) continue
        } else if (!sameLogin(pr.createdBy.uniqueName, login)) {
          continue
        }
        const number = pr.pullRequestId
        // No head SHA yet (merge evaluation queued / never run): the snapshot
        // isn't ready — a "" head would poison the ledger's dedup. Next poll.
        if (!pr.lastMergeSourceCommit?.commitId) continue
        const ledger = await loadLedger(client, directory, tasksDir, kind, number, now())
        const snapshot = await buildSnapshot(pr, ledger.lastCommentAtHandled ?? "")
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
        return { item: prWorkItem(loaded, "ado", snapshot, triggers, { ...(deps.maxDiffLines != null ? { maxDiffLines: deps.maxDiffLines } : {}) }, coords), skip: null }
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
      // recording it as handled is exactly what prevents self-triggering.
      const fresh = await fetchPr(snapshot.number)
      let head = snapshot.headRefOid
      let repositoryId = ""
      if (!("error" in fresh)) {
        head = fresh.pr.lastMergeSourceCommit?.commitId || head
        repositoryId = repoIdOf(fresh.pr)
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
