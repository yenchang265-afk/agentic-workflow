import assert from "node:assert/strict"
import { test } from "node:test"
import type { Shell } from "../host.js"
import type { Config } from "./state.js"
import { shipPr } from "./ship-pr.js"
import type { AdoGateway, AdoResult } from "../source/ado-gateway.js"

/**
 * `shipPr` over a scripted git shell (`$`) and a scripted `AdoGateway` —
 * mirrors the fake-shell convention of `git.test.ts` and
 * `source/ado-pr.test.ts`. `gh` calls go through the same `$`, so GitHub
 * coverage needs no gateway.
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
  checkTimeoutMinutes: 10,
  ignoreBacklog: true,
  worktreesDir: false,
  taskBranch: "feature/",
  workflows: {},
}

interface GatewayScript {
  /** Active PRs matching the source branch — a non-empty list means "reuse". */
  existing?: unknown[]
  /** The repository payload the default branch is read from. */
  repo?: unknown
  /** The created PR payload, or an error message to fail creation with. */
  created?: unknown
  createError?: string
  /** Make every call throw, to prove shipPr still never throws. */
  throws?: boolean
}

const ok = (data: unknown): AdoResult => ({ ok: true, data })

const scriptedGateway = (script: GatewayScript = {}, calls: unknown[] = []): AdoGateway => {
  const guard = <T>(fn: () => T): T => {
    if (script.throws) throw new Error("ECONNRESET")
    return fn()
  }
  return {
    async listPullRequests(a) {
      calls.push(a)
      return guard(() => ok(script.existing ?? []))
    },
    async getRepository(a) {
      calls.push(a)
      return guard(() => ok(script.repo ?? {}))
    },
    async createPullRequest(a) {
      calls.push(a)
      return guard(() => (script.createError ? { ok: false, error: script.createError } : ok(script.created ?? { pullRequestId: 99 })))
    },
    async getPullRequest() {
      throw new Error("shipPr must not fetch a PR by id")
    },
    async listPullRequestsByCommits() {
      throw new Error("shipPr must not query commits")
    },
    async listPullRequestThreads() {
      throw new Error("shipPr must not read threads")
    },
    async listBuilds() {
      throw new Error("shipPr must not list builds")
    },
    async getBuildStatus() {
      throw new Error("shipPr must not read build status")
    },
    async close() {},
  }
}

test("shipPr is a no-op when there's no feature/<id> branch", async () => {
  const $ = scriptedShell([BRANCH_MISSING])
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "Add rate limiting")
  assert.deepEqual(result, { attempted: false, mode: "pr", pushed: false, created: false })
})

test("shipPr reports a reason when the push fails", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_FAIL])
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "Add rate limiting")
  assert.equal(result.attempted, true)
  assert.equal(result.created, false)
  assert.equal(result.pushed, false, "the caveat may claim nothing landed on the remote")
  assert.equal(result.reason, "git push failed")
})

// --- publish modes ---
//
// The argv log is the assertion that matters here, not the returned object: the
// whole point of `local` is that nothing runs, and only the log can prove a
// command's ABSENCE.

test('publish "local" runs no push and no gh at all', async () => {
  const log: string[] = []
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK], log)
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "Add rate limiting", undefined, { publish: "local" })
  assert.deepEqual(result, { attempted: true, mode: "local", pushed: false, created: false, branch: "feature/task-1" })
  assert.ok(!log.some((c) => c.includes("push")), `nothing was pushed — ran: ${log.join(" | ")}`)
  assert.ok(!log.some((c) => c.startsWith("gh ")), "and no PR was attempted")
  // The branch check still runs: "there is no branch" and "you asked us not to
  // publish" are different facts, and only this order can report both.
  assert.ok(log.some((c) => c.includes("rev-parse --verify")))
})

test('publish "local" is still a no-op when there is no branch', async () => {
  const $ = scriptedShell([BRANCH_MISSING])
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "Add rate limiting", undefined, { publish: "local" })
  assert.deepEqual(result, { attempted: false, mode: "local", pushed: false, created: false })
})

test('publish "push" pushes the branch and opens no PR', async () => {
  const log: string[] = []
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK], log)
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "Add rate limiting", undefined, { publish: "push" })
  assert.deepEqual(result, { attempted: true, mode: "push", pushed: true, created: false, branch: "feature/task-1" })
  assert.ok(log.includes("git -C /repo push -u origin feature/task-1"), `the branch was pushed — ran: ${log.join(" | ")}`)
  assert.ok(!log.some((c) => c.startsWith("gh ")), "and gh was never reached")
})

