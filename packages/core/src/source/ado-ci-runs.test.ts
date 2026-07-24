import { defaultWorkflowsDir } from "../manifest/dir.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Client, Shell } from "../host.js"
import { loadManifest } from "../manifest/load.js"
import { shortSha } from "./ci-runs.js"
import { makeAdoCiRunsSource } from "./ado-ci-runs.js"
import type { AzExec, AzResult } from "./ado-az.js"

/**
 * The ado-ci-runs source over the real main-sitter manifest, against a
 * scripted `az` CLI (`azExec`) plus a scripted git/claim shell (`$`) — the
 * mirror of ci-runs.test.ts and ado-pr.test.ts. ADO is reached only through
 * the az CLI, whose `az devops invoke` returns the same `{ value: [...] }`
 * build envelopes the REST API would. The build→CiRun normalization is covered
 * in ado-shared.test.ts; these cover polling, ledger dedup, claim/pin mechanics
 * (shared with the GitHub source via ci-runs-shared.ts), and terminal writes.
 */

const WORKFLOWS_DIR = defaultWorkflowsDir()
const sitter = loadManifest(WORKFLOWS_DIR, "main-sitter")
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

/**
 * Scripted `az` CLI: the build-list `az devops invoke` returns `listResult`
 * (default: the given builds as a `{ value: [...] }` envelope, `ok:true`);
 * `azFail` forces that call to fail, standing in for a broken CLI / auth.
 */
const scriptedAz = (builds: unknown[], log: string[] = [], opts: { azFail?: boolean } = {}): AzExec => async (args) => {
  const cmd = args.join(" ")
  log.push(cmd)
  if (cmd.includes("--resource builds")) {
    return opts.azFail
      ? ({ ok: false, statusText: "az CLI not authenticated", body: "" } satisfies AzResult)
      : ({ ok: true, statusText: "OK", body: listBody(builds) } satisfies AzResult)
  }
  return { ok: false, statusText: `unexpected az call: ${cmd}`, body: "" }
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
  azFail?: boolean
  shellScript?: Cmd[]
  shellLog?: string[]
  azLog?: string[]
  branch?: string
}

const source = (builds: unknown[], opts: Opts = {}) =>
  makeAdoCiRunsSource({
    $: scriptedShell(
      [
        ...(opts.shellScript ?? []),
        { cmd: "git -C /r symbolic-ref refs/remotes/origin/HEAD", result: { stdout: "refs/remotes/origin/main\n" } },
        { cmd: "git -C /r rev-parse refs/remotes/origin/main", result: { stdout: `${SHA}\n` } },
        // opts.shellScript is consulted first (prepended above), so a re-claim
        // test can make the ancestor check succeed; this default is the
        // fresh-claim case — no remedy branch yet → check fails → pin via `branch -f`.
        { cmd: "git -C /r merge-base --is-ancestor", result: { exitCode: 1 } },
      ],
      opts.shellLog,
    ),
    azExec: scriptedAz(builds, opts.azLog, { azFail: opts.azFail }),
    client: ledgerClient(opts.ledgers ?? {}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets" },
    ...(opts.branch ? { branch: opts.branch } : {}),
    now: () => "2026-07-05T00:00:00Z",
  })

test("claims the red newest head over the az CLI: default branch resolved via git, head pinned to a main-sitter/ branch, platform stamped ado", async () => {
  const shellLog: string[] = []
  const azLog: string[] = []
  const { item, skip } = await source([build()], { shellLog, azLog }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, `${SHA.slice(0, 6)}-main`) // display id: short sha + readable branch
  assert.equal(item?.entryStage, "diagnose")
  assert.equal(item?.state.kind, "main-sitter")
  assert.equal(item?.state.platform, "ado")
  assert.deepEqual(item?.state.git, { base: "main", branch: `main-sitter/${shortSha(SHA)}` })
  assert.match(item?.state.goal ?? "", /^Red CI on main at abcdef123456/)
  assert.match(item?.state.goal ?? "", /Failing workflow\(s\): CI/)
  const list = azLog.find((c) => c.includes("--resource builds"))
  assert.match(list ?? "", /devops invoke --area build/)
  assert.match(list ?? "", /branchName=refs\/heads\/main/)
  assert.ok(shellLog.some((c) => c.includes("runs/main-sitter/.claims/head-abcdef123456")))
  assert.ok(shellLog.some((c) => c.startsWith(`git -C /r branch -f main-sitter/abcdef123456 ${SHA}`)))
})

test("re-claiming a head whose remedy branch already has commits reuses it, never branch -f", async () => {
  // After a head-ledger loss the same red head can be re-claimed while a prior
  // run already committed a fix onto main-sitter/<sha>. `branch -f` would reset
  // the branch to the bare red head and discard that work; the ancestor check
  // must reuse the existing branch instead.
  const shellLog: string[] = []
  const { item, skip } = await source([build()], {
    shellLog,
    shellScript: [{ cmd: "git -C /r merge-base --is-ancestor", result: { exitCode: 0 } }],
  }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, `${SHA.slice(0, 6)}-main`)
  assert.ok(!shellLog.some((c) => c.startsWith("git -C /r branch -f")), "must not reset a remedy branch that already has commits")
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

test("a build-list az failure is an actionable skip naming the CLI setup", async () => {
  const { skip } = await source([], { azFail: true }).claimNext()
  assert.match(skip?.message ?? "", /Azure DevOps build list failed \(az CLI\)/)
  assert.match(skip?.message ?? "", /azure-devops extension/)
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

test("a retryable stop leaves the ledger untouched so the next poll re-claims the head", async () => {
  // C2: a transient stop (ERROR verdict, interrupt) must not burn the head's one
  // shot. Recording a failedAttempt here parks a red default branch forever —
  // claimNext refuses any head with failedAttempts until someone pushes again.
  const shellLog: string[] = []
  const src = source([build()], { shellLog })
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "stop", message: "stage errored", retryable: true })
  assert.ok(
    !shellLog.some((c) => c.startsWith("printf") && c.includes(`head-${shortSha(SHA)}.json`)),
    "no ledger write on a retryable stop",
  )
  assert.ok(shellLog.some((c) => c.startsWith("rmdir") && c.includes(`head-${shortSha(SHA)}`)))
})

test("a non-retryable stop records a failed attempt", async () => {
  const shellLog: string[] = []
  const src = source([build()], { shellLog })
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "stop", message: "iteration cap", retryable: false })
  const write = shellLog.find((c) => c.startsWith("printf") && c.includes(`head-${shortSha(SHA)}.json`))
  assert.ok(write, "ledger written")
  assert.match(write ?? "", /failedAttempts/)
})

test("a configured branch override skips default-branch detection", async () => {
  const shellLog: string[] = []
  const azLog: string[] = []
  const { skip } = await source([build({ result: "succeeded" })], { branch: "release/v2", shellLog, azLog }).claimNext()
  assert.match(skip?.message ?? "", /release\/v2 is green/)
  assert.ok(shellLog.every((c) => !c.startsWith("git -C /r symbolic-ref")))
  assert.ok(azLog.some((c) => c.includes("branchName=refs/heads/release/v2")))
})

test("the build-list az invoke carries the branch and ordering query parameters", async () => {
  const azLog: string[] = []
  await source([build()], { azLog }).claimNext()
  const list = azLog.find((c) => c.includes("--resource builds"))
  assert.match(list ?? "", /--query-parameters branchName=refs\/heads\/main \$top=30 queryOrder=queueTimeDescending/)
})
