import type { GateCtx } from "@agentic-loop/core/loop/gate"
import type { HubDeps } from "./deps.js"
import { makeDrivingOracle } from "./driving.js"

/**
 * Adapt `HubDeps` to core's `GateCtx` — the seam that lets the hub call the same
 * gate entry points both hosts use (`approveTask`, `approvePlan`, `replanTask`,
 * `shipTask`) instead of re-implementing the moves.
 *
 * `GateCtx`'s docstring anticipates exactly this: it asks each host to answer
 * `isDriving` its own way, naming "the on-disk stage marker" as how a host
 * without an in-memory session map would do it. The hub is that host — see
 * driving.ts, which reads claims as well as the marker.
 *
 * The rename is the whole adapter: the hub calls its shell `sh`, core calls it `$`.
 */
export const gateCtx = async (deps: HubDeps, now: Date = new Date()): Promise<GateCtx> => {
  const oracle = await makeDrivingOracle(deps, now)
  return {
    $: deps.sh,
    client: deps.client,
    log: deps.log,
    directory: deps.directory,
    config: deps.config,
    isDriving: oracle.isDriving,
  }
}