test('publish "push" reports a failed push rather than claiming the branch landed', async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_FAIL])
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "Add rate limiting", undefined, { publish: "push" })
  assert.equal(result.mode, "push")
  assert.equal(result.pushed, false)
  assert.equal(result.reason, "git push failed")
})

test("the configured shipPublish applies when no per-ship mode is passed", async () => {
  const log: string[] = []
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK], log)
  // No `publish` argument at all — the repo's setting is what decides, which is
  // why every host forwards an omitted choice as omitted rather than as "pr".
  const result = await shipPr($, noop, "/repo", { ...baseConfig, shipPublish: "local" }, "engineering", "task-1", "Add rate limiting")
  assert.equal(result.mode, "local")
  assert.ok(!log.some((c) => c.includes("push")), "the configured local ship pushed nothing")
})

test("an explicit per-ship mode outranks the configured shipPublish", async () => {
  const log: string[] = []
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK], log)
  const result = await shipPr($, noop, "/repo", { ...baseConfig, shipPublish: "local" }, "engineering", "task-1", "T", undefined, { publish: "push" })
  assert.equal(result.mode, "push")
  assert.ok(log.includes("git -C /repo push -u origin feature/task-1"))
})

test("shipPr (github) reuses an existing PR for the branch", async () => {
  const $ = scriptedShell([
    BRANCH_EXISTS,
    PUSH_OK,
    { cmd: "gh pr view feature/task-1", result: { exitCode: 0, stdout: "https://github.com/acme/widgets/pull/9\n" } },
  ])
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "Add rate limiting")
  assert.deepEqual(result, { attempted: true, mode: "pr", pushed: true, branch: "feature/task-1", created: false, url: "https://github.com/acme/widgets/pull/9" })
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
  assert.deepEqual(result, { attempted: true, mode: "pr", pushed: true, branch: "feature/task-1", created: true, url: "https://github.com/acme/widgets/pull/10", base: "main" })
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
  const result = await shipPr($, noop, "/repo", cfg, "engineering", "task-1", "Add rate limiting", scriptedGateway())
  assert.equal(result.attempted, true)
  assert.equal(result.created, false)
  assert.match(result.reason ?? "", /ado.repository/)
})

test("shipPr (ado) fails clearly when no gateway is available", async () => {
  // A credential problem now stops the gateway being built at all, so the ship
  // gate sees "no gateway" rather than a PAT error. The ship still succeeds —
  // only the PR does not open.
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const result = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "Add rate limiting")
  assert.equal(result.attempted, true)
  assert.equal(result.created, false)
  assert.match(result.reason ?? "", /no Azure DevOps MCP gateway/)
})

test("shipPr (ado) reuses an existing active PR for the branch", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const gateway = scriptedGateway({ existing: [{ pullRequestId: 42 }] })
  const result = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "Add rate limiting", gateway)
  assert.deepEqual(result, {
    attempted: true,
    mode: "pr",
    pushed: true,
    branch: "feature/task-1",
    created: false,
    url: "https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/42",
  })
})

test("shipPr (ado) opens a new draft PR when none exists, using the repo's default branch", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const calls: unknown[] = []
  const gateway = scriptedGateway({ repo: { defaultBranch: "refs/heads/main" }, created: { pullRequestId: 99 } }, calls)
  const result = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "Add rate limiting", gateway)
  assert.deepEqual(result, {
    attempted: true,
    mode: "pr",
    pushed: true,
    branch: "feature/task-1",
    created: true,
    url: "https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/99",
    base: "main",
  })
  // A loop-opened PR is always a draft — never review-ready before a human looks.
  const create = calls.at(-1) as { isDraft?: boolean; targetRefName?: string }
  assert.equal(create.isDraft, true)
  assert.equal(create.targetRefName, "refs/heads/main")
})

test("shipPr (ado) ignores type-confused API bodies instead of acting on them", async () => {
  // A string pullRequestId must never become a reuse URL, and a non-string
  // defaultBranch must fall back — malformed bodies degrade, never propagate.
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const gateway = scriptedGateway({
    existing: [{ pullRequestId: "42/../evil" }],
    repo: { defaultBranch: 7 },
    created: { pullRequestId: 99 },
  })
  const result = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "Add rate limiting", gateway)
  assert.equal(result.created, true)
  assert.equal(result.url, "https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/99")
})

