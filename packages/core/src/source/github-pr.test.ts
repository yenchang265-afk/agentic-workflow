import { defaultWorkflowsDir } from "../manifest/dir.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import type { Client, Shell } from "../host.js"
import { loadManifest } from "../manifest/load.js"
import { makeGithubPrSource } from "./github-pr.js"

/**
 * The GitHub PR source over the real pr-sitter manifest, against a scripted
 * `gh`/git shell. The attention/dedup decision itself is covered by
 * ledger.test.ts; this covers the source's polling, filtering (drafts, forks,
 * own comments), claim/fetch mechanics, and terminal ledger writes.
 */

const WORKFLOWS_DIR = defaultWorkflowsDir()
const sitter = loadManifest(WORKFLOWS_DIR, "pr-sitter")

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
  number: 7,
  title: "Add rate limiting",
  headRefName: "feat/rate-limit",
  baseRefName: "main",
  headRefOid: "sha-1",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: "",
  isCrossRepository: false,
  statusCheckRollup: [] as unknown[],
  comments: [] as unknown[],
  ...over,
})

const source = (prs: unknown[], opts: { ledgers?: Record<string, string>; script?: Cmd[]; log?: string[]; warns?: string[] } = {}) =>
  makeGithubPrSource({
    $: scriptedShell(
      [
        { cmd: "gh api user", result: { stdout: "sitter-bot\n" } },
        { cmd: "gh pr list", result: { stdout: JSON.stringify(prs) } },
        ...(opts.script ?? []),
      ],
      opts.log,
    ),
    client: ledgerClient(opts.ledgers ?? {}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: async (level, message) => void (level === "warn" && opts.warns?.push(message)),
    loaded: sitter,
    now: () => "2026-07-05T00:00:00Z",
  })

test("claims a PR with failing checks: goal names the failure, state enters triage on the PR branch", async () => {
  const prs = [pr({ statusCheckRollup: [{ name: "ci/test", conclusion: "FAILURE" }] })]
  const log: string[] = []
  const { item, skip } = await source(prs, { log }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "pr-7")
  assert.equal(item?.entryStage, "triage")
  assert.equal(item?.state.kind, "pr-sitter")
  assert.deepEqual(item?.state.git, { base: "main", branch: "feat/rate-limit" })
  assert.match(item?.state.goal ?? "", /failing checks: ci\/test/)
  assert.match(item?.state.goal ?? "", /Never merge/)
  assert.ok(log.some((c) => c.startsWith("git -C /r fetch origin +refs/heads/feat/rate-limit")))
  assert.ok(log.some((c) => c.includes(".claims/pr-7")))
})

test("skips drafts, fork PRs, and PRs where the only comments are its own", async () => {
  const prs = [
    pr({ number: 1, isDraft: true, statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] }),
    pr({ number: 2, isCrossRepository: true, statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] }),
    pr({ number: 3, comments: [{ author: { login: "sitter-bot" }, createdAt: "2026-07-04T00:00:00Z" }] }),
  ]
  const { item, skip } = await source(prs).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /no PRs need attention \(3 matched/)
  assert.equal(skip?.actionable, false)
})

test("a human comment newer than the ledger watermark triggers a claim; an older one does not", async () => {
  const comment = { author: { login: "alice" }, createdAt: "2026-07-03T00:00:00Z" }
  const ledgers = {
    "docs/tasks/runs/pr-sitter/pr-7.json": JSON.stringify({
      pr: 7,
      lastCommentAtHandled: "2026-07-04T00:00:00Z",
      failedAttempts: [],
      updatedAt: "2026-07-04T00:00:00Z",
    }),
  }
  const old = await source([pr({ comments: [comment] })], { ledgers }).claimNext()
  assert.equal(old.item, null)
  const fresh = await source([pr({ comments: [{ ...comment, createdAt: "2026-07-05T00:00:00Z" }] })], {
    ledgers,
  }).claimNext()
  assert.match(fresh.item?.state.goal ?? "", /1 unanswered comment/)
})

test("a held claim marker reports actionably and claims nothing", async () => {
  const prs = [pr({ statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] })]
  const { item, skip } = await source(prs, {
    script: [{ cmd: "mkdir /r/docs/tasks/runs/pr-sitter/.claims/pr-7", result: { exitCode: 1 } }],
  }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /claim marker held for pr-7/)
  assert.equal(skip?.actionable, true)
})

