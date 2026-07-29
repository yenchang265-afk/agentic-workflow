import { z } from "zod"
import type { Client, Log, Shell } from "../host.js"
import type { LoadedManifest } from "../manifest/schema.js"
import { attentionTriggers, emptyLedger, loadLedger, saveLedger, type PrSnapshot, type PrTrigger } from "./ledger.js"
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
 * the backlog (`<tasksDir>/runs/<kind>/.claims/pr-<n>`) — atomic across
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

/** One PR object as `gh pr view --json` returns it — the element of the list schema, reused for a targeted single-PR fetch. */
const PrSchema = PrListSchema.element

/** The post-terminal `gh pr view` re-read — validated, not cast, like every other gh parse here. */
const FreshHeadSchema = z.object({
  headRefOid: z.string().optional(),
  comments: z.array(z.object({ createdAt: z.string().optional() })).default([]),
})

const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"])

/**
 * Ceiling for `gh pr list`. gh's own default is 30, which silently hides work
 * from a sweep that scans every PR for one needing attention. High enough that
 * real repos fit; hitting it is warned about rather than passed off as the full
 * set.
 */
const PR_LIST_LIMIT = 200

/**
 * Chronological "a is strictly after b" for API timestamp strings. GitHub
 * emits ISO-8601 Zulu (where lexical order happens to work), but an offset or
 * precision change would silently skew a string `>` — parse both sides and
 * fall back to lexical only when either is unparseable. Pure.
 */
const isAfter = (a: string, b: string): boolean => {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a > b
  return ta > tb
}

interface GithubPrDeps {
  readonly $: Shell
  readonly client: Client
  readonly directory: string
  readonly tasksDir: string
  readonly log: Log
  readonly loaded: LoadedManifest
  /** Override of the manifest's search query (config `workflows.pr-sitter.query`). */
  readonly query?: string
  /**
   * A specific PR number to claim, from `claim <pr>`. When set, `claimNext`
   * fetches that one PR directly (bypassing the search query and the dedup
   * ledger) and drives it even with no outstanding attention signal — a human
   * naming a PR overrides the "what needs attention" heuristic. The fork skip
   * (threat model T10) still holds.
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

export const makeGithubPrSource = (deps: GithubPrDeps): WorkSource => {
  const { $, client, directory, tasksDir, log, loaded } = deps
  const binding = loaded.manifest.workSource
  if (binding.type !== "pull-request") {
    throw new Error(`workflow kind "${loaded.manifest.kind}" does not use a pull-request work source`)
  }
  const kind = loaded.manifest.kind
  const query = deps.query ?? binding.query
  const now = deps.now ?? (() => new Date().toISOString())
  let viewerLogin: string | null = null

  const viewer = async (): Promise<string> => {
    if (viewerLogin !== null) return viewerLogin
    const out = await $`gh api user -q .login`.cwd(directory).quiet().nothrow()
    viewerLogin = out.exitCode === 0 ? out.stdout.toString().trim() : ""
    return viewerLogin
  }

  const markers = makeClaimMarkers($, directory, tasksDir, kind)

  const fields =
    "number,title,headRefName,baseRefName,headRefOid,isDraft,mergeable,reviewDecision,isCrossRepository,statusCheckRollup,comments"

  /** Normalize one parsed PR into the ledger's `PrSnapshot`. `watermark` gates the
   *  "new comments" signal; own-login comments are always filtered out. */
  const buildSnapshot = (pr: z.infer<typeof PrSchema>, login: string, watermark: string): PrSnapshot => ({
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
      .filter((c) => (c.author?.login ?? "") !== login && isAfter(c.createdAt, watermark))
      .map((c) => ({ author: c.author?.login ?? "", at: c.createdAt })),
  })

  /**
   * Claim one explicitly-named PR (`claim <pr>`), overriding the poller's
   * heuristics: fetch it directly, skip the dedup ledger and the search query,
   * and drive it even with no outstanding attention signal. The fork skip is a
   * security invariant (T10), so it still refuses. The claim marker and head
   * fetch are unchanged, so multi-watcher safety and isolation reuse hold.
   */
  const claimSpecific = async (target: number): ReturnType<WorkSource["claimNext"]> => {
    const out = await $`gh pr view ${String(target)} --json ${fields}`.cwd(directory).quiet().nothrow()
    if (out.exitCode !== 0) {
      return {
        item: null,
        skip: {
          message: `${kind}: PR #${target} not found or not accessible — ${out.stderr.toString().trim() || "is gh authenticated?"}`,
          actionable: true,
        } satisfies ClaimSkipReason,
      }
    }
    let pr: z.infer<typeof PrSchema>
    try {
      pr = PrSchema.parse(JSON.parse(out.stdout.toString() || "{}"))
    } catch (err) {
      return {
        item: null,
        skip: { message: `${kind}: could not parse gh output for PR #${target} — ${(err as Error).message}`, actionable: true },
      }
    }
    // Fork PRs are refused for every role even when named explicitly: an
    // author-role kind can't push the head, and a reviewer-role kind would run
    // untrusted fork code in its assess worktree (threat model T10).
    if (pr.isCrossRepository) {
      return {
        item: null,
        skip: { message: `${kind}: PR #${target} is from a fork — refusing to claim it (untrusted head, threat model T10).`, actionable: true },
      }
    }
    const login = await viewer()
    // Watermark "" surfaces every non-self comment, and an empty ledger surfaces
    // every raw signal — a forced claim ignores what prior polls handled.
    const snapshot = buildSnapshot(pr, login, "")
    const triggers = attentionTriggers(snapshot, emptyLedger(target, now()), binding.triggers)
    if (!(await markers.claim(target))) {
      return {
        item: null,
        skip: { message: `${kind}: claim marker held for pr-${target}`, actionable: true },
      }
    }
    if (!(await fetchHead($, directory, pr.headRefName))) {
      await markers.release(target)
      return {
        item: null,
        skip: { message: `${kind}: could not fetch ${pr.headRefName} for PR #${target} — skipping`, actionable: true },
      }
    }
    return { item: prWorkItem(loaded, "github", snapshot, triggers, { ...(deps.maxDiffLines != null ? { maxDiffLines: deps.maxDiffLines } : {}) }), skip: null }
  }

