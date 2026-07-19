import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "../config.js"
import { deleteTask, parseDeleteArgs, surveyDeletion } from "./delete.js"
import type { GateCtx } from "./gate.js"

/**
 * Same fake-`$` harness as isolate.test.ts: the node+tsx runner can't run Bun's
 * `$`, so inject a shell that records each reconstructed command and returns
 * canned results. Here the command LOG is the assertion surface — the most
 * important cases prove that a refusal issued no mutating command at all.
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

const DIR = "/repo"
const TASKS = "docs/tasks"
const WT = "/repo/.wt/f7k3-add-foo"
const ID = "f7k3-add-foo"
const FILE = `${DIR}/${TASKS}/in-progress/${ID}.md`

const taskFile = (title: string, extra = "", body = "") =>
  `---\ntitle: ${title}\npriority: 1\nacceptance:\n  - it works\n${extra}---\n\n${body}\n`

/**
 * Canned git for a task in `in-progress/` with a worktree and a branch.
 * Knobs cover each blocker independently.
 */
const gitHandler = (opts: {
  dirty?: boolean
  unmerged?: string
  unmergedFails?: boolean
  branchMissing?: boolean
  noWorktree?: boolean
  wtRemoveFails?: boolean
  branchDeleteFails?: boolean
  mainTreeOnBranch?: boolean
  fileContent?: string
  repo?: boolean
}) => (cmd: string): FakeResult => {
  if (cmd.includes("is-inside-work-tree")) {
    if (cmd.includes(WT)) return { exitCode: opts.noWorktree ? 1 : 0 }
    return { exitCode: opts.repo === false ? 1 : 0 }
  }
  if (cmd.includes("worktree list")) {
    if (opts.noWorktree) return { exitCode: 0, stdout: "" }
    const at = opts.mainTreeOnBranch ? DIR : WT
    return { exitCode: 0, stdout: `worktree ${DIR}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${at}\nHEAD def\nbranch refs/heads/feature/${ID}\n` }
  }
  if (cmd.includes("rev-parse --verify")) return { exitCode: opts.branchMissing ? 1 : 0 }
  if (cmd.includes("status --porcelain")) return { exitCode: 0, stdout: opts.dirty ? " M src/a.ts" : "" }
  if (cmd.includes("rev-list --count")) {
    if (opts.unmergedFails) return { exitCode: 1 }
    return { exitCode: 0, stdout: opts.unmerged ?? "0" }
  }
  if (cmd.includes("worktree remove")) return { exitCode: opts.wtRemoveFails ? 1 : 0 }
  if (cmd.startsWith("git -C /repo branch ")) return { exitCode: opts.branchDeleteFails ? 1 : 0 }
  // The task file: `cat` for lookups, `test -e` for the post-delete assertion.
  if (cmd.startsWith("cat ")) {
    if (cmd.includes(`/in-progress/${ID}.md`)) return { exitCode: 0, stdout: opts.fileContent ?? taskFile("Add foo") }
    return { exitCode: 1 }
  }
  if (cmd.startsWith("ls ")) {
    if (cmd.includes("in-progress")) return { exitCode: 0, stdout: `${ID}.md\n` }
    return { exitCode: 0, stdout: "" }
  }
  if (cmd.includes("test -e")) return { exitCode: 1 } // gone after delete
  return { exitCode: 0 }
}

const makeCtx = (handler: (cmd: string) => FakeResult, log: string[], isDriving?: (id: string) => boolean): GateCtx => {
  const $ = makeShell(handler, log)
  return {
    $,
    // `listByStatus` reads through the host client; only the epic cascade uses it.
    client: { file: { read: async () => ({ data: { content: "" } }) } } as never,
    log: async () => {},
    directory: DIR,
    config: { ...DEFAULT_CONFIG, tasksDir: TASKS, worktreesDir: ".wt" },
    ...(isDriving ? { isDriving } : {}),
  }
}

/** Commands that change state — a refusal must issue none of them. */
const MUTATING = ["worktree remove", "branch -d", "branch -D", "git -C /repo rm", "rm -f", "commit"]
const mutations = (log: string[]): string[] => log.filter((c) => MUTATING.some((m) => c.includes(m)))

test("parseDeleteArgs accepts every force spelling", () => {
  assert.deepEqual(parseDeleteArgs("f7k3"), { id: "f7k3", force: false })
  assert.deepEqual(parseDeleteArgs("f7k3 force"), { id: "f7k3", force: true })
  assert.deepEqual(parseDeleteArgs("--force f7k3"), { id: "f7k3", force: true })
  assert.deepEqual(parseDeleteArgs("f7k3 --force"), { id: "f7k3", force: true })
  assert.deepEqual(parseDeleteArgs("  "), { id: "", force: false })
})

test("clean worktree + merged branch: removes worktree without --force, deletes with -d", async () => {
  const log: string[] = []
  const r = await deleteTask(makeCtx(gitHandler({}), log), ID)
  assert.equal(r.ok, true)
  assert.ok(log.some((c) => c.includes(`worktree remove ${WT}`)), "removed the worktree")
  assert.ok(!log.some((c) => c.includes("--force")), "no --force on a clean delete")
  assert.ok(log.some((c) => c.includes(`branch -d feature/${ID}`)), "deleted the branch with -d")
  assert.ok(log.some((c) => c.includes("commit")), "committed the removal")
})

