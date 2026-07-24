import { defaultWorkflowsDir } from "../manifest/dir.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import type { Client, Shell } from "../host.js"
import { loadManifest } from "../manifest/load.js"
import { makeAdoPrSource } from "./ado-pr.js"
import type { AzExec, AzResult } from "./ado-az.js"

/**
 * The ado-pr source over the real pr-sitter manifest, against a scripted `az`
 * CLI (`azExec`) plus a scripted git/claim shell (`$`) — the mirror of
 * github-pr.test.ts. ADO is reached only through the az CLI, whose
 * `az devops invoke` returns the same `{ value: [...] }` envelopes the REST API
 * would, so the normalizers are shared. Covers the normalization (ref
 * stripping, conflicts → CONFLICTING, negative vote → CHANGES_REQUESTED, policy
 * failures → failingChecks), the filtering (drafts, forks, other authors,
 * own/system comments), the identity precondition, claim/fetch mechanics, and
 * terminal ledger writes.
 */

const WORKFLOWS_DIR = defaultWorkflowsDir()
const sitter = loadManifest(WORKFLOWS_DIR, "pr-sitter")

type Cmd = { cmd: string; result: { exitCode?: number; stdout?: string; stderr?: string } }

/** Scripted git/claim shell: first matching prefix wins; unmatched commands succeed empty. */
const scriptedShell = (script: Cmd[], log: string[] = []): Shell => {
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
    })
    cmd = cmd.trim().replace(/\s+/g, " ")
    log.push(cmd)
    const hit = script.find((c) => cmd.startsWith(c.cmd))
    const r = hit?.result ?? { exitCode: 0, stdout: "" }
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({
          exitCode: r.exitCode ?? 0,
          stdout: { toString: () => r.stdout ?? "" },
          stderr: { toString: () => r.stderr ?? "" },
        }).then(resolve, reject),
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((strings: TemplateStringsArray, ...exprs: unknown[]) => build(strings, exprs)) as any
}

/** A scripted az route: `match` is a substring of the joined `az` argv; first hit wins. */
type Route = { match: string; ok?: boolean; statusText?: string; body?: string }

/**
 * Scripted `az` CLI: first route whose `match` is a substring of the joined argv
 * wins, so callers route by resource (`--resource pullRequestThreads`) or a
 * route parameter (`pullRequestId=7`). Order the routes most-specific-first —
 * the threads call also carries `pullRequestId=`, so it must precede the by-id
 * PR re-read, which must precede the generic list route.
 */
const scriptedAz = (routes: Route[], log: string[] = []): AzExec => async (args) => {
  const cmd = args.join(" ")
  log.push(cmd)
  const hit = routes.find((r) => cmd.includes(r.match))
  return { ok: hit?.ok ?? true, statusText: hit?.statusText ?? "OK", body: hit?.body ?? "" } satisfies AzResult
}

/** Client whose reads serve ledger files from an in-memory map. */
const ledgerClient = (ledgers: Record<string, string>): Client => ({
  file: {
    async list() {
      return { data: [] }
    },
    async read({ query }) {
      const content = ledgers[query.path]
      return { data: content ? { content } : null }
    },
  },
  app: { async log() {} },
})

const pr = (over: Record<string, unknown> = {}) => ({
  pullRequestId: 7,
  title: "Add rate limiting",
  sourceRefName: "refs/heads/feat/rate-limit",
  targetRefName: "refs/heads/main",
  isDraft: false,
  mergeStatus: "succeeded",
  // Deliberately case-different from the configured selfLogin: ADO preserves
  // directory casing while identity lookups often lowercase — must still match.
  createdBy: { uniqueName: "Sitter@Acme.com" },
  lastMergeSourceCommit: { commitId: "sha-1" },
  reviewers: [] as unknown[],
  repository: { id: "repo-guid", name: "widgets", project: { id: "proj-guid" } },
  ...over,
})

/** `az devops invoke` returns the array wrapped in `{ value: [...] }`. */
const listBody = (prs: unknown[]) => JSON.stringify({ value: prs })
const threads = (comments: unknown[]) => JSON.stringify({ value: [{ isDeleted: false, comments }] })

type Opts = {
  ledgers?: Record<string, string>
  routes?: Route[]
  shellScript?: Cmd[]
  shellLog?: string[]
  azLog?: string[]
  /** The kind under test; defaults to pr-sitter (author role). */
  loaded?: ReturnType<typeof loadManifest>
}

