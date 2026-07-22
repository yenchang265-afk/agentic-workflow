import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-workflow/core/config"
import { REDACTED, type ConfigLayerResponse, type KindBoardInfo, type SaveConfigResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import type { JsonResponse } from "../http.js"
import { getConfig, saveConfig } from "./config.js"

/**
 * The config editor writes the file that grants every other authority, so these
 * tests are mostly about what it must NOT do. The two headline cases:
 *
 * - it must not strip keys core's schema doesn't know (parse-then-write would
 *   delete `watchIntervalMinutes` and the hub's own `hub` section);
 * - it must not flatten the user layer into the repo file (which would commit
 *   `ado.pat`).
 */

const BOARDS: readonly KindBoardInfo[] = [
  { kind: "engineering", description: "", sourceType: "backlog", statuses: [], gateStatuses: [], pools: [] },
  { kind: "dep-sitter", description: "", sourceType: "dependency-scan", statuses: [], gateStatuses: [], pools: [] },
]

interface Fixture {
  readonly dir: string
  readonly userFile: string
  readonly deps: HubDeps
  reloaded: number
}

const makeFixture = (repoCfg?: unknown, userCfg?: unknown, git = false): Fixture => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-config-"))
  const userFile = path.join(dir, "user-agentic-workflow.json")
  // Point the user layer at a fixture file — never a developer's real
  // ~/.agentic-workflow.json, which core's own docs warn tests about.
  process.env["AGENTIC_WORKFLOW_USER_CONFIG"] = userFile

  if (repoCfg !== undefined) fs.writeFileSync(path.join(dir, ".agentic-workflow.json"), typeof repoCfg === "string" ? repoCfg : JSON.stringify(repoCfg, null, 2))
  if (userCfg !== undefined) fs.writeFileSync(userFile, JSON.stringify(userCfg, null, 2))
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" })
  }

  const f: Fixture = {
    dir,
    userFile,
    reloaded: 0,
    deps: {
      directory: dir,
      tasksDir: "docs/tasks",
      boards: BOARDS,
      config: DEFAULT_CONFIG,
      workflowsDir: path.join(dir, "workflows-unused"),
      projectsDir: "/nonexistent",
      opencodeDbPath: "/nonexistent.db",
      client: fsClient,
      sh,
      log: () => {},
      reloadRepo: async () => {
        f.reloaded++
        return true
      },
    },
  }
  return f
}

const cleanup = (f: Fixture): void => {
  delete process.env["AGENTIC_WORKFLOW_USER_CONFIG"]
  fs.rmSync(f.dir, { recursive: true, force: true })
}

const get = async (f: Fixture, layer = "repo"): Promise<JsonResponse> =>
  getConfig(f.deps, { params: {}, query: new URLSearchParams({ layer }) })

const save = async (f: Fixture, body: unknown): Promise<JsonResponse> =>
  saveConfig(f.deps, { params: {}, query: new URLSearchParams(), body })

const repoFile = (f: Fixture): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(f.dir, ".agentic-workflow.json"), "utf8")) as Record<string, unknown>

// --- Crux A: the strip footgun ----------------------------------------------

test("a save preserves keys core's schema doesn't know — the headline regression", async () => {
  // watchIntervalMinutes is host-only (the OpenCode plugin adds it via safeExtend);
  // `hub` is the hub's own section. ConfigSchema.parse() strips BOTH. If this
  // route ever writes a parsed object, this test goes red — and in production the
  // hub would delete its own configuration.
  const f = makeFixture({ maxIterations: 3, watchIntervalMinutes: 5, hub: { repos: ["/a"], port: 4317 } })
  const res = await save(f, { layer: "repo", edits: [{ path: "maxIterations", value: 9 }] })
  assert.equal(res.status, 200)

  const after = repoFile(f)
  assert.equal(after["maxIterations"], 9, "the edit applied")
  assert.equal(after["watchIntervalMinutes"], 5, "host-only key must survive")
  assert.deepEqual(after["hub"], { repos: ["/a"], port: 4317 }, "the hub's own section must survive")
  cleanup(f)
})

