import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { dialectFor } from "./src/dialect.mjs"
import { agentNameOf, decideSpawnGuard, spawnDriftMessage } from "./src/spawn-guard.mjs"

/**
 * The spawn-stage guard: the deterministic link that stops a model-driven host
 * from running a stage the state machine has not reached.
 *
 * The bug this closes is one-directional, and so are the tests. `workflow_stage`
 * → spawn → `workflow_advance` is driven by a MODEL on Claude Code and Qwen, and
 * skipping a call leaves the machine at VERIFY while a REVIEW subagent runs — the
 * review is paid for in full and then discarded, because `workflow_verdict`
 * rejects it as stage drift. So the property under test is not "the guard
 * notices"; it is "the guard notices BEFORE the subagent runs, and every
 * uncertainty resolves to allowing the spawn".
 *
 * That asymmetry is the thing most easily lost in a refactor: a false allow only
 * restores the behaviour that shipped before this hook, while a false deny
 * refuses a spawn the protocol needed and stalls a run that has no way to
 * recover. Hence the long allow-side table below — it is the interesting half.
 */

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-spawn-stage.mjs")

const ARMED = {
  kind: "engineering",
  stage: "verify",
  agent: "workflow-verify",
  kindAgents: ["workflow-plan-author", "workflow-build", "workflow-verify", "workflow-review"],
}

// --- the pure decision ---

test("the armed agent is allowed", () => {
  assert.equal(decideSpawnGuard(ARMED, "workflow-verify"), "allow")
})

test("a SIBLING stage agent of the live kind is blocked — the reported bug", () => {
  // The loop is at verify; spawning the review agent means workflow_advance was
  // never called, and the review's verdict would be refused after the fact.
  assert.equal(decideSpawnGuard(ARMED, "workflow-review"), "block")
  assert.equal(decideSpawnGuard(ARMED, "workflow-build"), "block")
})

test("every uncertainty resolves to allow", () => {
  for (const [what, marker, agent] of [
    ["no marker at all — an ordinary session, not a loop", null, "workflow-review"],
    ["a marker that is not an object", "{}", "workflow-review"],
    ["an agent this plugin does not ship", ARMED, null],
    // A crashed server never runs writeStageMarker(null); its leftover marker
    // must not refuse every later stage spawn in the repo forever.
    ["a marker past its deadline", { ...ARMED, deadline: Date.now() - 60_000 }, "workflow-review"],
    // Written before this guard existed: it cannot tell a sibling stage agent
    // from an unrelated one, and guessing in the deny direction refuses
    // legitimate spawns.
    ["a marker with no kindAgents", { stage: "verify", agent: "workflow-verify" }, "workflow-review"],
    ["a kindAgents that is not an array", { ...ARMED, kindAgents: "workflow-review" }, "workflow-review"],
    // workflow-task-author is ours but backs no stage — spawning it during an
    // interview is not a protocol violation.
    ["a workflow-* agent that is not a stage of this loop", ARMED, "workflow-task-author"],
  ]) {
    assert.equal(decideSpawnGuard(marker, agent), "allow", what)
  }
})

test("a live deadline still guards; a deadline-less marker stays trusted", () => {
  assert.equal(decideSpawnGuard({ ...ARMED, deadline: Date.now() + 60_000 }, "workflow-review"), "block")
  assert.equal(decideSpawnGuard(ARMED, "workflow-review"), "block")
})

test("an expired marker whose writer still runs is a LATE loop, and still guards", () => {
  // The module's docstring claimed "the same liveness rule as check-stage-guard"
  // while implementing a weaker one — expiry alone allowed. A loop past its
  // deadline with a running writer is genuinely live, so a sibling spawn against
  // it is the same protocol drift; the probe is injected because this module
  // stays import-free.
  const expired = { ...ARMED, deadline: Date.now() - 60_000 }
  const alive = () => true
  const dead = () => false
  assert.equal(decideSpawnGuard(expired, "workflow-review", Date.now(), alive), "block")
  assert.equal(decideSpawnGuard(expired, "workflow-review", Date.now(), dead), "allow", "a crashed run's leftover never refuses a spawn")
  // No probe at all keeps the previous, weaker reading — a caller that cannot
  // judge liveness loses nothing.
  assert.equal(decideSpawnGuard(expired, "workflow-review"), "allow")
})

