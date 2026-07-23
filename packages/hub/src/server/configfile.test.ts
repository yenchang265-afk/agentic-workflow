import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-workflow/core/config"
import { REDACTED } from "../shared/api.js"
import type { HubDeps } from "./deps.js"
import { isGitIgnored, readRawLayer, redactSecrets, writeRawLayer } from "./configfile.js"
import { fsClient, sh } from "./fsclient.js"

/**
 * The raw config layer IO under the Config tab. The invariants that matter:
 * a broken file is reported (never thrown) so the editor can render it, secrets
 * never leave redaction, and writes are atomic even when they overlap.
 */

const makeFixture = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "hub-configfile-"))

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards: [],
  config: DEFAULT_CONFIG,
  workflowsDir: path.join(directory, "workflows-unused"),
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

const repoFile = (dir: string): string => path.join(dir, ".agentic-workflow.json")

test("readRawLayer: an absent file is a null layer with no parse error", async () => {
  const dir = makeFixture()
  const layer = await readRawLayer(depsFor(dir), "repo")
  assert.equal(layer.path, repoFile(dir))
  assert.equal(layer.raw, null)
  assert.equal(layer.parseError, undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("readRawLayer: a malformed file is reported, not thrown — the editor exists to fix it", async () => {
  const dir = makeFixture()
  fs.writeFileSync(repoFile(dir), "{ not json")
  const layer = await readRawLayer(depsFor(dir), "repo")
  assert.equal(layer.raw, null)
  assert.match(layer.parseError ?? "", /not valid JSON/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("readRawLayer: a non-object top level is refused with a reason", async () => {
  const dir = makeFixture()
  fs.writeFileSync(repoFile(dir), "[1, 2]")
  const layer = await readRawLayer(depsFor(dir), "repo")
  assert.equal(layer.raw, null)
  assert.match(layer.parseError ?? "", /top level must be a JSON object/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("readRawLayer: a valid file round-trips its raw JSON, unknown keys included", async () => {
  const dir = makeFixture()
  fs.writeFileSync(repoFile(dir), JSON.stringify({ codePlatform: "github", hub: { extra: true } }))
  const layer = await readRawLayer(depsFor(dir), "repo")
  assert.deepEqual(layer.raw, { codePlatform: "github", hub: { extra: true } })
  fs.rmSync(dir, { recursive: true, force: true })
})

test("redactSecrets replaces ado.pat and names the path, so a save can tell unchanged from cleared", () => {
  const { raw, redactedPaths } = redactSecrets({ ado: { pat: "hunter2", project: "p" } })
  assert.equal((raw["ado"] as Record<string, unknown>)["pat"], REDACTED)
  assert.equal((raw["ado"] as Record<string, unknown>)["project"], "p")
  assert.deepEqual(redactedPaths, ["ado.pat"])
})

test("redactSecrets leaves a config without secrets alone", () => {
  const input = { codePlatform: "github" }
  const { raw, redactedPaths } = redactSecrets(input)
  assert.deepEqual(raw, input)
  assert.deepEqual(redactedPaths, [])
})

test("writeRawLayer writes pretty JSON with a trailing newline and creates parent dirs", async () => {
  const dir = makeFixture()
  const file = path.join(dir, "nested", "config.json")
  await writeRawLayer(file, { a: 1 })
  assert.equal(fs.readFileSync(file, "utf8"), '{\n  "a": 1\n}\n')
  fs.rmSync(dir, { recursive: true, force: true })
})

test("overlapping writes to one file never collide on a temp name or leave debris", async () => {
  const dir = makeFixture()
  const file = repoFile(dir)
  await Promise.all(Array.from({ length: 10 }, (_, i) => writeRawLayer(file, { seq: i })))
  // The file holds ONE of the payloads intact (rename is atomic), and every
  // temp file was consumed by its rename.
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { seq: number }
  assert.ok(parsed.seq >= 0 && parsed.seq < 10)
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))
  assert.deepEqual(leftovers, [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test("isGitIgnored is the PAT rail: true only when git would ignore the file", async () => {
  const dir = makeFixture()
  await sh`git -C ${dir} init -q`
  fs.writeFileSync(path.join(dir, ".gitignore"), "secret.json\n")
  assert.equal(await isGitIgnored(sh, dir, path.join(dir, "secret.json")), true)
  assert.equal(await isGitIgnored(sh, dir, path.join(dir, "tracked.json")), false)
  fs.rmSync(dir, { recursive: true, force: true })
})
