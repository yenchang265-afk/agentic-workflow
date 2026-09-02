import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  addWorktree,
  branchExists,
  CHECKPOINT_BLOB_MAX,
  commitAll,
  defaultBranchName,
  diffShortstat,
  headSha,
  listWorktrees,
  pushBranch,
  screenCheckpoint,
  screenedWarning,
  secretShapedPath,
  sweptPaths,
  worktreeForBranch,
} from "./git.js"

/**
 * git.ts shells out via Bun's `$` (redirections, quoting) which the node+tsx
 * test runner can't execute. These tests inject a fake `$` that records the
 * reconstructed command and returns canned output — enough to cover the arg
 * construction and porcelain parsing (the bug-prone logic). Real end-to-end
 * worktree creation is a manual/e2e checklist item (see docs/design/improvements/01).
 */
type FakeResult = { exitCode?: number; stdout?: string; stderr?: string }

const makeShell = (handler: (cmd: string) => FakeResult, log?: string[]) => {
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) {
        const e = exprs[i]
        cmd += Array.isArray(e) ? e.join(" ") : String(e)
      }
    })
    cmd = cmd.trim().replace(/\s+/g, " ")
    log?.push(cmd)
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const r = handler(cmd)
        return Promise.resolve({
          exitCode: r.exitCode ?? 0,
          stdout: { toString: () => r.stdout ?? "" },
          stderr: { toString: () => r.stderr ?? "" },
        }).then(resolve, reject)
      },
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((strings: TemplateStringsArray, ...exprs: unknown[]) => build(strings, exprs)) as any
}

const PORCELAIN = [
  "worktree /repo",
  "HEAD abc123",
  "branch refs/heads/main",
  "",
  "worktree /repo/.workflow-worktrees/add-foo",
  "HEAD def456",
  "branch refs/heads/feature/add-foo",
  "",
  "worktree /repo/detached",
  "HEAD 999aaa",
  "detached",
  "",
].join("\n")

/** A worktree whose directory was deleted: git keeps the registration and marks it prunable. */
const PORCELAIN_PRUNABLE = [
  "worktree /repo",
  "HEAD abc123",
  "branch refs/heads/main",
  "",
  "worktree /repo/.workflow-worktrees/gone",
  "HEAD def456",
  "branch refs/heads/feature/gone",
  "prunable gitdir file points to non-existent location",
  "",
].join("\n")

/** The screen's status probe always runs first; a clean tree screens nothing. */
const STATUS_PROBE = "git -C /wt status --porcelain -z --untracked-files=all"

test("commitAll screens first, then stages everything by default and applies :(exclude) pathspecs when given", async () => {
  const plain: string[] = []
  const r = await commitAll(makeShell(() => ({ exitCode: 0 }), plain), "/wt", "msg")
  assert.equal(plain[0], STATUS_PROBE)
  assert.equal(plain[1], "git -C /wt add -A")
  assert.deepEqual(r, { committed: true, screened: [] })

  const excluded: string[] = []
  await commitAll(makeShell(() => ({ exitCode: 0 }), excluded), "/wt", "msg", ["docs/tasks"])
  assert.equal(excluded[1], "git -C /wt add -A -- . :(exclude)docs/tasks")
  assert.equal(excluded[2], "git -C /wt commit -m msg")

  const empty: string[] = []
  await commitAll(makeShell(() => ({ exitCode: 0 }), empty), "/wt", "msg", [])
  assert.equal(empty[1], "git -C /wt add -A")
})