test("the refusal names both stages and both calls, so the next attempt succeeds", () => {
  const message = spawnDriftMessage(ARMED, "workflow-review")
  assert.match(message, /workflow-review/)
  assert.match(message, /verify/)
  assert.match(message, /workflow-verify/)
  // Without BOTH names the orchestrator re-runs workflow_stage, gets
  // stageOrderError, and has learned nothing new.
  assert.match(message, /workflow_advance/)
  assert.match(message, /workflow_stage/)
})

test("the refusal survives a marker missing the fields it quotes", () => {
  // Unreachable through decideSpawnGuard, but a message that throws would turn a
  // block into an unhandled crash — which the entry's catch turns into an ALLOW.
  assert.doesNotThrow(() => spawnDriftMessage(null, "workflow-review"))
  assert.doesNotThrow(() => spawnDriftMessage({}, "workflow-review"))
})

// --- agentNameOf, shared with the spawn-model stamp ---

test("agentNameOf strips a host prefix and rejects anything not ours", () => {
  const prefixes = ["agentic-workflow:", "mcp__plugin_agentic-workflow_agentic-workflow__"]
  assert.equal(agentNameOf("agentic-workflow:workflow-build", prefixes), "workflow-build")
  assert.equal(agentNameOf("mcp__plugin_agentic-workflow_agentic-workflow__workflow-build", prefixes), "workflow-build")
  assert.equal(agentNameOf("workflow-build", prefixes), "workflow-build") // Qwen passes it bare
  assert.equal(agentNameOf("workflow-build", []), "workflow-build")
  for (const foreign of ["general-purpose", "Explore", "statusline-setup", "", undefined, 42]) {
    assert.equal(agentNameOf(foreign, prefixes), null, String(foreign))
  }
})

// --- the built hook, over the real stdin/exit-code contract ---

const makeRepo = (marker) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-stage-"))
  if (marker !== undefined) {
    fs.mkdirSync(path.join(cwd, "docs", "tasks", "runs"), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, "docs", "tasks", "runs", marker.__file ?? ".stage.json"),
      typeof marker === "string" ? marker : JSON.stringify(marker),
    )
  }
  return cwd
}

const run = (cwd, subagent_type, { tool_name = "Agent", host } = {}) =>
  spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd, tool_name, tool_input: { description: "run it", prompt: "…", subagent_type } }),
    encoding: "utf8",
    env: { ...process.env, AGENTIC_WORKFLOW_USER_CONFIG: "", ...(host === undefined ? {} : { AGENTIC_WORKFLOW_HOST: host }) },
  })

test("the built hook blocks a drifted spawn with exit 2 and an explanatory stderr", () => {
  const out = run(makeRepo(ARMED), "agentic-workflow:workflow-review")
  assert.equal(out.status, 2, out.stderr)
  assert.match(out.stderr, /refusing to spawn/)
  assert.match(out.stderr, /workflow_advance/)
})

test("the built hook allows the armed spawn", () => {
  const out = run(makeRepo(ARMED), "agentic-workflow:workflow-verify")
  assert.equal(out.status, 0, out.stderr)
  // Never an envelope: the stamp hook shares this matcher, and two PreToolUse
  // hooks rewriting one tool_input is undocumented behaviour.
  assert.equal(out.stdout.trim(), "")
})

test("a non-spawn tool is never judged", () => {
  for (const tool_name of ["Bash", "Edit", "Write", "mcp__agentic-workflow__workflow_stage"]) {
    assert.equal(run(makeRepo(ARMED), "agentic-workflow:workflow-review", { tool_name }).status, 0, tool_name)
  }
})

