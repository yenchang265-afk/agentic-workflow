import { defaultLoopsDir } from "../manifest/dir.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Client, Shell } from "../host.js"
import { loadManifest } from "../manifest/load.js"
import { shortSha } from "./ci-runs.js"
import { makeAdoCiRunsSource, type AdoHttp } from "./ado-ci-runs.js"

/**
 * The ado-ci-runs source over the real main-sitter manifest, against a
 * scripted ADO REST transport (`http`) plus a scripted git/claim shell (`$`)
 * — the mirror of ci-runs.test.ts and ado-pr.test.ts. The build→CiRun
 * normalization is covered in ado-shared.test.ts; these cover polling,
 * ledger dedup, claim/pin mechanics (shared with the GitHub source via
 * ci-runs-shared.ts), and terminal writes.
 */

const LOOPS_DIR = defaultLoopsDir()
const sitter = loadManifest(LOOPS_DIR, "main-sitter")
const SHA = "abcdef1234567890abcdef1234567890abcdef12"
const OLD = "0123456789abcdef0123456789abcdef01234567"

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

const build = (over: Record<string, unknown> = {}) => ({
  sourceVersion: SHA,
  status: "completed",
  result: "failed",
  definition: { name: "CI" },
  queueTime: "2026-07-05T00:00:00Z",
  ...over,
})

const listBody = (builds: unknown[]) => JSON.stringify({ value: builds })

type Opts = {
  ledgers?: Record<string, string>
  routes?: Route[]
  shellScript?: Cmd[]
  shellLog?: string[]
  httpLog?: string[]
  pat?: string
  branch?: string
}

const source = (builds: unknown[], opts: Opts = {}) =>
  makeAdoCiRunsSource({
    $: scriptedShell(
      [
        ...(opts.shellScript ?? []),
        { cmd: "git -C /r symbolic-ref refs/remotes/origin/HEAD", result: { stdout: "refs/remotes/origin/main\n" } },
        { cmd: "git -C /r rev-parse refs/remotes/origin/main", result: { stdout: `${SHA}\n` } },
      ],
      opts.shellLog,
    ),
    http: scriptedHttp([...(opts.routes ?? []), { match: "/build/builds?", body: listBody(builds) }], opts.httpLog),
    client: ledgerClient(opts.ledgers ?? {}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets" },
    pat: opts.pat ?? "test-pat",
    ...(opts.branch ? { branch: opts.branch } : {}),
    now: () => "2026-07-05T00:00:00Z",
  })

test("claims the red newest head: default branch resolved via git, head pinned to a main-sitter/ branch, platform stamped ado", async () => {
  const shellLog: string[] = []
  const httpLog: string[] = []
  const { item, skip } = await source([build()], { shellLog, httpLog }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, `${SHA.slice(0, 6)}-main`) // display id: short sha + readable branch
  assert.equal(item?.entryStage, "diagnose")
  assert.equal(item?.state.kind, "main-sitter")
  assert.equal(item?.state.platform, "ado")
  assert.deepEqual(item?.state.git, { base: "main", branch: `main-sitter/${shortSha(SHA)}` })
  assert.match(item?.state.goal ?? "", /^Red CI on main at abcdef123456/)
  assert.match(item?.state.goal ?? "", /Failing workflow\(s\): CI/)
  assert.ok(httpLog.some((u) => u.includes("branchName=refs%2Fheads%2Fmain")))
  assert.ok(shellLog.some((c) => c.includes("runs/main-sitter/.claims/head-abcdef123456")))
  assert.ok(shellLog.some((c) => c.startsWith(`git -C /r branch -f main-sitter/abcdef123456 ${SHA}`)))
})

test("a green newest head (succeeded result) claims nothing", async () => {
  const { item, skip } = await source([build({ result: "succeeded" })]).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /main is green at abcdef123456/)
})

test("an in-progress build on the newest head is pending — never claimed mid-run", async () => {
  const { item, skip } = await source([build({ status: "notStarted", result: null })]).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /main is pending/)
})

test("a handled or failed head is never re-claimed — a new push makes a new judgement", async () => {
  const handled = {
    [`docs/tasks/runs/main-sitter/head-${shortSha(SHA)}.json`]: JSON.stringify({
      sha: SHA,
      handled: true,
      failedAttempts: [],
      updatedAt: "2026-07-04T00:00:00Z",
    }),
  }
  const { item, skip } = await source([build()], { ledgers: handled }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /already handled — waiting for a new push/)
})

test("no PAT set is an actionable skip", async () => {
  const { item, skip } = await source([build()], { pat: "" }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /Azure DevOps PAT not set/)
  assert.equal(skip?.actionable, true)
})

test("a build-list HTTP failure is an actionable skip", async () => {
  const { skip } = await source([], { routes: [{ match: "/build/builds?", status: 500 }] }).claimNext()
  assert.match(skip?.message ?? "", /Azure DevOps build list failed — HTTP 500/)
  assert.equal(skip?.actionable, true)
})

test("a branch tip that moved during the claim is released for the next poll", async () => {
  const shellLog: string[] = []
  const src = source([build()], {
    shellScript: [{ cmd: "git -C /r rev-parse refs/remotes/origin/main", result: { stdout: `${OLD}\n` } }],
    shellLog,
  })
  const { item, skip } = await src.claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /moved during claim/)
  assert.ok(shellLog.some((c) => c.startsWith("rmdir") && c.includes("head-abcdef123456")))
})

test("onTerminal(done) marks the head handled under runs/main-sitter/; stop records a failed attempt", async () => {
  const shellLog: string[] = []
  const src = source([build()], { shellLog })
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "done", message: "remedy PR opened" })
  const write = shellLog.find((c) => c.startsWith("printf") && c.includes(`head-${shortSha(SHA)}.json`))
  assert.ok(write, "ledger written")
  assert.match(write ?? "", /"handled": true/)
  assert.ok(shellLog.some((c) => c.startsWith("rmdir") && c.includes(`head-${shortSha(SHA)}`)))
})

test("a configured branch override skips default-branch detection", async () => {
  const shellLog: string[] = []
  const httpLog: string[] = []
  const { skip } = await source([build({ result: "succeeded" })], { branch: "release/v2", shellLog, httpLog }).claimNext()
  assert.match(skip?.message ?? "", /release\/v2 is green/)
  assert.ok(shellLog.every((c) => !c.startsWith("git -C /r symbolic-ref")))
  assert.ok(httpLog.some((u) => u.includes("branchName=refs%2Fheads%2Frelease%2Fv2")))
})
