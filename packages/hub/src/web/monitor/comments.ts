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
 * One line, because core's `appendNote` writes a single `> …` blockquote (the
 * server flattens whitespace as a second guard, see routes/gate.ts `oneLine`).
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

const clip = (text: string, max = ANCHOR_MAX): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

/**
 * Compose the gate `reason`. Comments with no note are dropped — an opened and
 * abandoned composer must not send an empty quote downstream.
 */
export const composeReason = (comments: readonly AnchoredComment[]): string =>
  comments
    .filter((c) => c.note.trim() !== "")
    .map((c) => `${c.target} “${clip(c.anchor)}”: ${clip(c.note, 400)}`)
    .join("; ")

/** How many comments would actually be sent (the empty ones never are). */
export const sendableCount = (comments: readonly AnchoredComment[]): number =>
  comments.filter((c) => c.note.trim() !== "").length
