/** The first text block's text, or "" when there is none. */
const firstText = (result) => {
    for (const block of result.content ?? []) {
        if (typeof block?.text === "string")
            return block.text;
    }
    return "";
};
const truncate = (s, max = 200) => (s.length > max ? `${s.slice(0, max)}…` : s);
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
export const unwrapAdoResult = (result) => {
    if (result.isError) {
        const text = firstText(result);
        return { ok: false, error: text ? truncate(text) : "azure-devops MCP returned an error with no detail" };
    }
    if (result.structuredContent !== undefined)
        return { ok: true, data: result.structuredContent };
    const text = firstText(result);
    if (!text)
        return { ok: false, error: "azure-devops MCP returned an empty result" };
    try {
        return { ok: true, data: JSON.parse(text) };
    }
    catch {
        return { ok: false, error: `azure-devops MCP returned non-JSON: ${truncate(text)}` };
    }
};