test("unknown keys are surfaced as passthrough rather than silently preserved", async () => {
  const f = makeFixture({ maxIterations: 3, watchIntervalMinutes: 5, maxIteration: 4 })
  const body = (await get(f)).body as ConfigLayerResponse
  // A typo shows up here instead of vanishing — same mechanism, honest UX.
  assert.deepEqual([...body.passthrough].sort(), ["maxIteration", "watchIntervalMinutes"])
  cleanup(f)
})

// --- Crux B: the layer footgun ----------------------------------------------

test("editing the repo layer never flattens the user layer into it", async () => {
  // The nightmare: ado.pat lives in the user layer; a naive save of the merged
  // view would write it into the repo file, which may well be committed.
  const f = makeFixture({ maxIterations: 3 }, { ado: { organization: "acme", project: "p", selfLogin: "bot", pat: "super-secret" } })
  const res = await save(f, { layer: "repo", edits: [{ path: "maxIterations", value: 9 }] })
  assert.equal(res.status, 200)

  const after = repoFile(f)
  assert.deepEqual(Object.keys(after), ["maxIterations"], "the repo file gains no ado section")
  assert.equal(JSON.stringify(after).includes("super-secret"), false, "the secret must never reach the repo file")
  cleanup(f)
})

test("a secret is redacted on the way out and preserved when the sentinel comes back", async () => {
  const f = makeFixture({}, { ado: { organization: "acme", project: "p", selfLogin: "bot", pat: "super-secret" } })

  const body = (await get(f, "user")).body as ConfigLayerResponse
  assert.equal(JSON.stringify(body).includes("super-secret"), false, "the pat must never reach the browser")
  assert.deepEqual(body.redactedPaths, ["ado.pat"])

  // Echoing the sentinel back means "unchanged" — not "set the pat to the literal
  // string __REDACTED__", which is what a naive round-trip would do.
  await save(f, { layer: "user", edits: [{ path: "ado.pat", value: REDACTED }, { path: "ado.project", value: "p2" }] })
  const user = JSON.parse(fs.readFileSync(f.userFile, "utf8")) as { ado: { pat: string; project: string } }
  assert.equal(user.ado.pat, "super-secret", "the real secret survived the round-trip")
  assert.equal(user.ado.project, "p2")

  // A genuinely new value does replace it.
  await save(f, { layer: "user", edits: [{ path: "ado.pat", value: "rotated" }] })
  assert.equal((JSON.parse(fs.readFileSync(f.userFile, "utf8")) as { ado: { pat: string } }).ado.pat, "rotated")
  cleanup(f)
})

test("provenance says which layer each value comes from", async () => {
  const f = makeFixture({ maxIterations: 9 }, { maxIterations: 5, tasksDir: "user-tasks" })
  const body = (await get(f)).body as ConfigLayerResponse
  assert.equal(body.provenance["maxIterations"], "repo")
  assert.equal(body.provenance["tasksDir"], "user")
  cleanup(f)
})

test("writing a plaintext pat into a repo file that isn't gitignored is refused", async () => {
  const f = makeFixture({ ado: { organization: "acme", project: "p", selfLogin: "bot" }, codePlatform: "ado" }, undefined, true)
  const res = await save(f, { layer: "repo", edits: [{ path: "ado.pat", value: "leak-me" }] })

  assert.equal(res.status, 400)
  assert.match(String((res.body as { error: string }).error), /not gitignored/)
  assert.equal(JSON.stringify(repoFile(f)).includes("leak-me"), false, "nothing was written")

  // Gitignored → allowed.
  fs.writeFileSync(path.join(f.dir, ".gitignore"), ".agentic-workflow.json\n")
  const ok = await save(f, { layer: "repo", edits: [{ path: "ado.pat", value: "fine" }] })
  assert.equal(ok.status, 200)
  cleanup(f)
})

