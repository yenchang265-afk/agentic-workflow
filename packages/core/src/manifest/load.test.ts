import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { defaultLoopsDir } from "./dir.js"
import { listLoopKinds, loadManifest } from "./load.js"

/**
 * loadManifest's fail-loud contract: a broken loop kind must throw with the
 * offending path at host startup, never drive garbage. The happy path is
 * exercised implicitly by every source test that loads a shipped manifest.
 */

const LOOPS_DIR = defaultLoopsDir()

/** A scratch loops/ dir holding one kind cloned from the shipped engineering manifest. */
const scratchKind = (mutate: (dir: string, manifest: Record<string, unknown>) => void): string => {
  const loops = fs.mkdtempSync(path.join(os.tmpdir(), "loops-"))
  const dir = path.join(loops, "engineering")
  fs.cpSync(path.join(LOOPS_DIR, "engineering"), dir, { recursive: true })
  const manifestPath = path.join(dir, "loop.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  mutate(dir, manifest)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  return loops
}

test("every shipped loop kind loads with all its stage prompts", () => {
  const kinds = listLoopKinds(LOOPS_DIR)
  assert.deepEqual(kinds, ["dep-sitter", "engineering", "main-sitter", "pr-sitter", "review-sitter"])
  for (const kind of kinds) {
    const { manifest, prompts } = loadManifest(LOOPS_DIR, kind)
    assert.equal(manifest.kind, kind)
    for (const stage of manifest.stages) assert.ok(prompts[stage.name], `${kind}/${stage.name} prompt loaded`)
  }
})

test("a missing loop.json throws with the offending path", () => {
  assert.throws(() => loadManifest(LOOPS_DIR, "no-such-kind"), /could not load loop manifest .*no-such-kind.*loop\.json/)
})

test("a manifest whose kind mismatches its directory throws", () => {
  const loops = scratchKind((_dir, manifest) => {
    manifest.kind = "imposter"
  })
  assert.throws(() => loadManifest(loops, "engineering"), /declares kind "imposter" but lives in loops\/engineering\//)
})

test("a missing stage prompt throws with the offending path", () => {
  const loops = scratchKind((dir, manifest) => {
    const stages = manifest.stages as { prompt: string }[]
    fs.rmSync(path.join(dir, stages[0]!.prompt))
  })
  assert.throws(() => loadManifest(loops, "engineering"), /could not load stage prompt/)
})

test("a manifest that fails schema validation throws through the manifest-path error", () => {
  const loops = scratchKind((_dir, manifest) => {
    delete manifest.transitions
  })
  assert.throws(() => loadManifest(loops, "engineering"), /could not load loop manifest/)
})

test("listLoopKinds ignores files, promptless dirs, and a missing loops dir", () => {
  const loops = fs.mkdtempSync(path.join(os.tmpdir(), "loops-"))
  fs.mkdirSync(path.join(loops, "not-a-kind"))
  fs.writeFileSync(path.join(loops, "stray.json"), "{}")
  assert.deepEqual(listLoopKinds(loops), [])
  assert.deepEqual(listLoopKinds(path.join(loops, "missing")), [])
})
