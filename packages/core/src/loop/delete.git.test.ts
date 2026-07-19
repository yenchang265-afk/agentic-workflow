import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Client, FileNode, Shell, ShellOutput } from "../host.js"
import { DEFAULT_CONFIG } from "../config.js"
import { serializeTask } from "../task/schema.js"
import { deleteTask, surveyDeletion } from "./delete.js"
import type { GateCtx } from "./gate.js"

/**
 * Real-git coverage for `delete`. The stubbed suite (delete.test.ts) proves
 * which commands we *emit*; only a real repository proves how git *answers* —
 * that `-d` genuinely refuses an unmerged branch, that a checked-out branch
 * can't be deleted at all, and that `worktree remove` blocks on a dirty tree.
 * Those refusals are the whole safety story, so they get a real repo.
 */

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

/** Filesystem-backed Client, mirroring the MCP host's `fsClient`. */
const fsClient: Client = {
  file: {
    async list({ query }) {
      const abs = path.resolve(query.directory, query.path)
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true })
      } catch {
        return { data: [] }
      }
      const data: FileNode[] = entries.map((e) => ({
        type: e.isDirectory() ? "directory" : "file",
        name: e.name,
        path: path.join(query.path, e.name),
        absolute: path.join(abs, e.name),
      }))
      return { data }
    },
    async read({ query }) {
      const abs = path.resolve(query.directory, query.path)
      try {
        return { data: { content: fs.readFileSync(abs, "utf8") } }
      } catch {
        return { data: null }
      }
    },
  },
  app: { async log() {} },
}

const git = async (repo: string, ...args: string[]): Promise<string> => {
  const out = await sh`git -C ${repo} ${args}`.quiet().nothrow()
  assert.equal(out.exitCode, 0, `git ${args.join(" ")} failed: ${out.stderr.toString()}`)
  return out.stdout.toString().trim()
}

const TASKS = DEFAULT_CONFIG.tasksDir
const ctxFor = (repo: string, isDriving?: (id: string) => boolean): GateCtx => ({
  $: sh,
  client: fsClient,
  log: async () => {},
  directory: repo,
  config: { ...DEFAULT_CONFIG, worktreesDir: ".wt" },
  ...(isDriving ? { isDriving } : {}),
})

