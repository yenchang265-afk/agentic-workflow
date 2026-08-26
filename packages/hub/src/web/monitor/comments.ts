/**
 * Anchored review comments → the one-line `reason` a gate move carries.
 *
 * The reason is not decoration: it is the only thing that reaches the next pass.
 * `replanTask` writes it into the task's audit note, which the PLAN prompt reads
 * back as "why the prior plan failed"; `retaskTask` does the same for the
 * authoring interview. So each comment has to carry its own context — a bare
 * "this is wrong" is useless three stages later, which is why the anchor text is
 * quoted alongside it.
 *
 * One line, because core's `appendNote` writes a single `> …` blockquote
 * (core's `oneLineReason` in workflow/gate.ts flattens whitespace and bounds
 * the length as a second guard on every writer's path).
 *
 * Pure — tested in comments.test.ts.
 */

/** Which file the comment was left on — a replan reason may mix both. */
export type CommentTarget = "task" | "plan"

export interface AnchoredComment {
  /** Block id from the Markdown parse (`L12`) — the key comments are stored under. */
  readonly id: string
  readonly target: CommentTarget
  /** The block's leading text, quoted back so the next pass knows what was meant. */
  readonly anchor: string
  readonly note: string
}

/** Anchors are quoted into a one-line reason, so a long block gets an ellipsis. */
const ANCHOR_MAX = 60

/** A comment's note at full comfort — the cap each note gets when the whole reason fits. */
const NOTE_MAX = 400

/** The floor a squeezed note never goes below — a quote with no room for its point is noise. */
const NOTE_MIN = 40

/**
 * The reason budget. This is core's `REPLAN_REASON_MAX` (workflow/gate.ts) —
 * `oneLineReason` clips anything longer with an ellipsis, which used to eat
 * the TAIL comments whole: three average anchored comments compose past 1200,
 * so the drawer invited per-line comments and then silently never sent the
 * later ones to the next PLAN pass. Declared here (not imported) because this
 * file is browser-bundled and core is node-flavoured; comments.test.ts pins
 * the two constants equal so they cannot drift.
 */
export const REASON_BUDGET = 1200

const clip = (text: string, max = ANCHOR_MAX): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

const line = (c: AnchoredComment, noteMax: number): string => `${c.target} “${clip(c.anchor)}”: ${clip(c.note, noteMax)}`

const JOINER = "; "

const sendable = (comments: readonly AnchoredComment[]): AnchoredComment[] => comments.filter((c) => c.note.trim() !== "")

/**
 * Compose the gate `reason`, inside the budget. Comments with no note are
 * dropped — an opened and abandoned composer must not send an empty quote
 * downstream. When the comfortable composition would blow the budget, the
 * note allotment is divided evenly instead so EVERY comment survives clipped
 * — losing the tail of each note beats losing the last comments entirely,
 * which is the vague-replan failure this drawer exists to fix. The final
 * hard clip is only reachable when the NOTE_MIN floor engages (very many
 * comments), where core's own clip would fire anyway.
 */
export const composeReason = (comments: readonly AnchoredComment[]): string => {
  const list = sendable(comments)
  if (list.length === 0) return ""
  const ideal = list.map((c) => line(c, NOTE_MAX)).join(JOINER)
  if (ideal.length <= REASON_BUDGET) return ideal
  const overhead = list.reduce((sum, c) => sum + `${c.target} “${clip(c.anchor)}”: `.length, 0) + JOINER.length * (list.length - 1)
  const share = Math.max(NOTE_MIN, Math.floor((REASON_BUDGET - overhead) / list.length))
  const squeezed = list.map((c) => line(c, share)).join(JOINER)
  return squeezed.length <= REASON_BUDGET ? squeezed : `${squeezed.slice(0, REASON_BUDGET - 1).trimEnd()}…`
}

/** What the drawer's meter shows about the composed reason. */
export interface ReasonStats {
  readonly length: number
  readonly budget: number
  /** True when the budget forced per-note clipping below the comfortable cap. */
  readonly squeezed: boolean
}

/** Meter data for the composed reason — pure, same inputs as composeReason. */
export const reasonStats = (comments: readonly AnchoredComment[]): ReasonStats => {
  const list = sendable(comments)
  const ideal = list.map((c) => line(c, NOTE_MAX)).join(JOINER)
  return { length: composeReason(comments).length, budget: REASON_BUDGET, squeezed: ideal.length > REASON_BUDGET }
}

/** How many comments would actually be sent (the empty ones never are). */
export const sendableCount = (comments: readonly AnchoredComment[]): number =>
  comments.filter((c) => c.note.trim() !== "").length
