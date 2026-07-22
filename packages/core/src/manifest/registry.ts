import type { WorkflowState } from "../workflow/state.js"
import type { Task } from "../task/schema.js"
import type { TemplateContext } from "./template.js"

/**
 * The TS escape hatch for logic a manifest can't express. Hooks are plain
 * functions registered under `"<kind>.<name>"` refs; manifests point at them
 * by ref (`hooks.compose`, `hooks.validateBeforeTransition`). Workflow kinds
 * shipping with core register theirs at import time; external kinds register
 * from their host plugin before the first drive.
 */

/** Augment (or replace) a stage's prompt-template context before rendering. */
export type ComposeHook = (ctx: TemplateContext, state: WorkflowState) => TemplateContext

/**
 * Veto a terminal transition (park/done) when its side conditions don't hold —
 * e.g. engineering's "the PLAN stage must have actually written a plan onto
 * the task file". Returns an error message to veto, or null to allow. Hosts
 * run these (they need IO); the engine itself stays pure.
 */
export type ValidateHook = (state: WorkflowState) => Promise<string | null> | string | null

/** Whether a backlog task is claimable for a manifest pool (`pools[].claimPredicate`). */
export type ClaimPredicate = (task: Task) => boolean

const composeHooks = new Map<string, ComposeHook>()
const validateHooks = new Map<string, ValidateHook>()
const claimPredicates = new Map<string, ClaimPredicate>()

export const registerComposeHook = (ref: string, hook: ComposeHook): void => void composeHooks.set(ref, hook)
export const registerValidateHook = (ref: string, hook: ValidateHook): void => void validateHooks.set(ref, hook)

/** Resolve a compose hook by ref; throws on a dangling manifest reference. */
export const resolveComposeHook = (ref: string): ComposeHook => {
  const hook = composeHooks.get(ref)
  if (!hook) throw new Error(`unknown compose hook "${ref}" — register it before driving this workflow kind`)
  return hook
}

/** Resolve a validate hook by ref (null when the manifest names none); throws on a dangling reference. */
export const resolveValidateHook = (ref: string | undefined): ValidateHook | null => {
  if (!ref) return null
  const hook = validateHooks.get(ref)
  if (!hook) throw new Error(`unknown validate hook "${ref}" — register it before driving this workflow kind`)
  return hook
}

export const registerClaimPredicate = (ref: string, predicate: ClaimPredicate): void =>
  void claimPredicates.set(ref, predicate)

/** Resolve a claim predicate by ref; throws on a dangling manifest reference. */
export const resolveClaimPredicate = (ref: string): ClaimPredicate => {
  const predicate = claimPredicates.get(ref)
  if (!predicate) throw new Error(`unknown claim predicate "${ref}" — register it before polling this workflow kind`)
  return predicate
}
