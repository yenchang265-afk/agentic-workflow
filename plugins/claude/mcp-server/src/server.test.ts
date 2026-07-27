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

// The stage marker is now the DETERMINISTIC channel for stageModels: the
// PreToolUse stamp (plugins/claude/hooks/src/stamp-spawn-model.entry.mjs) reads
// `stageAgentModels` off it and rewrites the spawn call's `model`, so the
// orchestrator's cooperation stops mattering. The hook cannot resolve this
// itself — manifest/dir.ts locates the workflows dir from `import.meta.url` and
// build-hooks.mjs inlines core into the bundle, so that walk lands on the hook's
// own directory — which is why the server has to park the answer here.
test("the stage marker carries stageAgentModels, resolved by the same stageModel the payload uses", () => {
  const src = code(source())
  assert.match(src, /const stageAgentModels = \(m: LoadedManifest\)/, "the resolver must exist")
  // Keyed by AGENT over the whole kind, not the current stage: workflow_advance
  // returns the next stage's fire payload without rewriting the marker, so a
  // current-stage field would be stale for exactly the spawn that follows an
  // advance — a VERIFY-FAIL → BUILD re-fire would drop BUILD's model silently.
  assert.match(src, /for \(const def of m\.manifest\.stages\)[\s\S]{0,200}out\[def\.agent\] = model/, "the map must cover every stage agent of the kind")
  assert.match(src, /stageAgentModels: stageAgentModelMap/, "writeStageMarker must emit the map")
  // One resolver feeding both channels, so the marker and the payload cannot drift.
  const resolver = src.slice(src.indexOf("const stageAgentModels = "))
  assert.match(resolver.slice(0, resolver.indexOf("\n}")), /stageModel\(m\.manifest\.kind, def\)/)
})

// Claude Code's spawn tool validates `model` against sonnet|opus|haiku|fable and
// errors the WHOLE spawn on a miss rather than falling back, so the server must
// hand out an alias, never a model id. Emitting `bareModel(...)` here described a
// call the tool would reject for any config naming a real id; it stayed invisible
// only because the prose carrying it was being ignored.
test("stageModel resolves to a spawn alias, not a bare model id", () => {
  const src = code(source())
  const fn = src.slice(src.indexOf("const stageModel = "))
  const body = fn.slice(0, fn.indexOf("\n}"))
  assert.match(body, /spawnAlias\(modelFor\(config, kind, def\)\)/)
  assert.doesNotMatch(body, /bareModel/, "a bare model id is not a value the spawn tool accepts")
})

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

// --- per-axis fan-out ---
// Source-level for the same reason as the notes above: the handlers are inline
// literals in a module that only boots as an MCP transport, so there is no seam
// to call them through. These pin the invariants that are silent when broken.