test("no worktree and no branch: still deletes the file, issues no git worktree/branch commands", async () => {
  const log: string[] = []
  const r = await deleteTask(makeCtx(gitHandler({ noWorktree: true, branchMissing: true }), log), ID)
  assert.equal(r.ok, true)
  assert.ok(!log.some((c) => c.includes("worktree remove")), "nothing to remove")
  assert.ok(!log.some((c) => c.includes("branch -")), "no branch to delete")
  assert.ok(log.some((c) => c.includes("git -C /repo rm")), "file still removed")
})

test("refuses a dirty worktree and mutates NOTHING", async () => {
  const log: string[] = []
  const r = await deleteTask(makeCtx(gitHandler({ dirty: true }), log), ID)
  assert.equal(r.ok, false)
  assert.match(r.message, /uncommitted changes/)
  assert.match(r.message, /force/)
  assert.deepEqual(mutations(log), [], "a refusal must issue no mutating command")
})

test("refuses unmerged commits and mutates NOTHING", async () => {
  const log: string[] = []
  const r = await deleteTask(makeCtx(gitHandler({ unmerged: "3" }), log), ID)
  assert.equal(r.ok, false)
  assert.match(r.message, /3 commit\(s\) that exist nowhere else/)
  assert.deepEqual(mutations(log), [])
})

test("undeterminable unmerged count is treated as unsafe", async () => {
  const log: string[] = []
  const r = await deleteTask(makeCtx(gitHandler({ unmergedFails: true }), log), ID)
  assert.equal(r.ok, false)
  assert.match(r.message, /could not determine/)
  assert.deepEqual(mutations(log), [])
})

test("force discards a dirty worktree and unmerged commits with --force / -D", async () => {
  const log: string[] = []
  const r = await deleteTask(makeCtx(gitHandler({ dirty: true, unmerged: "3" }), log), ID, { force: true })
  assert.equal(r.ok, true)
  assert.ok(log.some((c) => c.includes(`worktree remove --force ${WT}`)), "forced worktree removal")
  assert.ok(log.some((c) => c.includes(`branch -D feature/${ID}`)), "forced branch deletion")
})

test("a live loop's task is never deleted — even with force", async () => {
  for (const force of [false, true]) {
    const log: string[] = []
    const r = await deleteTask(makeCtx(gitHandler({}), log, (x) => x === ID), ID, { force })
    assert.equal(r.ok, false, `force=${force} must refuse`)
    assert.match(r.message, /a loop is driving it/)
    assert.deepEqual(mutations(log), [], `force=${force} must mutate nothing`)
  }
})

test("worktree removal failure aborts before the file is touched", async () => {
  const log: string[] = []
  const r = await deleteTask(makeCtx(gitHandler({ wtRemoveFails: true }), log), ID)
  assert.equal(r.ok, false)
  assert.match(r.message, /could not be removed/)
  assert.ok(!log.some((c) => c.includes("git -C /repo rm")), "file must survive")
  assert.ok(!log.some((c) => c.includes("commit")), "nothing committed")
})

test("branch deletion failure is non-fatal — file still deleted, branch reported", async () => {
  const log: string[] = []
  const r = await deleteTask(makeCtx(gitHandler({ branchDeleteFails: true }), log), ID)
  assert.equal(r.ok, true)
  assert.ok(log.some((c) => c.includes("git -C /repo rm")), "file removed anyway")
  assert.match(r.message, /survive/)
  assert.deepEqual(r.ok && r.data.survivingBranches, [`feature/${ID}`])
})

test("never removes the main tree, even when it is checked out on the task branch", async () => {
  const log: string[] = []
  const r = await deleteTask(makeCtx(gitHandler({ mainTreeOnBranch: true }), log), ID, { force: true })
  assert.equal(r.ok, true)
  assert.ok(!log.some((c) => c.includes(`worktree remove --force ${DIR} `) || c.endsWith(`worktree remove --force ${DIR}`)), "must never remove the main tree")
})

test("outside a git repo: plain rm, no git commands, still succeeds", async () => {
  const log: string[] = []
  const r = await deleteTask(makeCtx(gitHandler({ repo: false, noWorktree: true, branchMissing: true }), log), ID)
  assert.equal(r.ok, true)
  assert.ok(log.some((c) => c.includes(`rm -f ${FILE}`)), "fell back to a plain rm")
  assert.ok(!log.some((c) => c.includes("worktree remove")), "no git worktree work")
})

test("unknown id refuses", async () => {
  const log: string[] = []
  const handler = (cmd: string): FakeResult => {
    if (cmd.startsWith("cat ") || cmd.startsWith("ls ")) return { exitCode: 1 }
    return gitHandler({})(cmd)
  }
  const r = await deleteTask(makeCtx(handler, log), "nope")
  assert.equal(r.ok, false)
  assert.match(r.message, /No task/)
  assert.deepEqual(mutations(log), [])
})

test("surveyDeletion reports what would be lost without mutating", async () => {
  const log: string[] = []
  const s = await surveyDeletion(makeCtx(gitHandler({ dirty: true, unmerged: "2" }), log), ID)
  assert.ok("survey" in s)
  assert.equal(s.survey.worktreeDirty, true)
  assert.equal(s.survey.unmergedCommits, 2)
  assert.equal(s.survey.blockers.length, 2)
  assert.deepEqual(mutations(log), [], "a survey is read-only")
})
