#!/usr/bin/env node
// Manual, on-demand e2e smoke test for the PR sitters' TARGETED claim
// (`claim <pr>`): drives the REAL pr-sitter and review-sitter loops against a
// real headless opencode process, but with a FAKE `gh` CLI on PATH so no real
// GitHub is touched. Proves that a named PR is claimed and driven end-to-end
// even though the poller's query/ledger would never surface it.
//
//   node scripts/e2e-sitters.mjs [--keep]
//
// Two throwaway things are created and (on success) cleaned up: a scratch git
// repo with a local bare `origin` holding two PR head branches, and a scratch
// OPENCODE_CONFIG_DIR (never touches ~/.config/opencode). Costs real LLM
// calls/time — not wired into CI, run by hand.
//
// Scenario (fully hermetic — the fake `gh` serves scripted PR JSON and records
// the sitters' writes):
//   - PR #101 (branch pr/babysit): its head introduced a one-line greeting bug
//     so `npm test` fails; the fake `gh` reports a failing check. pr-sitter
//     babysit must triage -> fix -> verify -> publish: fix the bug, push the
//     head branch, and post a comment. Assert the pushed head now passes and a
//     comment was recorded.
//   - PR #202 (branch pr/review): a benign additive change. review-sitter must
//     fetch -> assess -> publish EXACTLY ONE comment and NEVER push. Assert one
//     comment recorded and the head branch untouched on origin.
//
// Notes mirror e2e-opencode.mjs: `claim` is asynchronous (arms `pending`, does
// the real work off the next `session.idle`), so this owns a long-lived
// `opencode serve` via `createOpencode()` and polls on-disk state (the sitters'
// ledgers + the fake gh's recorded writes) rather than trusting exit codes.

import { createOpencode } from "@opencode-ai/sdk"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TASKS_DIR = "docs/tasks"
const SELF_LOGIN = "sitter-bot"

const KEEP = process.argv.slice(2).includes("--keep")

const log = (msg) => console.log(`[e2e-sitters ${new Date().toISOString()}] ${msg}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

// The two scripted PRs. `oid` is an opaque head marker (nothing validates it
// against real git — the ledger only compares it as a string), `statusFail`
// drives the fake `gh pr checks`, `reviewWanted` makes the review fetch stage
// confirm a review is still wanted.
const REGISTRY = {
  "101": { branch: "pr/babysit", base: "main", author: SELF_LOGIN, title: "Adjust the greeting", oid: "oid-101", statusFail: true },
  "202": { branch: "pr/review", base: "main", author: "alice", title: "Add a farewell helper", oid: "oid-202", reviewWanted: true },
}

// --- scratch repo + local bare origin ---

const setupScratchRepo = () => {
  const repo = mkdtempSync(path.join(tmpdir(), "agentic-workflow-e2e-sitter-repo-"))
  const bare = mkdtempSync(path.join(tmpdir(), "agentic-workflow-e2e-sitter-origin-")) + "/origin.git"
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" })
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" })
  git(repo, "config", "user.name", "agentic-workflow-e2e")
  git(repo, "config", "user.email", "agentic-workflow-e2e@example.invalid")

  // base (main): a tiny zero-dep app whose test passes.
  writeFileSync(path.join(repo, "greet.js"), "module.exports = (name) => `Hello, ${name}!`\n")
  writeFileSync(
    path.join(repo, "greet.test.js"),
    'const greet = require("./greet")\n' +
      'const got = greet("World")\n' +
      'const want = "Hello, World!"\n' +
      "if (got !== want) {\n" +
      "  console.error(`FAIL: greet(\"World\") returned ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)\n" +
      "  process.exit(1)\n" +
      "}\n" +
      'console.log("ok")\n',
  )
  writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "e2e-sitter-app", version: "1.0.0", private: true, scripts: { test: "node greet.test.js" } }, null, 2) + "\n",
  )
  git(repo, "add", "-A")
  git(repo, "commit", "-m", "initial app")

  // pr/babysit: break the greeting so `npm test` fails — the PR pr-sitter fixes.
  git(repo, "checkout", "-b", "pr/babysit")
  writeFileSync(path.join(repo, "greet.js"), "module.exports = (name) => `Hi, ${name}!`\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-m", "tweak greeting wording")

  // pr/review: a benign additive change — the PR review-sitter comments on.
  git(repo, "checkout", "main")
  git(repo, "checkout", "-b", "pr/review")
  writeFileSync(path.join(repo, "farewell.js"), "module.exports = (name) => `Goodbye, ${name}!`\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-m", "add farewell helper")

  git(repo, "checkout", "main")
  git(repo, "remote", "add", "origin", bare)
  git(repo, "push", "origin", "main", "pr/babysit", "pr/review")
  return { repo, bare }
}

