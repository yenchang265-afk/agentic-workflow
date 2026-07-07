import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Client, Shell } from "../host.js"
import { loadManifest } from "../manifest/load.js"
import {
  makeAdoMcpPrSource,
  describeAdoDataRequest,
  type AdoDataBundle,
  type AdoDataProvider,
  type AdoDataRequest,
} from "./ado-mcp-pr.js"

/**
 * The ado-mcp source over the real pr-sitter manifest. Unlike ado-pr.test.ts it
 * scripts no `az` — the ADO data arrives as a bundle from an injected provider,
 * so these tests cover the same normalization/filtering/claim logic the CLI
 * source has, plus the two things unique to this mode: the "needs data" skip
 * when the provider has nothing, and the git-derived (no-ADO) terminal ledger.
 */

const LOOPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..", "loops")
const sitter = loadManifest(LOOPS_DIR, "pr-sitter")

type Cmd = { cmd: string; result: { exitCode?: number; stdout?: string; stderr?: string } }

/** Scripted shell: first matching prefix wins; unmatched commands succeed empty. */
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

const thread = (comments: unknown[]) => ({ isDeleted: false, comments })

const bundlePr = (over: Record<string, unknown> = {}) => ({
  pullRequestId: 7,
  title: "Add rate limiting",
  sourceRefName: "refs/heads/feat/rate-limit",
  targetRefName: "refs/heads/main",
  isDraft: false,
  mergeStatus: "succeeded",
  // Case-different from the configured selfLogin on purpose — must still match.
  createdBy: { uniqueName: "Sitter@Acme.com" },
  lastMergeSourceCommit: { commitId: "sha-1" },
  reviewers: [] as unknown[],
  repository: { id: "repo-guid", name: "widgets" },
  threads: [] as unknown[],
  failingChecks: [] as string[],
  ...over,
})

const bundle = (prs: unknown[], viewerLogin = "sitter@acme.com"): AdoDataBundle =>
  ({ viewerLogin, pullRequests: prs }) as AdoDataBundle

const constProvider = (b: AdoDataBundle | null): AdoDataProvider => ({ fetch: async () => b })

