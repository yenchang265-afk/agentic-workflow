import { defaultWorkflowsDir } from "../manifest/dir.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Client, Shell } from "../host.js"
import { loadManifest } from "../manifest/load.js"
import { makeAdoPrSource } from "./ado-pr.js"
import type { AdoGateway, AdoResult } from "./ado-gateway.js"

/**
 * The ado-pr source over the real pr-sitter manifest, against a scripted
 * `AdoGateway` plus a scripted git/claim shell (`$`) — the mirror of
 * github-pr.test.ts. Covers the normalization (ref stripping, conflicts →
 * CONFLICTING, negative vote → CHANGES_REQUESTED, failing pipelines →
 * failingChecks), the filtering (drafts, forks, other authors, own/system
 * comments), identity preconditions, claim/fetch mechanics, and terminal
 * ledger writes.
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

const ok = (data: unknown): AdoResult => ({ ok: true, data })
const fail = (error: string): AdoResult => ({ ok: false, error })

interface Script {
  /** The active-PR list. Ignored when `paged` is set. */
  prs?: unknown[]
  /** Serves pages by `skip`/`top`, for the paging tests. */
  paged?: (skip: number, top: number) => unknown[]
  /** The single-PR fetch (targeted claim, terminal re-read). */
  getPr?: unknown
  threads?: unknown[]
  /** Builds on `refs/pull/<n>/merge`. */
  mergeBuilds?: unknown[]
  /** Builds on the PR's source branch — the fallback path. */
  sourceBuilds?: unknown[]
  /** Make the PR list fail with this message. */
  listError?: string
  /** Make the single-PR fetch fail with this message. */
  getPrError?: string
}

/**
 * A scripted gateway. Every call is recorded so tests can assert which
 * operations ran (e.g. that a targeted claim never lists).
 */
const scriptedGateway = (script: Script, calls: string[] = []): AdoGateway => ({
  async listPullRequests(a) {
    calls.push(`listPullRequests(skip=${a.skip ?? 0},top=${a.top ?? 0})`)
    if (script.listError) return fail(script.listError)
    if (script.paged) return ok(script.paged(a.skip ?? 0, a.top ?? 100))
    return ok(script.prs ?? [])
  },
  async getPullRequest(a) {
    calls.push(`getPullRequest(${a.pullRequestId})`)
    if (script.getPrError) return fail(script.getPrError)
    return script.getPr === undefined ? fail("not found") : ok(script.getPr)
  },
  async listPullRequestThreads(a) {
    calls.push(`listPullRequestThreads(${a.pullRequestId})`)
    return ok(script.threads ?? [])
  },
  async listPullRequestsByCommits() {
    calls.push("listPullRequestsByCommits")
    return ok([])
  },
  async getRepository() {
    calls.push("getRepository")
    return ok({})
  },
  async listBuilds(a) {
    calls.push(`listBuilds(${a.branchName ?? ""})`)
    const merge = (a.branchName ?? "").includes("/merge")
    return ok(merge ? (script.mergeBuilds ?? []) : (script.sourceBuilds ?? []))
  },
  async getBuildStatus() {
    calls.push("getBuildStatus")
    return ok({})
  },
  async createPullRequest() {
    calls.push("createPullRequest")
    return fail("the PR source must never create a pull request")
  },
  async close() {},
})

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

const thread = (comments: unknown[]) => [{ isDeleted: false, comments }]

const build = (name: string, result: string, queueTime = "2026-07-05T00:00:00Z") => ({
  definition: { name },
  status: "completed",
  result,
  sourceVersion: "sha-1",
  queueTime,
})

type Opts = {
  ledgers?: Record<string, string>
  script?: Script
  shellScript?: Cmd[]
  shellLog?: string[]
  calls?: string[]
  /** The kind under test; defaults to pr-sitter (author role). */
  loaded?: ReturnType<typeof loadManifest>
  /** A specific PR id to force-claim (`claim <pr>`). */
  target?: number
  /** Omit to scope the sitter to one repository (the default here). */
  repository?: string | null
  selfLogin?: string | null
  log?: (level: string, message: string) => void
}

