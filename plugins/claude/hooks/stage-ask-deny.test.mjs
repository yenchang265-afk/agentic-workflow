import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { dialectFor } from "./src/dialect.mjs"
import { machineIdSync } from "./src/marker.mjs"

/**
 * No stage may ask the human. A drive is unattended between the plan gate and
 * the ship gate, so a question dialog opened mid-VERIFY stalls the run on
 * someone who may not be at the terminal — on a `watch` worker, on nobody at
 * all.
 *
 * OpenCode refuses this at runtime in the plugin, which is the only layer that
 * does not depend on a host config key and the only one covering a USER-ADDED
 * kind's stage agent. This host had nothing equivalent: the `tools:` enumeration
 * excludes the ask tool only in the agents THIS repo ships, and no PreToolUse
 * matcher could see the tool at all.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = path.join(HERE, "check-stage-ask.mjs")

const makeRepo = (marker) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aw-stage-ask-"))
  fs.mkdirSync(path.join(cwd, "docs", "tasks", "runs"), { recursive: true })
  if (marker) fs.writeFileSync(path.join(cwd, "docs", "tasks", "runs", marker.file ?? ".stage.json"), JSON.stringify(marker))
  return cwd
}

const ask = (cwd, tool = "AskUserQuestion", env = {}) =>
  spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd, tool_name: tool, tool_input: { questions: [] } }),
    encoding: "utf8",
    env: { ...process.env, AGENTIC_WORKFLOW_USER_CONFIG: "", ...env },
  })

const LIVE = { kind: "engineering", stage: "verify", check: true, taskId: "t", deadline: Date.now() + 3_600_000 }
const EXPIRED = { ...LIVE, deadline: Date.now() - 60_000, pid: 999_999_999, machine: machineIdSync() }

test("a stage agent's question is refused, and the refusal names the channels that work", () => {
  const res = ask(makeRepo(LIVE))
  assert.equal(res.status, 2)
  assert.match(res.stderr, /VERIFY stage cannot ask the user/)
  assert.match(res.stderr, /workflow_blocked/, "the refusal has to name the alternative it is redirecting to")
  assert.match(res.stderr, /FAIL\/ERROR verdict/)
})

test("an ordinary session asks freely — the deny is marker-gated", () => {
  assert.equal(ask(makeRepo(null)).status, 0)
})

test("a crashed run's leftover marker cannot silence the human's questions", () => {
  // The rule every other marker-scoped control reads: expired plus a writer that
  // is provably gone is NO marker. Without it a SIGKILLed stage would refuse
  // every question in the repo until something overwrote the file.
  assert.equal(ask(makeRepo(EXPIRED)).status, 0)
})

test("every uncertainty fails OPEN — an unknown host, a garbled marker, junk on stdin", () => {
  assert.equal(ask(makeRepo(LIVE), "AskUserQuestion", { AGENTIC_WORKFLOW_HOST: "not-a-host" }).status, 0)
  const cwd = makeRepo(null)
  fs.writeFileSync(path.join(cwd, "docs", "tasks", "runs", ".stage.json"), "{ not json")
  assert.equal(ask(cwd).status, 0)
  const junk = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" })
  assert.equal(junk.status, 0)
})

test("only the ask tool is judged — nothing else routed here is ever blocked", () => {
  assert.equal(ask(makeRepo(LIVE), "Bash").status, 0)
})

test("each host's ask tool is the one its hooks.json routes here", () => {
  // The matcher and the dialect are a writer/matcher pair across two files: a
  // host whose hooks.json routes a tool name the hook does not recognise (or the
  // reverse) is a control that exists and never fires.
  for (const [host, file] of [
    ["claude", path.join(HERE, "hooks.json")],
    ["qwen", path.join(HERE, "..", "..", "qwen", "hooks", "hooks.json")],
  ]) {
    const json = JSON.parse(fs.readFileSync(file, "utf8"))
    const entry = json.hooks.PreToolUse.find((e) => (e.hooks ?? []).some((h) => String(h.command).includes("check-stage-ask.mjs")))
    assert.ok(entry, `${host} does not route the stage-ask deny at all`)
    assert.match(dialectFor(host).askTool, new RegExp(`^(?:${entry.matcher})$`), `${host}'s matcher does not cover its own ask tool`)
  }
})

test("the qwen host refuses its own ask tool under a live marker", () => {
  const cwd = makeRepo({ ...LIVE, file: ".stage-qwen.json" })
  const res = ask(cwd, "ask_user_question", { AGENTIC_WORKFLOW_HOST: "qwen" })
  assert.equal(res.status, 2)
  assert.match(res.stderr, /cannot ask the user/)
})
