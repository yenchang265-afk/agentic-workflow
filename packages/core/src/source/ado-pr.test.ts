import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Client, Shell } from "../host.js"
import { loadManifest } from "../manifest/load.js"
import { makeAdoPrSource } from "./ado-pr.js"

/**
 * The ado-pr source over the real pr-sitter manifest, against a scripted
 * `az`/git shell — the mirror of github-pr.test.ts. Covers the normalization
 * (ref stripping, conflicts → CONFLICTING, negative vote → CHANGES_REQUESTED,
 * policy failures → failingChecks), the filtering (drafts, forks, other
 * authors, own/system comments), claim/fetch mechanics, and terminal ledger
 * writes.
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
  repository: { id: "repo-guid", name: "widgets" },
  ...over,
})

const threads = (comments: unknown[]) => JSON.stringify({ value: [{ isDeleted: false, comments }] })

const source = (prs: unknown[], opts: { ledgers?: Record<string, string>; script?: Cmd[]; log?: string[] } = {}) =>
  makeAdoPrSource({
    $: scriptedShell(
      [
        { cmd: "az repos pr list", result: { stdout: JSON.stringify(prs) } },
        ...(opts.script ?? []),
      ],
      opts.log,
    ),
    client: ledgerClient(opts.ledgers ?? {}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" },
    now: () => "2026-07-05T00:00:00Z",
  })

const failingPolicy = {
  cmd: "az repos pr policy list --id 7",
  result: {
    stdout: JSON.stringify([
      { status: "rejected", configuration: { isBlocking: true, type: { displayName: "Build" } } },
      { status: "approved", configuration: { isBlocking: true, type: { displayName: "Reviewers" } } },
      { status: "rejected", configuration: { isBlocking: false, type: { displayName: "Optional Build" } } },
    ]),
  },
}

test("claims a PR with a failing policy: refs stripped, goal names the failure, state stamped ado", async () => {
  const log: string[] = []
  const { item, skip } = await source([pr()], { script: [failingPolicy], log }).claimNext()
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
    script: [{ cmd: "az devops invoke", result: { stdout: ownAndSystem } }],
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
    script: [{ cmd: "az devops invoke", result: { stdout: comment("2026-07-03T00:00:00Z") } }],
  }).claimNext()
  assert.equal(old.item, null)
  const fresh = await source([pr()], {
    ledgers,
    script: [{ cmd: "az devops invoke", result: { stdout: comment("2026-07-05T00:00:00Z") } }],
  }).claimNext()
  assert.match(fresh.item?.state.goal ?? "", /1 unanswered comment/)
})

test("a held claim marker reports actionably and claims nothing", async () => {
  const { item, skip } = await source([pr({ mergeStatus: "conflicts" })], {
    script: [{ cmd: "mkdir /r/docs/tasks/runs/pr-sitter/.claims/pr-7", result: { exitCode: 1 } }],
  }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /claim marker held for pr-7/)
  assert.equal(skip?.actionable, true)
})

test("az failure surfaces as an actionable skip naming the extension and auth", async () => {
  const src = makeAdoPrSource({
    $: scriptedShell([{ cmd: "az repos pr list", result: { exitCode: 1, stderr: "az: 'repos' is not in the 'az' command group" } }]),
    client: ledgerClient({}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets" },
    now: () => "2026-07-05T00:00:00Z",
  })
  const { skip } = await src.claimNext()
  assert.match(skip?.message ?? "", /az repos pr list failed — az: 'repos' is not in the 'az' command group/)
  assert.match(skip?.message ?? "", /azure-devops az extension/)
  assert.equal(skip?.actionable, true)
})

test("onTerminal(done) records the post-push head + comment watermark from az", async () => {
  const log: string[] = []
  const src = source([pr({ mergeStatus: "conflicts" })], {
    script: [
      {
        cmd: "az repos pr show --id 7",
        result: {
          stdout: JSON.stringify({
            lastMergeSourceCommit: { commitId: "sha-own-push" },
            repository: { id: "repo-guid" },
          }),
        },
      },
      {
        cmd: "az devops invoke",
        result: {
          stdout: threads([
            { commentType: "text", publishedDate: "2026-07-05T01:00:00Z", author: { uniqueName: "alice@acme.com" } },
          ]),
        },
      },
    ],
    log,
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
  const src = source([pr({ mergeStatus: "conflicts" })], { log })
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "stop", message: "capped" })
  const write = log.find((c) => c.startsWith("printf") && c.includes("pr-7.json"))
  assert.match(write ?? "", /failedAttempts/)
  assert.match(write ?? "", /sha-1/)
  assert.match(write ?? "", /merge-conflict/)
})

test("selfLogin config short-circuits identity lookup; without it az identity is asked", async () => {
  const log: string[] = []
  await source([pr()], { log }).claimNext()
  assert.ok(!log.some((c) => c.startsWith("az ad signed-in-user")))
  const noSelf: string[] = []
  const src = makeAdoPrSource({
    $: scriptedShell(
      [
        { cmd: "az repos pr list", result: { stdout: JSON.stringify([pr()]) } },
        { cmd: "az ad signed-in-user show", result: { stdout: "sitter@acme.com\n" } },
      ],
      noSelf,
    ),
    client: ledgerClient({}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets" },
    now: () => "2026-07-05T00:00:00Z",
  })
  await src.claimNext()
  assert.ok(noSelf.some((c) => c.startsWith("az ad signed-in-user")))
})

test("unresolvable identity (PAT-only auth, no selfLogin) skips actionably instead of sitting on everyone's PRs", async () => {
  const src = makeAdoPrSource({
    // Unmatched identity commands succeed with empty stdout — same signature
    // as PAT-only auth where az has no signed-in account to report.
    $: scriptedShell([{ cmd: "az repos pr list", result: { stdout: JSON.stringify([pr({ mergeStatus: "conflicts" })]) } }]),
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
    script: [{ cmd: "az devops invoke", result: { stdout: older } }],
  }).claimNext()
  assert.equal(item, null)
})
