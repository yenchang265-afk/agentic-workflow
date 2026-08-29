import type { GateCtx } from "@agentic-workflow/core/workflow/gate"
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

/**
 * Per-command cap on the shell a gate move runs — design 21's bound on
 * OpenCode, design 42's on the model hosts, and now here, because the hub is
 * the THIRD surface making the same moves and was the one still making them on
 * a raw shell. The hang class is host-agnostic and this surface is the worst
 * place for it: `routes/gate.ts` runs `approveTask`/`approvePlan`/`replanTask`/
 * `shipTask` inside an HTTP request, and the ship arm shells out to `git push`
 * and `gh pr create`. One hung git command on a slow tree pends the request
 * forever with the task file possibly already moved — design 21's incident,
 * replayed with a mouse: a spinner over work that is done.
 *
 * Same value and same reasoning as the two hosts: generous, because the slowest
 * legitimate gate command is the ship's push, and cutting one short costs a
 * caveated ship a human can finish by hand — where not capping costs a request
 * that never returns. `.timeout` resolves exit 124, which core reads as an
 * ordinary failed command, so the move still reports and only its best-effort
 * bookkeeping is skipped.
 *
 * Deliberately NOT applied to `deps.sh` at large: the doctor's repairs and the
 * hub's own git reads carry their own regime, exactly as the hosts leave their
 * plain `$` alone.
 */
const GATE_SHELL_TIMEOUT_MS = 60_000

const boundedGateSh =
  (sh: HubDeps["sh"]): HubDeps["sh"] =>
  (strings, ...exprs) => {
    // `.timeout` is optional on the host interface; the hub's shell ships it,
    // but degrade to the unbounded call rather than crash if that changes.
    const p = sh(strings, ...exprs)
    return p.timeout?.(GATE_SHELL_TIMEOUT_MS) ?? p
  }

export const gateCtx = async (deps: HubDeps, now: Date = new Date()): Promise<GateCtx> => {
  const oracle = await makeDrivingOracle(deps, now)
  return {
    $: boundedGateSh(deps.sh),
    client: deps.client,
    log: deps.log,
    directory: deps.directory,
    config: deps.config,
    isDriving: oracle.isDriving,
  }
}