test("shipPr (ado) reports a reason when PR creation fails", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const gateway = scriptedGateway({ createError: "TF401027: you need Contribute permission (403)" })
  const result = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "Add rate limiting", gateway)
  assert.equal(result.attempted, true)
  assert.equal(result.created, false)
  assert.match(result.reason ?? "", /403/)
})

test("shipPr never throws on an unexpected error, and still reports the push it made", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const result = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "Add rate limiting", scriptedGateway({ throws: true }))
  assert.equal(result.attempted, true)
  assert.equal(result.created, false)
  assert.ok(result.reason)
  // The catch used to hardcode `pushed: false`, reasoning that nothing after the
  // push can throw. True of the `gh` arm; false of this one — `AdoGateway` is an
  // injected PORT, and its calls sit after `pushBranch` with their try/catch
  // around the payload parse only. So a throwing implementation had the ship
  // gate tell the human "the branch was not pushed, so no PR was opened"
  // (`publishOutcome`) about a branch that is on origin, and send them to
  // re-push it.
  assert.equal(result.pushed, true, "the push succeeded before the gateway threw — the caveat must not deny it")
  // Same rule for the branch: the caller passed none here, so reporting
  // `options.branch` left the caveat unable to name what it was talking about.
  assert.equal(result.branch, "feature/task-1", "the resolved branch is named even when the failure came later")
})

// --- Which branch gets shipped ---

test("an explicitly recorded branch wins over the configured prefix", async () => {
  // `extractRunBranch` reads it off the task file, and it is the authority: the
  // prefix is only a guess once `taskBranch` may have changed since the run.
  const $ = scriptedShell([
    { cmd: "git -C /repo rev-parse --verify --quiet refs/heads/claude/my-feature", result: { exitCode: 0 } },
    { cmd: "git -C /repo push -u origin claude/my-feature", result: { exitCode: 0 } },
    { cmd: "gh pr view claude/my-feature", result: { exitCode: 1 } },
    { cmd: "gh repo view", result: { exitCode: 0, stdout: "main\n" } },
    { cmd: "gh pr create", result: { exitCode: 0, stdout: "https://github.com/acme/widgets/pull/11\n" } },
  ])
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "T", undefined, { branch: "claude/my-feature" })
  assert.deepEqual(result, { attempted: true, mode: "pr", pushed: true, branch: "claude/my-feature", created: true, url: "https://github.com/acme/widgets/pull/11", base: "main" })
})

test("a configured prefix names the branch when nothing was recorded", async () => {
  const $ = scriptedShell([
    { cmd: "git -C /repo rev-parse --verify --quiet refs/heads/wip-task-1", result: { exitCode: 0 } },
    { cmd: "git -C /repo push -u origin wip-task-1", result: { exitCode: 0 } },
    { cmd: "gh pr view wip-task-1", result: { exitCode: 0, stdout: "https://github.com/acme/widgets/pull/12\n" } },
  ])
  const result = await shipPr($, noop, "/repo", { ...baseConfig, taskBranch: "wip-" }, "engineering", "task-1", "T")
  assert.equal(result.url, "https://github.com/acme/widgets/pull/12")
})

test("with taskBranch:false and nothing recorded, the tree's own branch is the last resort", async () => {
  // Correct only because teardown deliberately leaves the tree on that branch;
  // the recorded branch above is what makes this a fallback rather than the rule.
  const $ = scriptedShell([
    { cmd: "git -C /repo rev-parse --abbrev-ref HEAD", result: { exitCode: 0, stdout: "my-work\n" } },
    { cmd: "git -C /repo rev-parse --verify --quiet refs/heads/my-work", result: { exitCode: 0 } },
    { cmd: "git -C /repo push -u origin my-work", result: { exitCode: 0 } },
    { cmd: "gh pr view my-work", result: { exitCode: 0, stdout: "https://github.com/acme/widgets/pull/13\n" } },
  ])
  const result = await shipPr($, noop, "/repo", { ...baseConfig, taskBranch: false }, "engineering", "task-1", "T")
  assert.equal(result.url, "https://github.com/acme/widgets/pull/13")
})

