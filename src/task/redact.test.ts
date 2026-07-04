import assert from "node:assert/strict"
import { test } from "node:test"
import { redact } from "./redact.ts"

test("empty and secret-free text pass through unchanged with no hits", () => {
  assert.deepEqual(redact(""), { text: "", hits: [] })
  const clean = "BUILD finished (iteration 1) — all tests green"
  const r = redact(clean)
  assert.equal(r.text, clean)
  assert.deepEqual(r.hits, [])
})

test("redacts an AWS access key id", () => {
  const r = redact("key is AKIAIOSFODNN7EXAMPLE here")
  assert.match(r.text, /\[REDACTED:aws-access-key\]/)
  assert.doesNotMatch(r.text, /AKIA/)
  assert.deepEqual(r.hits, [{ pattern: "aws-access-key", count: 1 }])
})

test("redacts openai and anthropic keys, anthropic labeled correctly", () => {
  const oa = redact("token sk-abcdefghij0123456789ABC done")
  assert.equal(oa.hits[0]?.pattern, "openai-key")
  const an = redact("token sk-ant-abcdefghij0123456789ABC done")
  assert.equal(an.hits[0]?.pattern, "anthropic-key")
  assert.doesNotMatch(an.text, /sk-ant/)
})

test("a short sk- prefix is NOT treated as an openai key", () => {
  const r = redact("using sk-123 as a variable")
  assert.deepEqual(r.hits, [])
})

test("redacts github tokens (classic and fine-grained)", () => {
  const classic = redact(`ghp_${"a".repeat(36)}`)
  assert.equal(classic.hits[0]?.pattern, "github-token")
  const pat = redact(`github_pat_${"A".repeat(22)}`)
  assert.equal(pat.hits[0]?.pattern, "github-token")
})

test("redacts a JWT", () => {
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(20)}.${"b".repeat(20)}`
  const r = redact(`Authorization: Bearer ${jwt}`)
  assert.match(r.text, /\[REDACTED:jwt\]/)
})

test("collapses a multi-line PEM private key block to one marker", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----"
  const r = redact(`here it is\n${pem}\nafter`)
  assert.match(r.text, /here it is\n\[REDACTED:private-key-block\]\nafter/)
})

test("generic-assignment redacts only the value, keeping the key name", () => {
  const r = redact('password: "hunter2supersecret"')
  assert.match(r.text, /password: "\[REDACTED:generic-assignment\]/)
  assert.doesNotMatch(r.text, /hunter2supersecret/)
})

test("generic-assignment leaves short example values alone (<8 chars)", () => {
  const r = redact("password: pw123")
  assert.deepEqual(r.hits, [])
})

test("is idempotent — redacting already-redacted text is a no-op", () => {
  const once = redact("key AKIAIOSFODNN7EXAMPLE and sk-abcdefghij0123456789ABC")
  const twice = redact(once.text)
  assert.equal(twice.text, once.text)
  assert.deepEqual(twice.hits, [])
})

test("counts multiple hits of the same pattern", () => {
  const r = redact("AKIAIOSFODNN7EXAMPLE AKIA1234567890ABCDEF")
  assert.deepEqual(r.hits, [{ pattern: "aws-access-key", count: 2 }])
})
