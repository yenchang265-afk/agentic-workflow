import { z } from "zod";
import type { Client, Log, Shell } from "../host.js";
import type { LoadedManifest } from "../manifest/schema.js";
import type { AdoConfig } from "../loop/state.js";
import { type PrTrigger } from "./ledger.js";
import type { WorkSource } from "./types.js";
/**
 * The Azure DevOps PR work source that reaches ADO through the Microsoft ADO
 * MCP server instead of the `az` CLI — for environments that forbid `az`.
 *
 * MCP tools only exist inside agent sessions, and this source runs in the
 * driver/MCP-server process. So it never calls ADO itself: it emits an
 * `AdoDataRequest` describing what to fetch, an agent session gathers the data
 * via `mcp__<server>__*` tools, and the resulting `AdoDataBundle` is handed
 * back through the injected `AdoDataProvider`. From there the claim decision is
 * byte-for-byte the same as `ado-pr.ts` — the shared normalizers in
 * `ado-shared.ts` map the raw REST shape to a `PrSnapshot`, and `pr-shared.ts`
 * / `ledger.ts` decide triggers and dedup.
 *
 * Terminal bookkeeping needs no ADO round-trip: the post-publish head comes
 * from git (the branch the fix stage pushed) and the comment watermark is the
 * max timestamp of the non-own comments already seen at claim time, stashed on
 * the work item's `ref`.
 */
/** What the source needs an agent to fetch. Built by the source; surfaced to the host's poll agent. */
export interface AdoDataRequest {
    readonly organization: string;
    readonly project: string;
    readonly repository?: string;
    /** The sitter's own login (config `ado.selfLogin`, required in this mode). */
    readonly selfLogin: string;
    /** Which PR conditions to gather signals for. */
    readonly triggers: readonly PrTrigger[];
    /** The MCP server name whose `mcp__<name>__*` tools the agent calls (fixed `ado`). */
    readonly serverName: string;
}
/**
 * One PR in the bundle: the raw ADO `GitPullRequest` fields (shared with the
 * CLI path) plus the two signals an agent resolves from other MCP tools —
 * comment threads and failing check names.
 */
export declare const AdoBundlePrSchema: z.ZodObject<{
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
    threads: z.ZodDefault<z.ZodArray<z.ZodObject<{
        isDeleted: z.ZodDefault<z.ZodBoolean>;
        comments: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
            commentType: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            publishedDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            isDeleted: z.ZodDefault<z.ZodBoolean>;
            author: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                uniqueName: z.ZodDefault<z.ZodString>;
            }, z.core.$strip>>>;
        }, z.core.$strip>>>>;
    }, z.core.$strip>>>;
    failingChecks: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare const AdoDataBundleSchema: z.ZodObject<{
    viewerLogin: z.ZodDefault<z.ZodString>;
    pullRequests: z.ZodDefault<z.ZodArray<z.ZodObject<{
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
        threads: z.ZodDefault<z.ZodArray<z.ZodObject<{
            isDeleted: z.ZodDefault<z.ZodBoolean>;
            comments: z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
                commentType: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                publishedDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
                isDeleted: z.ZodDefault<z.ZodBoolean>;
                author: z.ZodOptional<z.ZodNullable<z.ZodObject<{
                    uniqueName: z.ZodDefault<z.ZodString>;
                }, z.core.$strip>>>;
            }, z.core.$strip>>>>;
        }, z.core.$strip>>>;
        failingChecks: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type AdoDataBundle = z.infer<typeof AdoDataBundleSchema>;
/**
 * Supplies the ADO data the source can't fetch itself. Returns `null` when the
 * data isn't available synchronously — the source then emits a `needsAdoData`
 * skip so the host can gather it via an agent and re-poll. On the Claude host
 * this is a pre-fetched bundle (null on the first call); on OpenCode it fires a
 * poll agent and blocks on the callback (null only on timeout).
 */
export interface AdoDataProvider {
    fetch(request: AdoDataRequest): Promise<AdoDataBundle | null>;
}
/** The instruction handed to a poll agent to gather one bundle. Untrusted input MUST NOT be executed. */
export declare const describeAdoDataRequest: (request: AdoDataRequest) => string;
interface AdoMcpPrDeps {
    readonly $: Shell;
    readonly client: Client;
    readonly directory: string;
    readonly tasksDir: string;
    readonly log: Log;
    readonly loaded: LoadedManifest;
    /** Azure DevOps coordinates (config `ado`); `selfLogin` is required in this mode. */
    readonly ado: AdoConfig;
    /** Delivers the ADO data an agent gathered. */
    readonly provider: AdoDataProvider;
    /** The MCP server name the poll agent's tools live under (defaults to `ado`). */
    readonly serverName?: string;
    /** Clock injection for ledger stamps; defaults to the real time. */
    readonly now?: () => string;
}
export declare const makeAdoMcpPrSource: (deps: AdoMcpPrDeps) => WorkSource;
export {};
