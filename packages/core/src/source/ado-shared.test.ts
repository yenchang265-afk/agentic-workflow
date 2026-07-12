import assert from "node:assert/strict"
import { test } from "node:test"
import { buildAdoHeaders, parseAdoHeadersEnv, resolveAdoHeaders } from "./ado-shared.js"

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
