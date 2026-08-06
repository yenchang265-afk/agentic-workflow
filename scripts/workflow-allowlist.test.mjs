import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

/**
 * Invariants over every stage `bashAllowlist` in workflows/<kind>/workflow.json.
 *
 * Both are enforced somewhere already, but only indirectly: the cross-manifest
 * one throws out of `gen-prompts.mjs` (a generator stack trace that doesn't name
 * the offending file), and the twin one wasn't enforced at all — `npm outdated*`
 * shipped without its `cd * && ` twin, which on the OpenCode host made the entry
 * dead. Asserting them here fails with the file and the glob in the message.
 */

const WORKFLOWS = path.join(import.meta.dirname, "..", "packages", "core", "workflows")

const manifests = fs
  .readdirSync(WORKFLOWS)
  .sort()
  .map((kind) => ({ kind, file: path.join(WORKFLOWS, kind, "workflow.json") }))
  .filter(({ file }) => fs.existsSync(file))
  .map(({ kind, file }) => ({ kind, manifest: JSON.parse(fs.readFileSync(file, "utf8")) }))

assert.ok(manifests.length > 0, "no workflow manifests found — wrong path?")

const CD_PREFIX = "cd * && "

/**
 * Globs that intentionally carry no `cd * && ` twin. A check stage reaches files
 * in its worktree by absolute path and git by `git -C <worktree> …`, so these
 * never need the prefix — only commands that must RUN in the worktree do.
 */
const NO_TWIN = /^(?:git |ls|cat |head |tail |grep |find |wc |gh |curl )/

test("every runner glob has its `cd * && ` twin", () => {
  for (const { kind, manifest } of manifests) {
    for (const stage of manifest.stages ?? []) {
      // Only a worktree-isolated stage is told to prefix its commands; a stage
      // running in the repo root (isolation "none") needs no twin.
      if (stage.isolation !== "worktree") continue
      const globs = stage.bashAllowlist ?? []
      const present = new Set(globs)
      for (const glob of globs) {
        if (glob.startsWith(CD_PREFIX) || NO_TWIN.test(glob)) continue
        assert.ok(
          present.has(CD_PREFIX + glob),
          `${kind}/${stage.name}: "${glob}" has no "${CD_PREFIX}${glob}" twin — ` +
            `the OpenCode host matches the whole command string, so the bare form alone is unreachable in a worktree`,
        )
      }
    }
  }
})

test("every `cd * && ` twin has a bare form", () => {
  for (const { kind, manifest } of manifests) {
    for (const stage of manifest.stages ?? []) {
      const present = new Set(stage.bashAllowlist ?? [])
      for (const glob of present) {
        if (!glob.startsWith(CD_PREFIX)) continue
        const bare = glob.slice(CD_PREFIX.length)
        assert.ok(present.has(bare), `${kind}/${stage.name}: "${glob}" has no bare "${bare}" form`)
      }
    }
  }
})

test("no stage allowlist repeats a glob", () => {
  for (const { kind, manifest } of manifests) {
    for (const stage of manifest.stages ?? []) {
      const globs = stage.bashAllowlist ?? []
      assert.equal(new Set(globs).size, globs.length, `${kind}/${stage.name}: duplicate glob in bashAllowlist`)
    }
  }
})

/**
 * One agent, one static frontmatter — an agent bound by several kinds must
 * declare the identical list in each, or `gen-prompts.mjs` cannot render it.
 * `workflow-verify` is the live case: engineering, dep-sitter, main-sitter and
 * pr-sitter all bind it.
 */
test("an agent bound by several manifests declares identical allowlists", () => {
  const byAgent = new Map()
  for (const { kind, manifest } of manifests) {
    for (const stage of manifest.stages ?? []) {
      const globs = [...(stage.bashAllowlist ?? []), ...Object.values(stage.platformAllowlist ?? {}).flat()]
      if (globs.length === 0) continue
      const seen = byAgent.get(stage.agent)
      if (!seen) {
        byAgent.set(stage.agent, { kind, globs })
        continue
      }
      assert.deepEqual(
        globs,
        seen.globs,
        `agent "${stage.agent}" declares a different bash allowlist in ${kind} than in ${seen.kind} — ` +
          `one static frontmatter must serve both, so reconcile them in workflows/*/workflow.json`,
      )
    }
  }
  // Guards the guard: if the shared agent ever stops being shared, this test
  // would pass vacuously and the invariant above would be untested.
  assert.ok(byAgent.has("workflow-verify"), "expected workflow-verify to declare an allowlist")
})