test("commitAll keeps secret-shaped paths out of the sweep as literal excludes and reports them", async () => {
  // A porcelain entry starts with its XY code — ` M` has a leading SPACE, which
  // the trimming `run` helper would eat; the screen must read it raw.
  const porcelain = ["?? .env", "?? src/new.ts", " M src/x.ts", "?? certs/server.pem", " D gone.txt", "?? .env.example"].join("\u0000") + "\u0000"
  const log: string[] = []
  const shell = makeShell((cmd) => (cmd.startsWith(STATUS_PROBE) ? { exitCode: 0, stdout: porcelain } : { exitCode: 0 }), log)
  const r = await commitAll(shell, "/wt", "msg", ["docs/tasks"])
  assert.deepEqual(r.screened, [
    { path: ".env", why: "secret-shaped" },
    { path: "certs/server.pem", why: "secret-shaped" },
  ])
  assert.equal(r.committed, true)
  assert.equal(log[1], "git -C /wt add -A -- . :(exclude)docs/tasks :(exclude,literal).env :(exclude,literal)certs/server.pem")
  assert.match(screenedWarning(r.screened)!, /2 paths kept out of the automatic sweep — \.env \(secret-shaped\), certs\/server\.pem \(secret-shaped\)/)
  assert.match(screenedWarning(r.screened)!, /git add <path>/)
  assert.equal(screenedWarning([]), null)
})

test("commitAll's screen fails toward the sweep: a failed status probe screens nothing", async () => {
  const log: string[] = []
  const shell = makeShell((cmd) => (cmd.startsWith(STATUS_PROBE) ? { exitCode: 128, stderr: "not a git repo" } : { exitCode: 0 }), log)
  const r = await commitAll(shell, "/wt", "msg")
  assert.deepEqual(r, { committed: true, screened: [] })
  assert.equal(log[1], "git -C /wt add -A")
})

test("sweptPaths reads porcelain -z: deletions skipped, rename sources consumed, XY codes never mistaken for the path", () => {
  const z = ["?? a.txt", " M b.txt", "R  new.txt", "old.txt", " D c.txt", "D  d.txt", "A  e.txt", "MM f g.txt"].join("\u0000") + "\u0000"
  assert.deepEqual(sweptPaths(z), ["a.txt", "b.txt", "new.txt", "e.txt", "f g.txt"])
  assert.deepEqual(sweptPaths(""), [])
})

test("secretShapedPath judges the basename: keys, keystores, dotenv, ssh keys, credential files — never the doc conventions", () => {
  for (const p of [".env", ".env.local", ".env.production", "a/b/.env", "certs/x.pem", "x.key", "k.p12", "k.pfx", "app.jks", "~/id_rsa", ".ssh/id_ed25519", "credentials.json", "service-account-prod.json", "client_secret_123.json", ".netrc", ".git-credentials", "infra/terraform.tfstate", "x.tfstate.backup", "secret.gpg", "C:\\repo\\.env"]) {
    assert.equal(secretShapedPath(p), true, p)
  }
  for (const p of [".env.example", ".env.sample", ".env.template", ".env.dist", ".env.defaults", "id_rsa.pub", "src/env.ts", "README.md", "keys.ts", "package.json", ".npmrc", "pemfile.txt", ""]) {
    assert.equal(secretShapedPath(p), false, p)
  }
})