test("the legacy Task spelling is guarded too", () => {
  // Task was renamed Agent in 2.1.63 and is still an alias; a rename that
  // silently stopped matching would disable the guard without failing anything.
  assert.equal(run(makeRepo(ARMED), "agentic-workflow:workflow-review", { tool_name: "Task" }).status, 2)
})

test("a malformed marker allows rather than crashing the spawn", () => {
  assert.equal(run(makeRepo("{ not json"), "agentic-workflow:workflow-review").status, 0)
})

test("no marker allows — the ordinary session case", () => {
  assert.equal(run(makeRepo(), "agentic-workflow:workflow-review").status, 0)
})

test("an unknown host fails OPEN, unlike check-stage-guard", () => {
  // The deliberate divergence: that guard exits 2 on an unknown host because a
  // wrong dialect disarms every rule it enforces, so guessing is worse than
  // refusing. This hook's whole job IS refusing — guessing here would stall every
  // loop in the session over a typo'd env var.
  const out = run(makeRepo(ARMED), "agentic-workflow:workflow-review", { host: "bogus" })
  assert.equal(out.status, 0, out.stderr)
})

test("Qwen reads its own marker and guards its own spawn tool", () => {
  // Its `agent` tool passes the name bare, and its marker is a different file —
  // an empty `spawn` list or the wrong marker path would silently disable the
  // guard on that host while every layer reported healthy.
  const cwd = makeRepo({ ...ARMED, __file: ".stage-qwen.json" })
  assert.equal(run(cwd, "workflow-review", { tool_name: "agent", host: "qwen" }).status, 2)
  assert.equal(run(cwd, "workflow-verify", { tool_name: "agent", host: "qwen" }).status, 0)
  // Claude's tool names are not Qwen's.
  assert.equal(run(cwd, "workflow-review", { tool_name: "Agent", host: "qwen" }).status, 0)
})

// --- hook wiring: an unrouted guard guards nothing ---

const HERE = path.dirname(fileURLToPath(import.meta.url))
const hooksJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
const entryFor = (json, bundle) => {
  const entry = json.hooks.PreToolUse.find((e) => (e.hooks ?? []).some((h) => String(h.command).includes(bundle)))
  assert.ok(entry, `no PreToolUse entry runs ${bundle}`)
  return entry
}

test("the guard is routed to each host's spawn tool", () => {
  // The whole mechanism is "the spawn does not happen". Unrouted, it never runs
  // and the drift goes back to surfacing as a rejected verdict after a stage's
  // work is already spent — with nothing failing to say so.
  for (const [file, host] of [
    [path.join(HERE, "hooks.json"), "claude"],
    [path.join(HERE, "..", "..", "qwen", "hooks", "hooks.json"), "qwen"],
  ]) {
    const matcher = new RegExp(`^(?:${entryFor(hooksJson(file), "check-spawn-stage.mjs").matcher})$`)
    for (const tool of dialectFor(host).spawn) assert.ok(matcher.test(tool), `${tool} is not routed to the guard on ${host}`)
  }
})

test("the guard shares the stamp's matcher but never its envelope", () => {
  // They deliberately overlap on Claude — both judge the same spawn — which is
  // only safe because exactly one of them emits `updatedInput`. Two hooks
  // rewriting one tool_input is undocumented behaviour, so this is the property
  // that must hold, not disjointness.
  const claude = hooksJson(path.join(HERE, "hooks.json"))
  assert.equal(entryFor(claude, "check-spawn-stage.mjs").matcher, entryFor(claude, "stamp-spawn-model.mjs").matcher)
  const source = fs.readFileSync(path.join(HERE, "src", "check-spawn-stage.entry.mjs"), "utf8")
  assert.ok(!source.includes("rewriteInput"), "the guard must never emit an updatedInput envelope")
})
