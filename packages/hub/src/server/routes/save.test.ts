import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { SaveKindResponse, ValidateResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import { saveKind, validateKind } from "./kinds.js"

const MANIFEST = {
  kind: "triage-bot",
  version: 1,
  description: "test kind",
  workSource: { type: "github-pr", query: "is:open", triggers: ["failing-checks"] },
  stages: [
    { name: "scan", kind: "work", command: "scan", agent: "loop-scan", prompt: "stages/scan.md" },
    { name: "check", kind: "check", command: "check", agent: "loop-check", prompt: "stages/check.md" },
  ],
  transitions: {
    scan: { onDone: { kind: "fire", stage: "check" } },
    check: {
      onPass: { kind: "done", message: "all good" },
      onFail: { kind: "fire", stage: "scan", countIteration: true, capMessage: "gave up after {maxIterations}" },
      onError: { kind: "stop", message: "broken" },
    },
  },
  maxIterations: 3,
}

const depsFor = (directory: string, loopsDir: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards: [],
  loopsDir,
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

const req = (kind: string, body: unknown) => ({ params: { kind }, query: new URLSearchParams(), body })

test("validateKind reports zod issues with paths", async () => {
  const deps = depsFor("/unused", "/unused-loops")
  const bad = await validateKind(deps, req("x", { manifest: { kind: "x", version: 1 } }))
  const body = bad.body as ValidateResponse
  assert.equal(body.valid, false)
  assert.ok(body.issues.length > 0)
  assert.ok(body.issues.every((i) => typeof i.path === "string" && typeof i.message === "string"))

  const good = await validateKind(deps, req("triage-bot", { manifest: MANIFEST }))
  assert.deepEqual(good.body, { valid: true, issues: [] })
})

test("saveKind writes loop.json + prompt stubs and returns the checklist", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hub-save-"))
  const loops = path.join(repo, "loops")
  fs.mkdirSync(loops, { recursive: true })
  const res = await saveKind(depsFor(repo, loops), req("triage-bot", { manifest: MANIFEST }))
  assert.equal(res.status, 200)
  const body = res.body as SaveKindResponse
  assert.ok(body.written.includes("loops/triage-bot/loop.json"))
  assert.ok(body.written.some((w) => w.includes("stages/scan.md")))

  const onDisk = JSON.parse(fs.readFileSync(path.join(loops, "triage-bot", "loop.json"), "utf8")) as { kind: string }
  assert.equal(onDisk.kind, "triage-bot")
  assert.match(fs.readFileSync(path.join(loops, "triage-bot", "stages", "check.md"), "utf8"), /loop_verdict/)

  const labels = body.checklist.map((c) => c.label).join("\n")
  assert.match(labels, /prompts\/agents\/loop-scan\//)
  assert.match(labels, /gen:prompts/)
  assert.match(labels, /plugins\/opencode\/commands\/scan\.md/)
  assert.match(labels, /plugins\/claude\/commands\/triage-bot\.md/)
  assert.match(labels, /"triage-bot": \{"enabled": true\}/)
  assert.ok(body.checklist.every((c) => c.done === false))
  fs.rmSync(repo, { recursive: true, force: true })
})

test("saveKind refuses an existing kind without overwrite, and preserves prompts on overwrite", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hub-save-"))
  const loops = path.join(repo, "loops")
  fs.mkdirSync(loops, { recursive: true })
  const deps = depsFor(repo, loops)
  await saveKind(deps, req("triage-bot", { manifest: MANIFEST }))
  fs.writeFileSync(path.join(loops, "triage-bot", "stages", "scan.md"), "HAND-TUNED\n")

  const conflict = await saveKind(deps, req("triage-bot", { manifest: MANIFEST }))
  assert.equal(conflict.status, 409)

  const updated = await saveKind(deps, req("triage-bot", { manifest: MANIFEST, overwrite: true }))
  assert.equal(updated.status, 200)
  assert.equal(fs.readFileSync(path.join(loops, "triage-bot", "stages", "scan.md"), "utf8"), "HAND-TUNED\n")
  fs.rmSync(repo, { recursive: true, force: true })
})

test("saveKind rejects traversal kinds, foreign prompt paths, and invalid manifests", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hub-save-"))
  const loops = path.join(repo, "loops")
  fs.mkdirSync(loops, { recursive: true })
  const deps = depsFor(repo, loops)

  assert.equal((await saveKind(deps, req("../evil", { manifest: MANIFEST }))).status, 400)
  assert.equal((await saveKind(deps, req("Evil", { manifest: MANIFEST }))).status, 400)

  const foreignPrompt = {
    ...MANIFEST,
    kind: "foreign",
    stages: [{ ...MANIFEST.stages[0], prompt: "../../escape.md" }],
    transitions: { scan: { onDone: { kind: "done", message: "x" } } },
  }
  assert.equal((await saveKind(deps, req("foreign", { manifest: foreignPrompt }))).status, 400)

  const invalid = await saveKind(deps, req("triage-bot", { manifest: { kind: "triage-bot" } }))
  assert.equal(invalid.status, 400)
  assert.ok(!fs.existsSync(path.join(loops, "foreign")))
  fs.rmSync(repo, { recursive: true, force: true })
})