test("screenCheckpoint sizes the swept files and refuses a blob over CHECKPOINT_BLOB_MAX", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-ckpt-"))
  fs.writeFileSync(path.join(dir, "small.bin"), Buffer.alloc(1024))
  fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(CHECKPOINT_BLOB_MAX + 1))
  const porcelain = ["?? small.bin", "?? big.bin", "?? missing.bin"].join("\u0000") + "\u0000"
  const shell = makeShell((cmd) => (cmd.includes("status --porcelain") ? { exitCode: 0, stdout: porcelain } : { exitCode: 0 }))
  try {
    assert.deepEqual(await screenCheckpoint(shell, dir), [{ path: "big.bin", why: "oversized" }])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("branchExists maps a zero exit code to true", async () => {
  const yes = makeShell(() => ({ exitCode: 0 }))
  const no = makeShell(() => ({ exitCode: 1 }))
  assert.equal(await branchExists(yes, "/repo", "feature/x"), true)
  assert.equal(await branchExists(no, "/repo", "feature/x"), false)
})

test("listWorktrees parses porcelain stanzas, including a detached entry", async () => {
  const $ = makeShell(() => ({ exitCode: 0, stdout: PORCELAIN }))
  const entries = await listWorktrees($, "/repo")
  assert.deepEqual(entries, [
    { path: "/repo", branch: "main", prunable: false },
    { path: "/repo/.workflow-worktrees/add-foo", branch: "feature/add-foo", prunable: false },
    { path: "/repo/detached", branch: null, prunable: false },
  ])
})

test("listWorktrees flags a prunable (vanished) worktree", async () => {
  const $ = makeShell(() => ({ exitCode: 0, stdout: PORCELAIN_PRUNABLE }))
  assert.deepEqual(await listWorktrees($, "/repo"), [
    { path: "/repo", branch: "main", prunable: false },
    { path: "/repo/.workflow-worktrees/gone", branch: "feature/gone", prunable: true },
  ])
})

test("worktreeForBranch ignores a prunable registration", async () => {
  // Adopting a vanished worktree as live isolation pins the whole stage to a cwd
  // that no longer exists — every command and the closing `git add -A` checkpoint
  // run in a missing directory. Returning null lets ensureIsolation recreate it.
  const $ = makeShell(() => ({ exitCode: 0, stdout: PORCELAIN_PRUNABLE }))
  assert.equal(await worktreeForBranch($, "/repo", "feature/gone"), null)
})

test("listWorktrees returns [] when the command fails", async () => {
  const $ = makeShell(() => ({ exitCode: 128, stderr: "not a git repo" }))
  assert.deepEqual(await listWorktrees($, "/nope"), [])
})

test("worktreeForBranch finds the matching worktree path", async () => {
  const $ = makeShell(() => ({ exitCode: 0, stdout: PORCELAIN }))
  assert.equal(await worktreeForBranch($, "/repo", "feature/add-foo"), "/repo/.workflow-worktrees/add-foo")
  assert.equal(await worktreeForBranch($, "/repo", "feature/missing"), null)
})

test("addWorktree creates a new branch with -b when the branch is absent", async () => {
  const log: string[] = []
  const $ = makeShell((cmd) => (cmd.includes("rev-parse --verify") ? { exitCode: 1 } : { exitCode: 0 }), log)
  const added = await addWorktree($, "/repo", "/wt/add-foo", "feature/add-foo", "main")
  assert.deepEqual(added, { ok: true, error: "" })
  assert.ok(log.some((c) => c.includes("worktree add -b feature/add-foo /wt/add-foo main")))
})

test("addWorktree reuses an existing branch without -b (never resets it)", async () => {
  const log: string[] = []
  const $ = makeShell((cmd) => (cmd.includes("rev-parse --verify") ? { exitCode: 0 } : { exitCode: 0 }), log)
  const added = await addWorktree($, "/repo", "/wt/add-foo", "feature/add-foo", "main")
  assert.equal(added.ok, true)
  assert.ok(log.some((c) => c.includes("worktree add /wt/add-foo feature/add-foo")))
  assert.ok(!log.some((c) => c.includes("worktree add -b")))
})

// The reason a worktree add failed is the only actionable part of the error the
// caller throws — it used to be dropped, leaving "could not create worktree X" alone.
test("addWorktree surfaces git's stderr on failure", async () => {
  const $ = makeShell((cmd) =>
    cmd.includes("rev-parse --verify")
      ? { exitCode: 0 }
      : { exitCode: 128, stderr: "fatal: '/wt/add-foo' already exists\n" },
  )
  const added = await addWorktree($, "/repo", "/wt/add-foo", "feature/add-foo", "main")
  assert.deepEqual(added, { ok: false, error: "fatal: '/wt/add-foo' already exists" })
})

test("pushBranch pushes to origin with -u", async () => {
  const log: string[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), log)
  const ok = await pushBranch($, "/repo", "feature/add-foo")
  assert.equal(ok, true)
  assert.ok(log.some((c) => c.includes("push -u origin feature/add-foo")))
})

