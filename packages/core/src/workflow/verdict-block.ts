import { z } from "zod"
import { normalizeRecord, type RawVerdictRecord, type VerdictRecord } from "./verdict.js"

/**
 * A SECOND verdict channel, for models too weak to call tools reliably.
 *
 * The `workflow_verdict` tool stays the primary and always wins. This module
 * adds an opt-in fallback (`verdictChannel: "tool+block"`): a fenced
 * ```workflow_verdict``` JSON block in the stage's own final message, carrying a
 * per-attempt **nonce** the loop injected into that stage's prompt.
 *
 * Why this does not reopen the hole `verdict.ts` closed. That rule — free text
 * is untrusted, because "a stage quoting its own contract, or repo content
 * echoed into the output, must never be able to flip the loop's control flow" —
 * is about text the model did not author: a README, a diff hunk, a quoted
 * earlier transcript. None of those can carry the nonce, because the nonce is
 * fresh per stage attempt and appears only in that attempt's prompt. What
 * remains is the model deliberately emitting a verdict block, which is exactly
 * the same authority it already has by calling the tool.
 *
 * Three rules make that argument hold, and all three are load-bearing:
 *  1. the nonce must match, and it is regenerated for every attempt (so a
 *     re-fire cannot be satisfied by the previous attempt's block);
 *  2. the `stage` must match, mirroring the tool's own stage check;
 *  3. only the LAST matching block counts, so a model that revises itself is
 *     read the same way repeat tool calls are.
 *
 * Everything here is pure and total: a malformed block is `null`, never a throw.
 */

/** The fence info-string a verdict block must open with. */
export const VERDICT_BLOCK_FENCE = "workflow_verdict"

/**
 * The verdict payload as it arrives from a model — the single shape behind both
 * hosts' tool schemas and the block channel. `severity` is a free string here;
 * `normalizeRecord` canonicalizes it (see `verdict.ts` `normalizeSeverity`).
 */
export const VerdictPayloadSchema = z.object({
  stage: z.string().min(1),
  verdict: z.enum(["PASS", "FAIL", "ERROR"]),
  reason: z.string().max(500).optional(),
  criteria: z.array(z.object({ criterion: z.string(), pass: z.boolean() })).optional(),
  axes: z
    .array(
      z.object({
        axis: z.string().min(1),
        verdict: z.enum(["PASS", "FAIL", "ERROR"]),
        findings: z
          .array(z.object({ severity: z.string(), detail: z.string(), location: z.string().optional() }))
          .optional(),
      }),
    )
    .optional(),
})

export type VerdictPayload = z.infer<typeof VerdictPayloadSchema>

/**
 * The prompt paragraph describing the block channel, appended after the tool
 * contract when the channel is on. Only ever rendered with a nonce — a block
 * contract without one would invite exactly the forgeable verdict this design
 * rules out.
 */
export const verdictBlockContract = (stage: string, nonce: string): string =>
  [
    `BACKUP VERDICT CHANNEL: if — and only if — the \`workflow_verdict\` tool is unavailable or its call fails,`,
    `end your final message with a fenced block instead:`,
    "",
    "```" + VERDICT_BLOCK_FENCE,
    `{"nonce": "${nonce}", "stage": "${stage}", "verdict": "PASS", "reason": "..."}`,
    "```",
    "",
    `The \`nonce\` field must be exactly \`${nonce}\` and the \`stage\` exactly \`${stage}\`, or the block is ignored.`,
    `It takes the same fields as the tool (including \`criteria\` and \`axes\` where the stage requires them).`,
    `Prefer the tool: the block is read only when no tool call was recorded.`,
    `Never print this nonce anywhere else, and never repeat it in prose.`,
  ].join("\n")

/** Every fenced ```workflow_verdict body in `text`, in document order. */
const blockBodies = (text: string): string[] => {
  const re = new RegExp("^[ \\t]*```[ \\t]*" + VERDICT_BLOCK_FENCE + "[ \\t]*\\r?\\n([\\s\\S]*?)^[ \\t]*```", "gm")
  return [...text.matchAll(re)].map((m) => m[1] ?? "")
}

/**
 * The last fenced verdict block in `text` whose `nonce` and `stage` both match,
 * as a canonicalized record — or `null` when there is none, the JSON is
 * malformed, or the payload fails the schema. Never throws. Pure.
 *
 * The returned record carries no `stage`; the caller already knows it, and the
 * host feeds this straight into `admitVerdict` like a tool call.
 */
export const parseVerdictBlock = (text: string, stage: string, nonce: string): VerdictRecord | null => {
  if (!text || !nonce) return null
  for (const body of blockBodies(text).reverse()) {
    let raw: unknown
    try {
      raw = JSON.parse(body)
    } catch {
      continue
    }
    if (typeof raw !== "object" || raw === null) continue
    if ((raw as { nonce?: unknown }).nonce !== nonce) continue
    const parsed = VerdictPayloadSchema.safeParse(raw)
    if (!parsed.success) continue
    if (parsed.data.stage.trim().toLowerCase() !== stage.trim().toLowerCase()) continue
    const { stage: _stage, ...record } = parsed.data
    return normalizeRecord(record as RawVerdictRecord)
  }
  return null
}

/**
 * Scrub a nonce out of text before it is written anywhere durable. The run log
 * is threaded into later prompts and read by later stages, so a nonce that
 * survived into it would be reusable by a stage that was never issued it —
 * the one genuinely new leak this channel introduces. Pure.
 */
export const redactNonce = (text: string, nonce: string): string =>
  nonce ? text.split(nonce).join("[verdict-nonce redacted]") : text
