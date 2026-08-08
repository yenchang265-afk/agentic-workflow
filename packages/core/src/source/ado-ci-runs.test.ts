import { defaultWorkflowsDir } from "../manifest/dir.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Client, Shell } from "../host.js"
import { loadManifest } from "../manifest/load.js"
import { shortSha } from "./ci-runs.js"
import { makeAdoCiRunsSource } from "./ado-ci-runs.js"
import type { AdoGateway } from "./ado-gateway.js"

/**
 * The ado-ci-runs source over the real main-sitter manifest, against a
 * scripted `AdoGateway` plus a scripted git/claim shell (`$`)
 * — the mirror of ci-runs.test.ts and ado-pr.test.ts. The build→CiRun
 * normalization is covered in ado-shared.test.ts; these cover polling,
 * ledger dedup, claim/pin mechanics (shared with the GitHub source via
 * ci-runs-shared.ts), and terminal writes.
 */

const WORKFLOWS_DIR = defaultWorkflowsDir()
const sitter = loadManifest(WORKFLOWS_DIR, "main-sitter")
const SHA = "abcdef1234567890abcdef1234567890abcdef12"
const OLD = "0123456789abcdef0123456789abcdef01234567"

/**
 * Assert the head marker was released through `releaseMarker`, i.e. the stamp
 * went first and the directory second.
 *
 * A bare `rmdir` assertion cannot see this bug: `onTerminal` always issued one,
 * it just never SUCCEEDED, because `acquireMarker` writes `claim.json` inside
 * the marker and `.nothrow()` swallowed the ENOTEMPTY. The `rm -f …/claim.json`
 * preceding it is the only part that distinguishes a real release from a
 * silent no-op that leaves the head claimed until the stale sweep.
 */
const assertMarkerReleased = (shellLog: readonly string[], sha: string = SHA): void => {
  const marker = `/r/docs/tasks/runs/main-sitter/.claims/head-${shortSha(sha)}`
  const stampRm = shellLog.findIndex((c) => c.startsWith(`rm -f ${marker}/claim.json`))
  const rmdir = shellLog.findIndex((c) => c.startsWith(`rmdir ${marker}`))
  assert.ok(stampRm !== -1 && rmdir !== -1 && stampRm < rmdir, "the head marker is released stamp-first, not by a bare rmdir")
}

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

/** Scripted gateway: serves one build list, or fails when `error` is set. */
const scriptedGateway = (builds: unknown[], log: string[] = [], error?: string): AdoGateway => {
  const notUsed = async (): Promise<never> => {
    throw new Error("the ci-runs source must not call this operation")
  }
  return {
    async listBuilds(a) {
      log.push(`listBuilds(${a.branchName ?? ""})`)
      return error ? { ok: false, error } : { ok: true, data: builds }
    },
    getPullRequest: notUsed,
    listPullRequests: notUsed,
    listPullRequestsByCommits: notUsed,
    listPullRequestThreads: notUsed,
    getRepository: notUsed,
    getBuildStatus: notUsed,
    createPullRequest: notUsed,
    async close() {},
  }
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


type Opts = {
  ledgers?: Record<string, string>
  gatewayError?: string
  shellScript?: Cmd[]
  shellLog?: string[]
  callLog?: string[]
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
    gateway: scriptedGateway(builds, opts.callLog, opts.gatewayError),
    client: ledgerClient(opts.ledgers ?? {}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    ado: { organization: "https://dev.azure.com/acme", project: "widgets" },
    ...(opts.branch ? { branch: opts.branch } : {}),
    now: () => "2026-07-05T00:00:00Z",
  })

test("claims the red newest head: default branch resolved via git, head pinned to a main-sitter/ branch, platform stamped ado", async () => {
  const shellLog: string[] = []
  const callLog: string[] = []
  const { item, skip } = await source([build()], { shellLog, callLog }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, `${SHA.slice(0, 6)}-main`) // display id: short sha + readable branch
  assert.equal(item?.entryStage, "diagnose")
  assert.equal(item?.state.kind, "main-sitter")
  assert.equal(item?.state.platform, "ado")
  assert.deepEqual(item?.state.git, { base: "main", branch: `main-sitter/${shortSha(SHA)}` })
  assert.match(item?.state.goal ?? "", /^Red CI on main at abcdef123456/)
  assert.match(item?.state.goal ?? "", /Failing workflow\(s\): CI/)
  assert.ok(callLog.some((c) => c === "listBuilds(refs/heads/main)"))
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

test("the head claim is stamped and sweepable — never the bare mkdir/rmdir pair", async () => {
  // Regression: this source used a bare mkdir with no stamp and no sweep, so a
  // SIGKILL between claim and release wedged the head forever (the exact
  // failure the shared claim-marker helpers exist to prevent — see
  // claim-marker.ts). The stamp write is what makes the marker recoverable,
  // and the entry state carries the marker path so drivers can restamp a live
  // drive (refreshWorkClaim).
  const shellLog: string[] = []
  const src = source([build()], { shellLog })
  const { item } = await src.claimNext()
  const marker = `/r/docs/tasks/runs/main-sitter/.claims/head-${shortSha(SHA)}`
  assert.ok(
    shellLog.some((c) => c.startsWith(`printf '%s' {"claimedAt"`) && c.includes(`${marker}/claim.json`)),
    "the claim writes the staleness stamp",
  )
  assert.equal(item?.state.claimMarkerDir, marker)
  await src.release({ ...item!, ref: { sha: SHA } })
  const stampRm = shellLog.findIndex((c) => c.startsWith(`rm -f ${marker}/claim.json`))
  const rmdir = shellLog.findIndex((c) => c.startsWith(`rmdir ${marker}`))
  assert.ok(stampRm !== -1 && rmdir !== -1 && stampRm < rmdir, "release drops the stamp, then the marker")
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

test("a build-list failure is an actionable skip naming the cause and the scope needed", async () => {
  // Credential problems now surface here rather than as a separate PAT
  // precondition: the gateway owns the credential, so a missing or rejected one
  // arrives as a failed call.
  const { skip } = await source([], { gatewayError: "no Azure DevOps credential: set AZURE_DEVOPS_EXT_PAT (or ado.pat)" }).claimNext()
  assert.match(skip?.message ?? "", /Azure DevOps build list failed/)
  assert.match(skip?.message ?? "", /AZURE_DEVOPS_EXT_PAT/)
  assert.match(skip?.message ?? "", /Build \(read\) scope/)
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
  assertMarkerReleased(shellLog)
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
  // The retryable arm depends on the release MOST: its contract is that the
  // next poll re-claims this head immediately, which a wedged marker blocks
  // for the whole stale window.
  assertMarkerReleased(shellLog)
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
  assertMarkerReleased(shellLog)
})

test("a configured branch override skips default-branch detection", async () => {
  const shellLog: string[] = []
  const callLog: string[] = []
  const { skip } = await source([build({ result: "succeeded" })], { branch: "release/v2", shellLog, callLog }).claimNext()
  assert.match(skip?.message ?? "", /release\/v2 is green/)
  assert.ok(shellLog.every((c) => !c.startsWith("git -C /r symbolic-ref")))
  assert.ok(callLog.some((c) => c === "listBuilds(refs/heads/release/v2)"))
})