test("a failed fetch releases the claim and moves on", async () => {
  const prs = [pr({ statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] })]
  const log: string[] = []
  const { item } = await source(prs, {
    script: [
      { cmd: "git -C /r fetch origin +refs/heads/feat/rate-limit", result: { exitCode: 1 } },
      { cmd: "git -C /r fetch origin feat/rate-limit", result: { exitCode: 1 } },
    ],
    log,
  }).claimNext()
  assert.equal(item, null)
  assert.ok(log.some((c) => c.startsWith("rmdir") && c.includes("pr-7")))
})

test("gh failure surfaces as an actionable skip", async () => {
  const src = makeGithubPrSource({
    $: scriptedShell([{ cmd: "gh pr list", result: { exitCode: 1, stderr: "gh: not logged in" } }]),
    client: ledgerClient({}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    now: () => "2026-07-05T00:00:00Z",
  })
  const { skip } = await src.claimNext()
  assert.match(skip?.message ?? "", /gh pr list failed — gh: not logged in/)
  assert.equal(skip?.actionable, true)
})

test("onTerminal(done) records the post-push head + comment watermark, ending the self-trigger loop", async () => {
  const prs = [pr({ statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] })]
  const log: string[] = []
  const src = source(prs, {
    script: [
      {
        cmd: "gh pr view 7",
        result: {
          stdout: JSON.stringify({
            headRefOid: "sha-own-push",
            comments: [{ createdAt: "2026-07-05T01:00:00Z" }],
          }),
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

test("onTerminal(done) warns loudly when the post-push head re-read fails or is garbled", async () => {
  // A silent fallback to the pre-run head means the sitter's own push may not
  // be recorded as handled — the exact self-trigger loop the ledger prevents.
  const prs = [pr({ statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] })]
  const failed: string[] = []
  const srcFail = source(prs, { script: [{ cmd: "gh pr view 7", result: { exitCode: 1 } }], warns: failed })
  const { item } = await srcFail.claimNext()
  assert.ok(item)
  await srcFail.onTerminal?.(item, { kind: "done", message: "pushed" })
  assert.ok(
    failed.some((m) => /pre-run head/.test(m)),
    `the failed re-read must be loud, got: ${JSON.stringify(failed)}`,
  )

  const garbled: string[] = []
  const srcGarbled = source(prs, { script: [{ cmd: "gh pr view 7", result: { stdout: "not json" } }], warns: garbled })
  const { item: item2 } = await srcGarbled.claimNext()
  assert.ok(item2)
  await srcGarbled.onTerminal?.(item2, { kind: "done", message: "pushed" })
  assert.ok(
    garbled.some((m) => /pre-run head/.test(m)),
    `the garbled re-read must be loud, got: ${JSON.stringify(garbled)}`,
  )
})

test("onTerminal(stop) records a failed attempt pinned to the claimed head", async () => {
  const prs = [pr({ statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] })]
  const log: string[] = []
  const src = source(prs, { log })
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "stop", message: "capped" })
  const write = log.find((c) => c.startsWith("printf") && c.includes("pr-7.json"))
  assert.match(write ?? "", /failedAttempts/)
  assert.match(write ?? "", /sha-1/)
  assert.match(write ?? "", /failing-checks/)
})

// --- the review-sitter kind over the same source: reviewer role, review-requested trigger ---

const reviewer = loadManifest(WORKFLOWS_DIR, "review-sitter")

const reviewerSource = (prs: unknown[], opts: { ledgers?: Record<string, string>; script?: Cmd[]; log?: string[] } = {}) =>
  makeGithubPrSource({
    $: scriptedShell(
      [
        { cmd: "gh api user", result: { stdout: "sitter-bot\n" } },
        { cmd: "gh pr list", result: { stdout: JSON.stringify(prs) } },
        ...(opts.script ?? []),
      ],
      opts.log,
    ),
    client: ledgerClient(opts.ledgers ?? {}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: reviewer,
    now: () => "2026-07-05T00:00:00Z",
  })

test("review-sitter claims a listed PR outright (the query pre-filters): fetch entry, reviewer goal, own runs/ namespace", async () => {
  const log: string[] = []
  const { item, skip } = await reviewerSource([pr()], { log }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "pr-7")
  assert.equal(item?.entryStage, "fetch")
  assert.equal(item?.state.kind, "review-sitter")
  assert.match(item?.state.goal ?? "", /one structured review comment/)
  assert.match(item?.state.goal ?? "", /Never approve, request changes, or merge/)
  // The PR head is fetched for the assess worktree, and the claim marker and
  // ledger live under this kind's own runs/ directory — never pr-sitter's.
  assert.ok(log.some((c) => c.startsWith("git -C /r fetch origin +refs/heads/feat/rate-limit")))
  assert.ok(log.some((c) => c.includes("runs/review-sitter/.claims/pr-7")))
  assert.ok(log.every((c) => !c.includes("runs/pr-sitter")))
})

test("review-sitter: a handled head suppresses re-review; a human's new push re-claims", async () => {
  const ledgers = {
    "docs/tasks/runs/review-sitter/pr-7.json": JSON.stringify({
      pr: 7,
      headShaHandled: "sha-1",
      failedAttempts: [],
      updatedAt: "2026-07-04T00:00:00Z",
    }),
  }
  const same = await reviewerSource([pr()], { ledgers }).claimNext()
  assert.equal(same.item, null)
  assert.match(same.skip?.message ?? "", /^review-sitter: no PRs need attention/)
  const pushed = await reviewerSource([pr({ headRefOid: "sha-2" })], { ledgers }).claimNext()
  assert.equal(pushed.item?.id, "pr-7")
})

test("review-sitter onTerminal(done) records the reviewed head in its own ledger", async () => {
  const log: string[] = []
  const src = reviewerSource([pr()], {
    script: [{ cmd: "gh pr view 7", result: { stdout: JSON.stringify({ headRefOid: "sha-1", comments: [] }) } }],
    log,
  })
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "done", message: "posted the review" })
  const write = log.find((c) => c.startsWith("printf") && c.includes("pr-7.json"))
  assert.ok(write, "ledger written")
  assert.match(write ?? "", /runs\/review-sitter\/pr-7\.json/)
  assert.match(write ?? "", /sha-1/)
})

test("review-sitter onTerminal: a retryable (onError fetch) stop leaves the head claimable (C2)", async () => {
  const log: string[] = []
  const src = reviewerSource([pr()], {
    script: [{ cmd: "gh pr view 7", result: { stdout: JSON.stringify({ headRefOid: "sha-1", comments: [] }) } }],
    log,
  })
  const { item } = await src.claimNext()
  assert.ok(item)
  // A transient fetch error is review-sitter's ONLY failedAttempt source; without C2 it
  // pinned the head forever. A retryable stop must write no ledger, so the next poll re-claims.
  await src.onTerminal?.(item, { kind: "stop", message: "gh pr diff failed", retryable: true })
  assert.ok(
    !log.some((c) => c.startsWith("printf") && c.includes("pr-7.json")),
    "retryable stop leaves the ledger untouched",
  )
  assert.ok(log.some((c) => c.includes("runs/review-sitter/.claims/pr-7")), "claim marker still released")
})

// --- paging: gh pr list defaults to 30, silently dropping the rest ---

test("gh pr list is invoked with an explicit --limit", async () => {
  // Without --limit, gh returns only the newest 30. This source iterates the FULL
  // set looking for one that needs attention, so a PR beyond the window is never
  // claimed — no error, no warning. (ci-runs' 30 is fine: it judges only the
  // newest head. A PR sweep is not.)
  const log: string[] = []
  await source([pr()], { log }).claimNext()
  const list = log.find((c) => c.startsWith("gh pr list"))
  assert.ok(list, "no gh pr list invocation")
  assert.match(list, /--limit \d+/)
})

test("a truncated PR page is reported, not silently dropped", async () => {
  // When the returned count equals the limit there may be more behind it; the
  // skip must not claim the number it saw is the number that exist.
  const warnings: string[] = []
  const many = Array.from({ length: 200 }, (_, i) => pr({ number: i + 1, isDraft: true }))
  const src = makeGithubPrSource({
    $: scriptedShell([
      { cmd: "gh api user", result: { stdout: "sitter-bot\n" } },
      { cmd: "gh pr list", result: { stdout: JSON.stringify(many) } },
    ]),
    client: ledgerClient({}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: (_l, m) => void warnings.push(m),
    loaded: sitter,
    now: () => "2026-07-05T00:00:00Z",
  })
  const { skip } = await src.claimNext()
  assert.equal(skip?.actionable, false)
  assert.match(warnings.join("\n"), /truncat/i)
})
