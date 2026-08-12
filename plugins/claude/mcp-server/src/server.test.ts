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

// The marker's second manifest-derived spawn fact, and the one that closes the
// reported bug: with no driver on this host, an orchestrating model owns
// workflow_stage -> spawn -> workflow_advance, and skipping a call leaves the
// machine at VERIFY while a REVIEW subagent runs — its verdict then rejected as
// drift after a whole stage was paid for. The PreToolUse spawn guard blocks that
// spawn, and it can only tell a sibling stage agent from an unrelated one if the
// server parks the kind's agents here (a bundled hook cannot read a manifest).
test("the stage marker carries kindAgents, so the spawn guard can recognise a sibling stage's agent", () => {
  const src = code(source())
  assert.match(src, /const stageAgents = \(m: LoadedManifest\): string\[\]/, "the resolver must exist")
  assert.match(src, /kindAgents: stageAgents\(m\)/, "writeStageMarker must emit the set")
  // Both fields are needed and neither substitutes for the other: `kindAgents`
  // answers "is this a stage of the running loop", `agent` answers "is it the one
  // armed right now". Dropping either turns the guard into a no-op or a source of
  // false denials.
  assert.match(src, /agent: def\.agent/, "the armed agent must stay on the marker")
  // Deduped: an agent backing two stages of one kind (workflow-verify does, across
  // kinds) must not appear twice.
  const resolver = src.slice(src.indexOf("const stageAgents = "))
  assert.match(resolver.slice(0, resolver.indexOf("\n")), /new Set/)
})