// --- the fake gh CLI ---

const SHIM_SOURCE = String.raw`#!/usr/bin/env node
// Fake gh for the sitter e2e — serves scripted PR data and records writes.
const { execFileSync } = require("node:child_process")
const { appendFileSync } = require("node:fs")
const args = process.argv.slice(2)
const OUT = process.env.E2E_SHIM_DIR
const REG = JSON.parse(process.env.E2E_PR_REGISTRY || "{}")
const LOGIN = process.env.E2E_SELF_LOGIN || "sitter-bot"
const record = (obj) => { try { appendFileSync(OUT + "/gh-calls.log", JSON.stringify({ args }) + "\n") } catch {} ; if (obj) { try { appendFileSync(OUT + "/" + obj.file, JSON.stringify(obj.data) + "\n") } catch {} } }
const out = (s) => process.stdout.write(String(s).endsWith("\n") ? s : s + "\n")
const num = (xs) => { for (const a of xs) if (/^\d+$/.test(a)) return a; return null }
const flag = (xs, name) => { const i = xs.indexOf(name); return i !== -1 ? xs[i + 1] : null }

const viewObject = (n, pr) => ({
  number: Number(n),
  title: pr.title || "PR " + n,
  headRefName: pr.branch,
  baseRefName: pr.base || "main",
  headRefOid: pr.oid || ("oid-" + n),
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: "",
  isCrossRepository: false,
  statusCheckRollup: pr.statusFail
    ? [{ name: "ci/test", conclusion: "FAILURE", state: "FAILURE" }]
    : [{ name: "ci/test", conclusion: "SUCCESS", state: "SUCCESS" }],
  comments: [],
  reviewRequests: pr.reviewWanted ? [{ login: LOGIN }] : [],
  reviews: [],
  state: "OPEN",
})

try {
  record()
  const sub = args[0]
  if (sub === "api") {
    const p = args[1] || ""
    if (p.startsWith("user")) { out(LOGIN); process.exit(0) }
    // repos/.../pulls/.../comments...: a reply POST carries -f/-X/--method; a bare GET is a read.
    const isWrite = args.includes("-f") || args.includes("-X") || args.includes("--method")
    if (isWrite) { record({ file: "replies.jsonl", data: { at: Date.now() } }); out("{}"); process.exit(0) }
    out("[]"); process.exit(0)
  }
  if (sub === "pr") {
    const verb = args[1]
    const rest = args.slice(2)
    const n = num(rest)
    const pr = REG[n] || {}
    if (verb === "view") {
      const fields = flag(rest, "--json")
      if (fields) {
        const full = viewObject(n, pr)
        const picked = {}
        for (const f of fields.split(",").filter(Boolean)) if (f in full) picked[f] = full[f]
        out(JSON.stringify(picked)); process.exit(0)
      }
      out("#" + n + "  " + (pr.title || "PR") + "\nAuthor: " + (pr.author || "someone") + "\nState: OPEN\n\n(no description)\n\n-- no comments --")
      process.exit(0)
    }
    if (verb === "diff") {
      try { out(execFileSync("git", ["diff", (pr.base || "main") + "..." + pr.branch], { encoding: "utf8" })) } catch { out("") }
      process.exit(0)
    }
    if (verb === "checks") {
      out("ci/test\t" + (pr.statusFail ? "fail" : "pass") + "\t1s\thttps://example.invalid/run/1")
      process.exit(0)
    }
    if (verb === "comment") {
      record({ file: "comments.jsonl", data: { pr: n, body: flag(rest, "--body") || "" } })
      out("https://example.invalid/pr/" + n + "#issuecomment-1")
      process.exit(0)
    }
    process.exit(0)
  }
  if (sub === "run") {
    if (args.includes("--log-failed") || args[1] === "view") {
      out("greet.test.js\n  FAIL: greet(\"World\") returned \"Hi, World!\", expected \"Hello, World!\"\n  process exited 1")
      process.exit(0)
    }
    out("completed\tfailure\tci/test\t1\t\t1s"); process.exit(0)
  }
  process.exit(0)
} catch (e) {
  try { appendFileSync(OUT + "/gh-calls.log", JSON.stringify({ args, error: String(e) }) + "\n") } catch {}
  process.exit(0)
}
`

const writeShim = () => {
  const shimDir = mkdtempSync(path.join(tmpdir(), "agentic-workflow-e2e-sitter-shim-"))
  const shimOut = path.join(shimDir, "out")
  mkdirSync(shimOut)
  const ghPath = path.join(shimDir, "gh")
  writeFileSync(ghPath, SHIM_SOURCE)
  chmodSync(ghPath, 0o755)
  return { shimDir, shimOut, ghPath }
}

