import { z } from "zod";
import type { Client, Shell } from "../host.js";
/**
 * The PR sitter's dedup ledger: one JSON file per PR under
 * `<tasksDir>/runs/pr-sitter/pr-<n>.json`, recording what the sitter has
 * already handled so it never reacts to its own pushes or replies, never
 * retries a failed attempt on the same head, and never re-answers old
 * comments. Like snapshots, ledgers are ephemeral machine state (gitignored
 * via `runs/`), validated on load, and fail closed — a garbled ledger reads
 * as "nothing handled yet", which only risks one redundant triage pass.
 */
declare const LedgerSchema: z.ZodObject<{
    pr: z.ZodNumber;
    headShaHandled: z.ZodOptional<z.ZodString>;
    lastCommentAtHandled: z.ZodOptional<z.ZodString>;
    conflictAttempt: z.ZodOptional<z.ZodObject<{
        headSha: z.ZodString;
        baseSha: z.ZodString;
    }, z.core.$strip>>;
    failedAttempts: z.ZodDefault<z.ZodArray<z.ZodObject<{
        headSha: z.ZodString;
        trigger: z.ZodString;
        at: z.ZodString;
    }, z.core.$strip>>>;
    updatedAt: z.ZodString;
}, z.core.$strip>;
export type PrLedger = z.infer<typeof LedgerSchema>;
export declare const emptyLedger: (pr: number, now: string) => PrLedger;
export declare const ledgerPath: (directory: string, tasksDir: string, pr: number) => string;
/** Load a PR's ledger; a missing/garbled file reads as an empty ledger. */
export declare const loadLedger: (client: Client, directory: string, tasksDir: string, pr: number, now: string) => Promise<PrLedger>;
/** Write a PR's ledger. Best-effort — dedup failure must never fail a drive. */
export declare const saveLedger: ($: Shell, directory: string, tasksDir: string, ledger: PrLedger) => Promise<void>;
/** What a polled PR currently looks like, normalized from the platform API (`gh pr list --json` / the ADO pull-requests REST API). */
export interface PrSnapshot {
    readonly number: number;
    readonly title: string;
    readonly headRefName: string;
    readonly baseRefName: string;
    readonly headRefOid: string;
    readonly mergeable: string;
    readonly reviewDecision: string;
    readonly failingChecks: readonly string[];
    /** Comments newer than the watermark and not authored by the sitter's own login. */
    readonly newComments: readonly {
        author: string;
        at: string;
    }[];
}
export type PrTrigger = "failing-checks" | "changes-requested" | "new-comments" | "merge-conflict";
/**
 * Which enabled triggers currently need attention on this PR, given its
 * ledger. Pure — THE dedup decision:
 * - failing checks / changes requested count only on a head the sitter
 *   hasn't already handled or failed on;
 * - new comments count via the timestamp watermark (own-login comments were
 *   already filtered out of the snapshot);
 * - a conflict counts once per (head, base) pair.
 */
export declare const attentionTriggers: (snapshot: PrSnapshot, ledger: PrLedger, enabled: readonly PrTrigger[], baseSha?: string) => PrTrigger[];
export {};
