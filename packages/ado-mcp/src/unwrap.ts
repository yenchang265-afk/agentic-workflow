import type { AdoResult } from "@agentic-workflow/core/source/ado-gateway"

/**
 * An MCP `CallToolResult`, narrowed to what unwrapping reads. Declared
 * structurally rather than imported so the pure half of this package stays
 * testable without constructing SDK types.
 */
export interface CallToolResultLike {
  readonly isError?: boolean
  readonly structuredContent?: unknown
  readonly content?: readonly { readonly type?: string; readonly text?: string }[]
}

/** The first text block's text, or "" when there is none. */
const firstText = (result: CallToolResultLike): string => {
  for (const block of result.content ?? []) {
    if (typeof block?.text === "string") return block.text
  }
  return ""
}

const truncate = (s: string, max = 200): string => (s.length > max ? `${s.slice(0, max)}…` : s)

/**
 * Turn one MCP tool result into the port's `AdoResult`.
 *
 * The prose branch is the load-bearing one: MCP servers are free to summarize,
 * and a summarized payload must fail HERE, loudly, at the transport boundary.
 * If it were allowed through it would fail a zod parse deep inside
 * `buildSnapshot`, where a parse failure degrades to an empty snapshot — and an
 * empty snapshot is indistinguishable from "this PR needs no attention", so the
 * loop would silently stop claiming work rather than report a problem.
 */
export const unwrapAdoResult = (result: CallToolResultLike): AdoResult => {
  if (result.isError) {
    const text = firstText(result)
    return { ok: false, error: text ? truncate(text) : "azure-devops MCP returned an error with no detail" }
  }

  if (result.structuredContent !== undefined) return { ok: true, data: result.structuredContent }

  const text = firstText(result)
  if (!text) return { ok: false, error: "azure-devops MCP returned an empty result" }

  try {
    return { ok: true, data: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, error: `azure-devops MCP returned non-JSON: ${truncate(text)}` }
  }
}
