import assert from "node:assert/strict"
import { test } from "node:test"
import { classifyWorktreeBash, isUnderTasksDir } from "./worktree-guard.js"

const WT = "/repo/.loop-worktrees/my-task"

const allow = (cmd: string) => assert.deepEqual(classifyWorktreeBash(cmd, WT), { allow: true }, cmd)
const deny = (cmd: string) => {
  const v = classifyWorktreeBash(cmd, WT)
  assert.equal(v.allow, false, `expected deny: ${cmd}`)
}

// --- pinned chains ---

test("cd into the worktree pins the rest of the chain", () => {
  allow(`cd ${WT} && npm test`)
  allow(`cd ${WT} && npm run build && node --test`)
  allow(`cd ${WT}/src && node --test util.test.ts`)
  allow(`cd "${WT}" && npm test`)
  allow(`cd '${WT}' && sed -i s/a/b/ x.ts`)
})

test("relative cd while pinned stays allowed as long as it cannot escape the worktree", () => {
  allow(`cd ${WT} && cd src && npm test`)
  allow(`cd ${WT}/a && cd ../b && npm test`)
})

test("cd escape out of the worktree blocks the chain", () => {
  deny(`cd ${WT} && cd .. && rm -rf x`)
  deny(`cd ${WT} && cd /repo && npm test`)
  deny(`cd ${WT}/src && cd ../../.. && ls`)
})

// --- unpinned segments ---

test("unpinned mutating commands are blocked with a teaching message", () => {
  const v = classifyWorktreeBash("npm test", WT)
  assert.equal(v.allow, false)
  assert.match((v as { reason: string }).reason, /cd \/repo\/\.loop-worktrees\/my-task && /)
  deny("git add -A")
  deny("sed -i s/a/b/ src/x.ts")
  deny("rm -rf dist")
  deny("touch marker")
  deny("echo hi > out.txt")
  deny(`npm test && cd ${WT} && npm test`)
})

test("cd anywhere outside the worktree is blocked", () => {
  deny("cd /repo && npm test")
  deny("cd src && npm test")
  deny("cd .. && ls")
})

test("git -C into the worktree is allowed unpinned", () => {
  allow(`git -C ${WT} status`)
  allow(`git -C ${WT} add -A`)
  allow(`git -C ${WT}/sub commit -m x`)
  allow(`git -C ${WT} diff && git -C ${WT} log --oneline`)
})

test("git -C outside the worktree is allowed only for reads", () => {
  allow("git -C /repo status")
  allow("git -C /repo log --oneline -5")
  deny("git -C /repo add -A")
  deny("git -C /repo commit -m x")
})

test("read-only inspection commands stay allowed unpinned", () => {
  allow("git status")
  allow("git diff HEAD~1")
  allow("git log --oneline -5")
  allow("git show abc123")
  allow("git blame src/x.ts")
  allow("ls -la")
  allow("pwd")
  allow("cat package.json")
  allow("head -20 src/x.ts")
  allow("tail -50 log.txt")
  allow("grep -rn TODO src")
  allow("rg TODO src")
  allow("find src -name '*.ts'")
  allow("wc -l src/x.ts")
  allow("git status && ls -la")
})

test("read-only shapes that actually mutate are still blocked unpinned", () => {
  deny("find src -name '*.tmp' -delete")
  deny("find src -name '*.ts' -exec rm {} \\;")
  deny("cat a.txt > b.txt")
  deny("ls > listing.txt")
})

test("quoted operators are not split points", () => {
  allow(`cd ${WT} && git commit -m "a && b"`)
  allow(`grep "x && y" src`) // one read-only segment; the quoted && is not a chain
})

test("empty command allows (nothing to run)", () => {
  allow("")
})

// --- isUnderTasksDir ---

test("isUnderTasksDir matches only paths under the worktree's tasksDir copy", () => {
  assert.equal(isUnderTasksDir(`${WT}/docs/tasks/in-progress/my-task.md`, WT, "docs/tasks"), true)
  assert.equal(isUnderTasksDir(`${WT}/docs/tasks`, WT, "docs/tasks"), true)
  assert.equal(isUnderTasksDir(`${WT}/docs/tasksish/x.md`, WT, "docs/tasks"), false)
  assert.equal(isUnderTasksDir(`${WT}/src/x.ts`, WT, "docs/tasks"), false)
  assert.equal(isUnderTasksDir("/repo/docs/tasks/in-progress/my-task.md", WT, "docs/tasks"), false)
})
