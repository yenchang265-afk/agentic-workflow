import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const source = () => fs.readFileSync(path.join(pkgDir, "src", "server.ts"), "utf8")

// The doc comments quote the very phrases these lints hunt for; strip them so a
// comment can never satisfy — or trip — an assertion about emitted code.
const code = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trimStart()
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*")
    })
    .join("\n")

/** Collapse wrapped expressions so a `note:` and its arguments read as one string. */
const flat = (src: string) => code(src).replace(/\n\s*/g, " ")

/** The body of one registerTool call, from its name literal to the next registration. */
const toolBody = (src: string, name: string) => src.slice(src.indexOf(`"${name}",`)).split("server.registerTool(")[0] ?? ""

// Every fire payload has always carried the configured stage model, but the
// notes that tell the orchestrator what to spawn once named only `agent` — so
// workflows.<kind>.stageModels was dropped at each hop and every stage ran the
// host default. Source-level because the notes are inline literals in a module
// that only boots as an MCP transport. Stronger than asserting each note happens
// to mention the model: no note may be hand-written at all, so a spawn site added
// later cannot omit the clause without deleting the composer call.
test("every spawn instruction the server emits is composed by spawnNote, so none can name `agent` without `model`", () => {
  const src = source()
  assert.match(
    code(src),
    /const spawnNote = \([\s\S]{0,160}\$\{SPAWN_TOOL_NOTE\}\$\{SPAWN_MODEL_NOTE\}/,
    "the composer must splice both notes — that is the whole guarantee",
  )
  const notes = [...flat(src).matchAll(/\bnote:\s*(.{0,240})/g)].map((m) => m[1]).filter((n): n is string => !!n && /spawn/i.test(n))
  assert.ok(notes.length >= 6, `expected every spawn note to be found; got ${notes.length}`)
  for (const note of notes) {
    assert.match(note, /spawnNote\(/, `a spawn note bypasses the composer and can omit the model:\n  ${note.trim()}`)
    // A note whose value opens with a literal is hand-written prose — the exact
    // shape that dropped the model before. A ternary picking between spawnNote
    // calls is fine, so gate on the opening token rather than on the whole value.
    assert.doesNotMatch(note, /^\s*[`"']/, `a spawn note is a hand-written literal, not a composed one:\n  ${note.trim()}`)
  }
})

// workflow_stage is called immediately before EVERY stage spawn of every kind, so
// its response is the last thing read before the Task call — and for a non-plan
// fire the only spawn instruction that is not several tool calls back. It used to
// carry `model` with no instruction to pass it.
test("the workflow_stage response carries a spawn instruction, not only the check-stage verdict reminder", () => {
  const src = code(source())
  const body = toolBody(src, "workflow_stage")
  assert.match(body, /note: spawnNote\(/, "the response must instruct the spawn, model included")
  assert.doesNotMatch(body, /\.\.\.\(def\.kind === "check"\s*\?\s*\{\s*note:/, "the note must not be gated on the stage kind")
  // The reminder moved into the shared tail when the note became composed; assert
  // both halves, or a composed note could quietly drop it.
  assert.match(body, /CHECK_VERDICT_TAIL/, "a check stage must still get the verdict reminder, now as the composed tail")
  assert.match(src, /const CHECK_VERDICT_TAIL =[\s\S]{0,300}workflow_verdict/, "the tail must still name the workflow_verdict tool")
})

// A non-plan fire — BUILD entry via workflow_start/workflow_claim, and every
// sitter's entry stage — used to arrive with `model` in the payload and no note
// at all, because the note key was gated on the plan stage.
test("firePayload's spawn note is not gated on the plan stage", () => {
  const src = code(source())
  const body = src.slice(src.indexOf("const firePayload"), src.indexOf("// --- server + tools ---"))
  assert.match(body, /^\s*note:/m, "the note must be an unconditional key of the payload")
  assert.doesNotMatch(body, /\.\.\.\(state\.stage === "plan"/, "a spread-gated note leaves every non-plan fire with none")
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
