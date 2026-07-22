import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { DEFAULT_CONFIG } from "@agentic-workflow/core/config"
import { verdictContractBlock } from "@agentic-workflow/core/workflow/verdict"
import { loadManifest } from "@agentic-workflow/core/manifest/load"
import type { KindDetailResponse, KindsResponse, PreviewResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import type { JsonResponse } from "../http.js"
import { getKind, getKinds, previewKind, saveKind } from "./kinds.js"

/** The real shipped manifests are the fixture — they must always load. */
const WORKFLOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../core/workflows")

const deps: HubDeps = {
  directory: "/unused",
  tasksDir: "docs/tasks",
  boards: [],
  config: DEFAULT_CONFIG,
  workflowsDir: WORKFLOWS_DIR,
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
}

test("getKinds lists the shipped workflow kinds with stages", async () => {
  const res = await getKinds(deps)
  assert.equal(res.status, 200)
  const body = res.body as KindsResponse
  const kinds = body.kinds.map((k) => k.kind)
  assert.ok(kinds.includes("engineering"))
  assert.ok(kinds.includes("pr-sitter"))
  const engineering = body.kinds.find((k) => k.kind === "engineering")
  assert.deepEqual(engineering?.stages, ["plan", "build", "verify", "review"])
})

test("getKind returns the manifest and its stage prompts", async () => {
  const res = await getKind(deps, { params: { kind: "engineering" }, query: new URLSearchParams() })
  assert.equal(res.status, 200)
  const body = res.body as KindDetailResponse
  assert.equal(body.manifest.kind, "engineering")
  assert.ok(body.prompts["build"] && body.prompts["build"].length > 0)
})

test("getKind 404s on unknown or malformed kind names", async () => {
  const unknown = await getKind(deps, { params: { kind: "nope" }, query: new URLSearchParams() })
  assert.equal(unknown.status, 404)
  const traversal = await getKind(deps, { params: { kind: "../secrets" }, query: new URLSearchParams() })
  assert.equal(traversal.status, 404)
})

// --- preview -----------------------------------------------------------------

/** The shipped engineering kind, loaded off disk — the same fixture getKind serves. */
const engineering = (): KindDetailResponse => {
  const { manifest, prompts } = loadManifest(WORKFLOWS_DIR, "engineering")
  return { manifest, prompts }
}

const preview = async (body: unknown): Promise<JsonResponse> =>
  previewKind(deps, { params: {}, query: new URLSearchParams(), body })

test("preview renders a real shipped prompt against sample state", async () => {
  const { manifest, prompts } = engineering()
  const res = await preview({ manifest, prompts, stage: "build" })
  assert.equal(res.status, 200)
  const body = res.body as PreviewResponse
  assert.ok(body.rendered.length > 0)
  // Substituted, not echoed: no template syntax survives a full render.
  assert.doesNotMatch(body.rendered, /\{\{/)
  assert.equal(body.sample.platform, "github")
})

test("preview toggles make conditional blocks fire or vanish — the point of the feature", async () => {
  const { manifest, prompts } = engineering()
  const withTask = (await preview({ manifest, prompts, stage: "build", sample: { task: true } })).body as PreviewResponse
  const without = (await preview({ manifest, prompts, stage: "build", sample: { task: false } })).body as PreviewResponse
  assert.notEqual(withTask.rendered, without.rendered, "{{#task.id}} must visibly change the render")

  const wt = (await preview({ manifest, prompts, stage: "build", sample: { git: true, worktree: true } }))
    .body as PreviewResponse
  const noWt = (await preview({ manifest, prompts, stage: "build", sample: { git: true, worktree: false } }))
    .body as PreviewResponse
  assert.match(wt.rendered, /\/sample\/worktree\/path/)
  assert.doesNotMatch(noWt.rendered, /\/sample\/worktree\/path/)
})

test("preview appends the verdict contract to check stages only", async () => {
  const { manifest, prompts } = engineering()
  const verify = (await preview({ manifest, prompts, stage: "verify" })).body as PreviewResponse
  const build = (await preview({ manifest, prompts, stage: "build" })).body as PreviewResponse
  // verify is a check stage, build is a work stage.
  assert.ok(verify.rendered.endsWith(verdictContractBlock("verify")), "check stages carry the contract")
  assert.doesNotMatch(build.rendered, /MANDATORY VERDICT/)
})

test("preview reports a compose hook instead of throwing on it", async () => {
  const { manifest, prompts } = engineering()
  const hooked = { ...manifest, hooks: { ...manifest.hooks, compose: { build: "some:unregistered-hook" } } }
  const res = await preview({ manifest: hooked, prompts, stage: "build" })
  // composePrompt would throw here — resolveComposeHook can't resolve a hook no
  // host registered, which is every hub-authored kind.
  assert.equal(res.status, 200)
  const body = res.body as PreviewResponse
  assert.match(body.note ?? "", /compose hook/)
  assert.ok(body.rendered.length > 0)
})

test("preview rejects an unknown stage, a missing prompt, and an invalid manifest", async () => {
  const { manifest, prompts } = engineering()
  assert.equal((await preview({ manifest, prompts, stage: "nope" })).status, 400)
  assert.equal((await preview({ manifest, prompts: {}, stage: "build" })).status, 400)
  assert.equal((await preview({ manifest: { kind: "broken" }, prompts, stage: "build" })).status, 400)
  assert.equal((await preview({ prompts, stage: "build" })).status, 400)
})

test("saveKind refuses the reserved route verbs, whatever the route table's order", async () => {
  for (const kind of ["preview", "validate"]) {
    const res = await saveKind(deps, { params: { kind }, query: new URLSearchParams(), body: { manifest: {} } })
    assert.equal(res.status, 400)
    assert.match(String((res.body as { error: string }).error), /reserved route name/)
  }
})
