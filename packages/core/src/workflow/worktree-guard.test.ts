import assert from "node:assert/strict"
import { test } from "node:test"
import { classifyWorktreeBash, isUnderTasksDir, pinBash, pinEditPath } from "./worktree-guard.js"

const DIR = "/repo"
const WT = "/repo/.workflow-worktrees/my-task"
const TASKS = "docs/tasks"

const allow = (cmd: string) => assert.deepEqual(pinBash(cmd, WT), { action: "allow" }, cmd)
const rewritten = (cmd: string) => {
  const v = pinBash(cmd, WT)
  assert.equal(v.action, "rewrite", `expected rewrite: ${cmd}`)
  return (v as { value: string }).value
}
const blocked = (cmd: string) => {
  const v = pinBash(cmd, WT)
  assert.equal(v.action, "block", `expected block: ${cmd}`)
  return (v as { reason: string }).reason
}

// --- pinned chains run untouched ---

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

test("git -C into the worktree is allowed unpinned", () => {
  allow(`git -C ${WT} status`)
  allow(`git -C ${WT} add -A`)
  allow(`git -C ${WT}/sub commit -m x`)
  allow(`git -C ${WT} diff && git -C ${WT} log --oneline`)
})

test("read-only inspection commands stay allowed unpinned", () => {
  for (const cmd of [
    "git status",
    "git diff HEAD~1",
    "git log --oneline -5",
    "git show abc123",
    "git blame src/x.ts",
    "ls -la",
    "pwd",
    "cat package.json",
    "head -20 src/x.ts",
    "tail -50 log.txt",
    "grep -rn TODO src",
    "rg TODO src",
    "find src -name '*.ts'",
    "wc -l src/x.ts",
    "git status && ls -la",
    "git -C /repo status",
    "git -C /repo log --oneline -5",
  ]) {
    allow(cmd)
  }
})

test("quoted operators are not split points", () => {
  allow(`cd ${WT} && git commit -m "a && b"`)
  allow(`grep "x && y" src`) // one read-only segment; the quoted && is not a chain
})

test("empty command allows (nothing to run)", () => {
  allow("")
  allow("   ")
})

// --- unpinned but harmless: corrected, not refused ---

test("an unpinned command is rewritten with the cd prefix instead of blocked", () => {
  assert.equal(rewritten("npm test"), `cd ${WT} && npm test`)
  assert.equal(rewritten("git add -A"), `cd ${WT} && git add -A`)
  assert.equal(rewritten("sed -i s/a/b/ src/x.ts"), `cd ${WT} && sed -i s/a/b/ src/x.ts`)
  assert.equal(rewritten("rm -rf dist"), `cd ${WT} && rm -rf dist`)
  assert.equal(rewritten("touch marker"), `cd ${WT} && touch marker`)
  assert.equal(rewritten("echo hi > out.txt"), `cd ${WT} && echo hi > out.txt`)
  assert.equal(rewritten("cat a.txt > b.txt"), `cd ${WT} && cat a.txt > b.txt`)
  assert.equal(rewritten("find src -name '*.tmp' -delete"), `cd ${WT} && find src -name '*.tmp' -delete`)
})

test("a relative cd is a missing prefix, not an escape — it is rewritten", () => {
  assert.equal(rewritten("cd src && npm test"), `cd ${WT} && cd src && npm test`)
})

test("a partially pinned chain is prefixed so its first segment lands inside too", () => {
  assert.equal(rewritten(`npm test && cd ${WT} && npm test`), `cd ${WT} && npm test && cd ${WT} && npm test`)
})

test("worktree paths containing spaces are quoted in the rewrite", () => {
  const spaced = "/mnt/c/Claude Code/repo/.workflow-worktrees/t1"
  const v = pinBash("npm test", spaced)
  assert.deepEqual(v, { action: "rewrite", value: `cd "${spaced}" && npm test` })
})

// --- unconditional escapes: still blocked ---