// --- opencode scratch config (mirrors e2e-opencode.mjs) ---

const ensureBuilt = () => {
  if (existsSync(path.join(REPO_DIR, "node_modules")) && existsSync(path.join(REPO_DIR, "packages/core/dist"))) return
  log("node_modules/ or packages/core/dist/ missing — running npm install (builds workspaces via prepare)")
  execFileSync("npm", ["install"], { cwd: REPO_DIR, stdio: "inherit" })
}

const setupScratchConfig = () => {
  ensureBuilt()
  const dir = mkdtempSync(path.join(tmpdir(), "agentic-workflow-e2e-sitter-config-"))
  execFileSync("./install.sh", ["opencode", "--no-config", dir], { cwd: REPO_DIR, stdio: "inherit" })
  const model = process.env.AGENTIC_WORKFLOW_E2E_MODEL
  if (model) {
    writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ model }, null, 2) + "\n")
    log(`scratch config model pinned: ${model}`)
  } else {
    log("WARN: AGENTIC_WORKFLOW_E2E_MODEL unset — opencode's weak default may be unable to drive the sitter stages")
  }
  return dir
}

const REQUIRED_AGENTS = [
  "workflow-pr-triage",
  "workflow-pr-fix",
  "workflow-verify",
  "workflow-pr-publish",
  "workflow-review-fetch",
  "workflow-review-assess",
  "workflow-review-publish",
]

const assertPluginLoaded = async (client) => {
  const { data, error } = await client.app.agents()
  if (error) throw new Error(`app.agents() failed: ${JSON.stringify(error)}`)
  const names = new Set((data ?? []).map((a) => a.name))
  const missing = REQUIRED_AGENTS.filter((n) => !names.has(n))
  if (missing.length) throw new Error(`agentic-workflow plugin did not load — missing sitter agents: ${missing.join(", ")}`)
  const cmds = await client.command.list()
  if (cmds.error) throw new Error(`command.list() failed: ${JSON.stringify(cmds.error)}`)
  const cmdNames = new Set((cmds.data ?? []).map((c) => c.name))
  for (const required of ["agentic-workflow:pr-sitter", "agentic-workflow:review-sitter"]) {
    if (!cmdNames.has(required)) throw new Error(`command "${required}" is not registered — check the opencode install`)
  }
}

const runCommand = async (client, sessionId, repoDir, command, commandArgs) => {
  try {
    const { data, error } = await client.session.command({
      path: { id: sessionId },
      query: { directory: repoDir },
      body: { command, arguments: commandArgs },
    })
    if (error) throw new Error(`session.command ${command} "${commandArgs}" failed: ${JSON.stringify(error)}`)
    return data
  } catch (err) {
    // A slow LLM turn can outlive fetch's body-idle timeout while the server keeps
    // driving; every outcome is polled from disk, so treat a transport drop as survivable.
    if (err instanceof TypeError || /fetch failed|terminated|socket/i.test(String(err?.message))) {
      log(`WARN: session.command ${command} connection dropped (${err.message}) — continuing on disk-state polling`)
      return null
    }
    throw err
  }
}

const pollUntil = async (label, check, { timeoutMs, intervalMs = 5000 }) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await check()
    if (result === "pass") return
    if (result !== "pending") throw new Error(`${label}: ${result}`)
    if (Date.now() > deadline) throw new Error(`${label}: timed out after ${timeoutMs}ms`)
    await sleep(intervalMs)
  }
}

// --- on-disk readers ---

const commentsFor = (shimOut, n) => {
  const p = path.join(shimOut, "comments.jsonl")
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => String(c.pr) === String(n))
}

const ledgerPresent = (repo, kind, n) => existsSync(path.join(repo, TASKS_DIR, "runs", kind, `pr-${n}.json`))

// Drive one sitter claim and wait for its terminal signal. A posted comment
// (publish ran) is success. A written ledger with NO comment is a terminal that
// never published — triage found nothing actionable, or the loop capped/parked —
// a real failure. The publish stage records its comment BEFORE the loop writes
// the ledger, so checking comments first means a successful run always trips the
// pass branch. A retryable (transient) stop writes no ledger, so it keeps polling.
const driveSitter = async (client, sessionId, repo, shimOut, kind, n, timeoutMs) => {
  log(`driving agentic-workflow:${kind} claim ${n} ...`)
  await runCommand(client, sessionId, repo, `agentic-workflow:${kind}`, `claim ${n}`)
  await pollUntil(
    `${kind} claim ${n}`,
    () => {
      if (commentsFor(shimOut, n).length > 0) return "pass"
      if (ledgerPresent(repo, kind, n)) return `fail:${kind} terminated on PR #${n} without publishing (see ledger + gh-calls.log)`
      return "pending"
    },
    { timeoutMs },
  )
}

