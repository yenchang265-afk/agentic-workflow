#!/usr/bin/env node
// Manual, on-demand e2e smoke test: drives the REAL agentic-loop task
// lifecycle (draft -> queued -> plan-review -> in-progress -> in-review ->
// completed) against a real headless opencode process building one small
// app picked from a fixed idea pool, in a throwaway scratch git repo and a
// throwaway scratch OPENCODE_CONFIG_DIR (never touches the user's real
// ~/.config/opencode). Costs real LLM calls/time — not wired into CI, run by
// hand: `node scripts/e2e-opencode.mjs [--idea <name>] [--keep]`.
//
// Known risks (see docs/design plan for full context):
// - First-ever real run doubles as timeout calibration for the poll loops.
// - `stageTimeoutMinutes` inside the driver is a logical abandonment, not a
//   hard kill of the underlying LLM/tool call — this script's own outer
//   timeout is the real safety net and force-kills the server on expiry.
// - `/agent-loop task <id>` is asynchronous (arms `pending`, does the real
//   work off the next `session.idle`) — this script owns a long-lived
//   `opencode serve` via `createOpencode()` and polls task-file state on
//   disk, rather than trusting any CLI process's exit code.

import { createOpencode } from "@opencode-ai/sdk"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TASKS_DIR = "docs/tasks"

const args = process.argv.slice(2)
const KEEP = args.includes("--keep")
const ideaArgIdx = args.indexOf("--idea")
const REQUESTED_IDEA = ideaArgIdx !== -1 ? args[ideaArgIdx + 1] : null

