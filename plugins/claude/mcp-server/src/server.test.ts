import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// Every fire payload has always carried the configured stage model, but the
// notes that tell the orchestrator what to spawn once named only `agent` — so
// workflows.<kind>.stageModels was dropped at each hop and every stage ran the
// host default. Source-level because the notes are inline literals in a module
// that only boots as an MCP transport: assert no spawn instruction can lose
// the model again.
test("every spawn instruction in the server's notes names the `model` field, not just `agent`", () => {
  const src = fs.readFileSync(path.join(pkgDir, "src", "server.ts"), "utf8")
  const spawnNotes = src
    .split("\n")
    .filter((line) => /note:|"spawn|spawn the/.test(line) && /spawn/.test(line))
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
  assert.ok(spawnNotes.length >= 4, `expected the spawn notes to be found; got ${spawnNotes.length}`)
  for (const line of spawnNotes) {
    assert.match(
      line,
      /SPAWN_MODEL_NOTE|`model`/,
      `a spawn instruction omits the model — the configured stageModels model would be dropped:\n  ${line.trim()}`,
    )
  }
})

// A done whose park failed (core's TerminalReport says stop — the task never
// left in-progress/) must not announce the ship gate. Source-level for the same
// reason as above: the advance handler is an inline literal in a module that
// only boots as an MCP transport.
test("workflow_advance gates the ship-gate payload on the terminal report, not the action alone", () => {
  const src = fs.readFileSync(path.join(pkgDir, "src", "server.ts"), "utf8")
  assert.match(src, /const report = await runTerminal\(action\)/, "the advance handler must consume runTerminal's report")
  assert.match(
    src,
    /action\.kind !== "done" \|\| report\?\.kind === "done"/,
    "the ship gate must require the report to confirm the park landed",
  )
})

// --- the degraded-model channels, asserted source-level for the reason above ---

test("every FIRE site composes through firePrompt, so each attempt is issued its own nonce", () => {
  // A fire that called composePrompt directly would hand the subagent a prompt
  // with no nonce (or, worse, the previous attempt's), silently disabling the
  // backup channel for that stage. workflow_compose is the one deliberate
  // exception: an idempotent read must reuse the armed nonce, never mint one.
  const src = fs.readFileSync(path.join(pkgDir, "src", "server.ts"), "utf8")
  const direct = src
    .split("\n")
    .filter((line) => /composePrompt\(/.test(line))
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .filter((line) => !/^import /.test(line.trimStart()))
    .filter((line) => !/const firePrompt =/.test(line))
  assert.deepEqual(
    direct.map((l) => l.trim()),
    ["return composePrompt(loaded, verdictNonce ? { ...state, verdictNonce } : state, stage)", "return ok({ prompt: composePrompt(activeManifest(), verdictNonce ? { ...active, verdictNonce } : active, stage) })"],
    "only firePrompt's own body and workflow_compose may call composePrompt directly",
  )
  // The four fire sites: the fresh-claim payload, the no-verdict re-fire, the
  // next-stage fire in workflow_advance, and workflow_recover's BUILD re-entry.
  assert.ok(src.split("firePrompt(").length - 1 >= 4, "every fire site must route through firePrompt")
})

test("the backup block channel is read only after the tool channel came up empty, and the tool wins", () => {
  const src = fs.readFileSync(path.join(pkgDir, "src", "server.ts"), "utf8")
  assert.match(src, /kind === "check" && !pending\)\s*\{\s*\n[\s\S]{0,400}?parseVerdictBlock/, "the block is read only when `pending` is empty")
  assert.match(src, /verdictNonce \? parseVerdictBlock\(/, "an unarmed stage must never read a block")
})

test("a rejected verdict keeps its axes in the partial slot, never in `pending`", () => {
  const src = fs.readFileSync(path.join(pkgDir, "src", "server.ts"), "utf8")
  assert.match(src, /if \(!admission\.ok\)\s*\{[\s\S]{0,300}?pendingPartialAxes = admission\.partialAxes/)
  // `pending` may only ever be assigned from the ok branch's record.
  for (const line of src.split("\n").filter((l) => /^\s*pending = /.test(l))) {
    assert.match(line, /pending = (null|admission\.record|\{)/, `pending assigned from an unadmitted value:\n  ${line.trim()}`)
  }
})

test("the retry budget comes from config, and the nonce is cleared when the stage ends", () => {
  const src = fs.readFileSync(path.join(pkgDir, "src", "server.ts"), "utf8")
  assert.match(src, /verdictRetries < config\.verdictRetries/, "the budget must be configurable, not hardcoded")
  assert.match(src, /verdictNonce = "" \/\/ the stage is over/, "a finished stage's nonce must not validate a later block")
  assert.match(src, /redactNonce\(stageOutput, verdictNonce\)/, "the nonce must be scrubbed from the durable artifact")
})

// Boot the server from source over stdio with an immediately-closed stdin: it
// must announce readiness on stderr (stdout stays clean for the MCP protocol)
// and exit on its own when the transport sees EOF.
test("server boots, announces readiness on stderr, and exits on stdin EOF", async () => {
  const proc = spawn(process.execPath, ["--import", "tsx", path.join(pkgDir, "src", "server.ts")], {
    cwd: pkgDir,
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  proc.stdout.on("data", (d) => (stdout += d))
  proc.stderr.on("data", (d) => (stderr += d))
  proc.stdin.end()

  const exited = new Promise<number | null>((resolve) => proc.on("close", resolve))
  const timeout = setTimeout(() => proc.kill("SIGKILL"), 30_000)
  const code = await exited
  clearTimeout(timeout)

  assert.notEqual(code, null, `server was killed after 30s without exiting; stderr:\n${stderr}`)
  assert.match(stderr, /agentic-workflow MCP server ready/)
  assert.equal(stdout, "", "stdout must stay clean for the MCP protocol")
})
