/**
 * Pure decision for the PreToolUse spawn-stage guard (check-spawn-stage).
 *
 * WHAT THIS FIXES
 *
 * OpenCode has a driver, so its loop cannot get out of step with itself. Claude
 * Code and Qwen have none: an orchestrating MODEL calls
 * `workflow_stage` → spawn → `workflow_advance` for every stage AND every
 * fan-out pass, and the server's own spawn note records that `workflow_stage`
 * and the spawn are routinely emitted as two tool_use blocks in one turn. Skip
 * one call and the state machine sits at VERIFY while a REVIEW subagent runs.
 *
 * The only thing that noticed was `workflow_verdict`, refusing the finished
 * review with "The loop is at verify, not review" — a whole stage paid for and
 * discarded, then a no-verdict retry, then an ERROR stop. `stageOrderError` is
 * the earlier tripwire but it can only fire if `workflow_stage` is called at
 * all, which is exactly what the drifting orchestrator skipped.
 *
 * So the enforcement is the SPAWN: a stage agent of the active kind may only be
 * spawned while the live marker has armed it. The drift is then caught before a
 * subagent runs rather than after it has done a stage's worth of work, and the
 * refusal names the call that was skipped.
 *
 * WHY IT FAILS OPEN EVERYWHERE EXCEPT A PROVEN MISMATCH
 *
 * The asymmetry is the point: a false ALLOW only restores the behaviour that
 * shipped before this hook, while a false DENY refuses a spawn the protocol
 * needed and stalls the run. So every uncertainty — no marker, an expired one, a
 * marker written by a version that did not carry `kindAgents`, an agent this
 * plugin does not ship — resolves to "allow". Only a spawn that is provably a
 * SIBLING stage agent of the live, armed kind is blocked, and even then the
 * message names the two calls that unblock it, so no run can wedge.
 *
 * Keep this file dependency-free (no imports at all) so a test can import it
 * under bare `node --test`, matching ./allowlist.mjs and ./dialect.mjs.
 */

/** Agents this plugin ships are all `workflow-*`; nothing else is ours to judge. */
const OURS = /^workflow-[a-z0-9-]+$/

/**
 * The bare agent name behind a `subagent_type`, or null when it is not one of
 * ours. Stripping the host's plugin prefix is what makes
 * `agentic-workflow:workflow-build` match; the `OURS` test is what stops a host
 * built-in (or `agentModels: {"general-purpose": …}`) from being treated as a
 * stage agent.
 *
 * Lives HERE rather than in stamp-spawn-model.entry.mjs, which used to own it:
 * two hooks now read the same `subagent_type` off the same tool call, and a
 * second copy of the prefix-stripping is a second thing to forget when a host
 * changes how it namespaces plugin agents.
 */
export const agentNameOf = (subagentType, prefixes = []) => {
  if (typeof subagentType !== "string") return null
  let name = subagentType.trim()
  for (const prefix of prefixes) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length)
      break
    }
  }
  return OURS.test(name) ? name : null
}

/**
 * What the guard should do with a spawn: "allow", or "block".
 *
 * `agent` is the bare name from `agentNameOf` (null ⇒ not ours ⇒ allow).
 *
 * A marker past its `deadline` is a crashed run's leftover — a SIGKILLed server
 * never runs `writeStageMarker(null)` — and must not refuse every later stage
 * spawn in the repo forever. A marker with no deadline (an older version) stays
 * trusted.
 *
 * `writerAlive` is the SAME liveness rule check-stage-guard applies, injected
 * because this module stays import-free: an expired marker whose writer is
 * still running is a genuinely live loop, however late, and a spawn against it
 * is still the protocol drift this guard exists to catch. The docstring claimed
 * that parity for a while and the code did not have it — the default keeps the
 * previous, weaker reading, so a caller that cannot probe loses nothing.
 */
export const decideSpawnGuard = (marker, agent, now = Date.now(), writerAlive = () => false) => {
  if (!agent) return "allow" // not one of this plugin's agents
  if (!marker || typeof marker !== "object") return "allow" // no loop stage — an ordinary session
  if (typeof marker.deadline === "number" && now > marker.deadline && !writerAlive(marker)) return "allow" // a dead loop's leftover
  const kindAgents = Array.isArray(marker.kindAgents) ? marker.kindAgents : null
  // Written by a version that predates this guard: it cannot tell a sibling
  // stage agent from an unrelated one, and guessing in the deny direction would
  // refuse legitimate spawns. Allow, exactly as before this hook existed.
  if (!kindAgents) return "allow"
  if (!kindAgents.includes(agent)) return "allow" // a workflow-* agent that is not a stage of this loop
  return agent === marker.agent ? "allow" : "block"
}

/**
 * The refusal fed back to the orchestrator (stderr, exit 2).
 *
 * It has to make the NEXT attempt succeed, so it names both halves of what went
 * wrong — the stage the machine is actually at, and the agent that was about to
 * run — and both calls, in order. Wording deliberately mirrors
 * `stageOrderError` (mcp-server/src/stage-guard.ts): an orchestrator that has
 * seen one of these messages should recognise the other.
 */
export const spawnDriftMessage = (marker, agent) =>
  `agentic-workflow: refusing to spawn "${agent}" — the loop is at "${String(marker?.stage ?? "?")}" and has armed ` +
  `"${String(marker?.agent ?? "?")}", so this stage was never started. Nothing has gone wrong with the work: a step of the ` +
  `orchestration protocol was skipped, and running "${agent}" now would do a whole stage's work that the loop then throws ` +
  `away — its workflow_verdict is rejected as stage drift because the state machine is still at "${String(marker?.stage ?? "?")}". ` +
  `Call workflow_advance with the finished "${String(marker?.stage ?? "?")}" stage's output first, then workflow_stage for the ` +
  `stage the returned action names (once per entry in its \`passes\` array, if it has one), and spawn the agent THAT response ` +
  `names. If "${agent}" really is the next stage, both calls will succeed and this spawn will be allowed.`