// The drift was audited on the task file and nowhere else — and on this host the
// thing that caused it (the driving model) never reads the task file. So a REVIEW
// that ran and was discarded looked, from the orchestrator's seat, exactly like a
// REVIEW that had not run yet: it would re-report the dropped findings as the
// loop's own.
test("workflow_advance reports a refused out-of-stage verdict back to the orchestrator", () => {
  const src = code(source())
  // The record, not a boolean: the advice names what drifted.
  assert.match(src, /let drifted: \{ readonly requested: string; readonly verdict: Verdict \} \| null/)
  assert.match(src, /drifted = \{ requested: stage, verdict \}/, "the verdict handler must capture the drift")
  // Captured BEFORE advance moves active.stage, or the advice names the stage the
  // loop moved on to rather than the one that refused the verdict.
  const advance = toolBody(src, "workflow_advance")
  const capture = advance.indexOf("stageDriftAdvice(stage,")
  assert.ok(capture > -1, "workflow_advance must compose the advice")
  assert.ok(capture < advance.indexOf("advance(activeManifest()"), "the advice must be composed before the transition")
  // EVERY arm that hands back an action carries it — a retry arm is exactly where
  // a drifting orchestrator lands, so missing one there defeats the point, and
  // "which arms carry it" is not a judgement call worth re-litigating per arm.
  assert.equal((advance.match(/ok\(/g) ?? []).length, (advance.match(/ok\(withDrift\(/g) ?? []).length, "an ok() arm that skips withDrift silently drops the report")
  assert.equal((advance.match(/ok\(withDrift\(/g) ?? []).length, 6, "the arm count changed — confirm the new arm carries the drift")
  assert.match(advance, /drifted = null/, "the transition must clear it")
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
    /const freshStage = fanoutStage !== stage \|\| !pass\.focus/,
    "the fresh-arming test must still be `this is not the next pass of the same fan-out`",
  )
  assert.match(
    body,
    /if \(freshStage\) \{ pending = null/,
    "the wipe must be conditional on this not being the next pass of the same fan-out",
  )
  assert.equal(
    (body.match(/pending = null/g) ?? []).length,
    1,
    "a second, unguarded wipe anywhere in the handler discards every pass but the last",
  )
})

// Where the checks run is the whole correctness argument: in the work tree the
// stage is about to judge (so AFTER isolation), before the stage is armed (so
// their results can reach its prompt), and once per fresh arming (so a five-axis
// review costs one test suite, not five).
test("workflow_stage runs the stage's checks after isolation and once per fresh arming", () => {
  const body = flat(toolBody(code(source()), "workflow_stage"))
  const isolate = body.indexOf("ensureIsolation(")
  const checks = body.indexOf("runStageChecks(active, stage)")
  const marker = body.indexOf("writeStageMarker(stage)")
  assert.ok(isolate >= 0 && checks >= 0 && marker >= 0, "all three steps must be present")
  assert.ok(isolate < checks, "checks must run in the isolated work tree, not the human's checkout")
  assert.ok(checks < marker, "checks must run before the stage is armed and its prompt handed out")
  assert.match(body, /if \(freshStage\) \{ try \{ active = await runStageChecks/, "a focused pass must reuse the fresh arming's results")
})

// A stage whose checks ran needs its prompt RE-composed: the fire payload was
// composed a turn earlier by workflow_advance, so it cannot carry exit codes
// from commands that had not run yet.
test("workflow_stage hands back a re-composed prompt when the stage ran checks", () => {
  const body = flat(toolBody(code(source()), "workflow_stage"))
  assert.match(body, /const checked = \(active\.checks\?\.\[stage\]\?\.length \?\? 0\) > 0/)
  assert.match(body, /checked \? \{ prompt: firePrompt\(activeManifest\(\), active, stage\) \}/)
  assert.match(body, /checked \? "spawn the subagent named in the `agent` field with THIS response's `prompt`/)
})

// workflow_compose is an agent-callable, idempotent READ. Running a test suite
// per call is unacceptable, and re-running would also make the prompt it returns
// disagree with the one the stage was actually given.
test("workflow_compose reuses recorded check results and never runs a check", () => {
  const body = toolBody(code(source()), "workflow_compose")
  assert.doesNotMatch(body, /runChecks|runStageChecks/, "compose must never run a command")
  assert.match(body, /composePrompt\(activeManifest\(\), active, stage, config\)/, "it composes from state, which carries the results")
})

// Finalizing (floor + all-unassessed guard, one bundled call) at finalization
// rather than inside admitVerdict: a pre-seeded check axis would flow through
// blockingFindingsIssue and get a genuine agent PASS REJECTED rather than
// derived down.
test("workflow_advance finalizes the admitted verdict with the checks, and admission is left alone", () => {
  const advanceBody = flat(toolBody(code(source()), "workflow_advance"))
  assert.match(advanceBody, /pending = finalizeCheckRecord\(pending, active\.checks\?\.\[stage\] \?\? \[\]\)/)
  const verdictBody = flat(toolBody(code(source()), "workflow_verdict"))
  assert.doesNotMatch(verdictBody, /withCheckFloor|finalizeCheckRecord/, "the admission contract must stay exactly as it was")
})

// A rejected verdict is not "nothing happened": the channel worked and the SHAPE
// was refused. Before this, a review that FAILED with an unadmittable shape left
// `pending` empty, the host re-fired the same review, and the second refusal
// became ERROR — so `review.onError` stopped the run and the findings never
// reached the BUILD they were for ("another REVIEW, and we never go back to
// BUILD"). The refused record has to be KEPT for the fallback to have anything
// to route on.
test("workflow_verdict keeps the refused record, not just the fact of a refusal", () => {
  const body = flat(toolBody(code(source()), "workflow_verdict"))
  // Rejections MERGE worst-wins — keeping only the last one let a rejected
  // FAIL vanish behind a later rejected PASS and ERROR-stop the run.
  assert.match(body, /verdictRejected = mergeRejected\(verdictRejected, \{ record: rec, message: admission\.message \}\)/)
  assert.doesNotMatch(body, /verdictRejected = true/, "a boolean cannot be routed on")
})

test("every loop entry and terminal path resets the pass-arming scratch through the one helper", () => {
  // `armedPass`/`fanoutStage` used to be reset only on a stage transition, so a
  // loop stopped mid-fan-out left `fanoutStage` armed: the NEXT loop's REVIEW
  // read `freshStage === false` and silently skipped `runStageChecks` for the
  // whole stage, while a straggler verdict could be admitted against the stale
  // pass's narrowed axes. One helper, called everywhere, so the next entry
  // point cannot forget a field.
  const body = code(source())
  assert.match(body, /const resetLoopScratch = /)
  const calls = body.match(/resetLoopScratch\(\)/g) ?? []
  assert.ok(calls.length >= 8, `startTask, startPlan, workflow_claim, workflow_recover, runPark (3 exits) and runTerminal must all reset — found ${calls.length} calls`)
})

test("workflow_advance routes a twice-rejected verdict on what the stage declared", () => {
  const body = flat(toolBody(code(source()), "workflow_advance"))
  assert.match(body, /const salvaged = rejectedFallback\(verdictRejected\)/)
  assert.match(body, /pending = salvaged \?\?/, "the ERROR is the fallback of the fallback, not the first answer")
  // `rejectedFallback` returns null for an effective PASS, so the ERROR arm still
  // catches the unearned PASS — and it must no longer blame plugin wiring for a
  // channel that answered twice.
  assert.match(body, /reason: noAdmissibleVerdictReason\(\{ rejected: verdictRejected, prose \}\)/)
  assert.doesNotMatch(body, /the verdict channel is unreachable from the stage subagent/, "that wording lives in core now, behind the rejected/silent split")
})

// A focused pass owes ONE axis. Admitting it against the stage's full
// requirement rejects every fan-out pass for the axes it was told not to review
// — and rejects every reviewLenses pass on this host too, which is a bug that
// predates fan-out.
test("workflow_verdict admits a pass against that pass's own axes, not the stage's", () => {
  const body = toolBody(code(source()), "workflow_verdict")
  assert.match(body, /admitVerdict\(rec, passAxes\(def, currentPass\(stage\)\), pending, evidenceCtx, criteriaCtx\)/)
  assert.doesNotMatch(body, /admitVerdict\(rec, def\.requiredAxes/, "the stage-wide requirement belongs on the accumulated record")
})

// The criteria gate is STAGE-level (an axis-less check stage), never per-pass:
// keying it on `passAxes` would bind lens passes of an axis-bearing stage. And
// the seeded check commands must reach admission as their own channel — merged
// into the observed ledger they could corroborate a PASS from a stage that did
// nothing itself.
test("workflow_verdict derives the criteria context from the stage def and the task, and seeds evidence separately", () => {
  const body = flat(toolBody(code(source()), "workflow_verdict"))
  assert.match(body, /stageRequiresCriteria\(def\)/)
  assert.match(body, /acceptance: active\?\.task\?\.acceptance \?\? \[\]/)
  assert.match(body, /seeded: checkCommands\(active\?\.checks\?\.\[stage\] \?\? \[\]\)/)
})

test("observedEvidence folds the ledger only — the seeded commands are no longer merged into it", () => {
  const body = code(source())
  const fn = body.slice(body.indexOf("const observedEvidence = "), body.indexOf("const agentRef = "))
  assert.doesNotMatch(fn, /checkCommands/, "seeding is derivation at the admission call, not mutation of the observation set")
})

// The run-time half of the zero-checks signal: the park forecast covers plans
// parked after it shipped; a plan approved before it (or a config changed since)
// reaches the fire with nothing on disk. One core helper owns predicate and
// phrasing for both hosts.
test("runStageChecks notes provenance through the shared helper, discovery-gated", () => {
  const body = flat(code(source()))
  assert.match(body, /const note = checksProvenanceNote\(\{/)
  assert.match(body, /discovering: discoverChecksFor\(config, activeManifest\(\)\.manifest\.kind, stageDef\(activeManifest\(\)\.manifest, stage\)\)/)
  assert.doesNotMatch(body, /source !== "discovered" \|\| warnings\.length > 0/, "the inline predicate must not survive beside the helper")
})

// Narrowing admission per pass gives up the stage-wide guarantee, so it has to
// be picked back up somewhere. On this host that somewhere is load-bearing, not
// defensive: the ORCHESTRATOR owns the pass loop and can simply skip a spawn,
// which no per-call check can ever see.
test("workflow_advance gates a fan-out on the accumulated axis coverage, and a gap is ERROR not FAIL", () => {
  const body = toolBody(code(source()), "workflow_advance")
  assert.match(body, /uncoveredAxes\(pending, gateDef\.requiredAxes\)/, "the gate must read the accumulated record")
  assert.match(flat(body), /: withCoverageGap\(pending, gaps\)/, "a gap must degrade to ERROR, never to a FAIL that rebuilds")
  // …except when the record was SALVAGED from a rejected declaration: a
  // rejected verdict is not a missing one, and converting the salvaged FAIL
  // back to ERROR undid the salvage the spent retry just bought — the run
  // stopped on `review.onError` instead of feeding BUILD the findings.
  assert.match(flat(body), /pending = salvagedFail \?/, "a salvaged FAIL must survive the coverage gate as FAIL")
  assert.match(flat(body), /gaps\.length && retryableByFocus && !verdictRetried/, "the missing passes get one retry before the stage errors")
  // Retryable whenever the gap names a resolvable focus: axis passes by
  // construction, and a lens set naming the axes verbatim (the only lens shape
  // enforcesAxisCoverage turns the gate on for). A gap naming no pass still
  // goes straight to ERROR.
  assert.match(flat(body), /gatePasses\.some\(\(p\) => p\.mode === "axis"\) \|\| \(gaps\.length > 0 && gaps\.every\(\(g\) => passFoci\.has\(g\)\)\)/)
  assert.match(flat(body), /enforcesAxisCoverage\(config, activeManifest\(\)\.manifest\.kind, gateDef\)/, "the gate is the shared predicate, not an inline mode test")
  assert.match(flat(body), /passes: gaps/, "the retry must name exactly the passes that recorded nothing")
  assert.match(flat(body), /armedPass = null/, "the retry arms its own pass; the finished one is already sampled")
})

// The no-verdict retry's own instruction has to be followable: on a stage that
// runs focused passes, workflow_stage refuses an unfocused call, so a bare
// "call workflow_stage" note was a deterministic dead end — the orchestrator
// had to guess a focus or abandon the retry.
test("the no-verdict retry names the stage's passes when the stage runs focused ones", () => {
  const body = flat(toolBody(code(source()), "workflow_advance"))
  assert.match(body, /retryLabels\.length \? \{ passes: retryLabels \}/, "the retry payload must carry the pass labels")
  assert.match(body, /focus:"<pass>"\}\) and spawn the stage subagent again for EACH pass/, "…and the note must say to arm each one")
})

// The retry note tells the orchestrator to call workflow_stage before
// re-spawning — and workflow_stage's fresh-arming wipe then destroyed the kept
// rejection, so a FAIL rejected twice ERRORed blaming a channel that answered
// both times. The wipe must skip the armed-retry window.
test("workflow_stage preserves the kept rejection while a retry is armed", () => {
  const body = flat(toolBody(code(source()), "workflow_stage"))
  assert.match(body, /if \(!verdictRetried\) verdictRejected = null/, "the rejection wipe must be gated on no retry pending")
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
    // `deadline` is the check-phase override (runStageChecks advertises the
    // check budget before the first check); the pinned part is the RETURN type —
    // a failure reason, not void.
    /const writeStageMarker = \(stage: string \| null, deadline\?: number\): string \| null =>/,
    "it must return a failure reason, not void",
  )
  const body = code(src).slice(code(src).indexOf("const writeStageMarker"))
  const fn = body.slice(0, body.indexOf("\n}\n") + 3)
  assert.match(fn, /return \(err as Error\)\.message/, "the catch must surface the error, not discard it")
  assert.match(fn, /fs\.rmSync\(stageMarkerPath\(\), \{ force: true \}\)/, "a failed arm must clear the stale marker")
  assert.doesNotMatch(fn, /catch \{\s*\/\* best-effort \*\/\s*\}\s*\}$/, "no silent best-effort swallow")
})

// `bashAllowlistExtra` is the per-project escape hatch for a runner (or a
// command-rewriting proxy) the manifests cannot know. The base-length guard is
// the load-bearing half: an empty base means the stage is UNRESTRICTED, and
// appending extras there would restrict it to just the extras.
test("the stage marker's allowlist appends bashAllowlistExtra only when the stage declares a base", () => {
  const body = code(source()).slice(code(source()).indexOf("const writeStageMarker"))
  const fn = flat(body.slice(0, body.indexOf("\n}\n") + 3))
  assert.match(fn, /const base = effectiveAllowlist\(def, platform\)/, "extras extend the effective allowlist, they never replace it")
  assert.match(
    fn,
    /base\.length \? withCommandPrefixes\(\[\.\.\.base, \.\.\.bashAllowlistExtras\(config\)\], prefixes\)/,
    "extras must be gated on a non-empty base — an unrestricted stage stays unrestricted",
  )
})

// The prefixes ride the marker because a bundled hook can read neither the
// config nor a manifest, and the guard needs them to strip a rewriting proxy's
// prefix before classifiers that anchor on the bare tool name run.
test("the stage marker carries bashPrefix, and omits the field when none is configured", () => {
  const body = code(source()).slice(code(source()).indexOf("const writeStageMarker"))
  const fn = flat(body.slice(0, body.indexOf("\n}\n") + 3))
  assert.match(fn, /const prefixes = bashAllowlistPrefixes\(config\)/)
  assert.match(
    fn,
    /\.\.\.\(prefixes\.length \? \{ bashPrefix: prefixes \} : \{\}\)/,
    "an unset key must write no field at all — the guard reads its absence as the previous behaviour",
  )
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
