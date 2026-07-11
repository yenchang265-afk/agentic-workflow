import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CONFIG, parseConfigWith, ConfigSchema } from "../config.js"
import { defaultLoopsDir } from "../manifest/dir.js"
import type { Client, Shell } from "../host.js"
import { serializeTask, parseTask } from "../task/schema.js"
import { PLAN_HEADING } from "../task/store.js"
import {
  buildEntryState,
  buildWorkSources,
  loopWorkTree,
  makeManifestCache,
  planEntryState,
  taskGoal,
  taskRef,
} from "./orchestrate.js"

const noopShell = ((..._args: unknown[]) => {
  throw new Error("shell must not run during source construction")
}) as unknown as Shell
const noopClient = {} as unknown as Client

const task = (body: string) => {
  const raw = serializeTask({ title: "Do the thing", body })
  return parseTask("my-task.md", raw, "/repo/docs/tasks/queued/my-task.md")
}

test("taskGoal joins title and body; taskRef carries id/path/acceptance", () => {
  const t = task("Some context.")
  assert.equal(taskGoal(t), "Do the thing\n\nSome context.")
  assert.deepEqual(taskRef(t, t.path), { id: "my-task", path: "/repo/docs/tasks/queued/my-task.md", acceptance: t.acceptance })
})

test("buildEntryState enters at build with the persisted plan; planEntryState at plan", () => {
  const planned = task(`${PLAN_HEADING}\n\n1. Step.`)
  const build = buildEntryState(planned)
  assert.equal(build.stage, "build")
  assert.match(build.artifacts["plan"] ?? "", /1\. Step\./)
  const plan = planEntryState(task("no plan yet"))
  assert.equal(plan.stage, "plan")
})

test("loopWorkTree prefers the state's worktree over the main tree", () => {
  const base = planEntryState(task("x"))
  assert.equal(loopWorkTree("/repo", base), "/repo")
  assert.equal(loopWorkTree("/repo", { ...base, git: { base: "main", branch: "b", worktree: "/wt" } }), "/wt")
})

test("makeManifestCache loads eagerly, caches, and serves lazy kinds", () => {
  const manifestFor = makeManifestCache(defaultLoopsDir(), ["engineering"])
  const eng = manifestFor("engineering")
  assert.equal(eng.manifest.kind, "engineering")
  assert.equal(manifestFor("engineering"), eng, "same cached instance")
  assert.equal(manifestFor("pr-sitter").manifest.kind, "pr-sitter")
})

test("buildWorkSources yields one source per enabled kind, in order", () => {
  const config = parseConfigWith(ConfigSchema, { loops: { "pr-sitter": { enabled: true } } })
  const manifestFor = makeManifestCache(defaultLoopsDir())
  const sources = buildWorkSources(
    { $: noopShell, client: noopClient, directory: "/repo", log: () => {}, isDriving: () => false },
    config,
    manifestFor,
  )
  assert.equal(sources.length, 2)
})

test("an unloadable kind is skipped with a warning, not fatal", () => {
  const config = parseConfigWith(ConfigSchema, { loops: { "no-such-kind": { enabled: true } } })
  const warnings: string[] = []
  const manifestFor = makeManifestCache(defaultLoopsDir())
  const sources = buildWorkSources(
    { $: noopShell, client: noopClient, directory: "/repo", log: (_l, m) => warnings.push(m), isDriving: () => false },
    config,
    manifestFor,
  )
  assert.equal(sources.length, 1, "engineering survives the bad kind")
  assert.ok(warnings.some((w) => w.includes('no-such-kind')))
})

test("a kind filter restricts the sources to that kind", () => {
  const config = parseConfigWith(ConfigSchema, { loops: { "pr-sitter": { enabled: true } } })
  const manifestFor = makeManifestCache(defaultLoopsDir())
  const deps = { $: noopShell, client: noopClient, directory: "/repo", log: () => {}, isDriving: () => false }
  assert.equal(buildWorkSources(deps, config, manifestFor, "pr-sitter").length, 1)
  assert.equal(buildWorkSources(deps, DEFAULT_CONFIG, manifestFor, "engineering").length, 1)
})
