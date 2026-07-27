#!/usr/bin/env node
/**
 * SOURCE of the PreToolUse spawn-model stamp. `npm run build:hooks`
 * (scripts/build-hooks.mjs) esbuild-bundles this file — inlining the
 * @agentic-workflow/core config readers — into the self-contained
 * ../stamp-spawn-model.mjs that hooks.json runs. Never edit the bundled output.
 *
 * WHAT THIS FIXES
 *
 * `stageModels` and `agentModels` used to reach a subagent spawn as ENGLISH:
 * the MCP response carried a `model` field and the prose asked the orchestrating
 * model to please pass it to the spawn tool. A prompt is a request, not a
 * binding — and it was already ignored once, silently, with every stage running
 * the host default while the config said otherwise (see spawn-model-binding.test.mjs).
 * This hook removes the model from that negotiation: it rewrites the spawn
 * call's `model` before the tool runs, so obeying is not optional.
 *
 * WHERE THE MODEL COMES FROM, in precedence order:
 *
 *  1. the live stage marker's `stageAgentModels` (the server resolved
 *     `workflows.<kind>.stageModels` + the manifest, and parked the answer);
 *  2. `agentModels.<agent>` read straight off the config layers.
 *
 * Marker first is not arbitrary: `agentModels` exists for spawns that are NOT
 * stage runs, so letting it win would let it retarget a stage — the bleed the
 * two settings are separate to prevent.
 *
 * WHY IT FAILS OPEN, EVERYWHERE
 *
 * Unlike check-stage-guard.entry.mjs, which fails CLOSED because guessing
 * disarms a security control, this hook is a convenience binding. Refusing every
 * subagent spawn in a session because an env var is typo'd or a config file has
 * a stray comma is far worse than running the host's default model. Every step
 * below therefore falls through to `allow()`, and `main` swallows any throw.
 *
 * Contract: exit 0 allows; a rewrite is emitted only when a model genuinely resolves.
 */
import { rawAgentModel, readRawConfigLayers, spawnAlias } from "@agentic-workflow/core/config-layers"
import { dialectFor, hostFor } from "./dialect.mjs"
import { readMarker, readTasksDir } from "./marker.mjs"
import { allow, readStdin, rewriteInput } from "./pretooluse.mjs"

/** Agents this plugin ships are all `workflow-*`; nothing else may be retargeted. */
const OURS = /^workflow-[a-z0-9-]+$/

/**
 * The bare agent name behind a `subagent_type`, or null when it is not one of
 * ours. Stripping the host's plugin prefix is what makes
 * `agentic-workflow:workflow-build` match; the `OURS` test is what stops
 * `agentModels: {"general-purpose": "opus"}` from hijacking a host built-in the
 * user never meant to rebind.
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
 * The model to bind for `agent`, or null to leave the spawn alone.
 *
 * The result is an ALIAS, not a model id: Claude Code's spawn tool validates
 * `model` against `sonnet|opus|haiku|fable`, and a value outside that set does
 * not degrade to the default — it fails the tool's schema and errors the whole
 * spawn. So an unmappable config value must resolve to null here. `spawnAlias`
 * owns that mapping; see its docstring.
 */
export const modelFor = (marker, rawConfig, agent) => {
  const fromMarker = marker && typeof marker === "object" ? marker.stageAgentModels : null
  const staged = fromMarker && typeof fromMarker === "object" ? fromMarker[agent] : null
  const configured = staged ?? rawAgentModel(rawConfig, agent)
  return spawnAlias(configured)
}

const main = async () => {
  let input
  try {
    input = JSON.parse(await readStdin())
  } catch {
    return allow()
  }

  const d = dialectFor(hostFor())
  // Unknown host, or a host whose spawn tool takes no per-call model (Qwen bakes
  // it into the installed agent file instead). Nothing to do either way.
  if (!d || !d.conveysSpawnModel) return allow()
  if (!d.spawn.includes(input.tool_name)) return allow()

  const ti = input.tool_input || {}
  const agent = agentNameOf(ti.subagent_type, d.agentPrefixes)
  if (!agent) return allow()

  const cwd = input.cwd || process.cwd()
  const marker = readMarker(cwd, readTasksDir(cwd), d.stageMarkerFile)
  const model = modelFor(marker, readRawConfigLayers(cwd), agent)
  if (!model) return allow()
  // Already correct — emitting an envelope would only add noise to the transcript.
  if (ti.model === model) return allow()

  // Spread the original: `updatedInput` REPLACES tool_input wholesale.
  return rewriteInput({ ...ti, model })
}

main().catch(() => allow())
