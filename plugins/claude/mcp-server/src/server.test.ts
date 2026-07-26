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
  // Both clauses now come from HOST_DIALECT. The composer's guarantee only holds
  // if every dialect actually declares them: a host that omits `spawnModelNote`
  // would splice `undefined` into every spawn note. A host that genuinely cannot
  // convey a model declares `""` — an explicit empty, which this still catches
  // the absence of.
  const dialects = [...code(src).matchAll(/^ {2}(claude|qwen): \{$/gm)].map((m) => m[1]).filter((h): h is string => !!h)
  assert.ok(dialects.length >= 2, `expected every host dialect to be found; got ${dialects.length}`)
  for (const host of dialects) {
    const body = code(src).slice(code(src).indexOf(`  ${host}: {`))
    const entry = body.slice(0, body.indexOf("\n  },"))
    assert.match(entry, /spawnToolNote:/, `the ${host} dialect declares no spawnToolNote`)
    assert.match(entry, /spawnModelNote:/, `the ${host} dialect declares no spawnModelNote`)
  }
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

/** Boot the server with an env overlay and return how it went. */
const boot = async (env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  const proc = spawn(process.execPath, ["--import", "tsx", path.join(pkgDir, "src", "server.ts")], {
    cwd: pkgDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
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
  return { code, stdout, stderr }
}

// The same binary serves the Qwen host; only HOST_DIALECT differs. If it did not
// boot under that env, the Qwen host would have no server at all.
test("server boots under AGENTIC_WORKFLOW_HOST=qwen", async () => {
  const { code, stdout, stderr } = await boot({ AGENTIC_WORKFLOW_HOST: "qwen" })
  assert.notEqual(code, null, `server was killed after 30s without exiting; stderr:\n${stderr}`)
  assert.match(stderr, /agentic-workflow MCP server ready/)
  assert.equal(stdout, "", "stdout must stay clean for the MCP protocol")
})

// A typo'd host must not fall back to Claude: on the wrong dialect every spawn
// targets a subagent_type that does not exist, and the failure surfaces much
// later as "the loop is broken" rather than as the config error it is.
test("an unknown AGENTIC_WORKFLOW_HOST fails the boot loudly instead of defaulting", async () => {
  const { code, stderr } = await boot({ AGENTIC_WORKFLOW_HOST: "claude-code" })
  assert.notEqual(code, 0, "an unrecognized host must not boot")
  assert.match(stderr, /AGENTIC_WORKFLOW_HOST="claude-code" is not a known host/)
})

// Shell wrappers and installers propagate empty env vars routinely, so an empty
// value means "not specified", not "typo" — refusing to boot on one would turn
// a harmless quirk into a hard failure.
test("an empty AGENTIC_WORKFLOW_HOST is treated as absent and boots the default host", async () => {
  const { code, stderr } = await boot({ AGENTIC_WORKFLOW_HOST: "" })
  assert.notEqual(code, null, `server was killed after 30s without exiting; stderr:\n${stderr}`)
  assert.match(stderr, /agentic-workflow MCP server ready/)
})