// THE trap of this feature. workflow_stage is called before EVERY pass, and it
// used to wipe `pending` unconditionally ("a fresh stage starts empty"). Under
// fan-out that throws away every earlier pass's axis the moment the next one is
// armed, so the coverage gate would ERROR on four axes on every single run —
// with nothing in the logs to say why.
test("workflow_stage keeps the accumulated verdict while a fan-out is still running", () => {
  const body = flat(toolBody(code(source()), "workflow_stage"))
  assert.match(
    body,
    /if \(fanoutStage !== stage \|\| !pass\.focus\) \{ pending = null/,
    "the wipe must be conditional on this not being the next pass of the same fan-out",
  )
  assert.equal(
    (body.match(/pending = null/g) ?? []).length,
    1,
    "a second, unguarded wipe anywhere in the handler discards every pass but the last",
  )
})

// A focused pass owes ONE axis. Admitting it against the stage's full
// requirement rejects every fan-out pass for the axes it was told not to review
// — and rejects every reviewLenses pass on this host too, which is a bug that
// predates fan-out.
test("workflow_verdict admits a pass against that pass's own axes, not the stage's", () => {
  const body = toolBody(code(source()), "workflow_verdict")
  assert.match(body, /admitVerdict\(rec, passAxes\(def, currentPass\(stage\)\), pending\)/)
  assert.doesNotMatch(body, /admitVerdict\(rec, def\.requiredAxes/, "the stage-wide requirement belongs on the accumulated record")
})

// Narrowing admission per pass gives up the stage-wide guarantee, so it has to
// be picked back up somewhere. On this host that somewhere is load-bearing, not
// defensive: the ORCHESTRATOR owns the pass loop and can simply skip a spawn,
// which no per-call check can ever see.
test("workflow_advance gates a fan-out on the accumulated axis coverage, and a gap is ERROR not FAIL", () => {
  const body = toolBody(code(source()), "workflow_advance")
  assert.match(body, /uncoveredAxes\(pending, gateDef\.requiredAxes\)/, "the gate must read the accumulated record")
  assert.match(body, /pending = withCoverageGap\(pending, gaps\)/, "a gap must degrade to ERROR, never to a FAIL that rebuilds")
  assert.match(flat(body), /gaps\.length && !verdictRetried/, "the missing passes get one retry before the stage errors")
  assert.match(flat(body), /passes: gaps/, "the retry must name exactly the passes that recorded nothing")
  assert.match(flat(body), /armedPass = null/, "the retry arms its own pass; the finished one is already sampled")
})

// The orchestrator could otherwise call workflow_stage once with no focus, spawn
// one reviewer, and advance — a fan-out in config that never happened in fact.
test("workflow_stage refuses an unfocused call on a stage that runs focused passes", () => {
  const body = flat(toolBody(code(source()), "workflow_stage"))
  assert.match(body, /if \(!focus && labels\.length\)/, "an unfocused call on a fan-out stage must be rejected")
  assert.match(body, /focused passes, not one/, "the rejection must say what to call instead")
  assert.match(body, /workflow_stage\(\{stage:"\$\{stage\}", focus:/, "…including the corrected call itself")
  // A focused pass needs its own prompt: the fire payload composed one for the
  // stage, and each pass has to be told which axis is its own.
  assert.match(body, /passFocusBlock\(pass, index, passes\.length\)/)
})

// The hub keys its per-pass panels on `lens`, and workflow_advance runs ONCE for
// the whole stage — so without a sample as each pass is superseded, N passes
// collapse into one row and every per-pass metric on this host is a lie.
test("each fan-out pass is sampled as the next one is armed", () => {
  const body = flat(toolBody(code(source()), "workflow_stage"))
  assert.match(body, /armedPass\?\.stage === stage && armedPass\.pass\.focus/, "the finished pass is sampled when its successor arms")
  assert.match(body, /lens: armedPass\.pass\.focus/, "an axis rides the existing `lens` slot")
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

// The stage marker is this host's ONLY deterministic enforcement input: the
// PreToolUse guard reads it for the bash allowlist, the worktree pin and the
// stage deadline (threat-model T8/T1). It used to be written best-effort inside
// a bare `catch {}` while `workflow_stage` returned ok(...) regardless — so a
// failed write left the PREVIOUS stage's marker armed and a check stage ran
// under BUILD's unrestricted list, with every layer reporting success.
test("writeStageMarker reports its failures instead of swallowing them", () => {
  const src = source()
  assert.match(
    code(src),
    /const writeStageMarker = \(stage: string \| null\): string \| null =>/,
    "it must return a failure reason, not void",
  )
  const body = code(src).slice(code(src).indexOf("const writeStageMarker"))
  const fn = body.slice(0, body.indexOf("\n}\n") + 3)
  assert.match(fn, /return \(err as Error\)\.message/, "the catch must surface the error, not discard it")
  assert.match(fn, /fs\.rmSync\(stageMarkerPath\(\), \{ force: true \}\)/, "a failed arm must clear the stale marker")
  assert.doesNotMatch(fn, /catch \{\s*\/\* best-effort \*\/\s*\}\s*\}$/, "no silent best-effort swallow")
})

test("workflow_stage refuses a stage whose marker it could not arm", () => {
  const body = flat(toolBody(source(), "workflow_stage"))
  assert.match(
    body,
    /const markerError = writeStageMarker\(stage\) if \(markerError\) \{ return fail\(/,
    "an unarmed stage must not be reported as started",
  )
})

// workflow_move is the low-level escape hatch, but it moved the file straight
// out from under a live loop: `active.task.path` then pointed at a path that no
// longer existed, so every later appendNote/snapshot/terminal move missed and
// the claim marker was orphaned in the folder the task had left.
test("workflow_move enforces the same liveness guards as every other move", () => {
  const body = flat(toolBody(source(), "workflow_move"))
  assert.match(body, /resolveTaskIdAnywhere\(/, "the short-hash handle resolves here like everywhere else")
  assert.match(body, /active\?\.task\?\.id === id/, "a task a live loop drives must be refused")
  assert.match(body, /listClaimIds\(/, "a held claim marker must be refused")
  assert.match(body, /catch \(err\) \{ return fail\(/, "a thrown move must not escape the ok/fail contract")
})