/** A repo with one committed task in `status/`, on `main`. */
const seedRepo = async (
  status: string,
  id: string,
  body = "",
  extra: Record<string, unknown> = {},
): Promise<string> => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-loop-delete-git-"))
  await git(repo, "init", "-q", "-b", "main")
  await git(repo, "config", "user.email", "test@example.com")
  await git(repo, "config", "user.name", "Delete Test")
  const dir = path.join(repo, TASKS, status)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${id}.md`), serializeTask({ title: `Task ${id}`, body, ...extra }))
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", `seed: ${id}`)
  return repo
}

/** Give `id` a real worktree on feature/<id> with a commit that exists nowhere else. */
const addWorktreeWithCommit = async (repo: string, id: string): Promise<string> => {
  const wt = path.join(repo, ".wt", id)
  await git(repo, "worktree", "add", "-q", "-b", `feature/${id}`, wt, "main")
  fs.writeFileSync(path.join(wt, "work.txt"), "unmerged work\n")
  await git(wt, "add", "-A")
  await git(wt, "commit", "-q", "-m", "build: work")
  return wt
}

test("real git: unmerged branch refuses without force, force deletes worktree + branch", async () => {
  const id = "a1b2-thing"
  const repo = await seedRepo("in-progress", id)
  try {
    const wt = await addWorktreeWithCommit(repo, id)
    const taskPath = path.join(repo, TASKS, "in-progress", `${id}.md`)

    // The survey must see the real unmerged commit.
    const s = await surveyDeletion(ctxFor(repo), id)
    assert.ok("survey" in s)
    assert.equal(s.survey.unmergedCommits, 1, "one commit exists nowhere else")

    const refused = await deleteTask(ctxFor(repo), id)
    assert.equal(refused.ok, false)
    assert.match(refused.message, /exist nowhere else/)
    assert.ok(fs.existsSync(taskPath), "refusal must leave the task file")
    assert.ok(fs.existsSync(wt), "refusal must leave the worktree")

    const forced = await deleteTask(ctxFor(repo), id, { force: true })
    assert.equal(forced.ok, true, forced.message)
    assert.ok(!fs.existsSync(taskPath), "task file deleted")
    assert.ok(!fs.existsSync(wt), "worktree removed")
    const branches = await git(repo, "branch", "--list", `feature/${id}`)
    assert.equal(branches, "", "branch actually gone")
    // The deletion is committed, not just applied to the working tree.
    const tracked = await git(repo, "ls-tree", "-r", "--name-only", "main")
    assert.ok(!tracked.includes(`${id}.md`), "deletion is committed on main")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("real git: a merged branch needs no force — -d succeeds", async () => {
  const id = "c3d4-merged"
  const repo = await seedRepo("in-progress", id)
  try {
    const wt = await addWorktreeWithCommit(repo, id)
    await git(repo, "merge", "-q", "--no-ff", "-m", "merge", `feature/${id}`)

    const s = await surveyDeletion(ctxFor(repo), id)
    assert.ok("survey" in s)
    assert.equal(s.survey.unmergedCommits, 0, "merged ⇒ nothing would be lost")
    assert.deepEqual(s.survey.blockers, [], "no blockers on a merged branch")

    const r = await deleteTask(ctxFor(repo), id)
    assert.equal(r.ok, true, r.message)
    assert.ok(!fs.existsSync(wt), "worktree removed")
    assert.equal(await git(repo, "branch", "--list", `feature/${id}`), "", "branch deleted with -d")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("real git: a dirty worktree refuses, and force discards it", async () => {
  const id = "e5f6-dirty"
  const repo = await seedRepo("in-progress", id)
  try {
    const wt = await addWorktreeWithCommit(repo, id)
    await git(repo, "merge", "-q", "--no-ff", "-m", "merge", `feature/${id}`) // isolate the dirty blocker
    fs.writeFileSync(path.join(wt, "scratch.txt"), "uncommitted\n")

    const refused = await deleteTask(ctxFor(repo), id)
    assert.equal(refused.ok, false)
    assert.match(refused.message, /uncommitted changes/)
    assert.ok(fs.existsSync(wt), "dirty worktree survives a refusal")

    const forced = await deleteTask(ctxFor(repo), id, { force: true })
    assert.equal(forced.ok, true, forced.message)
    assert.ok(!fs.existsSync(wt), "force discards the dirty worktree")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("real git: a branch checked out in the main tree survives; the task is still deleted", async () => {
  const id = "g7h8-checkedout"
  const repo = await seedRepo("in-progress", id)
  try {
    // Shared-tree shape: no worktree, and the MAIN tree sits on feature/<id>.
    await git(repo, "checkout", "-q", "-b", `feature/${id}`)
    const taskPath = path.join(repo, TASKS, "in-progress", `${id}.md`)

    const r = await deleteTask(ctxFor(repo), id, { force: true })
    assert.equal(r.ok, true, r.message)
    assert.ok(!fs.existsSync(taskPath), "task file deleted")
    // git refuses to delete a checked-out branch even with -D — reported, not fatal.
    assert.match(r.message, /survive/)
    assert.notEqual(await git(repo, "branch", "--list", `feature/${id}`), "", "branch still there")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("real git: a task with no worktree and no branch deletes cleanly", async () => {
  const id = "i9j0-plain"
  const repo = await seedRepo("draft", id)
  try {
    const taskPath = path.join(repo, TASKS, "draft", `${id}.md`)
    const r = await deleteTask(ctxFor(repo), id)
    assert.equal(r.ok, true, r.message)
    assert.ok(!fs.existsSync(taskPath), "task file deleted")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("real git: an epic previews its children and deletes nothing until forced", async () => {
  const epic = "k1l2-epic"
  const repo = await seedRepo("draft", epic, "Slices: one, two", { type: "epic" })
  try {
    const draftDir = path.join(repo, TASKS, "draft")
    for (const child of ["m3n4-one", "o5p6-two"]) {
      fs.writeFileSync(
        path.join(draftDir, `${child}.md`),
        serializeTask({ title: `Child ${child}`, body: `Part of epic: ${epic} (slice 1 of 2)\n` }),
      )
    }
    // A lookalike that must NOT be swept up — different epic id.
    fs.writeFileSync(
      path.join(draftDir, "q7r8-other.md"),
      serializeTask({ title: "Unrelated", body: "Part of epic: zzzz-other (slice 1 of 1)\n" }),
    )
    await git(repo, "add", "-A")
    await git(repo, "commit", "-q", "-m", "seed: slice set")

    const preview = await deleteTask(ctxFor(repo), epic)
    assert.equal(preview.ok, false, "an epic never deletes on the first call")
    assert.match(preview.message, /tracking epic/)
    assert.match(preview.message, /m3n4-one/)
    assert.match(preview.message, /o5p6-two/)
    assert.ok(!preview.message.includes("q7r8-other"), "an unrelated epic's child must not be listed")
    assert.ok(fs.existsSync(path.join(draftDir, `${epic}.md`)), "preview deletes nothing")
    assert.ok(fs.existsSync(path.join(draftDir, "m3n4-one.md")), "preview deletes no children")

    const forced = await deleteTask(ctxFor(repo), epic, { force: true })
    assert.equal(forced.ok, true, forced.message)
    assert.ok(!fs.existsSync(path.join(draftDir, `${epic}.md`)), "epic deleted")
    assert.ok(!fs.existsSync(path.join(draftDir, "m3n4-one.md")), "child one deleted")
    assert.ok(!fs.existsSync(path.join(draftDir, "o5p6-two.md")), "child two deleted")
    assert.ok(fs.existsSync(path.join(draftDir, "q7r8-other.md")), "unrelated task untouched")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("real git: a live loop's task is never deleted, even with force", async () => {
  const id = "s9t0-live"
  const repo = await seedRepo("in-progress", id)
  try {
    const taskPath = path.join(repo, TASKS, "in-progress", `${id}.md`)
    const r = await deleteTask(ctxFor(repo, (x) => x === id), id, { force: true })
    assert.equal(r.ok, false)
    assert.match(r.message, /a loop is driving it/)
    assert.ok(fs.existsSync(taskPath), "the driven task survives")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("real git: a failing pre-commit hook is reported, never passed off as success", async () => {
  const id = "u1v2-hooked"
  const repo = await seedRepo("draft", id)
  try {
    // The deletion stages fine; the commit is what fails.
    const hook = path.join(repo, ".git", "hooks", "pre-commit")
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n")
    fs.chmodSync(hook, 0o755)

    const r = await deleteTask(ctxFor(repo), id)

    assert.equal(r.ok, false, "a failed commit must not report success")
    assert.match(r.message, /STAGED/)
    // The file really is gone and really is staged — the message must say so.
    const status = await sh`git -C ${repo} status --porcelain`.quiet().nothrow()
    assert.match(status.stdout.toString(), /^D /m, "the deletion is staged")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("real git: an on-disk claim blocks deletion from another process, force included", async () => {
  const id = "w3x4-claimed"
  const repo = await seedRepo("in-progress", id)
  try {
    // What a `watch` worker in ANOTHER process leaves behind. No ctx.isDriving
    // is wired here — that is the point: the host callback cannot see it.
    fs.mkdirSync(path.join(repo, TASKS, "in-progress", ".claims", id), { recursive: true })
    const taskPath = path.join(repo, TASKS, "in-progress", `${id}.md`)

    for (const force of [false, true]) {
      const r = await deleteTask(ctxFor(repo), id, { force })
      assert.equal(r.ok, false, `force=${force} must refuse a claimed task`)
      assert.match(r.message, /holds a claim/)
      assert.ok(fs.existsSync(taskPath), `force=${force} must not delete it`)
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("real git: an epic does not cascade into a different epic with a shared id prefix", async () => {
  const epic = "y5z6-auth"
  const repo = await seedRepo("draft", epic, "Slices below.", { type: "epic" })
  try {
    const draftDir = path.join(repo, TASKS, "draft")
    // A SECOND epic whose id starts with the first one's id, and its child.
    fs.writeFileSync(path.join(draftDir, "y5z6-auth-v2.md"), serializeTask({ title: "Auth v2", body: "Slices below.", type: "epic" }))
    fs.writeFileSync(
      path.join(draftDir, "aa11-mine.md"),
      serializeTask({ title: "Mine", body: `Part of epic: ${epic} (slice 1 of 1)\n` }),
    )
    fs.writeFileSync(
      path.join(draftDir, "bb22-theirs.md"),
      serializeTask({ title: "Theirs", body: "Part of epic: y5z6-auth-v2 (slice 1 of 1)\n" }),
    )
    await git(repo, "add", "-A")
    await git(repo, "commit", "-q", "-m", "seed: two epics")

    const s = await surveyDeletion(ctxFor(repo), epic)
    assert.ok("survey" in s)
    assert.deepEqual(
      s.survey.children.map((c) => c.id),
      ["aa11-mine"],
      "a shared id prefix must not pull in the other epic's child",
    )

    const forced = await deleteTask(ctxFor(repo), epic, { force: true })
    assert.equal(forced.ok, true, forced.message)
    assert.ok(fs.existsSync(path.join(draftDir, "bb22-theirs.md")), "the other epic's child survives")
    assert.ok(fs.existsSync(path.join(draftDir, "y5z6-auth-v2.md")), "the other epic survives")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("real git: one blocked child blocks the whole epic cascade", async () => {
  const epic = "c7d8-epic"
  const repo = await seedRepo("draft", epic, "Slices below.", { type: "epic" })
  try {
    const draftDir = path.join(repo, TASKS, "draft")
    fs.writeFileSync(path.join(draftDir, "ee33-one.md"), serializeTask({ title: "One", body: `Part of epic: ${epic} (slice 1 of 1)\n` }))
    await git(repo, "add", "-A")
    await git(repo, "commit", "-q", "-m", "seed: slice")
    // Give the child unmergeable work — the blocker must surface on the EPIC.
    await addWorktreeWithCommit(repo, "ee33-one")

    const preview = await deleteTask(ctxFor(repo), epic)
    assert.equal(preview.ok, false)
    assert.match(preview.message, /ee33-one:.*exist nowhere else/s, "the child's blocker is attributed to it")
    assert.ok(fs.existsSync(path.join(draftDir, "ee33-one.md")), "nothing deleted")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
