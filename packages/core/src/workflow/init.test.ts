import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "../config.js"
import { STATUSES } from "../task/statuses.js"
import { initConfigSkeleton, initRepo } from "./init.js"

/**
 * `init` is one-shot scaffolding over the host shell, so these tests inject the
 * same fake-`$` shape git.test uses: a handler over the reconstructed command.
 * The contract under test is the safety half — create-if-absent only, never
 * overwrite, degrade outside a git repo — not the shell mechanics.
 */
const makeShell = (existing: Set<string>, opts: { gitRepo?: boolean } = {}, log?: string[]) => {
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
    const parts = cmd.split(" ")
    let out = { exitCode: 1, stdout: "" }
    if (parts[0] === "test") out = { exitCode: existing.has(parts[2] ?? "") ? 0 : 1, stdout: "" }
    else if (parts[0] === "mkdir") {
      existing.add(parts[parts.length - 1] ?? "")
      out = { exitCode: 0, stdout: "" }
    } else if (parts[0] === "printf" && cmd.includes(" > ")) {
      existing.add(parts[parts.length - 1] ?? "")
      out = { exitCode: 0, stdout: "" }
    } else if (parts[0] === "printf") out = { exitCode: 0, stdout: "" } // the exclude-file append
    else if (cmd.includes("is-inside-work-tree")) out = { exitCode: opts.gitRepo ? 0 : 1, stdout: opts.gitRepo ? "true" : "" }
    else if (cmd.includes("--git-common-dir")) out = { exitCode: opts.gitRepo ? 0 : 1, stdout: opts.gitRepo ? "/repo/.git" : "" }
    else if (parts[0] === "grep") out = { exitCode: 1, stdout: "" } // exclude entry not present yet
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ exitCode: out.exitCode, stdout: { toString: () => out.stdout }, stderr: { toString: () => "" } }).then(resolve),
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((strings: TemplateStringsArray, ...exprs: unknown[]) => build(strings, exprs)) as any
}

test("initRepo scaffolds every status folder and a safe-key config on a bare repo", async () => {
  const existing = new Set<string>()
  const r = await initRepo(makeShell(existing), "/repo", DEFAULT_CONFIG)
  assert.equal(r.createdDirs.length, STATUSES.length)
  assert.ok(r.createdDirs.includes("docs/tasks/draft/"))
  assert.equal(r.configCreated, true)
  assert.deepEqual(r.kept, [])
  assert.equal(r.excluded, null, "not a git repo → nothing to exclude")
  assert.match(r.message, /created \d+ status folders/)
  assert.match(r.message, /wrote \.agentic-workflow\.json/)
  assert.match(r.message, /new <idea>/)
})

test("initRepo is idempotent: a second run keeps everything and writes nothing", async () => {
  const existing = new Set<string>()
  await initRepo(makeShell(existing), "/repo", DEFAULT_CONFIG)
  const log: string[] = []
  const r = await initRepo(makeShell(existing, {}, log), "/repo", DEFAULT_CONFIG)
  assert.deepEqual(r.createdDirs, [])
  assert.equal(r.configCreated, false)
  assert.equal(r.kept.length, STATUSES.length + 1) // the folders + the config file
  assert.ok(r.kept.includes(".agentic-workflow.json"))
  assert.ok(!log.some((c) => c.startsWith("printf") && c.includes(" > ")), "an existing config is NEVER rewritten")
  assert.match(r.message, /already set up/)
  assert.match(r.message, /kept as-is/)
})

test("initRepo git-excludes the backlog in a git repo when ignoreBacklog is on", async () => {
  const existing = new Set<string>()
  const r = await initRepo(makeShell(existing, { gitRepo: true }), "/repo", DEFAULT_CONFIG)
  assert.equal(r.excluded, true)
  assert.match(r.message, /git-excluded/)
  // And not when the repo opted into committing the backlog.
  const opted = await initRepo(makeShell(new Set(), { gitRepo: true }), "/repo", { ...DEFAULT_CONFIG, ignoreBacklog: false })
  assert.equal(opted.excluded, null)
})

test("the skeleton carries safe repo keys only — defaults made visible, nothing shell-bearing", () => {
  const parsed: unknown = JSON.parse(initConfigSkeleton(DEFAULT_CONFIG))
  assert.deepEqual(parsed, { tasksDir: DEFAULT_CONFIG.tasksDir, maxIterations: DEFAULT_CONFIG.maxIterations })
})
