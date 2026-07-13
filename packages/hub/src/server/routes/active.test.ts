import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { ActiveResponse, KindBoardInfo } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import { getActive } from "./active.js"

/**
 * The live-activity route's dedup-ledger scan: each work source keeps its ledgers
 * under `runs/<kind>/`, and the monitor must show each kind ONLY its own — PR kinds
 * their pr-*.json (C4), dependency-scan kinds their dep-*.json and ci-runs kinds
 * their head-*.json (C8). Runs against a real on-disk fixture, like backlog.test.ts.
 */

const BOARDS: readonly KindBoardInfo[] = [
  { kind: "pr-sitter", description: "", sourceType: "github-pr", statuses: [], gateStatuses: [], pools: [] },
  { kind: "review-sitter", description: "", sourceType: "github-pr", statuses: [], gateStatuses: [], pools: [] },
  { kind: "dep-sitter", description: "", sourceType: "dependency-scan", statuses: [], gateStatuses: [], pools: [] },
  { kind: "main-sitter", description: "", sourceType: "ci-runs", statuses: [], gateStatuses: [], pools: [] },
]

const makeFixture = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-active-"))
  const runs = path.join(dir, "docs", "tasks", "runs")
  const write = (rel: string, obj: unknown) => {
    const p = path.join(runs, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(obj))
  }
  // Two PR kinds, SAME PR number — must not bleed across kinds (C4).
  write("pr-sitter/pr-7.json", { pr: 7, headShaHandled: "sha-a", failedAttempts: [{ headSha: "sha-a" }] })
  write("review-sitter/pr-7.json", { pr: 7, headShaHandled: "sha-b", failedAttempts: [] })
  // dep-sitter and main-sitter dedup state (C8).
  write("dep-sitter/dep-lodash.json", { pkg: "lodash", versionHandled: "4.17.21", failedAttempts: [] })
  write("main-sitter/head-abc1234.json", { sha: "abc1234def", handled: false, failedAttempts: [{ at: "t" }, { at: "t2" }] })
  // A stray non-ledger file in a runs/<kind> dir must be ignored (prefix filter).
  write("dep-sitter/notes.json", { hello: "world" })
  return dir
}

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards: BOARDS,
  loopsDir: path.join(directory, "loops-unused"),
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

test("getActive scans each source's ledgers, kind-scoped (C4/C8)", async () => {
  const dir = makeFixture()
  const res = await getActive(depsFor(dir))
  assert.equal(res.status, 200)
  const body = res.body as ActiveResponse

  // C4: both PR kinds surface, each stamped with its own kind — no cross-kind bleed.
  assert.equal(body.prLedgers.length, 2)
  const prByKind = Object.fromEntries(body.prLedgers.map((l) => [l.kind, l]))
  assert.equal(prByKind["pr-sitter"]?.pr, 7)
  assert.equal(prByKind["pr-sitter"]?.failedAttempts, 1)
  assert.equal(prByKind["review-sitter"]?.pr, 7)
  assert.equal(prByKind["review-sitter"]?.failedAttempts, 0)

  // C8: dep-sitter's per-package ledger, ignoring the stray non-dep file.
  assert.equal(body.depLedgers.length, 1)
  assert.equal(body.depLedgers[0]?.kind, "dep-sitter")
  assert.equal(body.depLedgers[0]?.pkg, "lodash")
  assert.equal(body.depLedgers[0]?.versionHandled, "4.17.21")

  // C8: main-sitter's per-head ledger.
  assert.equal(body.headLedgers.length, 1)
  assert.equal(body.headLedgers[0]?.kind, "main-sitter")
  assert.equal(body.headLedgers[0]?.sha, "abc1234def")
  assert.equal(body.headLedgers[0]?.handled, false)
  assert.equal(body.headLedgers[0]?.failedAttempts, 2)

  fs.rmSync(dir, { recursive: true, force: true })
})
