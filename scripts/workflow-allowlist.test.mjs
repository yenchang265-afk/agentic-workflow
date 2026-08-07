import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

/**
 * Invariants over every stage `bashAllowlist` in workflows/<kind>/workflow.json,
 * and over the OpenCode frontmatter generated from it.
 *
 * The `cd * && ` twins used to be hand-listed here, which is how `npm outdated*`
 * shipped without one, and how EVERY read glob (`git *`, `cat *`, …) went without
 * one — the defect that had REVIEW's whole allowlist unreachable in a worktree.
 * `gen-prompts.mjs` derives them now, so the invariants flipped: the manifest must
 * carry only bare forms, and the GENERATED frontmatter must carry both.
 *
 * Reading the committed frontmatter (rather than calling the generator) also
 * catches a stale `npm run gen:prompts`.
 */

const WORKFLOWS = path.join(import.meta.dirname, "..", "packages", "core", "workflows")
const OPENCODE_AGENTS = path.join(import.meta.dirname, "..", "plugins", "opencode", "agents")

const manifests = fs
  .readdirSync(WORKFLOWS)
  .sort()
  .map((kind) => ({ kind, file: path.join(WORKFLOWS, kind, "workflow.json") }))
  .filter(({ file }) => fs.existsSync(file))
  .map(({ kind, file }) => ({ kind, manifest: JSON.parse(fs.readFileSync(file, "utf8")) }))

assert.ok(manifests.length > 0, "no workflow manifests found — wrong path?")

const CD_PREFIX = "cd * && "

/** Every glob a stage grants, `bashAllowlist` plus each platform's extras. */
const stageGlobs = (stage) => [...(stage.bashAllowlist ?? []), ...Object.values(stage.platformAllowlist ?? {}).flat()]

test("no manifest glob is hand-written with the `cd * && ` prefix", () => {
  for (const { kind, manifest } of manifests) {
    for (const stage of manifest.stages ?? []) {
      for (const glob of stageGlobs(stage)) {
        assert.ok(
          !glob.startsWith(CD_PREFIX),
          `${kind}/${stage.name}: "${glob}" hand-writes the "${CD_PREFIX}" prefix — ` +
            `gen-prompts.mjs derives the twins for worktree-isolated stages, so declare the bare form only`,
        )
      }
    }
  }
})

/**
 * The generated frontmatter must grant both shapes for a worktree-isolated stage.
 * OpenCode matches the WHOLE command string — it does not split on `&&` the way
 * the Claude Code guard does — so a stage told to run commands inside its
 * worktree has the bare form unreachable there, and without the twin every such
 * command falls through to the `"*": deny` sentinel.
 */
test("the generated OpenCode frontmatter carries both shapes for a worktree stage", () => {
  let checked = 0
  for (const { kind, manifest } of manifests) {
    for (const stage of manifest.stages ?? []) {
      if (stage.isolation !== "worktree") continue
      const globs = stageGlobs(stage)
      if (globs.length === 0) continue
      const file = path.join(OPENCODE_AGENTS, `${stage.agent}.md`)
      assert.ok(fs.existsSync(file), `${kind}/${stage.name}: no generated agent at ${file}`)
      const granted = new Set([...fs.readFileSync(file, "utf8").matchAll(/^ *"(.+)": allow$/gm)].map((m) => m[1]))
      for (const glob of globs) {
        for (const want of [glob, CD_PREFIX + glob]) {
          assert.ok(
            granted.has(want),
            `${kind}/${stage.name}: ${stage.agent}.md does not grant "${want}" — run \`npm run gen:prompts\``,
          )
        }
        checked++
      }
    }
  }
  // Guards the guard: a path that stopped finding worktree stages would pass
  // vacuously and leave the whole invariant untested.
  assert.ok(checked > 0, "no worktree-isolated stage with an allowlist found — wrong path?")
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
