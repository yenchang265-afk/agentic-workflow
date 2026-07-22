import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { defaultWorkflowsDir } from "./dir.js"
import { listWorkflowKinds, loadManifest, normalizeManifestJson } from "./load.js"

/**
 * loadManifest's fail-loud contract: a broken workflow kind must throw with the
 * offending path at host startup, never drive garbage. The happy path is
 * exercised implicitly by every source test that loads a shipped manifest.
 */

const WORKFLOWS_DIR = defaultWorkflowsDir()

/** A scratch workflows/ dir holding one kind cloned from a shipped manifest. */
const scratchKind = (mutate: (dir: string, manifest: Record<string, unknown>) => void, kind = "engineering"): string => {
  const workflows = fs.mkdtempSync(path.join(os.tmpdir(), "workflows-"))
  const dir = path.join(workflows, kind)
  fs.cpSync(path.join(WORKFLOWS_DIR, kind), dir, { recursive: true })
  const manifestPath = path.join(dir, "workflow.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  mutate(dir, manifest)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  return workflows
}

test("every shipped workflow kind loads with all its stage prompts", () => {
  const kinds = listWorkflowKinds(WORKFLOWS_DIR)
  assert.deepEqual(kinds, ["dep-sitter", "engineering", "main-sitter", "pr-sitter", "review-sitter"])
  for (const kind of kinds) {
    const { manifest, prompts } = loadManifest(WORKFLOWS_DIR, kind)
    assert.equal(manifest.kind, kind)
    for (const stage of manifest.stages) assert.ok(prompts[stage.name], `${kind}/${stage.name} prompt loaded`)
  }
})

test("a missing workflow.json throws with the offending path", () => {
  assert.throws(() => loadManifest(WORKFLOWS_DIR, "no-such-kind"), /could not load workflow manifest .*no-such-kind.*workflow\.json/)
})

test("a manifest whose kind mismatches its directory throws", () => {
  const workflows = scratchKind((_dir, manifest) => {
    manifest.kind = "imposter"
  })
  assert.throws(() => loadManifest(workflows, "engineering"), /declares kind "imposter" but lives in workflows\/engineering\//)
})

test("a missing stage prompt throws with the offending path", () => {
  const workflows = scratchKind((dir, manifest) => {
    const stages = manifest.stages as { prompt: string }[]
    fs.rmSync(path.join(dir, stages[0]!.prompt))
  })
  assert.throws(() => loadManifest(workflows, "engineering"), /could not load stage prompt/)
})

test("a manifest that fails schema validation throws through the manifest-path error", () => {
  const workflows = scratchKind((_dir, manifest) => {
    delete manifest.transitions
  })
  assert.throws(() => loadManifest(workflows, "engineering"), /could not load workflow manifest/)
})

// --- legacy work-source type names (normalizeManifestJson) ---

test('a manifest declaring the legacy "github-pr" type loads as "pull-request"', () => {
  const workflows = scratchKind((_dir, manifest) => {
    ;(manifest.workSource as Record<string, unknown>).type = "github-pr"
  }, "pr-sitter")
  const { manifest } = loadManifest(workflows, "pr-sitter")
  assert.equal(manifest.workSource.type, "pull-request")
  // The rest of the binding survives the rewrite untouched.
  assert.equal(manifest.workSource.type === "pull-request" && manifest.workSource.role, "author")
})

test("the current spelling and every other source type pass through unchanged", () => {
  for (const kind of listWorkflowKinds(WORKFLOWS_DIR)) {
    const before = (JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, kind, "workflow.json"), "utf8")) as Record<string, unknown>)
      .workSource as { type: string }
    assert.equal(loadManifest(WORKFLOWS_DIR, kind).manifest.workSource.type, before.type)
  }
})

test("normalizeManifestJson leaves non-manifest shapes for zod to reject", () => {
  for (const raw of [null, 42, "str", [], {}, { workSource: null }, { workSource: [] }, { workSource: { type: 7 } }]) {
    assert.equal(normalizeManifestJson(raw), raw)
  }
  // An unknown type is not silently rewritten — it still fails validation.
  const workflows = scratchKind((_dir, manifest) => {
    ;(manifest.workSource as Record<string, unknown>).type = "gitlab-mr"
  }, "pr-sitter")
  assert.throws(() => loadManifest(workflows, "pr-sitter"), /could not load workflow manifest .*pr-sitter.*workflow\.json/)
})

test("listWorkflowKinds ignores files, promptless dirs, and a missing workflows dir", () => {
  const workflows = fs.mkdtempSync(path.join(os.tmpdir(), "workflows-"))
  fs.mkdirSync(path.join(workflows, "not-a-kind"))
  fs.writeFileSync(path.join(workflows, "stray.json"), "{}")
  assert.deepEqual(listWorkflowKinds(workflows), [])
  assert.deepEqual(listWorkflowKinds(path.join(workflows, "missing")), [])
})