// --- main ---

const main = async () => {
  const { repo, bare } = setupScratchRepo()
  const scratchConfig = setupScratchConfig()
  const { shimDir, shimOut, ghPath } = writeShim()
  log(`scratch repo:   ${repo}`)
  log(`bare origin:    ${bare}`)
  log(`scratch config: ${scratchConfig}`)
  log(`gh shim:        ${ghPath}`)

  process.env.OPENCODE_CONFIG_DIR = scratchConfig
  process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH}`
  process.env.E2E_SHIM_DIR = shimOut
  process.env.E2E_PR_REGISTRY = JSON.stringify(REGISTRY)
  process.env.E2E_SELF_LOGIN = SELF_LOGIN

  let server
  let succeeded = false
  try {
    // Confirm the shim shadows any real gh before booting.
    const which = execFileSync("gh", ["--version"], { encoding: "utf8" }).trim().slice(0, 40) || "(no output)"
    log(`PATH gh resolves to the shim (version probe: ${which || "shim"})`)

    log("booting opencode serve...")
    const booted = await createOpencode({
      config: { permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow" } },
    })
    server = booted.server
    const { client } = booted

    await assertPluginLoaded(client)
    log("plugin loaded — sitter agents + commands present")

    const { data: session, error: sessionErr } = await client.session.create({ query: { directory: repo } })
    if (sessionErr) throw new Error(`session.create failed: ${JSON.stringify(sessionErr)}`)
    log(`session created: ${session.id}`)

    // --- pr-sitter babysit (author role): triage -> fix -> verify -> publish ---
    const babysitTipBefore = git(bare, "rev-parse", "pr/babysit").trim()
    await driveSitter(client, session.id, repo, shimOut, "pr-sitter", 101, 30 * 60_000)
    log("pr-sitter published — verifying the fix landed on the head branch")

    const babysitTipAfter = git(bare, "rev-parse", "pr/babysit").trim()
    if (babysitTipAfter === babysitTipBefore) throw new Error("verification: pr-sitter never pushed the fix to origin pr/babysit")
    const fixedGreet = git(bare, "show", "pr/babysit:greet.js")
    if (!fixedGreet.includes("Hello, ")) {
      throw new Error(`verification: greet.js on pr/babysit was not fixed — still:\n${fixedGreet}`)
    }
    if (commentsFor(shimOut, 101).length === 0) throw new Error("verification: pr-sitter posted no comment")
    log("pr-sitter babysit PASS — head fixed, pushed, and a comment posted")

    // --- review-sitter (reviewer role): fetch -> assess -> publish ONE comment, never push ---
    const reviewTipBefore = git(bare, "rev-parse", "pr/review").trim()
    await driveSitter(client, session.id, repo, shimOut, "review-sitter", 202, 20 * 60_000)

    const reviewComments = commentsFor(shimOut, 202)
    if (reviewComments.length !== 1) {
      throw new Error(`verification: review-sitter must post exactly one comment on PR #202, saw ${reviewComments.length}`)
    }
    const reviewTipAfter = git(bare, "rev-parse", "pr/review").trim()
    if (reviewTipAfter !== reviewTipBefore) throw new Error("verification: review-sitter pushed to pr/review — it must never push")
    if (existsSync(path.join(shimOut, "replies.jsonl"))) {
      throw new Error("verification: review-sitter used gh api (thread reply) — it must post only via gh pr comment")
    }
    log("review-sitter review PASS — exactly one comment, no push")

    succeeded = true
    log("PASS — both sitters drove a targeted claim end-to-end")
  } catch (err) {
    log(`FAIL: ${err.message}`)
    log(`scratch repo preserved at:   ${repo}`)
    log(`bare origin preserved at:    ${bare}`)
    log(`scratch config preserved at: ${scratchConfig}`)
    const callsLog = path.join(shimOut, "gh-calls.log")
    if (existsSync(callsLog)) log(`gh-calls.log tail:\n${readFileSync(callsLog, "utf8").split("\n").slice(-25).join("\n")}`)
    const commentsPath = path.join(shimOut, "comments.jsonl")
    if (existsSync(commentsPath)) log(`recorded comments:\n${readFileSync(commentsPath, "utf8").trim()}`)
    process.exitCode = 1
  } finally {
    if (server) server.close()
    if (succeeded && !KEEP) {
      for (const d of [repo, path.dirname(bare), scratchConfig, shimDir]) rmSync(d, { recursive: true, force: true })
      log("cleaned up scratch dirs")
    } else if (succeeded && KEEP) {
      log(`--keep set; scratch dirs preserved:\n  repo: ${repo}\n  origin: ${bare}\n  config: ${scratchConfig}\n  shim: ${shimDir}`)
    }
  }
}

main()
