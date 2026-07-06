import { registerClaimPredicate } from "../manifest/registry.js"
import { isClaimable } from "../task/store.js"

/**
 * The engineering loop kind's TS escape hooks — everything its manifest
 * (`loops/engineering/loop.json`) names by ref. Hosts call this once at
 * startup before polling.
 *
 * Note: the manifest also names `validateBeforeTransition.plan =
 * "engineering.planLandedOnDisk"`; that check needs backlog IO and stays in
 * each host's park handler (they re-read the task file and verify the
 * `## Implementation Plan` heading landed) rather than in this registry.
 */
export const registerEngineeringHooks = (): void => {
  registerClaimPredicate("engineering.isClaimable", isClaimable)
}
