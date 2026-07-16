import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-loop/core/config"
import type { DoctorFixResponse, DoctorReport, KindBoardInfo } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import type { JsonResponse } from "../http.js"
import { getDoctor, postDoctorFix } from "./doctor.js"

/**
 * The backlog doctor, against a real git repo. Claim release is measured in
 * marker age (core: >15 min), so the fixtures backdate claim dirs with `touch`
 * to make an "orphaned" one without waiting.
 */

const BOARDS: readonly KindBoardInfo[] = [
  {
    kind: "engineering",
    description: "",
    sourceType: "backlog",
    statuses: ["draft", "queued", "in-progress"],
    gateStatuses: [],
    pools: ["queued", "in-progress"],
  },
]

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" })
}

const makeRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-doctor-"))
  git(dir, "init", "-q")
  git(dir, "config", "user.email", "t@e.com")
  git(dir, "config", "user.name", "T")
  for (const s of ["draft", "queued", "in-progress"]) fs.mkdirSync(path.join(dir, "docs", "tasks", s), { recursive: true })
  fs.writeFileSync(path.join(dir, "README.md"), "x\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "init")
  return dir
}

const TASK = (id: string): string => `---\nid: ${id}\ntitle: ${id}\ntype: feature\npriority: 2\n---\n\nBody.\n`

const place = (dir: string, status: string, id: string, extra = ""): void => {
  fs.writeFileSync(path.join(dir, "docs", "tasks", status, `${id}.md`), TASK(id) + extra)
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", `add ${id}`)
}

/** A claim marker. `ageMin` backdates it so it reads as stale (core's threshold is 15). */
const claim = (dir: string, status: string, id: string, ageMin = 0): void => {
  const marker = path.join(dir, "docs", "tasks", status, ".claims", id)
  fs.mkdirSync(marker, { recursive: true })
  if (ageMin > 0) {
    const when = new Date(Date.now() - ageMin * 60_000)
    // touch -d wants a timestamp; ISO works on GNU coreutils.
    execFileSync("touch", ["-d", when.toISOString(), marker])
  }
}

const stageMarker = (dir: string, taskId: string): void => {
  const p = path.join(dir, "docs", "tasks", "runs", ".stage.json")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ stage: "build", taskId }))
}

const lease = (dir: string): void => {
  const p = path.join(dir, "docs", "tasks", "runs", ".watch-lease", "owner.json")
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const now = new Date().toISOString()
  fs.writeFileSync(p, JSON.stringify({ pid: 999, host: "h", startedAt: now, heartbeatAt: now, intervalMs: 60_000 }))
}

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards: BOARDS,
  config: DEFAULT_CONFIG,
  loopsDir: path.join(directory, "loops-unused"),
  projectsDir: "/nonexistent",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

const report = async (dir: string): Promise<DoctorReport> => (await getDoctor(depsFor(dir))).body as DoctorReport
const fix = async (dir: string): Promise<JsonResponse> => postDoctorFix(depsFor(dir))
const claimIds = (dir: string, status: string): string[] => {
  const d = path.join(dir, "docs", "tasks", status, ".claims")
  return fs.existsSync(d) ? fs.readdirSync(d) : []
}
const cleanup = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true })

test("the report is read-only — a GET leaves the backlog byte-identical", async () => {
  const dir = makeRepo()
  place(dir, "in-progress", "aaa1")
  claim(dir, "in-progress", "aaa1", 30)
  fs.mkdirSync(path.join(dir, "docs", "tasks", "run"))
  fs.writeFileSync(path.join(dir, "docs", "tasks", "run", "stray.md"), TASK("stray"))

  const before = execFileSync("find", [path.join(dir, "docs")], { encoding: "utf8" })
  const r = await report(dir)
  const after = execFileSync("find", [path.join(dir, "docs")], { encoding: "utf8" })

  assert.equal(before, after, "GET must not touch the filesystem")
  assert.ok(r.strayFiles.some((s) => s.endsWith("run/stray.md")))
  assert.deepEqual(r.heldClaims, [{ id: "aaa1", status: "in-progress" }])
  cleanup(dir)
})

test("fix rescues a stray to draft/, commits, and reports it", async () => {
  const dir = makeRepo()
  fs.mkdirSync(path.join(dir, "docs", "tasks", "run"))
  fs.writeFileSync(path.join(dir, "docs", "tasks", "run", "orphan.md"), TASK("orphan"))
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "add stray")

  const res = await fix(dir)
  assert.equal(res.status, 200)
  const body = res.body as DoctorFixResponse
  assert.deepEqual(body.rescued, ["docs/tasks/run/orphan.md"])
  assert.ok(fs.existsSync(path.join(dir, "docs", "tasks", "draft", "orphan.md")))
  assert.match(execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: dir }).toString(), /doctor rescued/)
  cleanup(dir)
})

