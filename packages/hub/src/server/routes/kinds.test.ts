import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import type { KindDetailResponse, KindsResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import { getKind, getKinds } from "./kinds.js"

/** The real shipped manifests are the fixture — they must always load. */
const LOOPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../core/loops")

const deps: HubDeps = {
  directory: "/unused",
  tasksDir: "docs/tasks",
  loopsDir: LOOPS_DIR,
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
}

test("getKinds lists the shipped loop kinds with stages", async () => {
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