test("pushBranch returns false when the push fails", async () => {
  const $ = makeShell(() => ({ exitCode: 1, stderr: "rejected" }))
  assert.equal(await pushBranch($, "/repo", "feature/add-foo"), false)
})

test("headSha returns the commit HEAD points at", async () => {
  const $ = makeShell(() => ({ exitCode: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n" }))
  assert.equal(await headSha($, "/repo"), "0123456789abcdef0123456789abcdef01234567")
})

test("headSha returns null on an empty repo, and on anything that isn't a sha", async () => {
  assert.equal(await headSha(makeShell(() => ({ exitCode: 128, stderr: "fatal: bad revision 'HEAD'" })), "/repo"), null)
  // The shape is validated, not trusted: this value reaches a composed prompt
  // and a `git diff`, so stray chatter must read as "no sha", not ride along.
  assert.equal(await headSha(makeShell(() => ({ exitCode: 0, stdout: "warning: something\nabc123" })), "/repo"), null)
})

test("defaultBranchName prefers origin/HEAD, then init.defaultBranch, then null — never the network", async () => {
  const log: string[] = []
  const fromRemote = makeShell(
    (cmd) => (cmd.includes("symbolic-ref") ? { exitCode: 0, stdout: "refs/remotes/origin/trunk" } : { exitCode: 0, stdout: "nope" }),
    log,
  )
  assert.equal(await defaultBranchName(fromRemote, "/repo"), "trunk")

  const fromConfig = makeShell((cmd) =>
    cmd.includes("symbolic-ref") ? { exitCode: 1 } : { exitCode: 0, stdout: "mainline" },
  )
  assert.equal(await defaultBranchName(fromConfig, "/repo"), "mainline")

  assert.equal(await defaultBranchName(makeShell(() => ({ exitCode: 1 })), "/repo"), null)
  // It gates every fresh BUILD, so it must never pay a round trip.
  assert.ok(!log.some((c) => c.includes("gh ")), log.join(" | "))
})

test("diffShortstat returns the validated one-line summary of base...branch", async () => {
  const $ = makeShell((cmd) =>
    cmd === "git -C /repo diff --shortstat main...feature/x"
      ? { stdout: " 3 files changed, 40 insertions(+), 2 deletions(-)\n" }
      : { exitCode: 1 },
  )
  assert.equal(await diffShortstat($, "/repo", "main", "feature/x"), "3 files changed, 40 insertions(+), 2 deletions(-)")
})

test("diffShortstat reads an empty diff, a failure, and git chatter all as null", async () => {
  // Null degrades to "no stat clause on the note" — the pre-clause behavior —
  // so anything that is not the shortstat shape must land there, never ride
  // into an audit line downstream parsers anchor on.
  assert.equal(await diffShortstat(makeShell(() => ({ stdout: "" })), "/repo", "a", "b"), null)
  assert.equal(await diffShortstat(makeShell(() => ({ exitCode: 1, stdout: "1 file changed" })), "/repo", "a", "b"), null)
  assert.equal(await diffShortstat(makeShell(() => ({ stdout: "warning: refname 'b' is ambiguous" })), "/repo", "a", "b"), null)
  // Singular forms and a missing insertions/deletions half are all real git output.
  assert.equal(await diffShortstat(makeShell(() => ({ stdout: " 1 file changed, 1 insertion(+)" })), "/repo", "a", "b"), "1 file changed, 1 insertion(+)")
  assert.equal(await diffShortstat(makeShell(() => ({ stdout: " 2 files changed, 3 deletions(-)" })), "/repo", "a", "b"), "2 files changed, 3 deletions(-)")
})
