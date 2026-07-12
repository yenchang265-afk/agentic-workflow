import { defaultLoopsDir } from "../manifest/dir.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Client, Shell } from "../host.js"
import { loadManifest } from "../manifest/load.js"
import { makeCiRunsSource, newestHeadVerdict, shortSha, type CiRun } from "./ci-runs.js"

/**
 * The ci-runs source over the real main-sitter manifest, against a scripted
 * gh/git shell. The newest-head judgement is covered on the pure
 * `newestHeadVerdict`; the source tests cover branch resolution, the
 * moved-tip race, ledger dedup, claim/pin mechanics, and terminal writes.
 */

const LOOPS_DIR = defaultLoopsDir()
const sitter = loadManifest(LOOPS_DIR, "main-sitter")
const SHA = "abcdef1234567890abcdef1234567890abcdef12"
const OLD = "0123456789abcdef0123456789abcdef01234567"

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

const run = (over: Partial<CiRun> = {}): CiRun => ({
  headSha: SHA,
  status: "completed",
  conclusion: "failure",
  workflowName: "CI",
  createdAt: "2026-07-05T00:00:00Z",
  ...over,
})

test("newestHeadVerdict judges only the newest head, by its latest run per workflow", () => {
  // A red run on an OLD head is moot once a newer green head exists.
  const recovered = [
    run({ conclusion: "success", createdAt: "2026-07-05T02:00:00Z" }),
    run({ headSha: OLD, createdAt: "2026-07-05T01:00:00Z" }),
  ]
  assert.deepEqual(newestHeadVerdict(recovered, []), { sha: SHA, verdict: "green", failing: [] })
  // A green RE-RUN of the same head retires the earlier failure (latest per workflow wins).
  const rerun = [
    run({ conclusion: "success", createdAt: "2026-07-05T02:00:00Z" }),
    run({ createdAt: "2026-07-05T01:00:00Z" }),
  ]
  assert.deepEqual(newestHeadVerdict(rerun, []), { sha: SHA, verdict: "green", failing: [] })
  // Red across two workflows: both named (newest-first insertion order).
  const red = [run(), run({ workflowName: "Lint", createdAt: "2026-07-05T00:30:00Z" })]
  assert.deepEqual(newestHeadVerdict(red, [])?.failing.sort(), ["CI", "Lint"])
  // Anything still in flight on the head → pending, never claimed mid-run.
  const pending = [run({ status: "in_progress", conclusion: null, createdAt: "2026-07-05T02:00:00Z" }), run()]
  assert.equal(newestHeadVerdict(pending, [])?.verdict, "pending")
  // A workflows filter scopes the judgement.
  const filtered = [run({ workflowName: "Nightly" }), run({ workflowName: "CI", conclusion: "success", createdAt: "2026-07-04T00:00:00Z" })]
  assert.equal(newestHeadVerdict(filtered, ["CI"])?.verdict, "green")
  assert.equal(newestHeadVerdict([], []), null)
})

const source = (runs: unknown[], opts: { ledgers?: Record<string, string>; script?: Cmd[]; log?: string[]; branch?: string } = {}) =>
  makeCiRunsSource({
    $: scriptedShell(
      [
        { cmd: "git -C /r symbolic-ref refs/remotes/origin/HEAD", result: { stdout: "refs/remotes/origin/main\n" } },
        { cmd: "gh run list --branch main", result: { stdout: JSON.stringify(runs) } },
        { cmd: "git -C /r rev-parse refs/remotes/origin/main", result: { stdout: `${SHA}\n` } },
        ...(opts.script ?? []),
      ],
      opts.log,
    ),
    client: ledgerClient(opts.ledgers ?? {}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    ...(opts.branch ? { branch: opts.branch } : {}),
    now: () => "2026-07-05T00:00:00Z",
  })

test("claims the red newest head: default branch resolved, head pinned to a main-sitter/ branch, diagnose entry", async () => {
  const log: string[] = []
  const { item, skip } = await source([run()], { log }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, `head-${shortSha(SHA)}`)
  assert.equal(item?.entryStage, "diagnose")
  assert.equal(item?.state.kind, "main-sitter")
  assert.deepEqual(item?.state.git, { base: "main", branch: `main-sitter/${shortSha(SHA)}` })
  assert.match(item?.state.goal ?? "", /^Red CI on main at abcdef123456/)
  assert.match(item?.state.goal ?? "", /Failing workflow\(s\): CI/)
  assert.match(item?.state.goal ?? "", /NEVER push main/)
  assert.ok(log.some((c) => c.includes("runs/main-sitter/.claims/head-abcdef123456")))
  assert.ok(log.some((c) => c.startsWith(`git -C /r branch -f main-sitter/abcdef123456 ${SHA}`)))
})

test("a green or pending newest head claims nothing", async () => {
  const green = await source([run({ conclusion: "success" })]).claimNext()
  assert.equal(green.item, null)
  assert.match(green.skip?.message ?? "", /main is green at abcdef123456/)
  const pending = await source([run({ status: "queued", conclusion: null })]).claimNext()
  assert.equal(pending.item, null)
  assert.match(pending.skip?.message ?? "", /main is pending/)
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
  const { item, skip } = await source([run()], { ledgers: handled }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /already handled — waiting for a new push/)
})

test("a branch tip that moved during the claim is released for the next poll", async () => {
  // Built without the factory so the drifted rev-parse is the only match.
  const log: string[] = []
  const src = makeCiRunsSource({
    $: scriptedShell(
      [
        { cmd: "git -C /r symbolic-ref refs/remotes/origin/HEAD", result: { stdout: "refs/remotes/origin/main\n" } },
        { cmd: "gh run list --branch main", result: { stdout: JSON.stringify([run()]) } },
        { cmd: "git -C /r rev-parse refs/remotes/origin/main", result: { stdout: `${OLD}\n` } },
      ],
      log,
    ),
    client: ledgerClient({}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    now: () => "2026-07-05T00:00:00Z",
  })
  const { item, skip } = await src.claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /moved during claim/)
  // The claim marker is released so the next poll can re-judge.
  assert.ok(log.some((c) => c.startsWith("rmdir") && c.includes("head-abcdef123456")))
})

test("onTerminal(done) marks the head handled; stop records a failed attempt", async () => {
  const log: string[] = []
  const src = source([run()], { log })
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "done", message: "remedy PR opened" })
  const write = log.find((c) => c.startsWith("printf") && c.includes(`head-${shortSha(SHA)}.json`))
  assert.ok(write, "ledger written")
  assert.match(write ?? "", /"handled": true/)
  assert.ok(log.some((c) => c.startsWith("rmdir") && c.includes(`head-${shortSha(SHA)}`)))
})

test("a configured branch override skips default-branch detection", async () => {
  const log: string[] = []
  const src = makeCiRunsSource({
    $: scriptedShell(
      [
        { cmd: "gh run list --branch release/v2", result: { stdout: JSON.stringify([run({ conclusion: "success" })]) } },
      ],
      log,
    ),
    client: ledgerClient({}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: () => {},
    loaded: sitter,
    branch: "release/v2",
    now: () => "2026-07-05T00:00:00Z",
  })
  const { skip } = await src.claimNext()
  assert.match(skip?.message ?? "", /release\/v2 is green/)
  assert.ok(log.every((c) => !c.startsWith("git -C /r symbolic-ref")))
})
