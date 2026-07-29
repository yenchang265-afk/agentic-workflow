import assert from "node:assert/strict"
import test from "node:test"
import { ADO_TOOLS } from "@agentic-workflow/core/source/ado-tools"
import { makeAdoMcpGateway, type McpClientLike } from "./gateway.js"

interface Recorded {
  readonly name: string
  readonly arguments: Record<string, unknown>
}

/** A fake MCP client: records calls, returns a JSON text block, counts connects. */
const harness = (opts: { onCall?: (r: Recorded) => unknown; tools?: readonly string[] } = {}) => {
  const calls: Recorded[] = []
  const logs: { level: string; message: string }[] = []
  let connects = 0
  let closes = 0
  let failConnect = false
  let clock = 1_000_000

  const client: McpClientLike = {
    callTool: async (params) => {
      const rec = { name: params.name, arguments: params.arguments ?? {} }
      calls.push(rec)
      const out = opts.onCall?.(rec)
      if (out instanceof Error) throw out
      return { content: [{ type: "text", text: JSON.stringify(out ?? { ok: 1 }) }] }
    },
    listTools: async () => ({ tools: (opts.tools ?? Object.values(ADO_TOOLS)).map((name) => ({ name })) }),
    close: async () => {
      closes += 1
    },
  }

  const gateway = makeAdoMcpGateway({
    command: "npx",
    args: ["-y", "@azure-devops/mcp@2.8.1", "acme"],
    env: {},
    log: (level, message) => logs.push({ level, message: String(message) }),
    now: () => clock,
    connect: async () => {
      connects += 1
      if (failConnect) throw new Error("spawn ENOENT")
      return client
    },
  })

  return {
    gateway,
    calls,
    logs,
    get connects() {
      return connects
    },
    get closes() {
      return closes
    },
    setFailConnect: (v: boolean) => {
      failConnect = v
    },
    advance: (ms: number) => {
      clock += ms
    },
  }
}

test("each port method sends the tool name and arguments the server expects", async () => {
  const h = harness()
  await h.gateway.getPullRequest({ project: "P", repositoryId: "R", pullRequestId: 7 })
  await h.gateway.getRepository({ project: "P", repositoryNameOrId: "R" })
  await h.gateway.getBuildStatus({ project: "P", buildId: 42 })
  await h.gateway.createPullRequest({
    project: "P",
    repositoryId: "R",
    sourceRefName: "refs/heads/a",
    targetRefName: "refs/heads/main",
    title: "t",
    isDraft: true,
  })

  assert.deepEqual(
    h.calls.map((c) => c.name),
    [ADO_TOOLS.getPr, ADO_TOOLS.getRepo, ADO_TOOLS.getBuildStatus, ADO_TOOLS.createPr],
  )
  assert.deepEqual(h.calls[0]?.arguments, { project: "P", repositoryId: "R", pullRequestId: 7 })
  assert.deepEqual(h.calls[1]?.arguments, { project: "P", repositoryNameOrId: "R" })
  assert.equal(h.calls[3]?.arguments["isDraft"], true)
})

test("listPullRequestsByCommits spells the repo argument `repository`, not `repositoryId`", async () => {
  // The only tool in the surface that does. Getting this wrong is a silent
  // "no PRs found" rather than an error, so it is pinned by a test.
  const h = harness()
  await h.gateway.listPullRequestsByCommits({ project: "P", repository: "R", commits: ["abc"] })
  assert.deepEqual(h.calls[0]?.arguments, { project: "P", repository: "R", commits: ["abc"] })
  assert.ok(!Object.keys(h.calls[0]?.arguments ?? {}).includes("repositoryId"))
})

test("thread listing always asks for the full response", async () => {
  // Without this the payload may be trimmed and comment authors/timestamps —
  // which the dedup watermark depends on — go missing.
  const h = harness()
  await h.gateway.listPullRequestThreads({ project: "P", repositoryId: "R", pullRequestId: 7 })
  assert.equal(h.calls[0]?.arguments["fullResponse"], true)
})

test("build listing asks for newest-first ordering", async () => {
  const h = harness()
  await h.gateway.listBuilds({ project: "P", branchName: "refs/heads/main", top: 30 })
  assert.equal(h.calls[0]?.arguments["queryOrder"], "queueTimeDescending")
})

test("undefined optional arguments are omitted rather than sent", async () => {
  const h = harness()
  await h.gateway.listPullRequests({ project: "P" })
  assert.deepEqual(Object.keys(h.calls[0]?.arguments ?? {}).sort(), ["project"])
})

test("the server is connected once and reused across calls", async () => {
  const h = harness()
  await h.gateway.getPullRequest({ project: "P", repositoryId: "R", pullRequestId: 1 })
  await h.gateway.getPullRequest({ project: "P", repositoryId: "R", pullRequestId: 2 })
  await h.gateway.getPullRequest({ project: "P", repositoryId: "R", pullRequestId: 3 })
  assert.equal(h.connects, 1)
})

test("a failed call returns an error result instead of throwing", async () => {
  const h = harness({ onCall: () => new Error("socket hang up") })
  const r = await h.gateway.getPullRequest({ project: "P", repositoryId: "R", pullRequestId: 1 })
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.error : "", /socket hang up/)
})

test("a connect failure fails fast inside the cooldown, then retries after it", async () => {
  const h = harness()
  h.setFailConnect(true)
  const first = await h.gateway.getPullRequest({ project: "P", repositoryId: "R", pullRequestId: 1 })
  assert.equal(first.ok, false)
  assert.equal(h.connects, 1)

  // Inside the cooldown: no second spawn — this is what stops a permanently bad
  // credential from respawning a child process on every poll tick.
  const second = await h.gateway.getPullRequest({ project: "P", repositoryId: "R", pullRequestId: 1 })
  assert.equal(second.ok, false)
  assert.match(second.ok === false ? second.error : "", /unavailable/)
  assert.equal(h.connects, 1)

  h.advance(31_000)
  h.setFailConnect(false)
  const third = await h.gateway.getPullRequest({ project: "P", repositoryId: "R", pullRequestId: 1 })
  assert.equal(third.ok, true)
  assert.equal(h.connects, 2)
})

test("a missing tool is reported loudly — the signature of an upstream rename", async () => {
  const h = harness({ tools: [ADO_TOOLS.getPr] })
  await h.gateway.getPullRequest({ project: "P", repositoryId: "R", pullRequestId: 1 })
  const err = h.logs.find((l) => l.level === "error")
  assert.ok(err, "expected an error-level log naming the missing tools")
  assert.match(err.message, /missing expected tools/)
  assert.match(err.message, new RegExp(ADO_TOOLS.getBuilds))
})

test("close shuts the server down and later calls refuse", async () => {
  const h = harness()
  await h.gateway.getPullRequest({ project: "P", repositoryId: "R", pullRequestId: 1 })
  await h.gateway.close()
  assert.equal(h.closes, 1)
  const after = await h.gateway.getPullRequest({ project: "P", repositoryId: "R", pullRequestId: 1 })
  assert.equal(after.ok, false)
  assert.match(after.ok === false ? after.error : "", /closed/)
})

test("close is safe when the server was never connected", async () => {
  const h = harness()
  await h.gateway.close()
  assert.equal(h.connects, 0)
  assert.equal(h.closes, 0)
})