test("cd outside the worktree blocks the chain", () => {
  blocked("cd /repo && npm test")
  blocked("cd .. && ls")
  blocked(`cd ${WT} && cd .. && rm -rf x`)
  blocked(`cd ${WT} && cd /repo && npm test`)
  blocked(`cd ${WT}/src && cd ../../.. && ls`)
})

test("a mutating git -C outside the worktree is blocked, reads are not", () => {
  blocked("git -C /repo add -A")
  blocked("git -C /repo commit -m x")
  allow("git -C /repo status")
})

test("a pinned chain cannot write to an absolute path outside the worktree", () => {
  // The hole the pinned-segment passthrough used to leave open.
  blocked(`cd ${WT} && cp x /repo/y`)
  blocked(`cd ${WT} && mv src/a.ts /repo/src/a.ts`)
  blocked(`cd ${WT} && echo hi > /repo/out.txt`)
  blocked(`cd ${WT} && sed -i s/a/b/ /repo/src/x.ts`)
  blocked(`cd ${WT} && rm -rf /repo/src`)
  blocked("rm -rf /repo/src")
})

test("no command prefix launders an outside path past the escape check", () => {
  // A mutating-command ALLOWLIST is defeated by one token, so the rule is
  // inverted: in a non-read-only segment ANY outside absolute path escapes.
  for (const cmd of [
    "sudo rm -rf /repo/src",
    "env rm -rf /repo/src",
    "FOO=1 rm -rf /repo/src",
    "/bin/rm -rf /repo/src",
    "perl -i -pe s/a/b/ /repo/src/x.ts",
    "sed --in-place s/a/b/ /repo/src/x.ts",
    "patch /repo/src/x.ts",
    "tar -xf a.tar -C /repo",
    "npm install --prefix /repo",
    // NOT covered (documented residual): a path embedded in an interpreter's own
    // source — `node -e "…writeFileSync('/repo/x')"` — is not a shell word.
  ]) {
    blocked(`cd ${WT} && ${cmd}`)
    blocked(cmd)
  }
})

test("redirections escape even without a space before the operator", () => {
  blocked(`cd ${WT} && echo hi>/repo/out.txt`)
  blocked(`cd ${WT} && npm test 2>/repo/err.log`)
  blocked(`cd ${WT} && npm test >|/repo/err.log`)
})

test("cd targets that are not literal paths are refused, never resolved", () => {
  // `cd -` jumps to $OLDPWD and `cd ~` to $HOME; resolving them literally made
  // path.resolve(worktree, "-") look like an in-bounds subdirectory.
  blocked("cd - && rm -rf src")
  blocked("cd ~ && rm -rf x")
  blocked("cd $HOME && rm -rf x")
  blocked(`cd ${WT} && cd - && rm -rf src`)
  blocked(`cd ${WT} && cd ~/elsewhere && ls`)
})

test("a RELATIVE git -C escape is caught, pinned or not", () => {
  blocked(`cd ${WT} && git -C ../.. add -A`)
  blocked("git -C ../.. add -A")
  blocked(`cd ${WT} && git --git-dir=/repo/.git --work-tree=/repo add -A`)
  blocked(`cd ${WT} && git -C /repo/sub commit -m x`)
})

test("outside absolute paths in a read-only segment stay allowed", () => {
  // Reads of the main tree cannot corrupt it, and blocking them would reopen
  // the over-refusal this guard exists to remove.
  allow("git -C /repo status")
  allow("cat /repo/package.json")
  allow("ls /repo/src")
})

test("block reasons name the worktree so the agent can self-correct", () => {
  assert.match(blocked("cd /repo && npm test"), /isolated to its worktree \/repo\/\.workflow-worktrees\/my-task/)
  assert.match(blocked(`cd ${WT} && cp x /repo/y`), /reaches \/repo\/y/)
})

// --- classifyWorktreeBash: boolean view ---

