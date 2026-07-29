import type { AdoResult } from "@agentic-workflow/core/source/ado-gateway";
/**
 * An MCP `CallToolResult`, narrowed to what unwrapping reads. Declared
 * structurally rather than imported so the pure half of this package stays
 * testable without constructing SDK types.
 */
export interface CallToolResultLike {
    readonly isError?: boolean;
    readonly structuredContent?: unknown;
    readonly content?: readonly {
        readonly type?: string;
        readonly text?: string;
    }[];
}
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
export declare const unwrapAdoResult: (result: CallToolResultLike) => AdoResult;
