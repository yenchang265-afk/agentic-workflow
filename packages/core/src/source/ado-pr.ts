import { z } from "zod"
import type { Client, Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import type { AdoConfig } from "../loop/state.js"
import { attentionTriggers, loadLedger, saveLedger, type PrSnapshot, type PrTrigger } from "./ledger.js"
import { fetchHead, makeClaimMarkers, prWorkItem, terminalLedgerUpdate } from "./pr-shared.js"
import type { ClaimSkipReason, TerminalOutcome, WorkSource } from "./types.js"

/**
 * The Azure DevOps PR work source: the `gh`-backed `github-pr.ts` mirrored
 * onto the `az` CLI (`azure-devops` extension). Selected at wiring time when
 * config `codePlatform` resolves to `"ado"` for a `github-pr`-bound loop kind.
 *
 * Raw ADO output is normalized into the same `PrSnapshot` shape the ledger
 * judges (`conflicts` → `CONFLICTING`, a negative reviewer vote →
 * `CHANGES_REQUESTED`), so the dedup decision (`attentionTriggers`) and the
 * claim/fetch/terminal mechanics (`pr-shared.ts`) are shared verbatim.
 * Auth is delegated to the CLI (`az devops login` / `AZURE_DEVOPS_EXT_PAT`);
 * unlike GitHub's `statusCheckRollup`, check state comes from a per-PR
 * `az repos pr policy list` call, and comments from the pullRequestThreads
 * REST resource via `az devops invoke`.
 */

const AdoPrListSchema = z.array(
  z.object({
    pullRequestId: z.number().int().positive(),
    title: z.string(),
    sourceRefName: z.string(),
    targetRefName: z.string(),
    isDraft: z.boolean().default(false),
    mergeStatus: z.string().nullish(),
    createdBy: z.object({ uniqueName: z.string().default("") }).nullish(),
    lastMergeSourceCommit: z.object({ commitId: z.string().default("") }).nullish(),
    reviewers: z.array(z.object({ vote: z.number().default(0) })).nullish(),
    /** Present when the PR comes from a fork — same skip rule as GitHub's `isCrossRepository`. */
    forkSource: z.unknown().nullish(),
    repository: z.object({ id: z.string().default(""), name: z.string().default("") }).nullish(),
  }),
)

const AdoPolicySchema = z.array(
  z.object({
    status: z.string().nullish(),
    configuration: z
      .object({
        isBlocking: z.boolean().default(true),
        type: z.object({ displayName: z.string().default("") }).nullish(),
      })
      .nullish(),
  }),
)

const AdoThreadsSchema = z.object({
  value: z
    .array(
      z.object({
        isDeleted: z.boolean().default(false),
        comments: z
          .array(
            z.object({
              commentType: z.string().nullish(),
              publishedDate: z.string().nullish(),
              isDeleted: z.boolean().default(false),
              author: z.object({ uniqueName: z.string().default("") }).nullish(),
            }),
          )
          .nullish(),
      }),
    )
    .nullish(),
})

const POLICY_FAILING = new Set(["rejected", "broken", "failed"])

const stripRef = (ref: string): string => ref.replace(/^refs\/heads\//, "")

/** ADO logins are emails — case-insensitive identifiers. */
const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * `a` strictly newer than `b`. ADO timestamps carry variable-precision
 * fractional seconds ("…20.9Z" vs "…20.873Z"), which string comparison
 * misorders — compare parsed times, falling back to strings when unparsable.
 */
const newerThan = (a: string, b: string): boolean => {
  if (!b) return Boolean(a)
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  return Number.isNaN(ta) || Number.isNaN(tb) ? a > b : ta > tb
}

interface AdoPrDeps {
  readonly $: Shell
  readonly client: Client
  readonly directory: string
  readonly tasksDir: string
  readonly log: Log
  readonly loaded: LoadedManifest
  /** Azure DevOps coordinates (config `ado`). */
  readonly ado: AdoConfig
  /** Clock injection for ledger stamps; defaults to the real time. */
  readonly now?: () => string
}

export const makeAdoPrSource = (deps: AdoPrDeps): WorkSource => {
  const { $, client, directory, tasksDir, log, loaded, ado } = deps
  const binding = loaded.manifest.workSource
  if (binding.type !== "github-pr") {
    throw new Error(`loop kind "${loaded.manifest.kind}" does not use a hosted-PR work source`)
  }
  const now = deps.now ?? (() => new Date().toISOString())
  const org = ado.organization
  const project = ado.project
  let viewerLogin: string | null = null

  /** The sitter's own login: config override, else the az identity, else "" (degrades like the gh path). */
  const viewer = async (): Promise<string> => {
    if (viewerLogin !== null) return viewerLogin
    if (ado.selfLogin) return (viewerLogin = ado.selfLogin)
    const aad = await $`az ad signed-in-user show --query userPrincipalName -o tsv`.cwd(directory).quiet().nothrow()
    if (aad.exitCode === 0 && aad.stdout.toString().trim()) return (viewerLogin = aad.stdout.toString().trim())
    const acct = await $`az account show --query user.name -o tsv`.cwd(directory).quiet().nothrow()
    viewerLogin = acct.exitCode === 0 ? acct.stdout.toString().trim() : ""
    return viewerLogin
  }

  const markers = makeClaimMarkers($, directory, tasksDir)

  /** Names of blocking policies currently failing on the PR (ADO's nearest equivalent of failing checks). */
  const failingPolicies = async (pr: number): Promise<string[]> => {
    const out = await $`az repos pr policy list --id ${String(pr)} --organization ${org} --project ${project} -o json`
      .cwd(directory)
      .quiet()
      .nothrow()
    if (out.exitCode !== 0) return []
    try {
      return AdoPolicySchema.parse(JSON.parse(out.stdout.toString() || "[]"))
        .filter((p) => p.configuration?.isBlocking !== false) // optional policies don't gate the merge
        .filter((p) => POLICY_FAILING.has((p.status ?? "").toLowerCase()))
        .map((p) => p.configuration?.type?.displayName ?? "")
        .filter(Boolean)
    } catch {
      return []
    }
  }

  /** Non-system PR thread comments, flattened to `{ author, at }`, newest state from the REST resource. */
  const threadComments = async (repositoryId: string, pr: number): Promise<{ author: string; at: string }[]> => {
    const out =
      await $`az devops invoke --area git --resource pullRequestThreads --route-parameters ${`project=${project}`} ${`repositoryId=${repositoryId}`} ${`pullRequestId=${String(pr)}`} --organization ${org} --api-version 7.1 -o json`
        .cwd(directory)
        .quiet()
        .nothrow()
    if (out.exitCode !== 0) return []
    try {
      const threads = AdoThreadsSchema.parse(JSON.parse(out.stdout.toString() || "{}"))
      return (threads.value ?? [])
        .filter((t) => !t.isDeleted)
        .flatMap((t) => t.comments ?? [])
        .filter((c) => !c.isDeleted && (c.commentType ?? "text") !== "system" && c.publishedDate)
        .map((c) => ({ author: c.author?.uniqueName ?? "", at: c.publishedDate ?? "" }))
    } catch {
      return []
    }
  }

  return {
    loopKind: loaded.manifest.kind,

    async claimNext() {
      // Two branches instead of a conditional fragment: the Shell quotes every
      // interpolation as a single argument, so "--repository x" can't be spliced.
      const out = ado.repository
        ? await $`az repos pr list --status active --top 100 --organization ${org} --project ${project} --repository ${ado.repository} -o json`
            .cwd(directory)
            .quiet()
            .nothrow()
        : await $`az repos pr list --status active --top 100 --organization ${org} --project ${project} -o json`
            .cwd(directory)
            .quiet()
            .nothrow()
      if (out.exitCode !== 0) {
        return {
          item: null,
          skip: {
            message:
              `pr-sitter: az repos pr list failed — ${out.stderr.toString().trim() || "unknown error"}. ` +
              `Is the azure-devops az extension installed and authenticated (az devops login / AZURE_DEVOPS_EXT_PAT)?`,
            actionable: true,
          } satisfies ClaimSkipReason,
        }
      }
      let prs: z.infer<typeof AdoPrListSchema>
      try {
        prs = AdoPrListSchema.parse(JSON.parse(out.stdout.toString() || "[]"))
      } catch (err) {
        return {
          item: null,
          skip: { message: `pr-sitter: could not parse az output — ${(err as Error).message}`, actionable: true },
        }
      }
      const login = await viewer()
      if (!login) {
        // Unlike gh's server-side `author:@me`, the author filter here is
        // client-side — with no identity it would sit on EVERY active PR in
        // the project. Fail actionably instead of degrading.
        return {
          item: null,
          skip: {
            message:
              "pr-sitter: could not resolve the sitter's own ADO identity (PAT-only auth can't) — " +
              "set ado.selfLogin in .agentic-loop.json so the sitter only claims its own PRs.",
            actionable: true,
          } satisfies ClaimSkipReason,
        }
      }
      const heldIds: string[] = []
      for (const pr of prs.sort((a, b) => a.pullRequestId - b.pullRequestId)) {
        if (pr.isDraft) continue
        if (pr.forkSource != null) continue // fork PRs: can't push the head branch — a human's PR to sit on later
        if (!sameLogin(pr.createdBy?.uniqueName ?? "", login)) continue // parity with gh's author:@me
        const number = pr.pullRequestId
        const headRefOid = pr.lastMergeSourceCommit?.commitId ?? ""
        // No head SHA yet (merge evaluation queued / never run): the snapshot
        // isn't ready — a "" head would poison the ledger's dedup. Next poll.
        if (!headRefOid) continue
        const ledger = await loadLedger(client, directory, tasksDir, number, now())
        const watermark = ledger.lastCommentAtHandled ?? ""
        const enabled = binding.triggers
        const comments = enabled.includes("new-comments")
          ? await threadComments(pr.repository?.id || pr.repository?.name || "", number)
          : []
        const snapshot: PrSnapshot = {
          number,
          title: pr.title,
          headRefName: stripRef(pr.sourceRefName),
          baseRefName: stripRef(pr.targetRefName),
          headRefOid,
          mergeable: (pr.mergeStatus ?? "").toLowerCase() === "conflicts" ? "CONFLICTING" : "MERGEABLE",
          reviewDecision: (pr.reviewers ?? []).some((r) => r.vote < 0) ? "CHANGES_REQUESTED" : "",
          failingChecks: enabled.includes("failing-checks") ? await failingPolicies(number) : [],
          newComments: comments.filter((c) => !sameLogin(c.author, login) && newerThan(c.at, watermark)),
        }
        const triggers = attentionTriggers(snapshot, ledger, binding.triggers)
        if (triggers.length === 0) continue
        if (!(await markers.claim(number))) {
          heldIds.push(`pr-${number}`)
          continue
        }
        if (!(await fetchHead($, directory, snapshot.headRefName))) {
          await log("warn", `pr-sitter: could not fetch ${snapshot.headRefName} for PR #${number} — skipping`)
          await markers.release(number)
          continue
        }
        return { item: prWorkItem(loaded, "ado", snapshot, triggers), skip: null }
      }
      if (heldIds.length) {
        return {
          item: null,
          skip: { message: `pr-sitter: claim marker held for ${heldIds.join(", ")}`, actionable: true },
        }
      }
      return {
        item: null,
        skip: { message: `pr-sitter: no PRs need attention (${prs.length} active in the project)`, actionable: false },
      }
    },

    async release(work) {
      const { snapshot } = work.ref as { snapshot: PrSnapshot }
      await markers.release(snapshot.number)
    },

    async onTerminal(work, outcome: TerminalOutcome) {
      const { snapshot, triggers } = work.ref as { snapshot: PrSnapshot; triggers: PrTrigger[] }
      const ledger = await loadLedger(client, directory, tasksDir, snapshot.number, now())
      // Re-read the PR head: after a publish it is the sitter's own push, and
      // recording it as handled is exactly what prevents self-triggering.
      const fresh =
        await $`az repos pr show --id ${String(snapshot.number)} --organization ${org} -o json`
          .cwd(directory)
          .quiet()
          .nothrow()
      let head = snapshot.headRefOid
      let repositoryId = ""
      if (fresh.exitCode === 0) {
        try {
          const data = JSON.parse(fresh.stdout.toString()) as {
            lastMergeSourceCommit?: { commitId?: string }
            repository?: { id?: string; name?: string }
          }
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
      await saveLedger($, directory, tasksDir, updated)
      await markers.release(snapshot.number)
    },
  }
}
