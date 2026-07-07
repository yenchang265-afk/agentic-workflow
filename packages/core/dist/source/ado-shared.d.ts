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
export declare const stripRef: (ref: string) => string;
/** ADO logins are emails — case-insensitive identifiers. */
export declare const sameLogin: (a: string, b: string) => boolean;
/**
 * `a` strictly newer than `b`. ADO timestamps carry variable-precision
 * fractional seconds ("…20.9Z" vs "…20.873Z"), which string comparison
 * misorders — compare parsed times, falling back to strings when unparsable.
 */
export declare const newerThan: (a: string, b: string) => boolean;
/** Blocking-policy statuses that count as a failing check. */
export declare const POLICY_FAILING: Set<string>;
/** The `GitPullRequest` fields both sources read off the PR list. */
export declare const AdoPrFieldsSchema: z.ZodObject<{
    pullRequestId: z.ZodNumber;
    title: z.ZodString;
    sourceRefName: z.ZodString;
    targetRefName: z.ZodString;
    isDraft: z.ZodDefault<z.ZodBoolean>;
    mergeStatus: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    createdBy: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        uniqueName: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>>;
    lastMergeSourceCommit: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        commitId: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>>;
    reviewers: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        vote: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>>>;
    forkSource: z.ZodOptional<z.ZodNullable<z.ZodUnknown>>;
    repository: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        id: z.ZodDefault<z.ZodString>;
        name: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export declare const AdoPrListSchema: z.ZodArray<z.ZodObject<{
    pullRequestId: z.ZodNumber;
    title: z.ZodString;
    sourceRefName: z.ZodString;
    targetRefName: z.ZodString;
    isDraft: z.ZodDefault<z.ZodBoolean>;
    mergeStatus: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    createdBy: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        uniqueName: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>>;
    lastMergeSourceCommit: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        commitId: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>>;
    reviewers: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        vote: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>>>;
    forkSource: z.ZodOptional<z.ZodNullable<z.ZodUnknown>>;
    repository: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        id: z.ZodDefault<z.ZodString>;
        name: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>>;
}, z.core.$strip>>;
/** One PR comment thread. */
export declare const AdoThreadSchema: z.ZodObject<{
    isDeleted: z.ZodDefault<z.ZodBoolean>;
    comments: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        commentType: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        publishedDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        isDeleted: z.ZodDefault<z.ZodBoolean>;
        author: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            uniqueName: z.ZodDefault<z.ZodString>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>>>;
}, z.core.$strip>;
export type AdoThread = z.infer<typeof AdoThreadSchema>;
/** The `pullRequestThreads` REST resource wraps threads in `{ value: [...] }`. */
export declare const AdoThreadsSchema: z.ZodObject<{
    value: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        isDeleted: z.ZodDefault<z.ZodBoolean>;
        comments: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
            commentType: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            publishedDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            isDeleted: z.ZodDefault<z.ZodBoolean>;
            author: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                uniqueName: z.ZodDefault<z.ZodString>;
            }, z.core.$strip>>>;
        }, z.core.$strip>>>>;
    }, z.core.$strip>>>>;
}, z.core.$strip>;
export declare const AdoPolicySchema: z.ZodArray<z.ZodObject<{
    status: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    configuration: z.ZodOptional<z.ZodNullable<z.ZodObject<{
        isBlocking: z.ZodDefault<z.ZodBoolean>;
        type: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            displayName: z.ZodDefault<z.ZodString>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>>;
}, z.core.$strip>>;
/** Non-system, non-deleted thread comments flattened to `{ author, at }`. Pure. */
export declare const flattenThreadComments: (threads: readonly AdoThread[]) => {
    author: string;
    at: string;
}[];
/** Names of blocking policies currently failing (ADO's nearest equivalent of failing checks). Pure. */
export declare const failingPolicyNames: (raw: z.infer<typeof AdoPolicySchema>) => string[];
