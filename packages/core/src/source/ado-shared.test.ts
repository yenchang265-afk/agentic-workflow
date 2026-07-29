import assert from "node:assert/strict"
import { test } from "node:test"
import {
  AdoBuildSchema,
  AdoPrFieldsSchema,
  adoList,
  adoMcpPatToken,
  adoMcpSpawn,
  adoOrgName,
  failingPipelineNames,
  flattenThreadComments,
  newerThan,
  normalizeAdoBuild,
  sameLogin,
  stripRef,
} from "./ado-shared.js"
import { ADO_MCP_PACKAGE } from "./ado-tools.js"
import type { AdoConfig } from "../workflow/state.js"

/**
 * The pure Azure DevOps helpers: the MCP spawn spec (arg vector, child env,
 * refusals), the response schemas and their deliberate strictness, and the
 * normalizers shared by the work sources.
 */

const ado = (over: Partial<AdoConfig> = {}): AdoConfig => ({
  organization: "https://dev.azure.com/acme",
  project: "widgets",
  ...over,
})

// --- the credential ---

test("adoMcpPatToken encodes a colon-prefixed credential the server can split", () => {
  // The server base64-decodes, splits on ":" and keeps everything after the
  // FIRST colon. An empty username is therefore correct — and the colon is
  // mandatory, since a value without one decodes to an empty token.
  assert.equal(adoMcpPatToken("tok"), Buffer.from(":tok").toString("base64"))
  assert.equal(Buffer.from(adoMcpPatToken("tok"), "base64").toString().split(":").slice(1).join(":"), "tok")
})

test("adoMcpPatToken survives a PAT containing a colon", () => {
  const decoded = Buffer.from(adoMcpPatToken("a:b:c"), "base64").toString()
  assert.equal(decoded.split(":").slice(1).join(":"), "a:b:c")
})

// --- the organization name ---

test("adoOrgName reads the org from both hosted URL forms", () => {
  assert.equal(adoOrgName("https://dev.azure.com/acme"), "acme")
  assert.equal(adoOrgName("https://dev.azure.com/acme/"), "acme")
  assert.equal(adoOrgName("https://acme.visualstudio.com"), "acme")
})

test("adoOrgName returns empty for something that isn't an org URL, rather than guessing", () => {
  assert.equal(adoOrgName("not a url"), "")
  assert.equal(adoOrgName("https://dev.azure.com"), "")
})

// --- the spawn spec ---

test("adoMcpSpawn builds the pinned arg vector and puts the token only in the child env", () => {
  const spawn = adoMcpSpawn(ado({ pat: "cfg-pat" }), {})
  assert.equal(spawn.ok, true)
  if (!spawn.ok) return
  assert.equal(spawn.command, "npx")
  assert.deepEqual(spawn.args, ["-y", ADO_MCP_PACKAGE, "acme", "-d", "repositories", "-d", "pipelines", "-a", "pat"])
  assert.deepEqual(spawn.env, { PERSONAL_ACCESS_TOKEN: adoMcpPatToken("cfg-pat") })
})

test("the env var wins over config ado.pat, matching the old REST precedence", () => {
  const spawn = adoMcpSpawn(ado({ pat: "cfg-pat" }), { AZURE_DEVOPS_EXT_PAT: "env-pat" })
  assert.equal(spawn.ok, true)
  if (!spawn.ok) return
  assert.equal(spawn.env["PERSONAL_ACCESS_TOKEN"], adoMcpPatToken("env-pat"))
})

test("no credential at all is a refusal naming both places to set one", () => {
  const spawn = adoMcpSpawn(ado(), {})
  assert.equal(spawn.ok, false)
  if (spawn.ok) return
  assert.match(spawn.error, /AZURE_DEVOPS_EXT_PAT/)
  assert.match(spawn.error, /ado\.pat/)
})

test("interactive auth is refused — it opens a browser no poller can answer", () => {
  // It is the SERVER's default, so this is the most likely misconfiguration;
  // failing here beats hanging on a prompt nobody sees.
  const spawn = adoMcpSpawn(ado({ mcp: { authentication: "interactive" } }), {})
  assert.equal(spawn.ok, false)
  if (spawn.ok) return
  assert.match(spawn.error, /cannot work in a polling loop/)
})

test("interactive auth is allowed when explicitly opted into at a real terminal", () => {
  const spawn = adoMcpSpawn(ado({ mcp: { authentication: "interactive" } }), { ADO_MCP_ALLOW_INTERACTIVE: "1" })
  assert.equal(spawn.ok, true)
  if (!spawn.ok) return
  assert.deepEqual(spawn.env, {})
  assert.ok(spawn.args.includes("interactive"))
})

