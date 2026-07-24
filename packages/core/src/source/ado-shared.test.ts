import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:https"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { adoFetch, buildAdoHeaders, makeAdoAuthHeader, parseAdoHeadersEnv, resolveAdoHeaders } from "./ado-shared.js"

/**
 * The pure custom-header helpers shared by the ADO work source and ship gate:
 * env parsing (malformed → {}, never thrown), env-wins resolution over config,
 * and the base+custom merge attached to each REST call.
 */

test("parseAdoHeadersEnv reads a JSON object of string headers", () => {
  assert.deepEqual(parseAdoHeadersEnv('{"Proxy-Authorization":"Bearer t","X-Route":"internal"}'), {
    "Proxy-Authorization": "Bearer t",
    "X-Route": "internal",
  })
})

test("parseAdoHeadersEnv degrades to {} for absent, malformed, non-object, or non-string values", () => {
  assert.deepEqual(parseAdoHeadersEnv(undefined), {})
  assert.deepEqual(parseAdoHeadersEnv(""), {})
  assert.deepEqual(parseAdoHeadersEnv("   "), {})
  assert.deepEqual(parseAdoHeadersEnv("not json"), {})
  assert.deepEqual(parseAdoHeadersEnv('["a","b"]'), {}) // array, not an object
  assert.deepEqual(parseAdoHeadersEnv("null"), {})
  // Non-string values are dropped, string ones kept.
  assert.deepEqual(parseAdoHeadersEnv('{"X-Keep":"ok","X-Drop":5,"":"no-key"}'), { "X-Keep": "ok" })
})

test("resolveAdoHeaders overlays the env over config, key by key", () => {
  const merged = resolveAdoHeaders(
    { "X-Route": "internal", "Proxy-Authorization": "config-token" },
    '{"Proxy-Authorization":"env-token","X-Extra":"from-env"}',
  )
  assert.deepEqual(merged, {
    "X-Route": "internal", // config-only survives
    "Proxy-Authorization": "env-token", // env wins on a clash
    "X-Extra": "from-env", // env-only added
  })
})

test("resolveAdoHeaders handles either side being absent", () => {
  assert.deepEqual(resolveAdoHeaders(undefined, undefined), {})
  assert.deepEqual(resolveAdoHeaders({ "X-Route": "internal" }, undefined), { "X-Route": "internal" })
  assert.deepEqual(resolveAdoHeaders(undefined, '{"X-Env":"v"}'), { "X-Env": "v" })
})

test("buildAdoHeaders merges custom headers over the built-in request headers", () => {
  assert.deepEqual(
    buildAdoHeaders({ Authorization: "Basic xyz", Accept: "application/json" }, { "Proxy-Authorization": "Bearer t" }),
    { Authorization: "Basic xyz", Accept: "application/json", "Proxy-Authorization": "Bearer t" },
  )
  // A custom key may override a built-in one — documented as the user's call.
  assert.equal(buildAdoHeaders({ Accept: "application/json" }, { Accept: "text/plain" }).Accept, "text/plain")
  // Undefined custom headers leave the base untouched.
  assert.deepEqual(buildAdoHeaders({ Accept: "application/json" }, undefined), { Accept: "application/json" })
})

test("AdoPrFieldsSchema reads reviewer identity and requirement additively", async () => {
  const { AdoPrFieldsSchema } = await import("./ado-shared.js")
  const pr = AdoPrFieldsSchema.parse({
    pullRequestId: 7,
    title: "t",
    sourceRefName: "refs/heads/feat/x",
    targetRefName: "refs/heads/main",
    reviewers: [{ uniqueName: "Sitter@Acme.com", vote: 0, isRequired: true }, { vote: -5 }],
  })
  assert.deepEqual(pr.reviewers?.[0], { uniqueName: "Sitter@Acme.com", vote: 0, isRequired: true })
  // Legacy entries without identity still parse (defaults, not rejections).
  assert.deepEqual(pr.reviewers?.[1], { uniqueName: "", vote: -5, isRequired: false })
})

test("normalizeAdoBuild maps ADO's build shape into the shared CiRun fields", async () => {
  const { normalizeAdoBuild, AdoBuildSchema } = await import("./ado-shared.js")
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
  const failed = AdoBuildSchema.parse({ sourceVersion: "x", status: "completed", result: "failed" })
  assert.equal(normalizeAdoBuild(failed).conclusion, "failure")
  // A partial success still means something broke — judged as failing.
  const partial = AdoBuildSchema.parse({ sourceVersion: "x", status: "completed", result: "partiallySucceeded" })
  assert.equal(normalizeAdoBuild(partial).conclusion, "failure")
  // A manual cancel isn't a code breakage — neither failing nor a green signal.
  const canceled = AdoBuildSchema.parse({ sourceVersion: "x", status: "completed", result: "canceled" })
  assert.equal(normalizeAdoBuild(canceled).conclusion, null)
  // In-flight builds carry no result yet.
  const pending = AdoBuildSchema.parse({ sourceVersion: "x", status: "inProgress" })
  assert.equal(normalizeAdoBuild(pending).conclusion, null)
  assert.equal(normalizeAdoBuild(pending).status, "inProgress")
})

test("normalizeAdoBuild falls back through queueTime → startTime → finishTime for createdAt", async () => {
  const { normalizeAdoBuild, AdoBuildSchema } = await import("./ado-shared.js")
  const noQueueTime = AdoBuildSchema.parse({ sourceVersion: "x", startTime: "2026-07-05T01:00:00Z", finishTime: "2026-07-05T02:00:00Z" })
  assert.equal(normalizeAdoBuild(noQueueTime).createdAt, "2026-07-05T01:00:00Z")
  const onlyFinish = AdoBuildSchema.parse({ sourceVersion: "x", finishTime: "2026-07-05T02:00:00Z" })
  assert.equal(normalizeAdoBuild(onlyFinish).createdAt, "2026-07-05T02:00:00Z")
})

/**
 * `adoFetch`'s TLS behavior against a real self-signed HTTPS server: proves
 * the default path still verifies (rejects the untrusted cert) and that
 * `insecureSkipTlsVerify: true` is what actually lets the call through — not
 * just a flag that's threaded around unused. Skips if `openssl` isn't on
 * PATH rather than failing the suite over an environment gap.
 */
const withSelfSignedServer = async (run: (url: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "ado-fetch-tls-"))
  const keyPath = join(dir, "key.pem")
  const certPath = join(dir, "cert.pem")
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=localhost",
  ])
  const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (_req, res) => res.end("ok"))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("expected a bound TCP address")
    await run(`https://127.0.0.1:${address.port}/`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test("adoFetch verifies certificates by default and only skips verification when told to", async (t) => {
  try {
    execFileSync("openssl", ["version"])
  } catch {
    t.skip("openssl not available")
    return
  }
  await withSelfSignedServer(async (url) => {
    await assert.rejects(adoFetch(undefined)(url, { headers: {} }))
    await assert.rejects(adoFetch(false)(url, { headers: {} }))
    const res = await adoFetch(true)(url, { headers: {} })
    assert.equal(res.ok, true)
    assert.equal(await res.text(), "ok")
  })
})

test("makeAdoAuthHeader: a PAT becomes HTTP Basic; without one the REST transport fails loud", async () => {
  const auth = makeAdoAuthHeader({ pat: "tok" })
  assert.equal(await auth(), `Basic ${Buffer.from(":tok").toString("base64")}`)
  const none = makeAdoAuthHeader({})
  await assert.rejects(none(), /AZURE_DEVOPS_EXT_PAT.*ADO REST calls always need a PAT/s)
})
