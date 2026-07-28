import type { GateResult, SaveTaskResponse } from "../../shared/api.js"

/**
 * How a server answer should look and how loudly it should be announced.
 *
 * Pure and separate from the components, because the interesting case has
 * nothing to do with rendering: core answers a *successful* ship whose pull
 * request could not be opened with `ok: true, variant: "warning"`. Hardcoding
 * "ok is green" would paint that caveat the same colour as a clean ship, and it
 * is the one outcome a human most needs to notice. There is no DOM test harness
 * in this package, so the rule lives where `node --test` can reach it.
 */

export type Tone = "info" | "ok" | "warn" | "error"

/** Whether a tone is worth interrupting a screen reader for. */
export const isAssertive = (tone: Tone): boolean => tone === "warn" || tone === "error"

const fromVariant = (variant: "info" | "warning" | undefined, fallback: Tone): Tone =>
  variant === "warning" ? "warn" : variant === "info" ? "info" : fallback

/**
 * A gate move's outcome. A refusal (`ok: false`) is data, not a failure — core
 * explains why and the board is unchanged — so it warns rather than erroring;
 * `error` is reserved for a request that never got an answer.
 */
export const gateTone = (result: GateResult): Tone =>
  result.ok ? fromVariant(result.variant, "ok") : fromVariant(result.variant, "warn")

/**
 * A task save. The `ok: true` case can still carry a failed retask — the edit
 * landed but the task did not move back to draft/ — which is exactly the
 * half-done outcome that must not read as a clean success.
 */
export const saveTaskTone = (result: SaveTaskResponse): Tone =>
  result.ok ? (result.retask && !result.retask.ok ? "warn" : "ok") : fromVariant(result.variant, "warn")
