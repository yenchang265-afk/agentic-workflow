import assert from "node:assert/strict"
import { test } from "node:test"
import type { Shell } from "../host.js"
import type { Config } from "./state.js"
import type { AzExec, AzResult } from "../source/ado-az.js"
import { shipPr } from "./ship-pr.js"

/**
 * `shipPr` over a scripted git shell (`$`) and a scripted `az` CLI (`az`) —
 * mirrors the fake-shell convention of `git.test.ts` and `source/ado-pr.test.ts`.
 * `gh` and the ADO `az` calls both go through the injected runners; GitHub
 * coverage needs no ADO transport at all.
 */

type Cmd = { cmd: string; result: { exitCode?: number; stdout?: string; stderr?: string } }

const scriptedShell = (script: Cmd[], log: string[] = []): Shell => {
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) {
        const e = exprs[i]
        cmd += Array.isArray(e) ? e.join(" ") : String(e)
      }
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

const BRANCH_EXISTS: Cmd = { cmd: "git -C /repo rev-parse --verify --quiet refs/heads/feature/task-1", result: { exitCode: 0 } }
const BRANCH_MISSING: Cmd = { cmd: "git -C /repo rev-parse --verify --quiet refs/heads/feature/task-1", result: { exitCode: 1 } }
const PUSH_OK: Cmd = { cmd: "git -C /repo push -u origin feature/task-1", result: { exitCode: 0 } }
const PUSH_FAIL: Cmd = { cmd: "git -C /repo push -u origin feature/task-1", result: { exitCode: 1, stderr: "rejected" } }

const noop = async () => {}

const baseConfig: Config = {
  maxIterations: 3,
  tasksDir: "docs/tasks",
  stageTimeoutMinutes: 60,
  reviewLenses: [],
  workflows: {},
}

/** A scripted az route: `match` is a substring of the joined `az` argv; first hit wins. */
type Route = { match: string; ok?: boolean; statusText?: string; body?: string }

const scriptedAz = (routes: Route[], log: string[] = []): AzExec => async (args) => {
  const cmd = args.join(" ")
  log.push(cmd)
  const hit = routes.find((r) => cmd.includes(r.match))
  return { ok: hit?.ok ?? true, statusText: hit?.statusText ?? "OK", body: hit?.body ?? "" } satisfies AzResult
}

test("shipPr is a no-op when there's no feature/<id> branch", async () => {
  const $ = scriptedShell([BRANCH_MISSING])
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "Add rate limiting")
  assert.deepEqual(result, { attempted: false, created: false })
})

test("shipPr reports a reason when the push fails", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_FAIL])
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "Add rate limiting")
  assert.equal(result.attempted, true)
  assert.equal(result.created, false)
  assert.equal(result.reason, "git push failed")
})

test("shipPr (github) reuses an existing PR for the branch", async () => {
  const $ = scriptedShell([
    BRANCH_EXISTS,
    PUSH_OK,
    { cmd: "gh pr view feature/task-1", result: { exitCode: 0, stdout: "https://github.com/acme/widgets/pull/9\n" } },
  ])
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "Add rate limiting")
  assert.deepEqual(result, { attempted: true, created: false, url: "https://github.com/acme/widgets/pull/9" })
})

test("shipPr (github) opens a new draft PR when none exists", async () => {
  const $ = scriptedShell([
    BRANCH_EXISTS,
    PUSH_OK,
    { cmd: "gh pr view feature/task-1", result: { exitCode: 1 } },
    { cmd: "gh repo view", result: { exitCode: 0, stdout: "main\n" } },
    { cmd: "gh pr create", result: { exitCode: 0, stdout: "https://github.com/acme/widgets/pull/10\n" } },
  ])
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "Add rate limiting")
  assert.deepEqual(result, { attempted: true, created: true, url: "https://github.com/acme/widgets/pull/10" })
})

test("shipPr (github) invokes gh pr create with only flags gh accepts", async () => {
  // `gh pr create` has no `--json`/`-q` (those are `gh pr view`/`list` flags); it
  // prints the PR URL on stdout. Passing them makes every ship exit non-zero with
  // "unknown flag: --json" while the branch is already pushed and the task already
  // completed — a silent no-PR ship. Assert on the real argv, not a prefix match.
  const ghLog: string[] = []
  const $ = scriptedShell(
    [
      BRANCH_EXISTS,
      PUSH_OK,
      { cmd: "gh pr view feature/task-1", result: { exitCode: 1 } },
      { cmd: "gh repo view", result: { exitCode: 0, stdout: "main\n" } },
      { cmd: "gh pr create", result: { exitCode: 0, stdout: "https://github.com/acme/widgets/pull/10\n" } },
    ],
    ghLog,
  )
  await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "Add rate limiting")
  const create = ghLog.find((c) => c.startsWith("gh pr create"))
  assert.ok(create, "expected a gh pr create invocation")
  assert.doesNotMatch(create, /--json/)
  assert.doesNotMatch(create, /\s-q\s/)
  assert.match(create, /--draft/)
  assert.match(create, /--head feature\/task-1 --base main/)
})

