import assert from "node:assert/strict"
import { Readable } from "node:stream"
import path from "node:path"
import { test } from "node:test"
import { isLocalHost, matchRoute, readBody, safeStaticPath } from "./http.js"
import type { IncomingMessage } from "node:http"

test("matchRoute extracts params and rejects shape mismatches", () => {
  assert.deepEqual(matchRoute("/api/backlog", "/api/backlog"), {})
  assert.deepEqual(matchRoute("/api/tasks/:status/:id", "/api/tasks/queued/add-foo"), {
    status: "queued",
    id: "add-foo",
  })
  assert.equal(matchRoute("/api/tasks/:status/:id", "/api/tasks/queued"), null)
  assert.equal(matchRoute("/api/backlog", "/api/kinds"), null)
  assert.deepEqual(matchRoute("/api/kinds/:kind", "/api/kinds/pr%2Dsitter"), { kind: "pr-sitter" })
})

test("matchRoute treats a malformed percent-encoding as no-match, never throws", () => {
  // The bug: an unguarded decodeURIComponent threw URIError and hung the request.
  assert.equal(matchRoute("/api/tasks/:status/:id", "/api/tasks/queued/%"), null)
  assert.equal(matchRoute("/api/kinds/:kind", "/api/kinds/%E0%A4%A"), null)
})

/** A one-shot fake request stream carrying `chunks` as the body. */
const fakeReq = (chunks: readonly Buffer[]): IncomingMessage => {
  const r = Readable.from(chunks) as unknown as IncomingMessage & { destroy: () => void }
  return r
}

test("readBody parses JSON and decodes UTF-8 split across chunks", async () => {
  // "café" — the é (0xC3 0xA9) is split across two chunks; string concat would
  // corrupt it, a single decode over the joined bytes does not.
  const json = Buffer.from(JSON.stringify({ v: "café" }), "utf8")
  const cut = json.length - 2
  const body = await readBody(fakeReq([json.subarray(0, cut), json.subarray(cut)]))
  assert.deepEqual(body, { v: "café" })
})

test("readBody returns undefined for an empty or garbled body", async () => {
  assert.equal(await readBody(fakeReq([])), undefined)
  assert.equal(await readBody(fakeReq([Buffer.from("{not json", "utf8")])), undefined)
})

test("readBody drops an oversized body instead of buffering it", async () => {
  const huge = Buffer.alloc(1_000_001, 0x61) // one byte over the 1 MB cap
  assert.equal(await readBody(fakeReq([huge])), undefined)
})

test("isLocalHost accepts local hosts only", () => {
  assert.equal(isLocalHost("localhost:4317"), true)
  assert.equal(isLocalHost("127.0.0.1:4317"), true)
  assert.equal(isLocalHost("[::1]:4317"), true)
  assert.equal(isLocalHost("localhost"), true)
  assert.equal(isLocalHost("evil.example.com"), false)
  assert.equal(isLocalHost("localhost.evil.example.com"), false)
  assert.equal(isLocalHost(undefined), false)
})

test("safeStaticPath refuses traversal out of the web root", () => {
  const root = path.resolve("/srv/web")
  assert.equal(safeStaticPath(root, "/"), path.join(root, "index.html"))
  assert.equal(safeStaticPath(root, "/assets/main.js"), path.join(root, "assets", "main.js"))
  assert.equal(safeStaticPath(root, "/../secret"), null)
  assert.equal(safeStaticPath(root, "/assets/../../secret"), null)
  assert.equal(safeStaticPath(root, "/%2e%2e/secret"), path.join(root, "%2e%2e", "secret"))
})
