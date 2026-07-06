import path from "node:path";
import { z } from "zod";
/**
 * The PR sitter's dedup ledger: one JSON file per PR under
 * `<tasksDir>/runs/pr-sitter/pr-<n>.json`, recording what the sitter has
 * already handled so it never reacts to its own pushes or replies, never
 * retries a failed attempt on the same head, and never re-answers old
 * comments. Like snapshots, ledgers are ephemeral machine state (gitignored
 * via `runs/`), validated on load, and fail closed — a garbled ledger reads
 * as "nothing handled yet", which only risks one redundant triage pass.
 */
const LedgerSchema = z.object({
    pr: z.number().int().positive(),
    /** Head SHA whose checks/conflicts the sitter last handled (usually its own push). */
    headShaHandled: z.string().optional(),
    /** Comments at or before this timestamp are handled. */
    lastCommentAtHandled: z.string().optional(),
    /** Head+base pairs whose conflict the sitter already attempted. */
    conflictAttempt: z.object({ headSha: z.string(), baseSha: z.string() }).optional(),
    /** Capped/stopped runs — the PR parks until a human push changes the head SHA. */
    failedAttempts: z.array(z.object({ headSha: z.string(), trigger: z.string(), at: z.string() })).default([]),
    updatedAt: z.string(),
});
export const emptyLedger = (pr, now) => ({ pr, failedAttempts: [], updatedAt: now });
export const ledgerPath = (directory, tasksDir, pr) => path.join(directory, tasksDir, "runs", "pr-sitter", `pr-${pr}.json`);
/** Load a PR's ledger; a missing/garbled file reads as an empty ledger. */
export const loadLedger = async (client, directory, tasksDir, pr, now) => {
    const rel = `${tasksDir}/runs/pr-sitter/pr-${pr}.json`;
    const read = await client.file.read({ query: { path: rel, directory } }).catch(() => null);
    const content = read?.data?.content;
    if (!content)
        return emptyLedger(pr, now);
    try {
        const parsed = LedgerSchema.safeParse(JSON.parse(content));
        return parsed.success ? parsed.data : emptyLedger(pr, now);
    }
    catch {
        return emptyLedger(pr, now);
    }
};
/** Write a PR's ledger. Best-effort — dedup failure must never fail a drive. */
export const saveLedger = async ($, directory, tasksDir, ledger) => {
    const dir = path.join(directory, tasksDir, "runs", "pr-sitter");
    await $ `mkdir -p ${dir}`.quiet().nothrow();
    const file = ledgerPath(directory, tasksDir, ledger.pr);
    await $ `printf '%s' ${JSON.stringify(ledger, null, 2)} > ${file}`.quiet().nothrow();
};
/**
 * Which enabled triggers currently need attention on this PR, given its
 * ledger. Pure — THE dedup decision:
 * - failing checks / changes requested count only on a head the sitter
 *   hasn't already handled or failed on;
 * - new comments count via the timestamp watermark (own-login comments were
 *   already filtered out of the snapshot);
 * - a conflict counts once per (head, base) pair.
 */
export const attentionTriggers = (snapshot, ledger, enabled, baseSha = "") => {
    const headHandled = ledger.headShaHandled === snapshot.headRefOid ||
        ledger.failedAttempts.some((f) => f.headSha === snapshot.headRefOid);
    const out = [];
    if (enabled.includes("failing-checks") && snapshot.failingChecks.length && !headHandled)
        out.push("failing-checks");
    if (enabled.includes("changes-requested") && snapshot.reviewDecision === "CHANGES_REQUESTED" && !headHandled) {
        out.push("changes-requested");
    }
    if (enabled.includes("new-comments") && snapshot.newComments.length && !headHandled)
        out.push("new-comments");
    if (enabled.includes("merge-conflict") &&
        snapshot.mergeable === "CONFLICTING" &&
        !headHandled &&
        !(ledger.conflictAttempt && ledger.conflictAttempt.headSha === snapshot.headRefOid && ledger.conflictAttempt.baseSha === baseSha)) {
        out.push("merge-conflict");
    }
    return out;
};