  return {
    workflowKind: kind,

    async claimNext() {
      if (deps.target != null) return claimSpecific(deps.target)
      // `gh pr list` defaults to 30. This source iterates the FULL set looking
      // for one that needs attention, so anything past the window would never be
      // claimed — silently, with no error. Ask for a high explicit ceiling and
      // warn if we still hit it, so truncation is never mistaken for "all of
      // them". (`ci-runs`' 30 is fine by contrast: it judges only the newest head.)
      const out = await $`gh pr list --search ${query} --json ${fields} --limit ${String(PR_LIST_LIMIT)}`
        .cwd(directory)
        .quiet()
        .nothrow()
      if (out.exitCode !== 0) {
        return {
          item: null,
          skip: {
            message: `${kind}: gh pr list failed — ${out.stderr.toString().trim() || "is gh authenticated?"}`,
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
          skip: { message: `${kind}: could not parse gh output — ${(err as Error).message}`, actionable: true },
        }
      }
      const truncated = prs.length >= PR_LIST_LIMIT
      if (truncated) {
        await log(
          "warn",
          `${kind}: the PR list hit the ${PR_LIST_LIMIT}-PR ceiling — results are TRUNCATED and a PR needing ` +
            `attention may be invisible to this sitter. Narrow the kind's \`query\` so the set fits.`,
        )
      }
      const login = await viewer()
      const heldIds: string[] = []
      for (const pr of prs.sort((a, b) => a.number - b.number)) {
        if (pr.isDraft) continue
        // Fork PRs are skipped for every role: an author-role kind can't push the
        // head branch, and a reviewer-role kind would execute untrusted fork code
        // in its assess worktree (threat model T10).
        if (pr.isCrossRepository) continue
        const ledger = await loadLedger(client, directory, tasksDir, kind, pr.number, now())
        const snapshot = buildSnapshot(pr, login, ledger.lastCommentAtHandled ?? "")
        const triggers = attentionTriggers(snapshot, ledger, binding.triggers)
        if (triggers.length === 0) continue
        if (!(await markers.claim(pr.number))) {
          heldIds.push(`pr-${pr.number}`)
          continue
        }
        if (!(await fetchHead($, directory, pr.headRefName))) {
          await log("warn", `${kind}: could not fetch ${pr.headRefName} for PR #${pr.number} — skipping`)
          await markers.release(pr.number)
          continue
        }
        return { item: prWorkItem(loaded, "github", snapshot, triggers, { ...(deps.maxDiffLines != null ? { maxDiffLines: deps.maxDiffLines } : {}) }), skip: null }
      }
      if (heldIds.length) {
        return {
          item: null,
          skip: { message: `${kind}: claim marker held for ${heldIds.join(", ")}`, actionable: true },
        }
      }
      return {
        item: null,
        skip: {
          message: `${kind}: no PRs need attention (${prs.length}${truncated ? "+ (truncated)" : ""} matched the query)`,
          actionable: false,
        },
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
      let reReadFailed = fresh.exitCode !== 0
      if (!reReadFailed) {
        try {
          const data = FreshHeadSchema.parse(JSON.parse(fresh.stdout.toString()))
          head = data.headRefOid ?? head
          for (const c of data.comments) {
            if (c.createdAt && isAfter(c.createdAt, lastCommentAt)) lastCommentAt = c.createdAt
          }
        } catch {
          reReadFailed = true
        }
      }
      if (reReadFailed) {
        // Falling back to the snapshot records the PRE-RUN head as handled, so
        // a publish push may re-trigger next poll — recoverable (the next run
        // sees its own comments), but never silent.
        await log(
          "warn",
          `${kind}: could not re-read PR #${snapshot.number} after the run — recording the pre-run head as handled; the sitter's own push may re-trigger one poll`,
        )
      }
      const updated = terminalLedgerUpdate(ledger, outcome, triggers, snapshot.headRefOid, head, lastCommentAt, now())
      // A retryable stop returns the ledger unchanged (C2) — skip the write so the head stays claimable.
      if (updated !== ledger) await saveLedger($, directory, tasksDir, kind, updated)
      await markers.release(snapshot.number)
    },
  }
}