test("the PR base never equals the head when gh repo view fails", async () => {
  // In current-branch mode the tree is still ON the shipped branch at ship time,
  // so the old `?? currentBranch` fallback asked for a PR from a branch onto
  // itself and gh refused.
  const calls: string[] = []
  const $ = scriptedShell(
    [
      { cmd: "git -C /repo rev-parse --verify --quiet refs/heads/my-work", result: { exitCode: 0 } },
      { cmd: "git -C /repo push -u origin my-work", result: { exitCode: 0 } },
      { cmd: "gh pr view my-work", result: { exitCode: 1 } },
      { cmd: "gh repo view", result: { exitCode: 1 } },
      { cmd: "git -C /repo rev-parse --abbrev-ref HEAD", result: { exitCode: 0, stdout: "my-work\n" } },
      { cmd: "gh pr create", result: { exitCode: 0, stdout: "https://github.com/acme/widgets/pull/14\n" } },
    ],
    calls,
  )
  await shipPr($, noop, "/repo", { ...baseConfig, taskBranch: false }, "engineering", "task-1", "T", undefined, { branch: "my-work" })
  const create = calls.find((c) => c.includes("gh pr create"))
  assert.ok(create?.includes("--head my-work"), create)
  assert.ok(create?.includes("--base main"), create) // the "main" backstop, never --base my-work
})


// --- PR base branch ---
//
// The argv log carries the assertions that matter: an explicit base must reach
// `--base`, and the network default lookup must NOT run — skipping it is half of
// why an explicit base is worth having.

const LS_REMOTE_HIT: Cmd = {
  cmd: "git -C /repo ls-remote --heads origin release/2.4",
  result: { exitCode: 0, stdout: "9f1c0de1c0de1c0de1c0de1c0de1c0de1c0de1c0\trefs/heads/release/2.4\n" },
}

test("shipPr (github) targets an explicit base and never asks the platform for its default", async () => {
  const log: string[] = []
  const $ = scriptedShell(
    [
      BRANCH_EXISTS,
      PUSH_OK,
      { cmd: "gh pr view feature/task-1", result: { exitCode: 1 } },
      LS_REMOTE_HIT,
      { cmd: "gh pr create", result: { exitCode: 0, stdout: "https://github.com/acme/widgets/pull/13\n" } },
    ],
    log,
  )
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "T", undefined, { base: "release/2.4" })
  assert.equal(result.created, true)
  assert.equal(result.base, "release/2.4")
  const create = log.find((c) => c.startsWith("gh pr create"))
  assert.match(create ?? "", /--head feature\/task-1 --base release\/2.4/)
  // The point of the short-circuit: an explicit base IS the answer, so asking
  // the platform for another one is pure latency and one more way to fail.
  assert.equal(
    log.find((c) => c.startsWith("gh repo view")),
    undefined,
    "an explicit base must skip the default-branch lookup",
  )
})

test("shipPr (github) accepts a refs/heads-qualified base without double-prefixing it", async () => {
  const log: string[] = []
  const $ = scriptedShell(
    [
      BRANCH_EXISTS,
      PUSH_OK,
      { cmd: "gh pr view feature/task-1", result: { exitCode: 1 } },
      LS_REMOTE_HIT,
      { cmd: "gh pr create", result: { exitCode: 0, stdout: "https://github.com/acme/widgets/pull/14\n" } },
    ],
    log,
  )
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "T", undefined, { base: "refs/heads/release/2.4" })
  assert.equal(result.base, "release/2.4")
  assert.match(log.find((c) => c.startsWith("gh pr create")) ?? "", /--base release\/2.4/)
})

test("shipPr (ado) targets an explicit base and never calls getRepository", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK, LS_REMOTE_HIT])
  const calls: unknown[] = []
  const gateway = scriptedGateway({ repo: { defaultBranch: "refs/heads/main" }, created: { pullRequestId: 77 } }, calls)
  const result = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "T", gateway, { base: "release/2.4" })
  assert.equal(result.base, "release/2.4")
  const create = calls.find((c) => JSON.stringify(c).includes("targetRefName"))
  assert.match(JSON.stringify(create), /"targetRefName":"refs\/heads\/release\/2.4"/)
  // The gateway records ARGUMENTS, not tool names, so the default-branch call is
  // identified by the only field it sends.
  assert.equal(
    calls.some((c) => JSON.stringify(c).includes("repositoryNameOrId")),
    false,
    "an explicit base must skip the ADO default-branch lookup",
  )
})