const source = (prs: unknown[], opts: Opts = {}) =>
  makeAdoPrSource({
    $: scriptedShell(opts.shellScript ?? [], opts.shellLog),
    // Caller routes come first (most-specific), then the generic list default.
    azExec: scriptedAz([...(opts.routes ?? []), { match: "--resource pullrequests", body: listBody(prs) }], opts.azLog),
    client: ledgerClient(opts.ledgers ?? {}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: opts.loaded ?? sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" },
    now: () => "2026-07-05T00:00:00Z",
  })

const failingPolicy: Route = {
  match: "--resource evaluations",
  body: JSON.stringify({
    value: [
      { status: "rejected", configuration: { isBlocking: true, type: { displayName: "Build" } } },
      { status: "approved", configuration: { isBlocking: true, type: { displayName: "Reviewers" } } },
      { status: "rejected", configuration: { isBlocking: false, type: { displayName: "Optional Build" } } },
    ],
  }),
}

test("claims a PR with a failing policy: refs stripped, goal names the failure, state stamped ado", async () => {
  const log: string[] = []
  const { item, skip } = await source([pr()], { routes: [failingPolicy], shellLog: log }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "pr-7")
  assert.equal(item?.entryStage, "triage")
  assert.equal(item?.state.platform, "ado")
  assert.deepEqual(item?.state.git, { base: "main", branch: "feat/rate-limit" })
  assert.match(item?.state.goal ?? "", /failing checks: Build/)
  assert.doesNotMatch(item?.state.goal ?? "", /Optional Build/) // non-blocking policies don't gate the merge
  assert.match(item?.state.goal ?? "", /Never merge/)
  assert.ok(log.some((c) => c.startsWith("git -C /r fetch origin +refs/heads/feat/rate-limit")))
  assert.ok(log.some((c) => c.includes(".claims/pr-7")))
})

test("a merge conflict and a negative reviewer vote trigger via the normalized snapshot", async () => {
  const conflicted = await source([pr({ mergeStatus: "conflicts" })]).claimNext()
  assert.match(conflicted.item?.state.goal ?? "", /merge conflict/)
  const rejected = await source([pr({ reviewers: [{ vote: -5 }] })]).claimNext()
  assert.match(rejected.item?.state.goal ?? "", /review requested changes/)
})

test("skips drafts, fork PRs, other authors' PRs, and system/own comments", async () => {
  const prs = [
    pr({ pullRequestId: 1, isDraft: true, mergeStatus: "conflicts" }),
    pr({ pullRequestId: 2, forkSource: { repository: { id: "x" } }, mergeStatus: "conflicts" }),
    pr({ pullRequestId: 3, createdBy: { uniqueName: "alice@acme.com" }, mergeStatus: "conflicts" }),
    pr({ pullRequestId: 4 }),
  ]
  const ownAndSystem = threads([
    { commentType: "text", publishedDate: "2026-07-04T00:00:00Z", author: { uniqueName: "SITTER@acme.com" } },
    { commentType: "system", publishedDate: "2026-07-04T00:00:00Z", author: { uniqueName: "bob@acme.com" } },
    {
      commentType: "text",
      publishedDate: "2026-07-04T00:00:00Z",
      isDeleted: true,
      author: { uniqueName: "carol@acme.com" },
    },
  ])
  const { item, skip } = await source(prs, {
    routes: [{ match: "--resource pullRequestThreads", body: ownAndSystem }],
  }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /no PRs need attention \(4 active/)
  assert.equal(skip?.actionable, false)
})

test("a human comment newer than the ledger watermark triggers a claim; an older one does not", async () => {
  const ledgers = {
    "docs/tasks/runs/pr-sitter/pr-7.json": JSON.stringify({
      pr: 7,
      lastCommentAtHandled: "2026-07-04T00:00:00Z",
      failedAttempts: [],
      updatedAt: "2026-07-04T00:00:00Z",
    }),
  }
  const comment = (at: string) =>
    threads([{ commentType: "text", publishedDate: at, author: { uniqueName: "alice@acme.com" } }])
  const old = await source([pr()], {
    ledgers,
    routes: [{ match: "--resource pullRequestThreads", body: comment("2026-07-03T00:00:00Z") }],
  }).claimNext()
  assert.equal(old.item, null)
  const fresh = await source([pr()], {
    ledgers,
    routes: [{ match: "--resource pullRequestThreads", body: comment("2026-07-05T00:00:00Z") }],
  }).claimNext()
  assert.match(fresh.item?.state.goal ?? "", /1 unanswered comment/)
})

test("a held claim marker reports actionably and claims nothing", async () => {
  const { item, skip } = await source([pr({ mergeStatus: "conflicts" })], {
    shellScript: [{ cmd: "mkdir /r/docs/tasks/runs/pr-sitter/.claims/pr-7", result: { exitCode: 1 } }],
  }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /claim marker held for pr-7/)
  assert.equal(skip?.actionable, true)
})

test("a failed az list surfaces as an actionable skip carrying the CLI's stderr and setup hint", async () => {
  // The az CLI owns auth, so a broken environment (missing extension, expired
  // login) surfaces here as a failed list call — not a pre-flight PAT check.
  const { skip } = await source([], {
    routes: [{ match: "--resource pullrequests", ok: false, statusText: "ERROR: Please run 'az login'" }],
  }).claimNext()
  assert.match(skip?.message ?? "", /pull-request list failed \(az CLI\).*ERROR: Please run 'az login'/s)
  assert.match(skip?.message ?? "", /azure-devops extension/)
  assert.equal(skip?.actionable, true)
})

test("onTerminal(done) records the post-push head + comment watermark, re-read over the az CLI", async () => {
  const log: string[] = []
  const src = source([pr({ mergeStatus: "conflicts" })], {
    // Threads first: that call also carries pullRequestId=7, so it must match
    // before the by-id PR re-read (itself before the generic list default).
    routes: [
      {
        match: "--resource pullRequestThreads",
        body: threads([
          { commentType: "text", publishedDate: "2026-07-05T01:00:00Z", author: { uniqueName: "alice@acme.com" } },
        ]),
      },
      {
        match: "pullRequestId=7",
        body: JSON.stringify({
          lastMergeSourceCommit: { commitId: "sha-own-push" },
          repository: { id: "repo-guid" },
        }),
      },
    ],
    shellLog: log,
  })
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "done", message: "pushed" })
  const write = log.find((c) => c.startsWith("printf") && c.includes("pr-7.json"))
  assert.ok(write, "ledger written")
  assert.match(write ?? "", /sha-own-push/)
  assert.match(write ?? "", /2026-07-05T01:00:00Z/)
  assert.ok(log.some((c) => c.startsWith("rmdir") && c.includes("pr-7")))
})

