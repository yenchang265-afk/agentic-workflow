#!/usr/bin/env node
/**
 * SOURCE of the PreToolUse stage-ask deny. `pnpm run build:hooks`
 * (scripts/build-hooks.mjs) bundles this into ../check-stage-ask.mjs; never edit
 * the bundled output by hand.
 *
 * NO STAGE MAY ASK THE HUMAN. A drive is unattended between the plan gate and
 * the ship gate, so a question dialog opened mid-VERIFY stalls the run on
 * someone who may not be at the terminal — on a `watch` worker, on nobody at
 * all. A stage's uncertainty has channels that keep the loop's control flow: a
 * FAIL/ERROR verdict, a criterion marked not met, `workflow_blocked`.
 *
 * OpenCode enforces this in three layers, and the third — the plugin's own
 * runtime refusal — is the only one that does not depend on a host config key
 * behaving as documented, and the only one covering a USER-ADDED kind's stage
 * agent. This host had no equivalent: the shipped agents' `tools:` enumeration
 * excludes the ask tool by construction, but that is a property of the files
 * this repo ships, checked by a test that runs only in this repo. An agent added
 * to a consuming repo's own workflow kind, omitting `tools:`, inherits every
 * tool the host offers — and no PreToolUse matcher could ever see the ask tool,
 * so nothing would refuse it.
 *
 * **Its own hook, not a branch in check-stage-guard.** That guard fails CLOSED
 * on an unknown host, which is right when a wrong dialect would disarm a
 * default-deny allowlist; here the same reflex would refuse a HUMAN's legitimate
 * question over a typo'd env var. Same split, same reasoning, as check-evidence.
 *
 * FAILS OPEN on every uncertainty — an unknown host, no marker, a crashed run's
 * leftover marker, an unreadable one. A false allow only restores what predates
 * this hook (the enumeration still covers every agent this repo ships); a false
 * deny refuses a question nobody else can answer.
 *
 * Contract: exit 0 allows; exit 2 blocks and feeds stderr back to the model.
 */
import { failOpen } from "./crash.mjs"
import { dialectFor, hostFor } from "./dialect.mjs"
import { liveMarker, readMarker } from "./marker.mjs"
import { allow, block, readStdin } from "./pretooluse.mjs"

/**
 * The refusal a stage agent reads at the moment it errs — which is worth more
 * than a line of prose carried in every stage's context forever, and is why no
 * stage prompt says this. Wording mirrors the OpenCode plugin's runtime deny.
 */
export const stageAskRefusal = (stage) =>
  `agentic-workflow: the ${String(stage ?? "current").toUpperCase()} stage cannot ask the user — the loop drives unattended ` +
  `between the plan gate and the ship gate, so a question here stalls the run on someone who may not be at the terminal. ` +
  `Resolve it from the code, or record the uncertainty where the loop can act on it: a FAIL/ERROR verdict (check stages) or ` +
  `workflow_blocked (work stages). A human sees your reasoning at the next gate.`

const main = async () => {
  let input
  try {
    input = JSON.parse(await readStdin())
  } catch {
    return allow()
  }
  const d = dialectFor(hostFor())
  if (!d) return allow()
  if (input.tool_name !== d.askTool) return allow()
  // `liveMarker`, so a crashed run's leftover cannot silence the human's own
  // questions for the rest of the repo's life — the same rule every other
  // marker-scoped control here reads.
  const marker = liveMarker(readMarker(input.cwd || process.cwd(), d.stageMarkerFile))
  if (!marker) return allow() // no loop stage — an ordinary session asks freely
  return block(stageAskRefusal(marker.stage))
}

main().catch(failOpen("check-stage-ask"))