test("azcli auth needs no token in the child env", () => {
  const spawn = adoMcpSpawn(ado({ mcp: { authentication: "azcli" } }), {})
  assert.equal(spawn.ok, true)
  if (!spawn.ok) return
  assert.deepEqual(spawn.env, {})
  assert.ok(spawn.args.includes("azcli"))
})

test("envvar auth requires its bearer token and passes it through", () => {
  assert.equal(adoMcpSpawn(ado({ mcp: { authentication: "envvar" } }), {}).ok, false)
  const spawn = adoMcpSpawn(ado({ mcp: { authentication: "envvar" } }), { ADO_MCP_AUTH_TOKEN: "bearer" })
  assert.equal(spawn.ok, true)
  if (!spawn.ok) return
  assert.equal(spawn.env["ADO_MCP_AUTH_TOKEN"], "bearer")
})

test("command, args, domains, tenant and extra env are overridable for air-gapped or multi-tenant installs", () => {
  const spawn = adoMcpSpawn(
    ado({
      pat: "p",
      mcp: {
        command: "/opt/ado-mcp",
        args: [],
        domains: ["repositories"],
        tenant: "tenant-guid",
        env: { NODE_EXTRA_CA_CERTS: "/etc/ca.pem" },
      },
    }),
    {},
  )
  assert.equal(spawn.ok, true)
  if (!spawn.ok) return
  assert.equal(spawn.command, "/opt/ado-mcp")
  assert.deepEqual(spawn.args, ["acme", "-d", "repositories", "-a", "pat", "-t", "tenant-guid"])
  assert.equal(spawn.env["NODE_EXTRA_CA_CERTS"], "/etc/ca.pem")
  assert.equal(spawn.env["PERSONAL_ACCESS_TOKEN"], adoMcpPatToken("p"))
})

test("an organization URL with no org in it is a refusal, not a spawn with a bad name", () => {
  const spawn = adoMcpSpawn(ado({ organization: "https://dev.azure.com", pat: "p" }), {})
  assert.equal(spawn.ok, false)
  if (spawn.ok) return
  assert.match(spawn.error, /organization name/)
})

// --- payload shapes ---

test("adoList accepts a bare array and a REST-style {value} envelope alike", () => {
  // The MCP server returns what azure-devops-node-api hands back, which already
  // unwraps `value`. Accepting both costs three lines; betting on one and losing
  // means every poll parses to zero items and reports "nothing needs attention".
  assert.deepEqual(adoList([1, 2]), [1, 2])
  assert.deepEqual(adoList({ value: [1, 2] }), [1, 2])
  assert.deepEqual(adoList({ count: 0 }), [])
  assert.deepEqual(adoList(null), [])
})

test("AdoPrFieldsSchema reads reviewer identity and requirement additively", () => {
  const pr = AdoPrFieldsSchema.parse({
    pullRequestId: 7,
    title: "t",
    sourceRefName: "refs/heads/feat/x",
    targetRefName: "refs/heads/main",
    createdBy: { uniqueName: "author@acme.com" },
    reviewers: [{ uniqueName: "Sitter@Acme.com", vote: 0, isRequired: true }, { vote: -5 }],
  })
  assert.deepEqual(pr.reviewers[0], { uniqueName: "Sitter@Acme.com", vote: 0, isRequired: true })
  // Legacy entries without identity still parse (defaults, not rejections).
  assert.deepEqual(pr.reviewers[1], { uniqueName: "", vote: -5, isRequired: false })
})

test("AdoPrFieldsSchema REQUIRES createdBy and reviewers so a trimmed payload fails loudly", () => {
  // These are what the role filter and the fork skip judge. If the MCP list tool
  // returns a projection without them, an author-role kind would claim nothing
  // and a reviewer-role kind would claim everything — both silently. That list
  // tool has no `fullResponse` flag, so this is a live possibility.
  const base = { pullRequestId: 7, title: "t", sourceRefName: "refs/heads/a", targetRefName: "refs/heads/main" }
  assert.throws(() => AdoPrFieldsSchema.parse({ ...base, reviewers: [] }))
  assert.throws(() => AdoPrFieldsSchema.parse({ ...base, createdBy: { uniqueName: "a@b.c" } }))
})

// --- normalizers ---

test("stripRef, sameLogin and newerThan", () => {
  assert.equal(stripRef("refs/heads/feat/x"), "feat/x")
  assert.equal(sameLogin("Sitter@Acme.com", "sitter@acme.com"), true)
  // Lexicographically "...00.12Z" > "...00.123Z" ('Z' > '3'), but 0.12s < 0.123s.
  assert.equal(newerThan("2026-07-04T00:00:00.12Z", "2026-07-04T00:00:00.123Z"), false)
  assert.equal(newerThan("2026-07-04T00:00:01Z", "2026-07-04T00:00:00Z"), true)
  assert.equal(newerThan("anything", ""), true)
})