test("an EXPLICIT base that is not on origin refuses the PR instead of quietly opening it elsewhere", async () => {
  const log: string[] = []
  const $ = scriptedShell(
    [
      BRANCH_EXISTS,
      PUSH_OK,
      { cmd: "gh pr view feature/task-1", result: { exitCode: 1 } },
      { cmd: "git -C /repo ls-remote --heads origin release/2.4", result: { exitCode: 0, stdout: "" } },
    ],
    log,
  )
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "T", undefined, {
    base: "release/2.4",
    baseExplicit: true,
  })
  assert.equal(result.created, false)
  // Pushed, deliberately: the branch is safely on origin, which is what makes
  // `approve <id> --base=<correct>` a cheap retry rather than a redo.
  assert.equal(result.pushed, true)
  assert.match(result.reason ?? "", /base branch "release\/2.4" is not on origin/)
  assert.equal(
    log.find((c) => c.startsWith("gh pr create")),
    undefined,
    "opening the PR onto the platform default is the exact failure this refuses",
  )
})

test("ls-remote prefix-matches, so a base is confirmed only by an exact refs/heads line", async () => {
  // `ls-remote --heads origin release/2.4` happily returns release/2.40. A
  // substring test would wave through the very typo this check exists to catch.
  const $ = scriptedShell([
    BRANCH_EXISTS,
    PUSH_OK,
    { cmd: "gh pr view feature/task-1", result: { exitCode: 1 } },
    {
      cmd: "git -C /repo ls-remote --heads origin release/2.4",
      result: { exitCode: 0, stdout: "9f1c0de1c0de1c0de1c0de1c0de1c0de1c0de1c0\trefs/heads/release/2.40\n" },
    },
  ])
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "T", undefined, {
    base: "release/2.4",
    baseExplicit: true,
  })
  assert.equal(result.created, false)
  assert.match(result.reason ?? "", /is not on origin/)
})

test("a base nobody asked for on this ship falls through to the platform default instead of refusing", async () => {
  // The base the run RECORDED, or `prBase` — not `--base=`. A shared-tree run
  // that hit an isolation degrade path records whatever the tree was parked on,
  // which is routinely local-only; refusing there means a task that reached the
  // ship gate cleanly opens no PR at all over a branch the human never chose.
  const log: string[] = []
  const $ = scriptedShell(
    [
      BRANCH_EXISTS,
      PUSH_OK,
      { cmd: "gh pr view feature/task-1", result: { exitCode: 1 } },
      { cmd: "git -C /repo ls-remote --heads origin feature/older-task", result: { exitCode: 0, stdout: "" } },
      { cmd: "gh pr create", result: { exitCode: 0, stdout: "https://github.com/o/r/pull/7\n" } },
    ],
    log,
  )
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "T", undefined, {
    base: "feature/older-task",
  })
  assert.equal(result.created, true)
  assert.equal(result.url, "https://github.com/o/r/pull/7")
  const create = log.find((c) => c.startsWith("gh pr create")) ?? ""
  assert.doesNotMatch(create, /feature\/older-task/, "the branch that is missing from origin must not be the PR's target")
})

test("an ls-remote that could not run is not proof of absence — the PR is attempted anyway", async () => {
  // No remote, no auth, offline: the question could not be asked. Refusing here
  // would block a PR the platform would have accepted.
  const $ = scriptedShell([
    BRANCH_EXISTS,
    PUSH_OK,
    { cmd: "gh pr view feature/task-1", result: { exitCode: 1 } },
    { cmd: "git -C /repo ls-remote --heads origin release/2.4", result: { exitCode: 128, stderr: "no such remote" } },
    { cmd: "gh pr create", result: { exitCode: 0, stdout: "https://github.com/acme/widgets/pull/15\n" } },
  ])
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "T", undefined, { base: "release/2.4" })
  assert.equal(result.created, true)
  assert.equal(result.base, "release/2.4")
})

test("without an explicit base nothing probes the remote and the old chain is unchanged", async () => {
  const log: string[] = []
  const $ = scriptedShell(
    [
      BRANCH_EXISTS,
      PUSH_OK,
      { cmd: "gh pr view feature/task-1", result: { exitCode: 1 } },
      { cmd: "gh repo view", result: { exitCode: 0, stdout: "main\n" } },
      { cmd: "gh pr create", result: { exitCode: 0, stdout: "https://github.com/acme/widgets/pull/16\n" } },
    ],
    log,
  )
  const result = await shipPr($, noop, "/repo", baseConfig, "engineering", "task-1", "T")
  assert.equal(result.base, "main")
  assert.match(log.find((c) => c.startsWith("gh pr create")) ?? "", /--base main/)
  assert.equal(
    log.find((c) => c.includes("ls-remote")),
    undefined,
    "a platform-derived default came from the platform — re-probing it only adds a failure mode",
  )
})
