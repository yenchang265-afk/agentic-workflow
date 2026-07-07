import { z } from "zod";
/**
 * The pure Azure DevOps normalizers shared by the two ADO work sources:
 * `ado-pr.ts` (the `az` CLI) and `ado-mcp-pr.ts` (the Microsoft ADO MCP server,
 * fed by an agent session). Both consume the raw ADO REST `GitPullRequest`
 * shape — the CLI prints it, the MCP server returns it — so the field schemas,
 * identifier semantics, and thread-comment flattening live here once and the
 * two sources differ only in HOW they obtain the raw data.
 */
/** `refs/heads/x` → `x`. */
export const stripRef = (ref) => ref.replace(/^refs\/heads\//, "");
/** ADO logins are emails — case-insensitive identifiers. */
export const sameLogin = (a, b) => a.toLowerCase() === b.toLowerCase();
/**
 * `a` strictly newer than `b`. ADO timestamps carry variable-precision
 * fractional seconds ("…20.9Z" vs "…20.873Z"), which string comparison
 * misorders — compare parsed times, falling back to strings when unparsable.
 */
export const newerThan = (a, b) => {
    if (!b)
        return Boolean(a);
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    return Number.isNaN(ta) || Number.isNaN(tb) ? a > b : ta > tb;
};
/** Blocking-policy statuses that count as a failing check. */
export const POLICY_FAILING = new Set(["rejected", "broken", "failed"]);
/** The `GitPullRequest` fields both sources read off the PR list. */
export const AdoPrFieldsSchema = z.object({
    pullRequestId: z.number().int().positive(),
    title: z.string(),
    sourceRefName: z.string(),
    targetRefName: z.string(),
    isDraft: z.boolean().default(false),
    mergeStatus: z.string().nullish(),
    createdBy: z.object({ uniqueName: z.string().default("") }).nullish(),
    lastMergeSourceCommit: z.object({ commitId: z.string().default("") }).nullish(),
    reviewers: z.array(z.object({ vote: z.number().default(0) })).nullish(),
    /** Present when the PR comes from a fork — same skip rule as GitHub's `isCrossRepository`. */
    forkSource: z.unknown().nullish(),
    repository: z.object({ id: z.string().default(""), name: z.string().default("") }).nullish(),
});
export const AdoPrListSchema = z.array(AdoPrFieldsSchema);
/** One PR comment thread. */
export const AdoThreadSchema = z.object({
    isDeleted: z.boolean().default(false),
    comments: z
        .array(z.object({
        commentType: z.string().nullish(),
        publishedDate: z.string().nullish(),
        isDeleted: z.boolean().default(false),
        author: z.object({ uniqueName: z.string().default("") }).nullish(),
    }))
        .nullish(),
});
/** The `pullRequestThreads` REST resource wraps threads in `{ value: [...] }`. */
export const AdoThreadsSchema = z.object({ value: z.array(AdoThreadSchema).nullish() });
export const AdoPolicySchema = z.array(z.object({
    status: z.string().nullish(),
    configuration: z
        .object({
        isBlocking: z.boolean().default(true),
        type: z.object({ displayName: z.string().default("") }).nullish(),
    })
        .nullish(),
}));
/** Non-system, non-deleted thread comments flattened to `{ author, at }`. Pure. */
export const flattenThreadComments = (threads) => threads
    .filter((t) => !t.isDeleted)
    .flatMap((t) => t.comments ?? [])
    .filter((c) => !c.isDeleted && (c.commentType ?? "text") !== "system" && c.publishedDate)
    .map((c) => ({ author: c.author?.uniqueName ?? "", at: c.publishedDate ?? "" }));
/** Names of blocking policies currently failing (ADO's nearest equivalent of failing checks). Pure. */
export const failingPolicyNames = (raw) => raw
    .filter((p) => p.configuration?.isBlocking !== false) // optional policies don't gate the merge
    .filter((p) => POLICY_FAILING.has((p.status ?? "").toLowerCase()))
    .map((p) => p.configuration?.type?.displayName ?? "")
    .filter(Boolean);