test("onTerminal(stop) records a failed attempt pinned to the claimed head", async () => {
  const log: string[] = []
  const src = source([pr({ mergeStatus: "conflicts" })], { shellLog: log })
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "stop", message: "capped" })
  const write = log.find((c) => c.startsWith("printf") && c.includes("pr-7.json"))
  assert.match(write ?? "", /failedAttempts/)
  assert.match(write ?? "", /sha-1/)
  assert.match(write ?? "", /merge-conflict/)
})

test("unresolvable identity (no selfLogin) skips actionably instead of sitting on everyone's PRs", async () => {
  const src = makeAdoPrSource({
    $: scriptedShell([]),
    azExec: scriptedAz([{ match: "--resource pullrequests", body: listBody([pr({ mergeStatus: "conflicts" })]) }]),
    client: ledgerClient({}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets" },
    now: () => "2026-07-05T00:00:00Z",
  })
  const { item, skip } = await src.claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /could not resolve the sitter's own ADO identity/)
  assert.match(skip?.message ?? "", /ado\.selfLogin/)
  assert.equal(skip?.actionable, true)
})

test("a PR without a head SHA (merge evaluation queued) is skipped, not claimed with a poisoned ledger key", async () => {
  const { item } = await source([pr({ mergeStatus: "conflicts", lastMergeSourceCommit: null })]).claimNext()
  assert.equal(item, null)
})

test("variable-precision ADO timestamps compare numerically against the watermark", async () => {
  const ledgers = {
    "docs/tasks/runs/pr-sitter/pr-7.json": JSON.stringify({
      pr: 7,
      lastCommentAtHandled: "2026-07-04T00:00:00.123Z",
      failedAttempts: [],
      updatedAt: "2026-07-04T00:00:00Z",
    }),
  }
  // Lexicographically "...00.12Z" > "...00.123Z" ('Z' > '3'), but 0.12s < 0.123s.
  const older = threads([
    { commentType: "text", publishedDate: "2026-07-04T00:00:00.12Z", author: { uniqueName: "alice@acme.com" } },
  ])
  const { item } = await source([pr()], {
    ledgers,
    routes: [{ match: "--resource pullRequestThreads", body: older }],
  }).claimNext()
  assert.equal(item, null)
})

// --- the review-sitter kind on ADO: reviewer-role filtering, no server-side query ---

const reviewSitter = loadManifest(WORKFLOWS_DIR, "review-sitter")

test("review-sitter on ADO claims another author's PR where selfLogin's vote is still pending (case-insensitive)", async () => {
  const prs = [
    pr({
      createdBy: { uniqueName: "alice@acme.com" },
      reviewers: [{ uniqueName: "SITTER@Acme.com", vote: 0, isRequired: true }],
    }),
  ]
  const log: string[] = []
  const { item, skip } = await source(prs, { loaded: reviewSitter, shellLog: log }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "pr-7")
  assert.equal(item?.entryStage, "fetch")
  assert.equal(item?.state.kind, "review-sitter")
  assert.equal(item?.state.platform, "ado")
  assert.match(item?.state.goal ?? "", /one structured review comment/)
  // The reviewer's vote is read off the PR the az list returned.
  // The reviewer kind's bookkeeping lives in its own runs/ namespace.
  assert.ok(log.some((c) => c.includes("runs/review-sitter/.claims/pr-7")))
})

test("review-sitter on ADO skips its own PRs, PRs it isn't a reviewer on, and PRs where its vote is already cast", async () => {
  const prs = [
    // Own PR (default createdBy is the sitter identity) even though listed as reviewer.
    pr({ pullRequestId: 1, reviewers: [{ uniqueName: "sitter@acme.com", vote: 0 }] }),
    // Someone else's PR, but the sitter is not on the reviewer list.
    pr({ pullRequestId: 2, createdBy: { uniqueName: "alice@acme.com" }, reviewers: [{ uniqueName: "bob@acme.com", vote: 0 }] }),
    // Review already cast (vote ≠ 0) — ADO's mirror of GitHub dropping the request.
    pr({ pullRequestId: 3, createdBy: { uniqueName: "alice@acme.com" }, reviewers: [{ uniqueName: "sitter@acme.com", vote: 5 }] }),
  ]
  const { item, skip } = await source(prs, { loaded: reviewSitter }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /^review-sitter: no PRs need attention \(3 active/)
})

// --- the az-CLI invoke argv shape ---

test("the PR-list az invoke carries the org, project route parameter, and paging query parameters", async () => {
  const azLog: string[] = []
  const { item, skip } = await source([pr()], { routes: [failingPolicy], azLog }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "pr-7")
  const list = azLog.find((c) => c.includes("--resource pullrequests"))
  assert.ok(list)
  assert.match(list ?? "", /devops invoke --area git/)
  assert.match(list ?? "", /--organization https:\/\/dev\.azure\.com\/acme/)
  assert.match(list ?? "", /--route-parameters project=widgets/)
  assert.match(list ?? "", /--query-parameters searchCriteria\.status=active \$top=100/)
})

// --- paging: $top=100 with no $skip silently dropped every PR past the first page ---

/** Build a source whose PR-list az invoke pages by `$skip`, serving `total` draft PRs. */
const pagedSource = (total: number, warnings: string[] = [], azLog: string[] = []) =>
  makeAdoPrSource({
    $: scriptedShell([]),
    azExec: async (args) => {
      const cmd = args.join(" ")
      azLog.push(cmd)
      let body = ""
      if (cmd.includes("--resource pullrequests") && cmd.includes("searchCriteria.status=active")) {
        const skip = Number(/\$skip=(\d+)/.exec(cmd)?.[1] ?? "0")
        const top = Number(/\$top=(\d+)/.exec(cmd)?.[1] ?? "100")
        const page = Array.from({ length: Math.max(0, Math.min(top, total - skip)) }, (_, i) =>
          pr({ pullRequestId: skip + i + 1, isDraft: true }),
        )
        body = JSON.stringify({ value: page })
      }
      return { ok: true, statusText: "OK", body } satisfies AzResult
    },
    client: ledgerClient({}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: (_l, m) => void warnings.push(m),
    loaded: sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" },
    now: () => "2026-07-05T00:00:00Z",
  })

test("the ADO PR list pages past the first 100 instead of truncating", async () => {
  // ADO has no server-side search, so role filtering happens client-side over the
  // WHOLE set — a PR at position 140 that needs attention was simply invisible.
  const azLog: string[] = []
  const { skip } = await pagedSource(150, [], azLog).claimNext()
  const listCalls = azLog.filter((c) => c.includes("searchCriteria.status=active"))
  assert.ok(listCalls.length >= 2, `expected paging, got ${listCalls.length} list call(s)`)
  assert.ok(listCalls.some((c) => /\$skip=100/.test(c)), "second page never requested")
  // The skip line must report the true total, not the first page's size.
  assert.match(skip?.message ?? "", /150/)
})

test("a single short page issues no extra request", async () => {
  const azLog: string[] = []
  const { skip } = await pagedSource(3, [], azLog).claimNext()
  assert.equal(azLog.filter((c) => c.includes("searchCriteria.status=active")).length, 1)
  assert.match(skip?.message ?? "", /3 active/)
})

test("hitting the page ceiling warns instead of silently truncating", async () => {
  const warnings: string[] = []
  await pagedSource(5000, warnings).claimNext()
  assert.match(warnings.join("\n"), /truncat/i)
})
