import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fsClient, sh } from "./fsclient.js"

/**
 * The host shim every route reads the repo through. Two properties carry real
 * weight: shell interpolation must be injection-safe (task ids reach `sh` as
 * template values), and the file reader must refuse traversal and runaway
 * files — it is the rail a future route inherits.
 */

const makeFixture = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "hub-fsclient-"))

test("sh escapes interpolated values — quotes and metacharacters round-trip as data", async () => {
  const hostile = `a'b"c $(whoami) ; echo pwned`
  const out = await sh`printf %s ${hostile}`
  assert.equal(out.exitCode, 0)
  assert.equal(out.stdout.toString(), hostile)
})

test("sh interpolates arrays as separately-escaped words", async () => {
  const out = await sh`printf '%s\n' ${["one word", "two'quote"]}`
  assert.equal(out.stdout.toString(), "one word\ntwo'quote\n")
})

test("sh never throws — failures land in exitCode", async () => {
  const out = await sh`exit 3`.quiet().nothrow()
  assert.equal(out.exitCode, 3)
})

test("file.read returns content for a contained file and null for missing paths", async () => {
  const dir = makeFixture()
  fs.writeFileSync(path.join(dir, "a.txt"), "content")
  assert.deepEqual(await fsClient.file.read({ query: { path: "a.txt", directory: dir } }), { data: { content: "content" } })
  assert.deepEqual(await fsClient.file.read({ query: { path: "missing.txt", directory: dir } }), { data: null })
  fs.rmSync(dir, { recursive: true, force: true })
})

test("file.read refuses traversal and absolute paths — the containment rail", async () => {
  const dir = makeFixture()
  const outside = path.join(os.tmpdir(), `hub-fsclient-outside-${process.pid}.txt`)
  fs.writeFileSync(outside, "secret")
  const escape = path.relative(dir, outside)
  assert.deepEqual(await fsClient.file.read({ query: { path: escape, directory: dir } }), { data: null })
  assert.deepEqual(await fsClient.file.read({ query: { path: outside, directory: dir } }), { data: null })
  fs.rmSync(outside, { force: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

test("file.read drops a file past the size cap instead of materializing it", async () => {
  const dir = makeFixture()
  fs.writeFileSync(path.join(dir, "huge.log"), Buffer.alloc(8 * 1024 * 1024 + 1))
  assert.deepEqual(await fsClient.file.read({ query: { path: "huge.log", directory: dir } }), { data: null })
  fs.rmSync(dir, { recursive: true, force: true })
})

test("file.list types entries and reads a missing directory as empty", async () => {
  const dir = makeFixture()
  fs.mkdirSync(path.join(dir, "sub", "child"), { recursive: true })
  fs.writeFileSync(path.join(dir, "sub", "f.md"), "")
  const listed = await fsClient.file.list({ query: { path: "sub", directory: dir } })
  const byName = new Map((listed.data ?? []).map((n) => [n.name, n.type]))
  assert.equal(byName.get("child"), "directory")
  assert.equal(byName.get("f.md"), "file")
  assert.deepEqual(await fsClient.file.list({ query: { path: "nope", directory: dir } }), { data: [] })
  // Traversal out of the directory lists nothing.
  assert.deepEqual(await fsClient.file.list({ query: { path: "..", directory: dir } }), { data: [] })
  fs.rmSync(dir, { recursive: true, force: true })
})