test("fix removes an emptied stray folder", async () => {
  const dir = makeRepo()
  fs.mkdirSync(path.join(dir, "docs", "tasks", "bogus"))
  const body = (await fix(dir)).body as DoctorFixResponse
  assert.deepEqual(body.removedDirs, ["bogus"])
  assert.equal(fs.existsSync(path.join(dir, "docs", "tasks", "bogus")), false)
  cleanup(dir)
})

test("a stale, undriven claim is released; a fresh one is kept", async () => {
  const dir = makeRepo()
  place(dir, "queued", "old1")
  place(dir, "queued", "new1")
  claim(dir, "queued", "old1", 30) // orphaned
  claim(dir, "queued", "new1", 0) // inside the claim→BUILD window

  const body = (await fix(dir)).body as DoctorFixResponse
  assert.deepEqual(body.releasedClaims, ["old1"])
  assert.equal(body.claimsSkipped, false)
  assert.deepEqual(claimIds(dir, "queued"), ["new1"], "the fresh claim must survive")
  cleanup(dir)
})

test("a claim the stage marker names is not released, however old", async () => {
  const dir = makeRepo()
  place(dir, "in-progress", "driven")
  claim(dir, "in-progress", "driven", 60)
  stageMarker(dir, "driven") // a live Claude-host stage is running it

  const body = (await fix(dir)).body as DoctorFixResponse
  assert.deepEqual(body.releasedClaims, [], "a marker-named task is being driven")
  assert.deepEqual(claimIds(dir, "in-progress"), ["driven"])
  cleanup(dir)
})

test("a live watcher lease with no stage marker skips claim release wholesale, but still fixes strays", async () => {
  const dir = makeRepo()
  place(dir, "in-progress", "held")
  claim(dir, "in-progress", "held", 60) // would look orphaned…
  lease(dir) // …but an opencode watcher is live, and we can't tell which task it drives
  fs.mkdirSync(path.join(dir, "docs", "tasks", "bogus"))

  const body = (await fix(dir)).body as DoctorFixResponse
  assert.equal(body.claimsSkipped, true)
  assert.deepEqual(body.releasedClaims, [])
  assert.deepEqual(claimIds(dir, "in-progress"), ["held"], "releasing it could steal the watcher's claim")
  assert.deepEqual(body.removedDirs, ["bogus"], "strays are unrelated and still safe to fix")
  cleanup(dir)
})

test("duplicates are reported but never auto-resolved", async () => {
  const dir = makeRepo()
  place(dir, "draft", "dup")
  place(dir, "queued", "dup")

  const r = await report(dir)
  assert.equal(r.duplicates.length, 1)
  assert.equal(r.duplicates[0]?.id, "dup")

  const body = (await fix(dir)).body as DoctorFixResponse
  assert.equal(body.duplicates.length, 1)
  assert.ok(fs.existsSync(path.join(dir, "docs", "tasks", "draft", "dup.md")))
  assert.ok(fs.existsSync(path.join(dir, "docs", "tasks", "queued", "dup.md")), "both copies untouched")
  cleanup(dir)
})

test("a stray colliding with an existing draft lands in failed, without throwing", async () => {
  const dir = makeRepo()
  place(dir, "draft", "clash") // draft/clash.md already exists
  fs.mkdirSync(path.join(dir, "docs", "tasks", "run"))
  fs.writeFileSync(path.join(dir, "docs", "tasks", "run", "clash.md"), TASK("clash"))

  const body = (await fix(dir)).body as DoctorFixResponse
  assert.deepEqual(body.rescued, [], "can't rescue onto an existing draft")
  assert.equal(body.failed?.length, 1)
  assert.match(body.failed?.[0]?.reason ?? "", /already exists/)
  assert.ok(fs.existsSync(path.join(dir, "docs", "tasks", "run", "clash.md")), "the stray stays for a human")
  cleanup(dir)
})

test("a clean backlog reports nothing and fix is a no-op", async () => {
  const dir = makeRepo()
  place(dir, "draft", "fine")

  const r = await report(dir)
  assert.deepEqual(r.findings, [])
  assert.deepEqual(r.heldClaims, [])

  const body = (await fix(dir)).body as DoctorFixResponse
  assert.deepEqual(body, { rescued: [], removedDirs: [], releasedClaims: [], claimsSkipped: false, duplicates: [] })
  cleanup(dir)
})