const source = (prs: unknown[], opts: Opts = {}) =>
  makeAdoPrSource({
    $: scriptedShell(opts.shellScript ?? [], opts.shellLog),
    gateway: scriptedGateway({ prs, ...(opts.script ?? {}) }, opts.calls),
    client: ledgerClient(opts.ledgers ?? {}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: (l, m) => opts.log?.(l, String(m)),
    loaded: opts.loaded ?? sitter,
    ado: {
      organization: "https://dev.azure.com/acme",
      project: "widgets",
      ...(opts.repository === null ? {} : { repository: opts.repository ?? "widgets" }),
      ...(opts.selfLogin === null ? {} : { selfLogin: opts.selfLogin ?? "sitter@acme.com" }),
    },
    now: () => "2026-07-05T00:00:00Z",
    ...(opts.target != null ? { target: opts.target } : {}),
  })

/** One failing and one passing pipeline, so "only the failing one is named" is testable. */
const failingBuilds = [build("Build", "failed"), build("Lint", "succeeded")]

test("claims a PR with a failing pipeline: refs stripped, goal names the failure, state stamped ado", async () => {
  const log: string[] = []
  const { item, skip } = await source([pr()], { script: { mergeBuilds: failingBuilds }, shellLog: log }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "pr-7")
  assert.equal(item?.entryStage, "triage")
  assert.equal(item?.state.platform, "ado")
  assert.deepEqual(item?.state.git, { base: "main", branch: "feat/rate-limit" })
  assert.match(item?.state.goal ?? "", /failing checks: Build/)
  assert.doesNotMatch(item?.state.goal ?? "", /Lint/) // a green pipeline is not a failing check
  assert.match(item?.state.goal ?? "", /Never merge/)
  assert.ok(log.some((c) => c.startsWith("git -C /r fetch origin +refs/heads/feat/rate-limit")))
  assert.ok(log.some((c) => c.includes(".claims/pr-7")))
})

test("only the NEWEST run per pipeline counts — a definition re-run green stops being a failing check", async () => {
  // Without newest-per-definition a pipeline that failed once would keep the PR
  // permanently claimable, re-waking the sitter on work already fixed.
  const builds = [
    build("Build", "succeeded", "2026-07-05T02:00:00Z"),
    build("Build", "failed", "2026-07-05T01:00:00Z"),
  ]
  const { item } = await source([pr()], { script: { mergeBuilds: builds } }).claimNext()
  assert.equal(item, null)
})

test("a partially-succeeded run is judged failing, not silently green", async () => {
  const { item } = await source([pr()], { script: { mergeBuilds: [build("Build", "partiallySucceeded")] } }).claimNext()
  assert.match(item?.state.goal ?? "", /failing checks: Build/)
})

test("validation runs on the source branch are used when the merge ref has none", async () => {
  // Some org configurations queue PR validation against the source branch.
  const { item, calls } = await (async () => {
    const calls: string[] = []
    const r = await source([pr()], {
      calls,
      script: { mergeBuilds: [], sourceBuilds: [build("Build", "failed")] },
    }).claimNext()
    return { ...r, calls }
  })()
  assert.match(item?.state.goal ?? "", /failing checks: Build/)
  assert.ok(calls.some((c) => c.includes("refs/pull/7/merge")), "merge ref tried first")
  assert.ok(calls.some((c) => c.includes("refs/heads/feat/rate-limit")), "source branch fallback not tried")
})

test("a source-branch run for a different commit is not mistaken for this PR's", async () => {
  const stale = { ...build("Build", "failed"), sourceVersion: "sha-other" }
  const { item } = await source([pr()], { script: { mergeBuilds: [], sourceBuilds: [stale] } }).claimNext()
  assert.equal(item, null)
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
  const ownAndSystem = thread([
    { commentType: "text", publishedDate: "2026-07-04T00:00:00Z", author: { uniqueName: "SITTER@acme.com" } },
    { commentType: "system", publishedDate: "2026-07-04T00:00:00Z", author: { uniqueName: "bob@acme.com" } },
    {
      commentType: "text",
      publishedDate: "2026-07-04T00:00:00Z",
      isDeleted: true,
      author: { uniqueName: "carol@acme.com" },
    },
  ])
  const { item, skip } = await source(prs, { script: { threads: ownAndSystem } }).claimNext()
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
    thread([{ commentType: "text", publishedDate: at, author: { uniqueName: "alice@acme.com" } }])
  const old = await source([pr()], { ledgers, script: { threads: comment("2026-07-03T00:00:00Z") } }).claimNext()
  assert.equal(old.item, null)
  const fresh = await source([pr()], { ledgers, script: { threads: comment("2026-07-05T00:00:00Z") } }).claimNext()
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

test("a gateway list failure surfaces as an actionable skip naming the cause and the scope needed", async () => {
  const { skip } = await source([], { script: { listError: "azure-devops MCP server unavailable — spawn ENOENT" } }).claimNext()
  assert.match(skip?.message ?? "", /pull-request list failed/)
  assert.match(skip?.message ?? "", /spawn ENOENT/)
  assert.match(skip?.message ?? "", /Code \(read\) scope/)
  assert.equal(skip?.actionable, true)
})

test("a PR list trimmed of createdBy/reviewers fails loudly instead of claiming the wrong PRs", async () => {
  // The MCP list tool has no `fullResponse` flag, so a trimmed projection is a
  // real possibility. Degrading would mean an author-role kind claims nothing
  // and a reviewer-role kind claims everything — both silent. A parse error is
  // the correct outcome.
  const trimmed = { pullRequestId: 7, title: "t", sourceRefName: "refs/heads/a", targetRefName: "refs/heads/main" }
  const { item, skip } = await source([trimmed]).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /could not parse the ADO response/)
  assert.equal(skip?.actionable, true)
})

test("onTerminal(done) records the post-push head + comment watermark", async () => {
  const log: string[] = []
  const src = source([pr({ mergeStatus: "conflicts" })], {
    script: {
      getPr: pr({ lastMergeSourceCommit: { commitId: "sha-own-push" } }),
      threads: thread([
        { commentType: "text", publishedDate: "2026-07-05T01:00:00Z", author: { uniqueName: "alice@acme.com" } },
      ]),
    },
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
  const src = source([pr({ mergeStatus: "conflicts" })], { shellLog: log, script: { getPr: pr() } })
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "stop", message: "capped" })
  const write = log.find((c) => c.startsWith("printf") && c.includes("pr-7.json"))
  assert.match(write ?? "", /failedAttempts/)
  assert.match(write ?? "", /sha-1/)
  assert.match(write ?? "", /merge-conflict/)
})

test("unresolvable identity (no selfLogin) skips actionably instead of sitting on everyone's PRs", async () => {
  const { item, skip } = await source([pr({ mergeStatus: "conflicts" })], { selfLogin: null }).claimNext()
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
  const older = thread([
    { commentType: "text", publishedDate: "2026-07-04T00:00:00.12Z", author: { uniqueName: "alice@acme.com" } },
  ])
  const { item } = await source([pr()], { ledgers, script: { threads: older } }).claimNext()
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

// --- paging: one page with no skip silently dropped every PR past the first 100 ---

/** A source whose PR list pages by `skip`, serving `total` draft PRs. */
const pagedSource = (total: number, warnings: string[] = [], calls: string[] = []) =>
  source([], {
    calls,
    log: (_l, m) => void warnings.push(m),
    script: {
      paged: (skip, top) =>
        Array.from({ length: Math.max(0, Math.min(top, total - skip)) }, (_, i) =>
          pr({ pullRequestId: skip + i + 1, isDraft: true }),
        ),
    },
  })

test("the ADO PR list pages past the first 100 instead of truncating", async () => {
  // ADO has no server-side search, so role filtering happens client-side over the
  // WHOLE set — a PR at position 140 that needs attention was simply invisible.
  const calls: string[] = []
  const { skip } = await pagedSource(150, [], calls).claimNext()
  const listCalls = calls.filter((c) => c.startsWith("listPullRequests"))
  assert.ok(listCalls.length >= 2, `expected paging, got ${listCalls.length} list call(s)`)
  assert.ok(listCalls.some((c) => c.includes("skip=100")), "second page never requested")
  // The skip line must report the true total, not the first page's size.
  assert.match(skip?.message ?? "", /150/)
})

test("a single short page issues no extra request", async () => {
  const calls: string[] = []
  const { skip } = await pagedSource(3, [], calls).claimNext()
  assert.equal(calls.filter((c) => c.startsWith("listPullRequests")).length, 1)
  assert.match(skip?.message ?? "", /3 active/)
})

test("hitting the page ceiling warns instead of silently truncating", async () => {
  const warnings: string[] = []
  await pagedSource(5000, warnings).claimNext()
  assert.match(warnings.join("\n"), /truncat/i)
})

// --- targeted claim (`claim <pr>`): fetch one PR directly and force it ---

test("targeted claim fetches the named PR directly, never the list", async () => {
  const calls: string[] = []
  const shellLog: string[] = []
  const { item, skip } = await source([], {
    target: 7,
    calls,
    shellLog,
    script: { getPr: pr(), mergeBuilds: failingBuilds },
  }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "pr-7")
  assert.equal(item?.state.platform, "ado")
  assert.ok(calls.includes("getPullRequest(7)"), "did not fetch the single PR")
  assert.ok(!calls.some((c) => c.startsWith("listPullRequests")), "targeted claim must not list")
  assert.ok(shellLog.some((c) => c.includes(".claims/pr-7")), "claim marker not placed")
})

test("without ado.repository a targeted claim resolves the id against the active list", async () => {
  // The MCP single-PR tool requires a repository, unlike the project-wide REST
  // route it replaced — a project-scoped sitter must still be able to `claim <pr>`.
  const calls: string[] = []
  const { item, skip } = await source([pr()], { target: 7, calls, repository: null }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "pr-7")
  assert.ok(calls.some((c) => c.startsWith("listPullRequests")), "expected the list fallback")
  assert.ok(!calls.includes("getPullRequest(7)"), "must not call the repo-scoped tool without a repository")
})

test("targeted claim forces an already-handled PR (bypasses the dedup ledger)", async () => {
  const ledgers = {
    "docs/tasks/runs/pr-sitter/pr-7.json": JSON.stringify({
      pr: 7,
      headShaHandled: "sha-1",
      failedAttempts: [],
      updatedAt: "2026-07-04T00:00:00Z",
    }),
  }
  const { item, skip } = await source([], { target: 7, ledgers, script: { getPr: pr() } }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "pr-7")
  assert.match(item?.state.goal ?? "", /manually claimed/)
})

test("targeted claim forces a reviewer-role claim regardless of the identity filter", async () => {
  // A PR authored by the sitter itself would be skipped by the reviewer-role
  // filter in a normal poll; a targeted claim drives it anyway.
  const { item, skip } = await source([], { target: 7, loaded: reviewSitter, script: { getPr: pr() } }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "pr-7")
  assert.equal(item?.workflowKind, "review-sitter")
  assert.match(item?.state.goal ?? "", /one structured review comment/)
})

test("targeted claim still refuses a fork PR (threat model T10)", async () => {
  const { item, skip } = await source([], {
    target: 7,
    script: { getPr: pr({ forkSource: { repository: { id: "x" } } }) },
  }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /fork/)
  assert.equal(skip?.actionable, true)
})

test("targeted claim reports an actionable skip when the PR is not found", async () => {
  const { item, skip } = await source([], { target: 999, script: { getPrError: "TF401180: not found" } }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /PR #999 not found or not accessible/)
  assert.match(skip?.message ?? "", /TF401180/)
  assert.equal(skip?.actionable, true)
})
