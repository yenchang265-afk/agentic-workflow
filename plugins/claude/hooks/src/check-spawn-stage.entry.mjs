#!/usr/bin/env node
/**
 * SOURCE of the PreToolUse spawn-stage guard. `npm run build:hooks`
 * (scripts/build-hooks.mjs) esbuild-bundles this file into the self-contained
 * ../check-spawn-stage.mjs that hooks.json runs, and the Qwen twin. Never edit
 * the bundled output.
 *
 * The policy, and why the failure preference is what it is, lives in
 * ./spawn-guard.mjs. In one line: on a host with no driver, spawning a stage
 * agent the live marker has not armed means a `workflow_advance` /
 * `workflow_stage` call was skipped, and the stage that runs anyway has its
 * verdict rejected as drift after the fact.
 *
 * Deliberately a SEPARATE hook from stamp-spawn-model.entry.mjs even though both
 * match the spawn tool. Two reasons, and hooks.json records them: that one only
 * ever emits an `updatedInput` envelope and this one never does (two hooks
 * rewriting the same tool_input is undocumented behaviour, so they must not be
 * merged into one that does both); and their failure preferences are opposites —
 * the stamp is a convenience binding that fails open on absolutely everything,
 * this one refuses a call. Same reasoning that split check-evidence from
 * check-stage-guard.
 *
 * Contract: exit 0 allows; exit 2 blocks and feeds stderr back to the model.
 */
import { dialectFor, hostFor } from "./dialect.mjs"
import { readMarker } from "./marker.mjs"
import { allow, block, readStdin } from "./pretooluse.mjs"
import { agentNameOf, decideSpawnGuard, spawnDriftMessage } from "./spawn-guard.mjs"
import { failOpen } from "./crash.mjs"

const main = async () => {
  let input
  try {
    input = JSON.parse(await readStdin())
  } catch {
    return allow()
  }

  // An unknown host fails OPEN here, unlike check-stage-guard.entry.mjs. That
  // guard exits 2 because a wrong dialect disarms every rule it enforces, so
  // guessing is worse than refusing. This one's whole job IS refusing: guessing
  // would refuse spawns rather than let them through, and stalling every loop in
  // a session over a typo'd env var is the worse of the two failures.
  const d = dialectFor(hostFor())
  if (!d) return allow()
  if (!d.spawn.includes(input.tool_name)) return allow()

  const ti = input.tool_input || {}
  const agent = agentNameOf(ti.subagent_type, d.agentPrefixes)
  if (!agent) return allow()

  const marker = readMarker(input.cwd || process.cwd(), d.stageMarkerFile)
  if (decideSpawnGuard(marker, agent) !== "block") return allow()
  return block(spawnDriftMessage(marker, agent))
}

main().catch(failOpen("check-spawn-stage"))