test("shipPr (github) falls back to currentBranch when gh repo view fails, and reports create failure", async () => {
  const $ = scriptedShell([
    BRANCH_EXISTS,
    PUSH_OK,
    { cmd: "gh pr view feature/task-1", result: { exitCode: 1 } },
    { cmd: "gh repo view", result: { exitCode: 1 } },
    { cmd: "git -C /repo rev-parse --abbrev-ref HEAD", result: { exitCode: 0, stdout: "main\n" } },
    { cmd: "gh pr create", result: { exitCode: 1, stderr: "pull request create failed: field title cannot be blank" } },
  ])
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "Add rate limiting")
  assert.equal(result.attempted, true)
  assert.equal(result.created, false)
  assert.equal(result.reason, "pull request create failed: field title cannot be blank")
})

const adoConfig: Config = {
  ...baseConfig,
  codePlatform: "ado",
  ado: {
    organization: "https://dev.azure.com/acme",
    project: "Widgets",
    repository: "widgets",
    selfLogin: "sitter@acme.com",
    pat: "test-pat",
  },
}

test("shipPr (ado) fails clearly when ado.repository is not configured", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const cfg: Config = { ...adoConfig, ado: { ...adoConfig.ado!, repository: undefined } }
  const result = await shipPr($, noop, "/repo", cfg, "engineering", "task-1", "Add rate limiting", scriptedAz([]))
  assert.equal(result.attempted, true)
  assert.equal(result.created, false)
  assert.match(result.reason ?? "", /ado.repository/)
})

test("shipPr (ado) opens a draft PR through the az CLI, using the repo's default branch", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const azLog: string[] = []
  const az = scriptedAz(
    [
      { match: "repos pr list", body: "[]" },
      { match: "repos show", body: JSON.stringify({ defaultBranch: "refs/heads/main" }) },
      { match: "repos pr create", body: JSON.stringify({ pullRequestId: 99 }) },
    ],
    azLog,
  )
  const result = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "Add rate limiting", az)
  assert.deepEqual(result, {
    attempted: true,
    created: true,
    url: "https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/99",
  })
  const create = azLog.find((c) => c.includes("repos pr create"))
  assert.match(create ?? "", /--draft/)
  assert.match(create ?? "", /--source-branch feature\/task-1 --target-branch main/)
  assert.match(create ?? "", /--organization https:\/\/dev\.azure\.com\/acme --project Widgets --repository widgets/)
})

test("shipPr (ado) reuses an existing active PR and reports az create failures", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const reuse = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "t",
    scriptedAz([{ match: "repos pr list", body: JSON.stringify([{ pullRequestId: 42 }]) }]))
  assert.deepEqual(reuse, {
    attempted: true,
    created: false,
    url: "https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/42",
  })
  const failed = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "t",
    scriptedAz([
      { match: "repos pr list", body: "[]" },
      { match: "repos show", body: JSON.stringify({ defaultBranch: "refs/heads/main" }) },
      { match: "repos pr create", ok: false, statusText: "ERROR: az login required" },
    ]))
  assert.equal(failed.created, false)
  assert.match(failed.reason ?? "", /az CLI.*az login required/s)
})

test("shipPr (ado) ignores type-confused az bodies instead of acting on them", async () => {
  // A string pullRequestId must never become a reuse URL, and a non-string
  // defaultBranch must fall back — malformed bodies degrade, never propagate.
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const az = scriptedAz([
    { match: "repos pr list", body: JSON.stringify([{ pullRequestId: "42/../evil" }]) },
    { match: "repos show", body: JSON.stringify({ defaultBranch: 7 }) },
    { match: "repos pr create", body: JSON.stringify({ pullRequestId: 99 }) },
  ])
  const result = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "Add rate limiting", az)
  assert.equal(result.created, true)
  assert.equal(result.url, "https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/99")
})

test("shipPr never throws on an unexpected error", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const throwingAz: AzExec = async () => {
    throw new Error("ECONNRESET")
  }
  const result = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "Add rate limiting", throwingAz)
  assert.equal(result.attempted, true)
  assert.equal(result.created, false)
  assert.ok(result.reason)
})