// --- validation, warnings, reload -------------------------------------------

test("an invalid config is refused and nothing is written", async () => {
  const f = makeFixture({ maxIterations: 3 })
  // codePlatform "ado" without an ado section trips the schema's cross-field refinement.
  const res = await save(f, { layer: "repo", edits: [{ path: "codePlatform", value: "ado" }] })

  assert.equal(res.status, 400)
  const issues = (res.body as { issues: { path: string }[] }).issues
  assert.ok(issues.some((i) => i.path === "ado"))
  assert.equal(repoFile(f)["codePlatform"], undefined, "the bad value must not land on disk")
  cleanup(f)
})

test("validation runs against the MERGED view, not the layer alone", async () => {
  // The repo layer alone is invalid (ado platform, no ado section) but the user
  // layer supplies it — refusing this would be wrong.
  const f = makeFixture({}, { ado: { organization: "acme", project: "p", selfLogin: "bot" } })
  const res = await save(f, { layer: "repo", edits: [{ path: "codePlatform", value: "ado" }] })
  assert.equal(res.status, 200)
  assert.equal(repoFile(f)["codePlatform"], "ado")
  cleanup(f)
})

test("knob warnings annotate a save but never block it", async () => {
  const f = makeFixture({ workflows: { "dep-sitter": { severityfloor: "high" } } })
  const res = await save(f, { layer: "repo", edits: [{ path: "maxIterations", value: 4 }] })

  assert.equal(res.status, 200, "warnings are advisory")
  const warnings = (res.body as SaveConfigResponse).warnings
  assert.ok(warnings.some((w) => w.suggestion === "severityFloor"))
  assert.equal(repoFile(f)["maxIterations"], 4)
  cleanup(f)
})

test("a malformed config is rendered, not thrown — and refused for editing", async () => {
  const f = makeFixture("{ not json")
  const body = (await get(f)).body as ConfigLayerResponse
  assert.match(body.parseError ?? "", /not valid JSON/)
  assert.equal(body.raw, null)

  const res = await save(f, { layer: "repo", edits: [{ path: "maxIterations", value: 9 }] })
  assert.equal(res.status, 400, "editing a file we can't parse would destroy it")
  assert.match(String((res.body as { error: string }).error), /fix the file by hand/)
  cleanup(f)
})

test("a successful save reloads the repo — config is otherwise read once at startup", async () => {
  const f = makeFixture({ maxIterations: 3 })
  await save(f, { layer: "repo", edits: [{ path: "maxIterations", value: 9 }] })
  assert.equal(f.reloaded, 1)

  // A refused save must not reload: nothing changed.
  await save(f, { layer: "repo", edits: [{ path: "codePlatform", value: "ado" }] })
  assert.equal(f.reloaded, 1)
  cleanup(f)
})

test("an edit can delete a key, and a save creates a config file that didn't exist", async () => {
  const f = makeFixture({ maxIterations: 3, worktreeSetup: "npm ci" })
  await save(f, { layer: "repo", edits: [{ path: "worktreeSetup" }] })
  assert.equal("worktreeSetup" in repoFile(f), false)
  cleanup(f)

  const f2 = makeFixture()
  const res = await save(f2, { layer: "repo", edits: [{ path: "maxIterations", value: 7 }] })
  assert.equal(res.status, 200)
  assert.deepEqual(repoFile(f2), { maxIterations: 7 })
  cleanup(f2)
})

test("malformed requests are rejected", async () => {
  const f = makeFixture({})
  assert.equal((await save(f, { layer: "nope", edits: [] })).status, 400)
  assert.equal((await save(f, { layer: "repo" })).status, 400)
  assert.equal((await getConfig(f.deps, { params: {}, query: new URLSearchParams({ layer: "merged" }) })).status, 400)
  cleanup(f)
})