test("flattenThreadComments drops deleted threads, deleted comments and system notes", () => {
  const out = flattenThreadComments([
    {
      isDeleted: false,
      comments: [
        { commentType: "text", publishedDate: "t1", isDeleted: false, author: { uniqueName: "a@b.c" } },
        { commentType: "system", publishedDate: "t2", isDeleted: false, author: { uniqueName: "d@e.f" } },
        { commentType: "text", publishedDate: "t3", isDeleted: true, author: { uniqueName: "g@h.i" } },
      ],
    },
    { isDeleted: true, comments: [{ commentType: "text", publishedDate: "t4", isDeleted: false, author: null }] },
  ])
  assert.deepEqual(out, [{ author: "a@b.c", at: "t1" }])
})

test("normalizeAdoBuild maps ADO's build shape into the shared CiRun fields", () => {
  const succeeded = AdoBuildSchema.parse({
    sourceVersion: "abc123",
    status: "completed",
    result: "succeeded",
    definition: { name: "CI" },
    queueTime: "2026-07-05T00:00:00Z",
  })
  assert.deepEqual(normalizeAdoBuild(succeeded), {
    headSha: "abc123",
    status: "completed",
    conclusion: "success",
    workflowName: "CI",
    createdAt: "2026-07-05T00:00:00Z",
  })
  const partial = AdoBuildSchema.parse({ sourceVersion: "a", status: "completed", result: "partiallySucceeded" })
  assert.equal(normalizeAdoBuild(partial).conclusion, "failure")
  // A manual cancellation isn't a code breakage — neither failing nor green.
  const canceled = AdoBuildSchema.parse({ sourceVersion: "a", status: "completed", result: "canceled" })
  assert.equal(normalizeAdoBuild(canceled).conclusion, null)
  // In-flight builds carry no result yet.
  const pending = AdoBuildSchema.parse({ sourceVersion: "x", status: "inProgress" })
  assert.equal(normalizeAdoBuild(pending).conclusion, null)
  assert.equal(normalizeAdoBuild(pending).status, "inProgress")
})

test("normalizeAdoBuild falls back through queueTime → startTime → finishTime for createdAt", () => {
  const noQueueTime = AdoBuildSchema.parse({
    sourceVersion: "x",
    startTime: "2026-07-05T01:00:00Z",
    finishTime: "2026-07-05T02:00:00Z",
  })
  assert.equal(normalizeAdoBuild(noQueueTime).createdAt, "2026-07-05T01:00:00Z")
  const onlyFinish = AdoBuildSchema.parse({ sourceVersion: "x", finishTime: "2026-07-05T02:00:00Z" })
  assert.equal(normalizeAdoBuild(onlyFinish).createdAt, "2026-07-05T02:00:00Z")
})

// --- failing checks, which are now pipelines rather than branch policies ---

const build = (name: string, result: string, queueTime: string) =>
  AdoBuildSchema.parse({ sourceVersion: "sha", status: "completed", result, definition: { name }, queueTime })

test("failingPipelineNames names failing definitions and ignores green ones", () => {
  const out = failingPipelineNames([
    build("Build", "failed", "2026-07-05T00:00:00Z"),
    build("Lint", "succeeded", "2026-07-05T00:00:00Z"),
    build("Test", "partiallySucceeded", "2026-07-05T00:00:00Z"),
  ])
  assert.deepEqual(out.sort(), ["Build", "Test"])
})

test("only the newest run per definition counts", () => {
  // Considering every run rather than only the newest would keep a definition
  // that was re-run green reporting as failing forever, re-waking the sitter on
  // work that is already fixed.
  assert.deepEqual(
    failingPipelineNames([
      build("Build", "succeeded", "2026-07-05T02:00:00Z"),
      build("Build", "failed", "2026-07-05T01:00:00Z"),
    ]),
    [],
  )
  assert.deepEqual(
    failingPipelineNames([
      build("Build", "failed", "2026-07-05T02:00:00Z"),
      build("Build", "succeeded", "2026-07-05T01:00:00Z"),
    ]),
    ["Build"],
  )
})

test("a still-running build is not yet a failing check, and an unnamed definition is ignored", () => {
  const running = AdoBuildSchema.parse({ sourceVersion: "s", status: "inProgress", definition: { name: "Build" } })
  assert.deepEqual(failingPipelineNames([running]), [])
  const unnamed = AdoBuildSchema.parse({ sourceVersion: "s", status: "completed", result: "failed" })
  assert.deepEqual(failingPipelineNames([unnamed]), [])
})