test("classifyWorktreeBash reports rewritable commands as allowed and escapes as denied", () => {
  assert.deepEqual(classifyWorktreeBash("npm test", WT), { allow: true })
  assert.deepEqual(classifyWorktreeBash(`cd ${WT} && npm test`, WT), { allow: true })
  assert.equal(classifyWorktreeBash("cd /repo && npm test", WT).allow, false)
  assert.equal(classifyWorktreeBash(`cd ${WT} && cp x /repo/y`, WT).allow, false)
})

// --- pinEditPath ---

const pin = (fp: string) => pinEditPath(fp, WT, DIR, TASKS)

test("an absolute path already inside the worktree is left alone", () => {
  assert.deepEqual(pin(`${WT}/src/a.ts`), { action: "allow" })
})

test("a relative path resolves against the worktree, not the session cwd", () => {
  assert.deepEqual(pin("src/a.ts"), { action: "rewrite", value: `${WT}/src/a.ts` })
  assert.deepEqual(pin("./src/a.ts"), { action: "rewrite", value: `${WT}/src/a.ts` })
})

test("a main-tree absolute path is remapped onto its worktree mirror", () => {
  // The reported symptom: the agent keeps targeting the current branch's checkout.
  assert.deepEqual(pin(`${DIR}/src/a.ts`), { action: "rewrite", value: `${WT}/src/a.ts` })
  assert.deepEqual(pin(`${DIR}/packages/core/src/workflow/git.ts`), {
    action: "rewrite",
    value: `${WT}/packages/core/src/workflow/git.ts`,
  })
})

test("the worktree's frozen backlog copy is refused", () => {
  for (const fp of [`${WT}/docs/tasks/in-progress/t.md`, "docs/tasks/queued/t.md"]) {
    const v = pin(fp)
    assert.equal(v.action, "block", fp)
    assert.match((v as { reason: string }).reason, /driver-owned/)
  }
})

test("a MAIN-TREE backlog path defers to the backlog guard — never remapped onto the branch", () => {
  // The driver and the PLAN stage legitimately write here; classifyMutation is
  // the authority, and remapping would put a task file on feature/<id>.
  assert.deepEqual(pin(`${DIR}/docs/tasks/in-progress/t.md`), { action: "allow" })
})

test("a path under neither tree has no worktree equivalent and is blocked", () => {
  const v = pin("/etc/passwd")
  assert.equal(v.action, "block")
  assert.match((v as { reason: string }).reason, /outside both it and the repo/)
})

test("docs/tasksish is not the backlog", () => {
  assert.deepEqual(pin(`${WT}/docs/tasksish/x.md`), { action: "allow" })
})

test("git metadata is never an edit target, in either tree", () => {
  // `<worktree>/.git` is a FILE in a linked worktree, so remapping there would
  // fail with ENOTDIR instead of an explanation.
  for (const fp of [`${DIR}/.git/config`, `${WT}/.git`, ".git/hooks/pre-commit"]) {
    const v = pin(fp)
    assert.equal(v.action, "block", fp)
    assert.match((v as { reason: string }).reason, /\.git/)
  }
})

test("a ~-prefixed path is refused rather than turned into a literal ~ directory", () => {
  const v = pin("~/.ssh/authorized_keys")
  assert.equal(v.action, "block")
  assert.match((v as { reason: string }).reason, /do not expand/)
})

// --- isUnderTasksDir ---

test("isUnderTasksDir matches only paths under the worktree's tasksDir copy", () => {
  assert.equal(isUnderTasksDir(`${WT}/docs/tasks/in-progress/my-task.md`, WT, TASKS), true)
  assert.equal(isUnderTasksDir(`${WT}/docs/tasks`, WT, TASKS), true)
  assert.equal(isUnderTasksDir(`${WT}/docs/tasksish/x.md`, WT, TASKS), false)
  assert.equal(isUnderTasksDir(`${WT}/src/x.ts`, WT, TASKS), false)
  assert.equal(isUnderTasksDir("/repo/docs/tasks/in-progress/my-task.md", WT, TASKS), false)
})