const source = (
  b: AdoDataBundle | null,
  opts: { ledgers?: Record<string, string>; script?: Cmd[]; log?: string[]; provider?: AdoDataProvider } = {},
) =>
  makeAdoMcpPrSource({
    $: scriptedShell(opts.script ?? [], opts.log),
    client: ledgerClient(opts.ledgers ?? {}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" },
    provider: opts.provider ?? constProvider(b),
    now: () => "2026-07-05T00:00:00Z",
  })

test("claims a PR with failing checks: refs stripped, goal names the failure, state stamped ado-mcp", async () => {
  const log: string[] = []
  const { item, skip } = await source(bundle([bundlePr({ failingChecks: ["Build"] })]), { log }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "pr-7")
  assert.equal(item?.entryStage, "triage")
  assert.equal(item?.state.platform, "ado-mcp")
  assert.deepEqual(item?.state.git, { base: "main", branch: "feat/rate-limit" })
  assert.match(item?.state.goal ?? "", /failing checks: Build/)
  assert.match(item?.state.goal ?? "", /Never merge/)
  assert.ok(log.some((c) => c.startsWith("git -C /r fetch origin +refs/heads/feat/rate-limit")))
  assert.ok(log.some((c) => c.includes(".claims/pr-7")))
  // No `az` ever runs in this mode.
  assert.ok(!log.some((c) => c.startsWith("az ")))
})

test("a merge conflict and a negative reviewer vote trigger via the normalized snapshot", async () => {
  const conflicted = await source(bundle([bundlePr({ mergeStatus: "conflicts" })])).claimNext()
  assert.match(conflicted.item?.state.goal ?? "", /merge conflict/)
  const rejected = await source(bundle([bundlePr({ reviewers: [{ vote: -5 }] })])).claimNext()
  assert.match(rejected.item?.state.goal ?? "", /review requested changes/)
})

test("skips drafts, fork PRs, other authors' PRs, and system/own comments", async () => {
  const prs = [
    bundlePr({ pullRequestId: 1, isDraft: true, mergeStatus: "conflicts" }),
    bundlePr({ pullRequestId: 2, forkSource: { repository: { id: "x" } }, mergeStatus: "conflicts" }),
    bundlePr({ pullRequestId: 3, createdBy: { uniqueName: "alice@acme.com" }, mergeStatus: "conflicts" }),
    bundlePr({
      pullRequestId: 4,
      threads: [
        thread([
          { commentType: "text", publishedDate: "2026-07-04T00:00:00Z", author: { uniqueName: "SITTER@acme.com" } },
          { commentType: "system", publishedDate: "2026-07-04T00:00:00Z", author: { uniqueName: "bob@acme.com" } },
          { commentType: "text", publishedDate: "2026-07-04T00:00:00Z", isDeleted: true, author: { uniqueName: "carol@acme.com" } },
        ]),
      ],
    }),
  ]
  const { item, skip } = await source(bundle(prs)).claimNext()
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
  const withComment = (at: string) =>
    bundlePr({ threads: [thread([{ commentType: "text", publishedDate: at, author: { uniqueName: "alice@acme.com" } }])] })
  const old = await source(bundle([withComment("2026-07-03T00:00:00Z")]), { ledgers }).claimNext()
  assert.equal(old.item, null)
  const fresh = await source(bundle([withComment("2026-07-05T00:00:00Z")]), { ledgers }).claimNext()
  assert.match(fresh.item?.state.goal ?? "", /1 unanswered comment/)
})

test("a held claim marker reports actionably and claims nothing", async () => {
  const { item, skip } = await source(bundle([bundlePr({ mergeStatus: "conflicts" })]), {
    script: [{ cmd: "mkdir /r/docs/tasks/runs/pr-sitter/.claims/pr-7", result: { exitCode: 1 } }],
  }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /claim marker held for pr-7/)
  assert.equal(skip?.actionable, true)
})

test("provider with no data yields a needsAdoData skip carrying the fetch request", async () => {
  const { item, skip } = await source(null).claimNext()
  assert.equal(item, null)
  assert.equal(skip?.needsAdoData, true)
  assert.equal(skip?.actionable, true)
  const request = skip?.request as AdoDataRequest
  assert.equal(request.organization, "https://dev.azure.com/acme")
  assert.equal(request.project, "widgets")
  assert.equal(request.selfLogin, "sitter@acme.com")
  assert.equal(request.serverName, "ado")
  assert.deepEqual([...request.triggers].sort(), ["changes-requested", "failing-checks", "merge-conflict", "new-comments"])
})

test("missing selfLogin skips actionably (config normally prevents this)", async () => {
  const src = makeAdoMcpPrSource({
    $: scriptedShell([]),
    client: ledgerClient({}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets" },
    provider: constProvider(bundle([bundlePr({ mergeStatus: "conflicts" })])),
    now: () => "2026-07-05T00:00:00Z",
  })
  const { item, skip } = await src.claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /ado\.selfLogin is required/)
  assert.equal(skip?.actionable, true)
})

test("onTerminal(done) records the post-push head from git and the comment watermark — no ADO call", async () => {
  const log: string[] = []
  const src = source(
    bundle([
      bundlePr({
        mergeStatus: "conflicts",
        threads: [thread([{ commentType: "text", publishedDate: "2026-07-05T01:00:00Z", author: { uniqueName: "alice@acme.com" } }])],
      }),
    ]),
    {
      script: [{ cmd: "git -C /r rev-parse refs/heads/feat/rate-limit", result: { stdout: "sha-own-push\n" } }],
      log,
    },
  )
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "done", message: "pushed" })
  const write = log.find((c) => c.startsWith("printf") && c.includes("pr-7.json"))
  assert.ok(write, "ledger written")
  assert.match(write ?? "", /sha-own-push/) // head came from git rev-parse, not ADO
  assert.match(write ?? "", /2026-07-05T01:00:00Z/) // watermark stashed at claim time
  assert.ok(log.some((c) => c.startsWith("rmdir") && c.includes("pr-7")))
  assert.ok(!log.some((c) => c.startsWith("az ")))
})

test("onTerminal(stop) records a failed attempt pinned to the claimed head", async () => {
  const log: string[] = []
  const src = source(bundle([bundlePr({ mergeStatus: "conflicts" })]), { log })
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "stop", message: "capped" })
  const write = log.find((c) => c.startsWith("printf") && c.includes("pr-7.json"))
  assert.match(write ?? "", /failedAttempts/)
  assert.match(write ?? "", /sha-1/)
  assert.match(write ?? "", /merge-conflict/)
})

test("a PR without a head SHA (merge evaluation queued) is skipped", async () => {
  const { item } = await source(bundle([bundlePr({ mergeStatus: "conflicts", lastMergeSourceCommit: null })])).claimNext()
  assert.equal(item, null)
})

test("describeAdoDataRequest names the read-only tools and the JSON shape", () => {
  const req: AdoDataRequest = {
    organization: "https://dev.azure.com/acme",
    project: "widgets",
    selfLogin: "sitter@acme.com",
    triggers: ["failing-checks", "new-comments"],
    serverName: "ado",
  }
  const text = describeAdoDataRequest(req)
  assert.match(text, /mcp__ado__repo_list_pull_requests_by_repo_or_project/)
  assert.match(text, /mcp__ado__repo_list_pull_request_threads/)
  assert.match(text, /mcp__ado__pipelines_get_builds/)
  assert.match(text, /"viewerLogin": "sitter@acme.com"/)
  assert.match(text, /untrusted/i)
  // No write tools mentioned.
  assert.doesNotMatch(text, /repo_update_pull_request|repo_vote_pull_request/)
})
