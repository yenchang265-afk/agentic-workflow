import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-workflow/core/config"
import type { RunTokensResponse, TokensSummaryResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import { getRunTokens, getTokensSummary } from "./tokens.js"

/**
 * The token routes over a real runs/ directory. The resolver's three-source
 * fallback logic is pinned by tokens/attribute + resolve's own callers; this
 * pins the ROUTE contract — id screening, 404 shape, and the summary's
 * exclusion of runs with no usage.
 */

const TASKS_DIR = "docs/tasks"

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: TASKS_DIR,
  boards: [],
  config: DEFAULT_CONFIG,
  workflowsDir: path.join(directory, "workflows-unused"),
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

const makeFixture = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-tokens-"))
  fs.mkdirSync(path.join(dir, TASKS_DIR, "runs"), { recursive: true })
  return dir
}

const tokens = (input: number, output: number) => ({ input, output, reasoning: 0, cacheRead: 10, cacheWrite: 5 })

const sidecar = (input: number, output: number, cost: number): string =>
  JSON.stringify({
    version: 1,
    runs: [
      {
        endedAt: "2026-07-05T13:16:25.138Z",
        outcome: "done",
        detail: "",
        host: "opencode",
        samples: [{ stage: "build", iteration: 0, ms: 1000, tokens: tokens(input, output), cost }],
      },
    ],
  })

const writeRun = (dir: string, id: string, sidecarJson?: string): void => {
  fs.writeFileSync(path.join(dir, TASKS_DIR, "runs", `${id}.md`), `# run log for ${id}\n`)
  if (sidecarJson !== undefined) fs.writeFileSync(path.join(dir, TASKS_DIR, "runs", `${id}.metrics.json`), sidecarJson)
}

const req = (id: string) => ({ params: { id }, query: new URLSearchParams() })

test("getRunTokens screens the id before it touches disk", async () => {
  const dir = makeFixture()
  const res = await getRunTokens(depsFor(dir), req("../../etc/passwd"))
  assert.equal(res.status, 404)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getRunTokens 404s a run with neither sidecar nor log", async () => {
  const dir = makeFixture()
  const res = await getRunTokens(depsFor(dir), req("no-such-run"))
  assert.equal(res.status, 404)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getRunTokens returns observed sidecar rows with summed totals", async () => {
  const dir = makeFixture()
  writeRun(dir, "f7k3-add-rate-limit", sidecar(100, 50, 0.12))
  const res = await getRunTokens(depsFor(dir), req("f7k3-add-rate-limit"))
  assert.equal(res.status, 200)
  const body = res.body as RunTokensResponse
  assert.equal(body.rows.length, 1)
  assert.equal(body.rows[0]?.source, "sidecar")
  assert.equal(body.rows[0]?.estimated, false)
  assert.equal(body.totals.input, 100)
  assert.equal(body.totals.output, 50)
  assert.equal(body.cost, 0.12)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("getTokensSummary lists runs with usage, sorted by total, and drops usage-less runs", async () => {
  const dir = makeFixture()
  writeRun(dir, "small-run", sidecar(100, 50, 0.1))
  writeRun(dir, "big-run", sidecar(9000, 500, 1.5))
  writeRun(dir, "no-usage-run") // log only: no sidecar, no attributable windows
  const res = await getTokensSummary(depsFor(dir))
  assert.equal(res.status, 200)
  const body = res.body as TokensSummaryResponse
  assert.deepEqual(
    body.runs.map((r) => r.id),
    ["big-run", "small-run"],
  )
  // input rolls cache into the total the bar renders
  assert.equal(body.runs[1]?.input, 100 + 10 + 5)
  assert.equal(body.runs[1]?.output, 50)
  fs.rmSync(dir, { recursive: true, force: true })
})
