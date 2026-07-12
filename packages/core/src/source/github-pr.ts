import { z } from "zod"
import type { Client, Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import { attentionTriggers, loadLedger, saveLedger, type PrSnapshot, type PrTrigger } from "./ledger.js"
import { fetchHead, makeClaimMarkers, prWorkItem, terminalLedgerUpdate } from "./pr-shared.js"
import type { ClaimSkipReason, TerminalOutcome, WorkSource } from "./types.js"

/**
 * The GitHub-PR work source (the PR sitter's): claimable units of work are
 * open pull requests matching the manifest's `gh pr list --search` query that
 * currently need attention — failing checks, changes requested, unanswered
 * comments, or a merge conflict — per the dedup ledger (`ledger.ts`).
 *
 * Everything goes through `gh` on the core `Shell` (mockable in tests).
 * GitHub has no atomic claim, so claims use the same local `mkdir` markers as
 * the backlog (`<tasksDir>/runs/pr-sitter/.claims/pr-<n>`) — atomic across
 * watchers on this filesystem. The PR's existing branch is fetched into a
 * local ref at claim time so the standard isolation path reuses it (same-repo
 * branches only; fork PRs are skipped). The sitter NEVER merges.
 */

const PrListSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    headRefName: z.string(),
    baseRefName: z.string(),
    headRefOid: z.string(),
    isDraft: z.boolean().default(false),
    mergeable: z.string().default("UNKNOWN"),
    reviewDecision: z.string().nullish(),
    isCrossRepository: z.boolean().default(false),
    statusCheckRollup: z
      .array(z.object({ name: z.string().default(""), conclusion: z.string().nullish(), state: z.string().nullish() }))
      .nullish(),
    comments: z
      .array(z.object({ author: z.object({ login: z.string().default("") }).nullish(), createdAt: z.string() }))
      .nullish(),
  }),
)

const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"])

interface GithubPrDeps {
  readonly $: Shell
  readonly client: Client
  readonly directory: string
  readonly tasksDir: string
  readonly log: Log
  readonly loaded: LoadedManifest
  /** Override of the manifest's search query (config `loops.pr-sitter.query`). */
  readonly query?: string
  /** Clock injection for ledger stamps; defaults to the real time. */
  readonly now?: () => string
}

export const makeGithubPrSource = (deps: GithubPrDeps): WorkSource => {
  const { $, client, directory, tasksDir, log, loaded } = deps
  const binding = loaded.manifest.workSource
  if (binding.type !== "github-pr") {
    throw new Error(`loop kind "${loaded.manifest.kind}" does not use a github-pr work source`)
  }
  const query = deps.query ?? binding.query
  const now = deps.now ?? (() => new Date().toISOString())
  let viewerLogin: string | null = null

  const viewer = async (): Promise<string> => {
    if (viewerLogin !== null) return viewerLogin
    const out = await $`gh api user -q .login`.cwd(directory).quiet().nothrow()
    viewerLogin = out.exitCode === 0 ? out.stdout.toString().trim() : ""
    return viewerLogin
  }

  const kind = loaded.manifest.kind
  const markers = makeClaimMarkers($, directory, tasksDir, kind)

  return {
    loopKind: kind,

    async claimNext() {
      const fields =
        "number,title,headRefName,baseRefName,headRefOid,isDraft,mergeable,reviewDecision,isCrossRepository,statusCheckRollup,comments"
      const out = await $`gh pr list --search ${query} --json ${fields}`.cwd(directory).quiet().nothrow()
      if (out.exitCode !== 0) {
        return {
          item: null,
          skip: {
            message: `pr-sitter: gh pr list failed — ${out.stderr.toString().trim() || "is gh authenticated?"}`,
            actionable: true,
          } satisfies ClaimSkipReason,
        }
      }
      let prs: z.infer<typeof PrListSchema>
      try {
        prs = PrListSchema.parse(JSON.parse(out.stdout.toString() || "[]"))
      } catch (err) {
        return {
          item: null,
          skip: { message: `pr-sitter: could not parse gh output — ${(err as Error).message}`, actionable: true },
        }
      }
      const login = await viewer()
      const heldIds: string[] = []
      for (const pr of prs.sort((a, b) => a.number - b.number)) {
        if (pr.isDraft) continue
        if (pr.isCrossRepository) continue // fork PRs: can't push the head branch — a human's PR to sit on later
        const ledger = await loadLedger(client, directory, tasksDir, kind, pr.number, now())
        const watermark = ledger.lastCommentAtHandled ?? ""
        const snapshot: PrSnapshot = {
          number: pr.number,
          title: pr.title,
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
          headRefOid: pr.headRefOid,
          mergeable: pr.mergeable,
          reviewDecision: pr.reviewDecision ?? "",
          failingChecks: (pr.statusCheckRollup ?? [])
            .filter((c) => FAILING.has((c.conclusion ?? c.state ?? "").toUpperCase()))
            .map((c) => c.name)
            .filter(Boolean),
          newComments: (pr.comments ?? [])
            .filter((c) => (c.author?.login ?? "") !== login && c.createdAt > watermark)
            .map((c) => ({ author: c.author?.login ?? "", at: c.createdAt })),
        }
        const triggers = attentionTriggers(snapshot, ledger, binding.triggers)
        if (triggers.length === 0) continue
        if (!(await markers.claim(pr.number))) {
          heldIds.push(`pr-${pr.number}`)
          continue
        }
        if (!(await fetchHead($, directory, pr.headRefName))) {
          await log("warn", `pr-sitter: could not fetch ${pr.headRefName} for PR #${pr.number} — skipping`)
          await markers.release(pr.number)
          continue
        }
        return { item: prWorkItem(loaded, "github", snapshot, triggers), skip: null }
      }
      if (heldIds.length) {
        return {
          item: null,
          skip: { message: `pr-sitter: claim marker held for ${heldIds.join(", ")}`, actionable: true },
        }
      }
      return {
        item: null,
        skip: { message: `pr-sitter: no PRs need attention (${prs.length} matched the query)`, actionable: false },
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
      const fresh = await $`gh pr view ${String(snapshot.number)} --json headRefOid,comments`
        .cwd(directory)
        .quiet()
        .nothrow()
      let head = snapshot.headRefOid
      let lastCommentAt = ledger.lastCommentAtHandled ?? ""
      if (fresh.exitCode === 0) {
        try {
          const data = JSON.parse(fresh.stdout.toString()) as {
            headRefOid?: string
            comments?: { createdAt?: string }[]
          }
          head = data.headRefOid ?? head
          for (const c of data.comments ?? []) {
            if (c.createdAt && c.createdAt > lastCommentAt) lastCommentAt = c.createdAt
          }
        } catch {
          /* keep snapshot values */
        }
      }
      const updated = terminalLedgerUpdate(ledger, outcome, triggers, snapshot.headRefOid, head, lastCommentAt, now())
      await saveLedger($, directory, tasksDir, kind, updated)
      await markers.release(snapshot.number)
    },
  }
}