const log = (msg) => console.log(`[e2e ${new Date().toISOString()}] ${msg}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const sh = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { cwd: REPO_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts })

// --- fixed idea pool (zero-dependency, fast, deterministic) ---

const IDEAS = [
  {
    name: "reverse-cli",
    newPromptSpec:
      "Build a tiny zero-dependency Node.js CLI at index.js: read all of stdin as UTF-8 text, reverse the " +
      "character order, and write the reversed text to stdout with no trailing newline unless the input had " +
      "one. Do not add a package.json unless the plan calls for it. Single file only.",
    expectFiles: ["index.js"],
    verify: async (repoDir) => {
      const out = execFileSync("node", ["index.js"], { cwd: repoDir, input: "hello", encoding: "utf8" })
      if (out !== "olleh") throw new Error(`reverse-cli: expected "olleh", got ${JSON.stringify(out)}`)
    },
  },
  {
    name: "fizzbuzz-cli",
    newPromptSpec:
      "Build a tiny zero-dependency Node.js CLI at fizzbuzz.js: read a single integer N from process.argv[2] " +
      "(default 100 if not given), then print the numbers 1 to N, one per line, except multiples of 3 print " +
      "'Fizz', multiples of 5 print 'Buzz', and multiples of both print 'FizzBuzz'. No package.json needed " +
      "unless the plan calls for it.",
    expectFiles: ["fizzbuzz.js"],
    verify: async (repoDir) => {
      const out = execFileSync("node", ["fizzbuzz.js", "15"], { cwd: repoDir, encoding: "utf8" }).trim()
      const expected = Array.from({ length: 15 }, (_, i) => {
        const n = i + 1
        if (n % 15 === 0) return "FizzBuzz"
        if (n % 3 === 0) return "Fizz"
        if (n % 5 === 0) return "Buzz"
        return String(n)
      }).join("\n")
      if (out !== expected) throw new Error(`fizzbuzz-cli: output mismatch.\nExpected:\n${expected}\nGot:\n${out}`)
    },
  },
  {
    name: "time-server",
    newPromptSpec:
      "Build a tiny zero-dependency Node.js HTTP server at server.js using only the built-in node:http module: " +
      "listen on port 8934 and respond to GET /time with a JSON body of the shape {\"time\": \"<current ISO " +
      "8601 timestamp>\"}. Do not add a package.json or any npm dependency unless the plan calls for it.",
    expectFiles: ["server.js"],
    verify: async (repoDir) => {
      const child = spawn("node", ["server.js"], { cwd: repoDir, stdio: "ignore" })
      try {
        const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
        let lastErr
        for (let i = 0; i < 20; i++) {
          await sleep(250)
          try {
            const res = await fetch("http://127.0.0.1:8934/time")
            const json = await res.json()
            if (typeof json.time !== "string" || !isoRe.test(json.time)) {
              throw new Error(`time-server: unexpected body ${JSON.stringify(json)}`)
            }
            return
          } catch (err) {
            lastErr = err
          }
        }
        throw new Error(`time-server: server never responded correctly (last error: ${lastErr?.message})`)
      } finally {
        child.kill()
      }
    },
  },
]

const pickIdea = () => {
  if (REQUESTED_IDEA) {
    const found = IDEAS.find((i) => i.name === REQUESTED_IDEA)
    if (!found) throw new Error(`Unknown --idea "${REQUESTED_IDEA}" — known: ${IDEAS.map((i) => i.name).join(", ")}`)
    return found
  }
  return IDEAS[Math.floor(Math.random() * IDEAS.length)]
}

// --- setup ---

const setupScratchRepo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agentic-loop-e2e-repo-"))
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "agentic-loop-e2e"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "agentic-loop-e2e@example.invalid"], { cwd: dir, stdio: "ignore" })
  writeFileSync(path.join(dir, "README.md"), "# scratch e2e repo\n")
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir, stdio: "ignore" })
  return dir
}

const ensureBuilt = () => {
  const hasNodeModules = existsSync(path.join(REPO_DIR, "node_modules"))
  const hasCoreDist = existsSync(path.join(REPO_DIR, "packages/core/dist"))
  if (hasNodeModules && hasCoreDist) return
  log("node_modules/ or packages/core/dist/ missing — running npm install (builds workspaces via prepare)")
  sh("npm", ["install"], { stdio: "inherit" })
}

const setupScratchConfig = () => {
  ensureBuilt()
  const dir = mkdtempSync(path.join(tmpdir(), "agentic-loop-e2e-config-"))
  sh("./install.sh", ["opencode", "--no-config", dir], { stdio: "inherit" })
  return dir
}

// --- driving ---

const REQUIRED_AGENTS = ["loop-plan-author", "loop-build", "loop-verify", "loop-review"]

const assertPluginLoaded = async (client) => {
  const { data, error } = await client.app.agents()
  if (error) throw new Error(`app.agents() failed: ${JSON.stringify(error)}`)
  const names = new Set((data ?? []).map((a) => a.name))
  const missing = REQUIRED_AGENTS.filter((n) => !names.has(n))
  if (missing.length) {
    throw new Error(
      `agentic-loop plugin did not load from the scratch config — missing agents: ${missing.join(", ")}. ` +
        `Check npm install / ./install.sh ran cleanly.`,
    )
  }
}

const runCommand = async (client, sessionId, repoDir, command, commandArgs) => {
  const { data, error } = await client.session.command({
    path: { id: sessionId },
    query: { directory: repoDir },
    body: { command, arguments: commandArgs },
  })
  if (error) throw new Error(`session.command ${command} "${commandArgs}" failed: ${JSON.stringify(error)}`)
  return data
}

const taskPath = (repoDir, status, id) => path.join(repoDir, TASKS_DIR, status, `${id}.md`)

const readTaskBody = (repoDir, status, id) => {
  const p = taskPath(repoDir, status, id)
  return existsSync(p) ? readFileSync(p, "utf8") : null
}

// Generic poller: `check()` returns "pass" | "fail:<reason>" | "pending".
const pollUntil = async (label, check, { timeoutMs, intervalMs = 4000 }) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await check()
    if (result === "pass") return
    if (result !== "pending") throw new Error(`${label}: ${result}`)
    if (Date.now() > deadline) throw new Error(`${label}: timed out after ${timeoutMs}ms`)
    await sleep(intervalMs)
  }
}

const findSoleDraftId = (repoDir) => {
  const dir = path.join(repoDir, TASKS_DIR, "draft")
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"))
  if (files.length === 0) return null
  if (files.length > 1) throw new Error(`expected exactly one draft task, found ${files.length}: ${files.join(", ")}`)
  return files[0].replace(/\.md$/i, "")
}

// --- main ---

const main = async () => {
  const idea = pickIdea()
  log(`picked idea: ${idea.name}`)

  const scratchRepo = setupScratchRepo()
  const scratchConfig = setupScratchConfig()
  log(`scratch repo: ${scratchRepo}`)
  log(`scratch config: ${scratchConfig}`)

  process.env.OPENCODE_CONFIG_DIR = scratchConfig

  let server
  let succeeded = false
  let id
  try {
    log("booting opencode serve...")
    const booted = await createOpencode({
      config: { permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow" } },
    })
    server = booted.server
    const { client } = booted

    await assertPluginLoaded(client)
    log("plugin loaded — required agents present")

    const { data: session, error: sessionErr } = await client.session.create({ query: { directory: scratchRepo } })
    if (sessionErr) throw new Error(`session.create failed: ${JSON.stringify(sessionErr)}`)
    log(`session created: ${session.id}`)

    // Step 1: new — real LLM turn (interview-me + loop-plan-author).
    log("step 1/6: agent-loop new ...")
    await runCommand(client, session.id, scratchRepo, "agent-loop", `new ${idea.newPromptSpec}`)
    await pollUntil("step 1 (new)", () => (findSoleDraftId(scratchRepo) ? "pass" : "pending"), { timeoutMs: 5 * 60_000 })
    id = findSoleDraftId(scratchRepo)
    log(`task id: ${id}`)

    // Step 2: approve — deterministic.
    log("step 2/6: agent-loop approve")
    await runCommand(client, session.id, scratchRepo, "agent-loop", `approve ${id}`)
    await pollUntil("step 2 (approve)", () => (existsSync(taskPath(scratchRepo, "queued", id)) ? "pass" : "pending"), {
      timeoutMs: 30_000,
    })

    // Step 3: task <id> — async PLAN stage.
    log("step 3/6: agent-loop task (PLAN)")
    await runCommand(client, session.id, scratchRepo, "agent-loop", `task ${id}`)
    await pollUntil(
      "step 3 (PLAN)",
      () => {
        const parked = readTaskBody(scratchRepo, "plan-review", id)
        if (parked && parked.includes("## Implementation Plan")) return "pass"
        const stillQueued = readTaskBody(scratchRepo, "queued", id)
        if (stillQueued && stillQueued.includes("PLAN stage failed")) return "fail:PLAN stage failed (see task body)"
        return "pending"
      },
      { timeoutMs: 5 * 60_000 },
    )
    log("PLAN parked in plan-review/")

    // Step 4: approve-plan — deterministic.
    log("step 4/6: agent-loop approve-plan")
    await runCommand(client, session.id, scratchRepo, "agent-loop", `approve-plan ${id}`)
    await pollUntil(
      "step 4 (approve-plan)",
      () => (existsSync(taskPath(scratchRepo, "in-progress", id)) ? "pass" : "pending"),
      { timeoutMs: 30_000 },
    )

    // Step 5: task <id> — async BUILD -> VERIFY -> REVIEW chain.
    log("step 5/6: agent-loop task (BUILD -> VERIFY -> REVIEW)")
    await runCommand(client, session.id, scratchRepo, "agent-loop", `task ${id}`)
    await pollUntil(
      "step 5 (BUILD chain)",
      () => {
        const inReview = readTaskBody(scratchRepo, "in-review", id)
        if (inReview) return "pass"
        const inProgress = readTaskBody(scratchRepo, "in-progress", id)
        if (inProgress && inProgress.includes("Loop stopped")) return "fail:loop stopped (see task body)"
        return "pending"
      },
      { timeoutMs: 30 * 60_000 },
    )
    log("BUILD chain parked in in-review/")

    // Step 6: ship — deterministic.
    log("step 6/6: agent-loop ship")
    await runCommand(client, session.id, scratchRepo, "agent-loop", `ship ${id}`)
    await pollUntil("step 6 (ship)", () => (existsSync(taskPath(scratchRepo, "completed", id)) ? "pass" : "pending"), {
      timeoutMs: 30_000,
    })
    log("task completed")

    // Verification phase.
    log("verifying...")
    const completedBody = readTaskBody(scratchRepo, "completed", id)
    const requiredNotes = [
      "Task approved — queued for planning",
      "Plan written — parked for plan review",
      "Plan approved — parked for execution",
      "BUILD started (iteration",
      "BUILD finished (iteration",
      "Loop done — review passed",
      "Shipped — moved to completed",
    ]
    for (const note of requiredNotes) {
      if (!completedBody.includes(note)) throw new Error(`verification: missing audit note "${note}" in completed task body`)
    }

    const gitLog = execFileSync("git", ["log", "--oneline"], { cwd: scratchRepo, encoding: "utf8" })
    if (!gitLog.includes(`loop(${id}):`)) throw new Error(`verification: no loop(${id}): commits found in git log`)

    for (const f of idea.expectFiles) {
      if (!existsSync(path.join(scratchRepo, f))) throw new Error(`verification: expected app file ${f} not found`)
    }

    await idea.verify(scratchRepo)
    log(`idea's own runnable check passed (${idea.name})`)

    succeeded = true
    log(`PASS — idea=${idea.name} task=${id}`)
  } catch (err) {
    log(`FAIL: ${err.message}`)
    log(`scratch repo preserved at: ${scratchRepo}`)
    log(`scratch config preserved at: ${scratchConfig}`)
    if (id) {
      for (const status of ["draft", "queued", "plan-review", "in-progress", "in-review", "completed"]) {
        const body = readTaskBody(scratchRepo, status, id)
        if (body) log(`last known status: ${status}/ — tail:\n${body.slice(-800)}`)
      }
    }
    process.exitCode = 1
  } finally {
    if (server) server.close()
    if (succeeded && !KEEP) {
      rmSync(scratchRepo, { recursive: true, force: true })
      rmSync(scratchConfig, { recursive: true, force: true })
      log("cleaned up scratch dirs")
    } else if (succeeded && KEEP) {
      log(`--keep set; scratch dirs preserved:\n  repo: ${scratchRepo}\n  config: ${scratchConfig}`)
    }
  }
}

main()
