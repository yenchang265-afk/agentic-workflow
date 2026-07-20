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

test("classifyBash allows mkdir of canonical status dirs (backlog scaffolding)", () => {
  for (const cmd of [
    "mkdir -p docs/tasks/draft",
    "mkdir docs/tasks/draft",
    "mkdir -p docs/tasks/in-progress",
    "mkdir -p docs/tasks/draft/", // trailing slash
    "mkdir -p ./docs/tasks/draft",
    "mkdir -p /repo/docs/tasks/completed",
    "mkdir -p docs/tasks/draft docs/tasks/queued", // several canonical dirs at once
    "ls docs/tasks && mkdir -p docs/tasks/draft", // read-only + canonical mkdir segments
  ]) {
    assert.equal(classifyBash(cmd, ctx).allow, true, cmd)
  }
})

test("classifyBash still blocks mkdir that isn't a plain canonical status dir", () => {
  for (const cmd of [
    "mkdir docs/tasks/run", // off-canonical folder (a stray)
    "mkdir -p docs/tasks", // the bare backlog root
    "mkdir -p docs/tasks/draft/nested", // deeper than a status dir
    "mkdir -p docs/tasks/in-progress/.claims/a", // a claim marker
    "mkdir -p docs/tasks/draft docs/tasks/run", // one canonical, one stray
    "mkdir -p docs/tasks/draft && rm -rf docs/tasks/queued", // canonical mkdir can't shield a mutation
    "mkdir -p docs/tasks/draft\nmv docs/tasks/a.md docs/tasks/completed/", // …nor across a newline
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

test("classifyBash blocks a mutation chained after a LONE & (background operator)", () => {
  // `&&` was a split point but a single `&` was not, so the read-only globs —
  // compiled with the dotAll flag and ending in `.*` — swallowed everything after
  // it. `ls docs/tasks/queued & rm -rf docs/tasks/queued` matched `^ls.*$` and was
  // ALLOWED, deleting the user's tasks and their audit trail.
  assert.equal(classifyBash("ls docs/tasks/queued & rm -rf docs/tasks/queued", ctx).allow, false)
  assert.equal(classifyBash("cat docs/tasks/queued/a.md & mv b.md docs/tasks/completed/", ctx).allow, false)
  assert.equal(classifyBash("grep -r x docs/tasks & rm docs/tasks/runs/x.json", ctx).allow, false)
  // A trailing `&` on a genuinely read-only command is still fine.
  assert.equal(classifyBash("ls docs/tasks/queued &", ctx).allow, true)
})

test("classifyBash blocks command substitution referencing the backlog", () => {
  // The read-only globs end in `*` and compile with dotAll, so `^cat .*$` matches
  // the whole of `cat docs/tasks/queued/a.md $(rm -rf docs/tasks/in-progress)` —
  // no `>` and no -exec token, so nothing else caught it either.
  assert.equal(classifyBash("cat docs/tasks/queued/a.md $(rm -rf docs/tasks/in-progress)", ctx).allow, false)
  assert.equal(classifyBash("ls $(rm -rf docs/tasks/queued)", ctx).allow, false)
  assert.equal(classifyBash("grep -r x docs/tasks `rm -rf docs/tasks/runs`", ctx).allow, false)
  // Expanded inside double quotes too — only single quotes are inert to bash.
  assert.equal(classifyBash('grep "$(cat docs/tasks/queued/a.md)" src', ctx).allow, false)
})

test("classifyBash still allows a literal $ or parenthesis in a quoted search term", () => {
  assert.equal(classifyBash("grep 'costs $5' docs/tasks", ctx).allow, true)
  assert.equal(classifyBash("grep '$(literal)' docs/tasks", ctx).allow, true)
})

test("classifyBash does not split on & inside a quoted argument", () => {
  // The shared splitter is quote-aware; a literal ampersand in a search term must
  // not fragment the command into bogus segments and cause a false block.
  assert.equal(classifyBash("grep -r 'a & b' docs/tasks", ctx).allow, true)
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

test("classifyBash closes aliased-path bypasses that dodge the literal tasksDir substring", () => {
  for (const cmd of [
    // path split across a `cd` so the literal "docs/tasks" never appears
    "cd docs && mv a.md tasks/queued/b.md",
    "cd docs && cp /tmp/x.md tasks/queued/b.md",
    // quote / backslash insertion that collapses to docs/tasks after normalization
    "mv a.md docs/ta''sks/queued/b.md",
    "cp /tmp/x docs/'tasks'/queued/y",
    "mv a.md docs/ta\\sks/queued/b.md",
    // aliased redirect (the `>` check sits behind the trigger)
    "cat plan.md > tasks/queued/b.md",
  ]) {
    assert.equal(classifyBash(cmd, ctx).allow, false, cmd)
  }
})

test("classifyBash does not false-block an unrelated <base>/<status> file path", () => {
  // `tasks/queued.ts` is a file (no trailing slash), not the backlog's queued/ folder.
  assert.equal(classifyBash("mv src/tasks/queued.ts src/x.ts", ctx).allow, true)
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
