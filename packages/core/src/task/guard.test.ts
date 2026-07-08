import assert from "node:assert/strict"
import { test } from "node:test"
import { backlogRelPath, classifyBash, classifyEdit, classifyMutation } from "./guard.js"

const ctx = { tasksDir: "docs/tasks" }
const planCtx = { tasksDir: "docs/tasks", planTaskId: "my-task" }

// --- backlogRelPath ---

test("backlogRelPath extracts the backlog-relative remainder for relative and absolute paths", () => {
  assert.equal(backlogRelPath("docs/tasks/draft/a.md", "docs/tasks"), "draft/a.md")
  assert.equal(backlogRelPath("/repo/docs/tasks/queued/b.md", "docs/tasks"), "queued/b.md")
  assert.equal(backlogRelPath("/repo/.claude/worktrees/x/docs/tasks/completed/c.md", "docs/tasks"), "completed/c.md")
})

test("backlogRelPath is null outside the backlog and does not false-match lookalikes", () => {
  assert.equal(backlogRelPath("src/index.ts", "docs/tasks"), null)
  assert.equal(backlogRelPath("/repo/mydocs/tasksy/a.md", "docs/tasks"), null)
  assert.equal(backlogRelPath("/repo/docs/tasks", "docs/tasks"), null)
})

// --- classifyEdit ---

test("classifyEdit allows files outside the backlog", () => {
  assert.deepEqual(classifyEdit("/repo/src/app.ts", ctx), { allow: true })
})

test("classifyEdit allows authoring drafts", () => {
  assert.deepEqual(classifyEdit("/repo/docs/tasks/draft/new-idea.md", ctx), { allow: true })
})

test("classifyEdit blocks status folders, runs/, and unknown dirs", () => {
  for (const p of [
    "/repo/docs/tasks/queued/a.md",
    "/repo/docs/tasks/completed/a.md",
    "/repo/docs/tasks/in-progress/a.md",
    "/repo/docs/tasks/runs/a.md",
    "/repo/docs/tasks/run/a.md",
    "/repo/docs/tasks/stray.md",
    "/repo/docs/tasks/draft/nested/a.md",
    "/repo/docs/tasks/draft/notes.txt",
  ]) {
    assert.equal(classifyEdit(p, ctx).allow, false, p)
  }
})

test("classifyEdit allows the live PLAN stage to write its own queued task only", () => {
  assert.equal(classifyEdit("/repo/docs/tasks/queued/my-task.md", planCtx).allow, true)
  assert.equal(classifyEdit("/repo/docs/tasks/queued/other.md", planCtx).allow, false)
  assert.equal(classifyEdit("/repo/docs/tasks/queued/my-task.md", ctx).allow, false)
})

// --- classifyBash ---

test("classifyBash allows commands that never reference the backlog", () => {
  assert.equal(classifyBash("mv src/a.ts src/b.ts", ctx).allow, true)
  assert.equal(classifyBash("rm -rf node_modules", ctx).allow, true)
})

test("classifyBash allows read-only commands against the backlog", () => {
  for (const cmd of [
    "ls docs/tasks/queued",
    "cat docs/tasks/queued/a.md",
    "grep -r 'plan' docs/tasks",
    "rg TODO docs/tasks/in-progress",
    "find docs/tasks -name '*.md'",
    "git diff docs/tasks",
    "git log --oneline docs/tasks/completed/a.md",
    "cat docs/tasks/queued/a.md | head -20",
    "ls docs/tasks/draft && ls docs/tasks/queued",
  ]) {
    assert.equal(classifyBash(cmd, ctx).allow, true, cmd)
  }
})

test("classifyBash blocks mutations of the backlog", () => {
  for (const cmd of [
    "mv docs/tasks/draft/a.md docs/tasks/completed/a.md",
    "mkdir docs/tasks/run",
    "rm docs/tasks/queued/a.md",
    "rmdir docs/tasks/in-progress/.claims/a",
    "touch docs/tasks/queued/new.md",
    "sed -i 's/x/y/' docs/tasks/queued/a.md",
    "echo done | tee docs/tasks/completed/a.md",
    "cp task.md docs/tasks/completed/",
    "bash -c 'mv docs/tasks/draft/a.md docs/tasks/queued/'",
  ]) {
    assert.equal(classifyBash(cmd, ctx).allow, false, cmd)
  }
})

test("classifyBash blocks redirects and compound-command escapes referencing the backlog", () => {
  assert.equal(classifyBash("cat plan.md > docs/tasks/queued/a.md", ctx).allow, false)
  assert.equal(classifyBash("printf 'x' >> docs/tasks/queued/a.md", ctx).allow, false)
  assert.equal(classifyBash("ls docs/tasks && mv a.md docs/tasks/completed/", ctx).allow, false)
  assert.equal(classifyBash("find docs/tasks -name '*.md' -exec rm {} +", ctx).allow, false)
  assert.equal(classifyBash("find docs/tasks -name '*.md' -delete", ctx).allow, false)
})

test("classifyBash blocks a mutation on a later LINE, even after a read-only first line", () => {
  // A newline is not a segment separator to the shell's `;`/`&&` matcher, and the
  // read-only globs compile with the dotAll flag — so a leading `ls`/`cat` line must
  // not be allowed to "swallow" a following `rm`/`mv` across the newline.
  assert.equal(classifyBash("ls docs/tasks/queued\nrm -rf docs/tasks/queued", ctx).allow, false)
  assert.equal(classifyBash("cat docs/tasks/x\nmv docs/tasks/a.md docs/tasks/completed/", ctx).allow, false)
  assert.equal(classifyBash("ls docs/tasks/queued\r\nrm -rf docs/tasks/queued", ctx).allow, false)
  // A genuinely all-read-only multi-line command still passes.
  assert.equal(classifyBash("ls docs/tasks/queued\ncat docs/tasks/queued/a.md", ctx).allow, true)
})

// --- classifyMutation routing ---

test("classifyMutation routes edit-shaped tools by filePath and Bash by command", () => {
  assert.equal(classifyMutation("Write", { filePath: "/repo/docs/tasks/completed/a.md" }, ctx).allow, false)
  assert.equal(classifyMutation("Edit", { filePath: "/repo/docs/tasks/draft/a.md" }, ctx).allow, true)
  assert.equal(classifyMutation("multiedit", { filePath: "/repo/docs/tasks/runs/a.md" }, ctx).allow, false)
  assert.equal(classifyMutation("Bash", { command: "mkdir docs/tasks/run" }, ctx).allow, false)
  assert.equal(classifyMutation("Bash", { command: "ls docs/tasks" }, ctx).allow, true)
})

test("classifyMutation allows unknown tools and missing args", () => {
  assert.equal(classifyMutation("Read", { filePath: "/repo/docs/tasks/completed/a.md" }, ctx).allow, true)
  assert.equal(classifyMutation("Bash", {}, ctx).allow, true)
  assert.equal(classifyMutation("Write", {}, ctx).allow, true)
})
