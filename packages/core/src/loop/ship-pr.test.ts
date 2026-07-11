import assert from "node:assert/strict"
import { test } from "node:test"
import type { Shell } from "../host.js"
import type { Config } from "./state.js"
import { shipPr, type ShipHttp } from "./ship-pr.js"

/**
 * `shipPr` over a scripted git shell (`$`) and a scripted ADO HTTP transport
 * (`http`) — mirrors the fake-shell convention of `git.test.ts` and
 * `source/ado-pr.test.ts`. `gh` calls go through the same `$`, so GitHub
 * coverage needs no separate transport.
 */

type Cmd = { cmd: string; result: { exitCode?: number; stdout?: string; stderr?: string } }

const scriptedShell = (script: Cmd[]): Shell => {
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
  loops: {},
}

type Route = { match: string; status?: number; body?: string }

const scriptedHttp = (routes: Route[]): ShipHttp => async (url) => {
  const hit = routes.find((r) => url.includes(r.match))
  const status = hit?.status ?? 200
  const body = hit?.body ?? ""
  return { ok: status >= 200 && status < 300, status, statusText: `status ${status}`, text: async () => body }
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
  const result = await shipPr($, noop, "/repo", cfg, "engineering", "task-1", "Add rate limiting", scriptedHttp([]))
  assert.equal(result.attempted, true)
  assert.equal(result.created, false)
  assert.match(result.reason ?? "", /ado.repository/)
})

test("shipPr (ado) fails clearly when no PAT is available", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const prevPat = process.env.AZURE_DEVOPS_EXT_PAT
  delete process.env.AZURE_DEVOPS_EXT_PAT
  try {
    const cfg: Config = { ...adoConfig, ado: { ...adoConfig.ado!, pat: undefined } }
    const result = await shipPr($, noop, "/repo", cfg, "engineering", "task-1", "Add rate limiting", scriptedHttp([]))
    assert.equal(result.attempted, true)
    assert.equal(result.created, false)
    assert.match(result.reason ?? "", /AZURE_DEVOPS_EXT_PAT/)
  } finally {
    if (prevPat !== undefined) process.env.AZURE_DEVOPS_EXT_PAT = prevPat
  }
})

test("shipPr (ado) reuses an existing active PR for the branch", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const http = scriptedHttp([{ match: "pullrequests?searchCriteria", body: JSON.stringify({ value: [{ pullRequestId: 42 }] }) }])
  const result = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "Add rate limiting", http)
  assert.deepEqual(result, {
    attempted: true,
    created: false,
    url: "https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/42",
  })
})

test("shipPr (ado) opens a new draft PR when none exists, using the repo's default branch", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const http = scriptedHttp([
    { match: "pullrequests?searchCriteria", body: JSON.stringify({ value: [] }) },
    { match: "_apis/git/repositories/widgets?api-version", body: JSON.stringify({ defaultBranch: "refs/heads/main" }) },
    { match: "pullrequests?api-version", body: JSON.stringify({ pullRequestId: 99 }) },
  ])
  const result = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "Add rate limiting", http)
  assert.deepEqual(result, {
    attempted: true,
    created: true,
    url: "https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/99",
  })
})

test("shipPr (ado) reports a reason when PR creation fails", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const http = scriptedHttp([
    { match: "pullrequests?searchCriteria", status: 200, body: JSON.stringify({ value: [] }) },
    { match: "_apis/git/repositories/widgets?api-version", status: 200, body: JSON.stringify({}) },
    { match: "pullrequests?api-version", status: 403, body: "" },
  ])
  const result = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "Add rate limiting", http)
  assert.equal(result.attempted, true)
  assert.equal(result.created, false)
  assert.match(result.reason ?? "", /403/)
})

test("shipPr never throws on an unexpected error", async () => {
  const $ = scriptedShell([BRANCH_EXISTS, PUSH_OK])
  const throwingHttp: ShipHttp = async () => {
    throw new Error("ECONNRESET")
  }
  const result = await shipPr($, noop, "/repo", adoConfig, "engineering", "task-1", "Add rate limiting", throwingHttp)
  assert.equal(result.attempted, true)
  assert.equal(result.created, false)
  assert.ok(result.reason)
})
