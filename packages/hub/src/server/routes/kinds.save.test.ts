import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-workflow/core/config"
import type { SaveKindResponse, ValidateResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import { checklistKind, saveKind, validateKind } from "./kinds.js"

const MANIFEST = {
  kind: "triage-bot",
  version: 1,
  description: "test kind",
  workSource: { type: "pull-request", query: "is:open", triggers: ["failing-checks"] },
  stages: [
    { name: "scan", kind: "work", command: "scan", agent: "workflow-scan", prompt: "stages/scan.md" },
    { name: "check", kind: "check", command: "check", agent: "workflow-check", prompt: "stages/check.md" },
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

const depsFor = (directory: string, workflowsDir: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards: [],
  config: DEFAULT_CONFIG,
  workflowsDir,
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

const req = (kind: string, body: unknown) => ({ params: { kind }, query: new URLSearchParams(), body })

test("validateKind reports zod issues with paths", async () => {
  const deps = depsFor("/unused", "/unused-workflows")
  const bad = await validateKind(deps, req("x", { manifest: { kind: "x", version: 1 } }))
  const body = bad.body as ValidateResponse
  assert.equal(body.valid, false)
  assert.ok(body.issues.length > 0)
  assert.ok(body.issues.every((i) => typeof i.path === "string" && typeof i.message === "string"))

  const good = await validateKind(deps, req("triage-bot", { manifest: MANIFEST }))
  assert.deepEqual(good.body, { valid: true, issues: [] })
})

test("saveKind writes workflow.json + prompt stubs and returns the checklist", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hub-save-"))
  const workflows = path.join(repo, "workflows")
  fs.mkdirSync(workflows, { recursive: true })
  const res = await saveKind(depsFor(repo, workflows), req("triage-bot", { manifest: MANIFEST }))
  assert.equal(res.status, 200)
  const body = res.body as SaveKindResponse
  assert.ok(body.written.includes("workflows/triage-bot/workflow.json"))
  assert.ok(body.written.some((w) => w.includes("stages/scan.md")))

  const onDisk = JSON.parse(fs.readFileSync(path.join(workflows, "triage-bot", "workflow.json"), "utf8")) as { kind: string }
  assert.equal(onDisk.kind, "triage-bot")
  assert.match(fs.readFileSync(path.join(workflows, "triage-bot", "stages", "check.md"), "utf8"), /workflow_verdict/)

  const labels = body.checklist.map((c) => c.label).join("\n")
  assert.match(labels, /prompts\/agents\/workflow-scan\//)
  assert.match(labels, /gen:prompts/)
  assert.match(labels, /plugins\/opencode\/commands\/scan\.md/)
  assert.match(labels, /plugins\/claude\/commands\/triage-bot\.md/)
  // The last step used to read "go hand-edit .agentic-workflow.json". The Config tab
  // writes that key now, so the checklist points at it instead of at a file.
  assert.match(labels, /enable it in the Config tab \(workflows\.triage-bot\.enabled\)/)
  assert.ok(body.checklist.every((c) => c.done === false))
  fs.rmSync(repo, { recursive: true, force: true })
})

test("saveKind refuses an existing kind without overwrite, and preserves prompts on overwrite", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hub-save-"))
  const workflows = path.join(repo, "workflows")
  fs.mkdirSync(workflows, { recursive: true })
  const deps = depsFor(repo, workflows)
  await saveKind(deps, req("triage-bot", { manifest: MANIFEST }))
  fs.writeFileSync(path.join(workflows, "triage-bot", "stages", "scan.md"), "HAND-TUNED\n")

  const conflict = await saveKind(deps, req("triage-bot", { manifest: MANIFEST }))
  assert.equal(conflict.status, 409)

  const updated = await saveKind(deps, req("triage-bot", { manifest: MANIFEST, overwrite: true }))
  assert.equal(updated.status, 200)
  assert.equal(fs.readFileSync(path.join(workflows, "triage-bot", "stages", "scan.md"), "utf8"), "HAND-TUNED\n")
  fs.rmSync(repo, { recursive: true, force: true })
})

test("checklistKind recomputes the checklist and tags the gen:prompts item", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hub-save-"))
  const deps = depsFor(repo, path.join(repo, "workflows"))

  const res = await checklistKind(deps, req("triage-bot", { manifest: MANIFEST }))
  assert.equal(res.status, 200)
  const before = (res.body as { checklist: { done: boolean; label: string; action?: string }[] }).checklist
  const gen = before.find((c) => c.action === "gen-prompts")
  assert.ok(gen, "gen:prompts item carries the action tag")
  assert.equal(gen?.done, false)
  assert.equal(before.find((c) => c.label.includes("prompts/agents/workflow-scan/"))?.done, false)

  // scaffolding the personas on disk flips their items (and gen:prompts) to done
  for (const agent of ["workflow-scan", "workflow-check"]) fs.mkdirSync(path.join(repo, "prompts", "agents", agent), { recursive: true })
  const after = ((await checklistKind(deps, req("triage-bot", { manifest: MANIFEST }))).body as { checklist: { done: boolean; label: string; action?: string }[] }).checklist
  assert.equal(after.find((c) => c.label.includes("prompts/agents/workflow-scan/"))?.done, true)
  assert.equal(after.find((c) => c.action === "gen-prompts")?.done, true)

  assert.equal((await checklistKind(deps, req("triage-bot", { manifest: { kind: "x" } }))).status, 400)
  fs.rmSync(repo, { recursive: true, force: true })
})

test("saveKind refuses the reserved kind name \"checklist\"", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hub-save-"))
  const deps = depsFor(repo, path.join(repo, "workflows"))
  const res = await saveKind(deps, req("checklist", { manifest: { ...MANIFEST, kind: "checklist" } }))
  assert.equal(res.status, 400)
  fs.rmSync(repo, { recursive: true, force: true })
})

test("saveKind rejects traversal kinds, foreign prompt paths, and invalid manifests", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hub-save-"))
  const workflows = path.join(repo, "workflows")
  fs.mkdirSync(workflows, { recursive: true })
  const deps = depsFor(repo, workflows)

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
  assert.ok(!fs.existsSync(path.join(workflows, "foreign")))
  fs.rmSync(repo, { recursive: true, force: true })
})
