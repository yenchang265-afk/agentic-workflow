import { z } from "zod"
import type { Client, Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import type { AdoConfig } from "../loop/state.js"
import { attentionTriggers, loadLedger, saveLedger, type PrSnapshot, type PrTrigger } from "./ledger.js"
import { fetchHead, makeClaimMarkers, prWorkItem, terminalLedgerUpdate } from "./pr-shared.js"
import {
  ADO_HEADERS_ENV,
  AdoPolicySchema,
  AdoPrListSchema,
  AdoThreadsSchema,
  buildAdoHeaders,
  failingPolicyNames,
  flattenThreadComments,
  newerThan,
  resolveAdoHeaders,
  sameLogin,
  stripRef,
} from "./ado-shared.js"
import type { ClaimSkipReason, TerminalOutcome, WorkSource } from "./types.js"

/**
 * The Azure DevOps PR work source: the `gh`-backed `github-pr.ts` mirrored onto
 * the Azure DevOps REST API. Selected at wiring time when config `codePlatform`
 * resolves to `"ado"` for a `github-pr`-bound loop kind.
 *
 * Raw ADO output is normalized into the same `PrSnapshot` shape the ledger
 * judges (`conflicts` → `CONFLICTING`, a negative reviewer vote →
 * `CHANGES_REQUESTED`), so the dedup decision (`attentionTriggers`) and the
 * claim/fetch/terminal mechanics (`pr-shared.ts`) are shared verbatim.
 *
 * Auth is a Personal Access Token sent as HTTP Basic (`Authorization: Basic
 * base64(":" + PAT)`), read from `AZURE_DEVOPS_EXT_PAT`, falling back to config
 * `ado.pat` when that env var is unset (the env var wins). A PAT carries no
 * reliable email identity, so the sitter's own login is config-supplied
 * (`ado.selfLogin`, required for this platform — enforced in `config.ts`).
 * Unlike GitHub's `statusCheckRollup`, check state comes from a per-PR
 * `policy/evaluations` call, and comments from the `pullRequestThreads` resource.
 */

/** Minimal HTTP response the source reads — structurally satisfied by the global `fetch` `Response`. */
export interface AdoHttpResponse {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  text(): Promise<string>
}

/** GET-only HTTP transport, injected so tests can script responses without touching the network. */
export type AdoHttp = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => Promise<AdoHttpResponse>

const defaultHttp: AdoHttp = (url, init) => fetch(url, init)

/** The env var holding the Azure DevOps PAT — the same name the `az` extension used, for continuity. */
const PAT_ENV = "AZURE_DEVOPS_EXT_PAT"
const API_VERSION = "api-version=7.1"

interface AdoPrDeps {
  readonly $: Shell
  readonly client: Client
  readonly directory: string
  readonly tasksDir: string
  readonly log: Log
  readonly loaded: LoadedManifest
  /** Azure DevOps coordinates (config `ado`); `selfLogin` is required for this platform. */
  readonly ado: AdoConfig
  /** HTTP transport for ADO REST calls; defaults to the global `fetch`. */
  readonly http?: AdoHttp
  /** The Personal Access Token; defaults to `process.env.AZURE_DEVOPS_EXT_PAT`. */
  readonly pat?: string
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
  const http = deps.http ?? defaultHttp
  // Precedence: explicit dep (tests) → env var → config `ado.pat`.
  const pat = deps.pat ?? process.env[PAT_ENV] ?? ado.pat ?? ""
  const org = ado.organization.replace(/\/+$/, "")
  const project = encodeURIComponent(ado.project)
  const login = ado.selfLogin ?? ""
  // Config headers as a base, env `AGENTIC_LOOP_ADO_HEADERS` overriding (env wins, like the PAT).
  const customHeaders = resolveAdoHeaders(ado.customHeaders, process.env[ADO_HEADERS_ENV])

  const kind = loaded.manifest.kind
  const markers = makeClaimMarkers($, directory, tasksDir, kind)

  const authHeader = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`

  /** One authenticated GET. Never throws — a network error reads as a non-ok response, like the CLI's `nothrow()`. */
  const get = async (url: string): Promise<{ ok: boolean; status: number; statusText: string; body: string }> => {
    try {
      const res = await http(url, {
        headers: buildAdoHeaders({ Authorization: authHeader, Accept: "application/json" }, customHeaders),
      })
      const body = await res.text().catch(() => "")
      return { ok: res.ok, status: res.status, statusText: res.statusText, body }
    } catch (err) {
      return { ok: false, status: 0, statusText: (err as Error).message, body: "" }
    }
  }

  /** Names of blocking policies currently failing on the PR (ADO's nearest equivalent of failing checks). */
  const failingPolicies = async (projectId: string, pr: number): Promise<string[]> => {
    if (!projectId) return []
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${pr}`
    const url = `${org}/${project}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifactId)}&${API_VERSION}`
    const out = await get(url)
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
    const url = `${org}/${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pr}/threads?${API_VERSION}`
    const out = await get(url)
    if (!out.ok) return []
    try {
      const threads = AdoThreadsSchema.parse(JSON.parse(out.body || "{}"))
      return flattenThreadComments(threads.value ?? [])
    } catch {
      return []
    }
  }

  return {
    loopKind: kind,

    async claimNext() {
      if (!pat) {
        return {
          item: null,
          skip: {
            message:
              `pr-sitter: Azure DevOps PAT not set — export ${PAT_ENV} with a token that has Code (read) scope so the ` +
              `sitter can call the ADO REST API.`,
            actionable: true,
          } satisfies ClaimSkipReason,
        }
      }
      if (!login) {
        // A PAT can't resolve the sitter's own identity; config.ts enforces this,
        // and this is the defensive guard for direct construction.
        return {
          item: null,
          skip: {
            message:
              "pr-sitter: could not resolve the sitter's own ADO identity (a PAT cannot) — " +
              "set ado.selfLogin in .agentic-loop.json so the sitter only claims its own PRs.",
            actionable: true,
          } satisfies ClaimSkipReason,
        }
      }
      const listUrl = ado.repository
        ? `${org}/${project}/_apis/git/repositories/${encodeURIComponent(ado.repository)}/pullrequests?searchCriteria.status=active&$top=100&${API_VERSION}`
        : `${org}/${project}/_apis/git/pullrequests?searchCriteria.status=active&$top=100&${API_VERSION}`
      const out = await get(listUrl)
      if (!out.ok) {
        return {
          item: null,
          skip: {
            message:
              `pr-sitter: Azure DevOps pull-request list failed — HTTP ${out.status} ${out.statusText}. ` +
              `Is ${PAT_ENV} a valid token with Code (read) scope, and are ado.organization/project correct?`,
            actionable: true,
          } satisfies ClaimSkipReason,
        }
      }
      let prs: z.infer<typeof AdoPrListSchema>
      try {
        const json = JSON.parse(out.body || "{}") as { value?: unknown }
        prs = AdoPrListSchema.parse(json.value ?? [])
      } catch (err) {
        return {
          item: null,
          skip: { message: `pr-sitter: could not parse the ADO response — ${(err as Error).message}`, actionable: true },
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
      const ledger = await loadLedger(client, directory, tasksDir, kind, snapshot.number, now())
      // Re-read the PR head: after a publish it is the sitter's own push, and
      // recording it as handled is exactly what prevents self-triggering.
      const fresh = await get(`${org}/${project}/_apis/git/pullrequests/${snapshot.number}?${API_VERSION}`)
      let head = snapshot.headRefOid
      let repositoryId = ""
      if (fresh.ok) {
        try {
          const data = JSON.parse(fresh.body) as {
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
      await saveLedger($, directory, tasksDir, kind, updated)
      await markers.release(snapshot.number)
    },
  }
}
