import { defaultWorkflowsDir } from "../manifest/dir.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import type { Client, Shell } from "../host.js"
import { loadManifest } from "../manifest/load.js"
import { makeAdoPrSource, type AdoHttp } from "./ado-pr.js"
import type { AdoHttpResponse } from "./ado-pr.js"

/**
 * The ado-pr source over the real pr-sitter manifest, against a scripted ADO
 * REST transport (`http`) plus a scripted git/claim shell (`$`) — the mirror of
 * github-pr.test.ts. Covers the normalization (ref stripping, conflicts →
 * CONFLICTING, negative vote → CHANGES_REQUESTED, policy failures →
 * failingChecks), the filtering (drafts, forks, other authors, own/system
 * comments), PAT/identity preconditions, claim/fetch mechanics, and terminal
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

type Route = { match: string; status?: number; body?: string }

/** Scripted ADO REST transport: first route whose `match` is a substring of the URL wins. */
const scriptedHttp = (routes: Route[], log: string[] = []): AdoHttp => async (url) => {
  log.push(url)
  const hit = routes.find((r) => url.includes(r.match))
  const status = hit?.status ?? 200
  const body = hit?.body ?? ""
  return { ok: status >= 200 && status < 300, status, statusText: `status ${status}`, text: async () => body }
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

/** The ADO PR-list REST response wraps the array in `{ value: [...] }`. */
const listBody = (prs: unknown[]) => JSON.stringify({ value: prs })
const threads = (comments: unknown[]) => JSON.stringify({ value: [{ isDeleted: false, comments }] })

type Opts = {
  ledgers?: Record<string, string>
  routes?: Route[]
  shellScript?: Cmd[]
  shellLog?: string[]
  httpLog?: string[]
  pat?: string
  /** The kind under test; defaults to pr-sitter (author role). */
  loaded?: ReturnType<typeof loadManifest>
}

const source = (prs: unknown[], opts: Opts = {}) =>
  makeAdoPrSource({
    $: scriptedShell(opts.shellScript ?? [], opts.shellLog),
    http: scriptedHttp(
      [{ match: "/pullrequests?searchCriteria", body: listBody(prs) }, ...(opts.routes ?? [])],
      opts.httpLog,
    ),
    client: ledgerClient(opts.ledgers ?? {}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: opts.loaded ?? sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" },
    pat: opts.pat ?? "test-pat",
    now: () => "2026-07-05T00:00:00Z",
  })

const failingPolicy: Route = {
  match: "/policy/evaluations",
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
    routes: [{ match: "/threads", body: ownAndSystem }],
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
    routes: [{ match: "/threads", body: comment("2026-07-03T00:00:00Z") }],
  }).claimNext()
  assert.equal(old.item, null)
  const fresh = await source([pr()], {
    ledgers,
    routes: [{ match: "/threads", body: comment("2026-07-05T00:00:00Z") }],
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

test("a REST list failure surfaces as an actionable skip naming the PAT and scope", async () => {
  const src = makeAdoPrSource({
    $: scriptedShell([]),
    http: scriptedHttp([{ match: "/pullrequests?searchCriteria", status: 401 }]),
    client: ledgerClient({}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" },
    pat: "test-pat",
    now: () => "2026-07-05T00:00:00Z",
  })
  const { skip } = await src.claimNext()
  assert.match(skip?.message ?? "", /pull-request list failed — HTTP 401/)
  assert.match(skip?.message ?? "", /AZURE_DEVOPS_EXT_PAT/)
  assert.match(skip?.message ?? "", /Code \(read\) scope/)
  assert.equal(skip?.actionable, true)
})

test("a missing PAT skips actionably, naming the env var to set", async () => {
  const { item, skip } = await source([pr({ mergeStatus: "conflicts" })], { pat: "" }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /Azure DevOps PAT not set/)
  assert.match(skip?.message ?? "", /AZURE_DEVOPS_EXT_PAT/)
  assert.equal(skip?.actionable, true)
})

test("config ado.pat is a fallback when neither a dep nor the env var supplies a PAT", async () => {
  const saved = process.env.AZURE_DEVOPS_EXT_PAT
  delete process.env.AZURE_DEVOPS_EXT_PAT
  try {
    const src = makeAdoPrSource({
      $: scriptedShell([]),
      http: scriptedHttp([{ match: "/pullrequests?searchCriteria", body: listBody([pr({ mergeStatus: "conflicts" })]) }]),
      client: ledgerClient({}),
      directory: "/r",
      tasksDir: "docs/tasks",
      log: () => {},
      loaded: sitter,
      // No `pat` dep and no env var → resolution must fall through to ado.pat.
      ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com", pat: "cfg-pat" },
      now: () => "2026-07-05T00:00:00Z",
    })
    const { item, skip } = await src.claimNext()
    assert.doesNotMatch(skip?.message ?? "", /PAT not set/) // the config pat satisfied the requirement
    assert.equal(item?.id, "pr-7") // and it proceeded to a real claim
  } finally {
    if (saved === undefined) delete process.env.AZURE_DEVOPS_EXT_PAT
    else process.env.AZURE_DEVOPS_EXT_PAT = saved
  }
})

test("onTerminal(done) records the post-push head + comment watermark from the REST API", async () => {
  const log: string[] = []
  const src = source([pr({ mergeStatus: "conflicts" })], {
    routes: [
      {
        match: "/pullrequests/7?",
        body: JSON.stringify({
          lastMergeSourceCommit: { commitId: "sha-own-push" },
          repository: { id: "repo-guid" },
        }),
      },
      {
        match: "/threads",
        body: threads([
          { commentType: "text", publishedDate: "2026-07-05T01:00:00Z", author: { uniqueName: "alice@acme.com" } },
        ]),
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
    http: scriptedHttp([{ match: "/pullrequests?searchCriteria", body: listBody([pr({ mergeStatus: "conflicts" })]) }]),
    client: ledgerClient({}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets" },
    pat: "test-pat",
    now: () => "2026-07-05T00:00:00Z",
  })
  const { item, skip } = await src.claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /could not resolve the sitter's own ADO identity/)
  assert.match(skip?.message ?? "", /ado\.selfLogin/)
  assert.equal(skip?.actionable, true)
})

test("ado.customHeaders ride every REST call, with AGENTIC_WORKFLOW_ADO_HEADERS overriding them", async () => {
  const seen: Array<Readonly<Record<string, string>>> = []
  const capturingHttp: AdoHttp = async (_url, init): Promise<AdoHttpResponse> => {
    seen.push(init.headers)
    return { ok: true, status: 200, statusText: "ok", text: async () => listBody([]) }
  }
  const prevEnv = process.env.AGENTIC_WORKFLOW_ADO_HEADERS
  process.env.AGENTIC_WORKFLOW_ADO_HEADERS = JSON.stringify({ "Proxy-Authorization": "env-token" })
  try {
    const src = makeAdoPrSource({
      $: scriptedShell([]),
      http: capturingHttp,
      client: ledgerClient({}),
      directory: "/r",
      tasksDir: "docs/tasks",
      log: () => {},
      loaded: sitter,
      ado: {
        organization: "https://dev.azure.com/acme",
        project: "widgets",
        selfLogin: "sitter@acme.com",
        customHeaders: { "Proxy-Authorization": "cfg-token", "X-Route": "internal" },
      },
      pat: "test-pat",
      now: () => "2026-07-05T00:00:00Z",
    })
    await src.claimNext()
    assert.ok(seen.length >= 1, "at least the PR-list call was made")
    for (const headers of seen) {
      assert.ok(headers.Authorization?.startsWith("Basic ")) // built-in auth preserved
      assert.equal(headers["X-Route"], "internal") // config-only header present
      assert.equal(headers["Proxy-Authorization"], "env-token") // env wins over config
    }
  } finally {
    if (prevEnv === undefined) delete process.env.AGENTIC_WORKFLOW_ADO_HEADERS
    else process.env.AGENTIC_WORKFLOW_ADO_HEADERS = prevEnv
  }
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
    routes: [{ match: "/threads", body: older }],
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

// --- paging: $top=100 with no $skip silently dropped every PR past the first page ---

/** Build a source whose PR-list transport pages by `$skip`, serving `total` draft PRs. */
const pagedSource = (total: number, warnings: string[] = [], httpLog: string[] = []) =>
  makeAdoPrSource({
    $: scriptedShell([]),
    http: async (url) => {
      httpLog.push(url)
      let body = ""
      if (url.includes("/pullrequests?searchCriteria")) {
        const skip = Number(/\$skip=(\d+)/.exec(url)?.[1] ?? "0")
        const top = Number(/\$top=(\d+)/.exec(url)?.[1] ?? "100")
        const page = Array.from({ length: Math.max(0, Math.min(top, total - skip)) }, (_, i) =>
          pr({ pullRequestId: skip + i + 1, isDraft: true }),
        )
        body = JSON.stringify({ value: page })
      }
      return { ok: true, status: 200, statusText: "ok", text: async () => body }
    },
    client: ledgerClient({}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: (_l, m) => void warnings.push(m),
    loaded: sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" },
    pat: "test-pat",
    now: () => "2026-07-05T00:00:00Z",
  })

test("the ADO PR list pages past the first 100 instead of truncating", async () => {
  // ADO has no server-side search, so role filtering happens client-side over the
  // WHOLE set — a PR at position 140 that needs attention was simply invisible.
  const httpLog: string[] = []
  const { skip } = await pagedSource(150, [], httpLog).claimNext()
  const listCalls = httpLog.filter((u) => u.includes("/pullrequests?searchCriteria"))
  assert.ok(listCalls.length >= 2, `expected paging, got ${listCalls.length} list call(s)`)
  assert.ok(listCalls.some((u) => /\$skip=100/.test(u)), "second page never requested")
  // The skip line must report the true total, not the first page's size.
  assert.match(skip?.message ?? "", /150/)
})

test("a single short page issues no extra request", async () => {
  const httpLog: string[] = []
  const { skip } = await pagedSource(3, [], httpLog).claimNext()
  assert.equal(httpLog.filter((u) => u.includes("/pullrequests?searchCriteria")).length, 1)
  assert.match(skip?.message ?? "", /3 active/)
})

test("hitting the page ceiling warns instead of silently truncating", async () => {
  const warnings: string[] = []
  await pagedSource(5000, warnings).claimNext()
  assert.match(warnings.join("\n"), /truncat/i)
})
