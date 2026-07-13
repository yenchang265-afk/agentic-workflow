import { registerClaimPredicate, registerValidateHook } from "../manifest/registry.js"
import { isClaimable } from "../task/store.js"

/**
 * The engineering loop kind's TS escape hooks — everything its manifest
 * (`loops/engineering/loop.json`) names by ref. Hosts call this once at
 * startup before polling.
 *
 * Note: `validateBeforeTransition.plan = "engineering.planLandedOnDisk"` is
 * registered as a pass-through: the real check needs backlog IO (a shell and
 * the task file) beyond the ValidateHook signature, so `terminal.ts` runPark
 * performs it inline. Registering the ref keeps `resolveValidateHook` strict —
 * a dangling ref in any manifest fails loudly instead of silently skipping.
 */
export const registerEngineeringHooks = (): void => {
  registerClaimPredicate("engineering.isClaimable", isClaimable)
  registerValidateHook("engineering.planLandedOnDisk", () => null)
}
