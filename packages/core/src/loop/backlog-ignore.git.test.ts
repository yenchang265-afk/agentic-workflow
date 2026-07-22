import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Client, Shell, ShellOutput } from "../host.js"
import { DEFAULT_CONFIG } from "../config.js"
import { serializeTask } from "../task/schema.js"
import { approveTask, type GateCtx } from "./gate.js"
import { ensureExcluded } from "./git.js"

/**
 * Real-git regression for `ignoreBacklog` (on by default): a gate move must
 * leave `tasksDir` uncommitted and instead register it in
 * `.git/info/exclude` — the same per-clone mechanism `worktreesDir` uses —
 * rather than the pre-existing behavior of committing every task move as an
 * audit trail. The in-memory `gate.test.ts` harness can't observe either
 * outcome (its fake git always reports failure), so this drives `approveTask`
 * against an actual repository.
 */

// A minimal bash-backed Shell — same harness as the other `*.git.test.ts` files
// (copied rather than imported; core tests must not reach into a plugin's shim).
const esc = (v: unknown): string => `'${String(v).replace(/'/g, "'\\''")}'`
const isRaw = (v: unknown): v is { raw: string } => typeof v === "object" && v !== null && "raw" in v
const sh: Shell = (strings, ...exprs) => {
  let cmd = ""
  strings.forEach((s, i) => {
    if (i < exprs.length) {
      const e: unknown = exprs[i]
      cmd += s + (isRaw(e) ? e.raw : Array.isArray(e) ? e.map(esc).join(" ") : esc(e))
    } else cmd += s
  })
  let cwd: string | undefined
  const exec = (): Promise<ShellOutput> =>
    new Promise((resolve) => {
      const child = spawn("bash", ["-c", cmd], { cwd })
      let out = ""
      let err = ""
      child.stdout.on("data", (d) => (out += d))
      child.stderr.on("data", (d) => (err += d))
      child.on("error", () => resolve({ exitCode: 127, stdout: { toString: () => out }, stderr: { toString: () => err || "spawn error" } }))
      child.on("close", (code) => resolve({ exitCode: code ?? 0, stdout: { toString: () => out }, stderr: { toString: () => err } }))
    })
  const chain = {
    quiet: () => chain,
    nothrow: () => chain,
    cwd: (dir: string) => {
      cwd = dir
      return chain
    },
    then: <T1, T2>(onfulfilled?: ((v: ShellOutput) => T1 | PromiseLike<T1>) | null, onrejected?: ((r: unknown) => T2 | PromiseLike<T2>) | null) =>
      exec().then(onfulfilled, onrejected),
  }
  return chain as ReturnType<Shell>
}

const git = async (repo: string, ...args: string[]): Promise<string> => {
  const out = await sh`git -C ${repo} ${args}`.quiet().nothrow()
  assert.equal(out.exitCode, 0, `git ${args.join(" ")} failed: ${out.stderr.toString()}`)
  return out.stdout.toString().trim()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeClient = { file: { list: async () => ({ data: [] }), read: async () => ({ data: null }) }, app: { log: async () => undefined } } as any as Client

const seedRepo = async (): Promise<string> => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentic-loop-backlog-ignore-")))
  await git(repo, "init", "-q", "-b", "main")
  await git(repo, "config", "user.email", "test@example.com")
  await git(repo, "config", "user.name", "Backlog Ignore Test")
  const draftDir = path.join(repo, DEFAULT_CONFIG.tasksDir, "draft")
  fs.mkdirSync(draftDir, { recursive: true })
  fs.writeFileSync(path.join(draftDir, "t1.md"), serializeTask({ title: "Do it", body: "context" }))
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "seed: draft task")
  return repo
}

const gateCtx = (repo: string, config: typeof DEFAULT_CONFIG): GateCtx => ({
  $: sh,
  client: fakeClient,
  log: () => {},
  directory: repo,
  config,
})

test("ignoreBacklog (the default): approveTask moves the task, commits nothing, and registers the exclude", async () => {
  const repo = await seedRepo()
  try {
    const before = await git(repo, "rev-list", "--count", "HEAD")
    const r = await approveTask(gateCtx(repo, DEFAULT_CONFIG), "t1")
    assert.ok(r.ok, `approveTask failed: ${JSON.stringify(r)}`)

    // The move happened on disk...
    assert.ok(fs.existsSync(path.join(repo, DEFAULT_CONFIG.tasksDir, "queued", "t1.md")), "task file must be in queued/")
    assert.ok(!fs.existsSync(path.join(repo, DEFAULT_CONFIG.tasksDir, "draft", "t1.md")), "task file must have left draft/")

    // ...but no commit was made for it.
    const after = await git(repo, "rev-list", "--count", "HEAD")
    assert.equal(after, before, "no new commit should be created when ignoreBacklog is on")
    const dirty = await git(repo, "status", "--porcelain")
    assert.match(dirty, /docs\/tasks\/(draft|queued)\/t1\.md/, "the move shows up as a working-tree change, not a commit")

    // .git/info/exclude gained the tasksDir entry, not the tracked .gitignore.
    // (git's own template pre-populates the file with comment lines — assert
    // the entry is present, not that the file is exactly one line.)
    const excludeFile = path.join(repo, ".git", "info", "exclude")
    assert.ok(fs.existsSync(excludeFile), ".git/info/exclude must be created")
    const excludeLines = fs.readFileSync(excludeFile, "utf8").split("\n")
    assert.equal(excludeLines.filter((l) => l === `/${DEFAULT_CONFIG.tasksDir}/`).length, 1)
    assert.ok(!fs.existsSync(path.join(repo, ".gitignore")), "the shared, tracked .gitignore must be untouched")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("ensureExcluded is idempotent — calling it again does not duplicate the entry", async () => {
  const repo = await seedRepo()
  try {
    await ensureExcluded(sh, repo, DEFAULT_CONFIG.tasksDir)
    await ensureExcluded(sh, repo, DEFAULT_CONFIG.tasksDir)
    const excludeFile = path.join(repo, ".git", "info", "exclude")
    const excludeLines = fs.readFileSync(excludeFile, "utf8").split("\n")
    assert.equal(excludeLines.filter((l) => l === `/${DEFAULT_CONFIG.tasksDir}/`).length, 1, "the exclude entry must not be duplicated")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("ignoreBacklog: false restores the old behavior — the move is committed", async () => {
  const repo = await seedRepo()
  try {
    const before = await git(repo, "rev-list", "--count", "HEAD")
    const config = { ...DEFAULT_CONFIG, ignoreBacklog: false }
    const r = await approveTask(gateCtx(repo, config), "t1")
    assert.ok(r.ok, `approveTask failed: ${JSON.stringify(r)}`)

    const after = await git(repo, "rev-list", "--count", "HEAD")
    assert.equal(Number(after), Number(before) + 1, "the move must be committed when ignoreBacklog is false")
    const dirty = await git(repo, "status", "--porcelain")
    assert.equal(dirty, "", "the working tree must be clean once the move is committed")
    const committed = await git(repo, "ls-tree", "-r", "--name-only", "HEAD")
    assert.ok(committed.includes(`${config.tasksDir}/queued/t1.md`), "the move must be committed")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
