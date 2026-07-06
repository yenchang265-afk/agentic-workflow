import { z } from "zod";
import { attentionTriggers, loadLedger, saveLedger } from "./ledger.js";
/**
 * The GitHub-PR work source (the PR sitter's): claimable units of work are
 * open pull requests matching the manifest's `gh pr list --search` query that
 * currently need attention — failing checks, changes requested, unanswered
 * comments, or a merge conflict — per the dedup ledger (`ledger.ts`).
 *
 * Everything goes through `gh` on the core `Shell` (mockable in tests).
 * GitHub has no atomic claim, so claims use the same local `mkdir` markers as
 * the backlog (`<tasksDir>/runs/pr-sitter/.claims/pr-<n>`) — atomic across
 * watchers on this filesystem. The PR's existing branch is fetched into a
 * local ref at claim time so the standard isolation path reuses it (same-repo
 * branches only; fork PRs are skipped). The sitter NEVER merges.
 */
const PrListSchema = z.array(z.object({
    number: z.number().int().positive(),
    title: z.string(),
    headRefName: z.string(),
    baseRefName: z.string(),
    headRefOid: z.string(),
    isDraft: z.boolean().default(false),
    mergeable: z.string().default("UNKNOWN"),
    reviewDecision: z.string().nullish(),
    isCrossRepository: z.boolean().default(false),
    statusCheckRollup: z
        .array(z.object({ name: z.string().default(""), conclusion: z.string().nullish(), state: z.string().nullish() }))
        .nullish(),
    comments: z
        .array(z.object({ author: z.object({ login: z.string().default("") }).nullish(), createdAt: z.string() }))
        .nullish(),
}));
const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
const triggerSummary = (triggers, snapshot) => triggers
    .map((t) => {
    switch (t) {
        case "failing-checks":
            return `failing checks: ${snapshot.failingChecks.join(", ")}`;
        case "changes-requested":
            return "review requested changes";
        case "new-comments":
            return `${snapshot.newComments.length} unanswered comment(s)`;
        case "merge-conflict":
            return "merge conflict with the base branch";
    }
})
    .join("; ");
export const makeGithubPrSource = (deps) => {
    const { $, client, directory, tasksDir, log, loaded } = deps;
    const binding = loaded.manifest.workSource;
    if (binding.type !== "github-pr") {
        throw new Error(`loop kind "${loaded.manifest.kind}" does not use a github-pr work source`);
    }
    const query = deps.query ?? binding.query;
    const now = deps.now ?? (() => new Date().toISOString());
    let viewerLogin = null;
    const viewer = async () => {
        if (viewerLogin !== null)
            return viewerLogin;
        const out = await $ `gh api user -q .login`.cwd(directory).quiet().nothrow();
        viewerLogin = out.exitCode === 0 ? out.stdout.toString().trim() : "";
        return viewerLogin;
    };
    const claimsDir = `${directory}/${tasksDir}/runs/pr-sitter/.claims`;
    const claimMarker = async (pr) => {
        await $ `mkdir -p ${claimsDir}`.quiet().nothrow();
        const out = await $ `mkdir ${`${claimsDir}/pr-${pr}`}`.quiet().nothrow();
        return out.exitCode === 0;
    };
    const releaseMarker = async (pr) => {
        await $ `rmdir ${`${claimsDir}/pr-${pr}`}`.quiet().nothrow();
    };
    /** Fetch the PR head into a local branch ref so isolation can reuse it. */
    const fetchHead = async (headRef) => {
        const out = await $ `git -C ${directory} fetch origin ${`+refs/heads/${headRef}:refs/heads/${headRef}`}`
            .quiet()
            .nothrow();
        if (out.exitCode !== 0) {
            // The branch may be checked out somewhere (fetch refuses to move it) —
            // fall back to a plain fetch so at least the remote ref is fresh.
            const plain = await $ `git -C ${directory} fetch origin ${headRef}`.quiet().nothrow();
            return plain.exitCode === 0;
        }
        return true;
    };
    const item = (snapshot, triggers) => {
        const goal = `PR #${snapshot.number} "${snapshot.title}" — address what needs attention and get it back to green ` +
            `(${triggerSummary(triggers, snapshot)}). Base: ${snapshot.baseRefName}, head: ${snapshot.headRefName}. ` +
            `Never merge the PR; that stays a human call.`;
        const state = {
            kind: loaded.manifest.kind,
            goal,
            stage: loaded.manifest.stages[0]?.name ?? "triage",
            iteration: 0,
            artifacts: {},
            git: { base: snapshot.baseRefName, branch: snapshot.headRefName },
        };
        return {
            id: `pr-${snapshot.number}`,
            loopKind: loaded.manifest.kind,
            title: `PR #${snapshot.number}: ${snapshot.title}`,
            entryStage: state.stage,
            state,
            claimMessage: `Watch: claimed PR #${snapshot.number} — ${triggerSummary(triggers, snapshot)}`,
            ref: { snapshot, triggers },
        };
    };
    return {
        loopKind: loaded.manifest.kind,
        async claimNext() {
            const fields = "number,title,headRefName,baseRefName,headRefOid,isDraft,mergeable,reviewDecision,isCrossRepository,statusCheckRollup,comments";
            const out = await $ `gh pr list --search ${query} --json ${fields}`.cwd(directory).quiet().nothrow();
            if (out.exitCode !== 0) {
                return {
                    item: null,
                    skip: {
                        message: `pr-sitter: gh pr list failed — ${out.stderr.toString().trim() || "is gh authenticated?"}`,
                        actionable: true,
                    },
                };
            }
            let prs;
            try {
                prs = PrListSchema.parse(JSON.parse(out.stdout.toString() || "[]"));
            }
            catch (err) {
                return {
                    item: null,
                    skip: { message: `pr-sitter: could not parse gh output — ${err.message}`, actionable: true },
                };
            }
            const login = await viewer();
            const heldIds = [];
            for (const pr of prs.sort((a, b) => a.number - b.number)) {
                if (pr.isDraft)
                    continue;
                if (pr.isCrossRepository)
                    continue; // fork PRs: can't push the head branch — a human's PR to sit on later
                const ledger = await loadLedger(client, directory, tasksDir, pr.number, now());
                const watermark = ledger.lastCommentAtHandled ?? "";
                const snapshot = {
                    number: pr.number,
                    title: pr.title,
                    headRefName: pr.headRefName,
                    baseRefName: pr.baseRefName,
                    headRefOid: pr.headRefOid,
                    mergeable: pr.mergeable,
                    reviewDecision: pr.reviewDecision ?? "",
                    failingChecks: (pr.statusCheckRollup ?? [])
                        .filter((c) => FAILING.has((c.conclusion ?? c.state ?? "").toUpperCase()))
                        .map((c) => c.name)
                        .filter(Boolean),
                    newComments: (pr.comments ?? [])
                        .filter((c) => (c.author?.login ?? "") !== login && c.createdAt > watermark)
                        .map((c) => ({ author: c.author?.login ?? "", at: c.createdAt })),
                };
                const triggers = attentionTriggers(snapshot, ledger, binding.triggers);
                if (triggers.length === 0)
                    continue;
                if (!(await claimMarker(pr.number))) {
                    heldIds.push(`pr-${pr.number}`);
                    continue;
                }
                if (!(await fetchHead(pr.headRefName))) {
                    await log("warn", `pr-sitter: could not fetch ${pr.headRefName} for PR #${pr.number} — skipping`);
                    await releaseMarker(pr.number);
                    continue;
                }
                return { item: item(snapshot, triggers), skip: null };
            }
            if (heldIds.length) {
                return {
                    item: null,
                    skip: { message: `pr-sitter: claim marker held for ${heldIds.join(", ")}`, actionable: true },
                };
            }
            return {
                item: null,
                skip: { message: `pr-sitter: no PRs need attention (${prs.length} matched the query)`, actionable: false },
            };
        },
        async release(work) {
            const { snapshot } = work.ref;
            await releaseMarker(snapshot.number);
        },
        async onTerminal(work, outcome) {
            const { snapshot, triggers } = work.ref;
            const ledger = await loadLedger(client, directory, tasksDir, snapshot.number, now());
            // Re-read the PR head: after a publish it is the sitter's own push, and
            // recording it as handled is exactly what prevents self-triggering.
            const fresh = await $ `gh pr view ${String(snapshot.number)} --json headRefOid,comments`
                .cwd(directory)
                .quiet()
                .nothrow();
            let head = snapshot.headRefOid;
            let lastCommentAt = ledger.lastCommentAtHandled ?? "";
            if (fresh.exitCode === 0) {
                try {
                    const data = JSON.parse(fresh.stdout.toString());
                    head = data.headRefOid ?? head;
                    for (const c of data.comments ?? []) {
                        if (c.createdAt && c.createdAt > lastCommentAt)
                            lastCommentAt = c.createdAt;
                    }
                }
                catch {
                    /* keep snapshot values */
                }
            }
            const updated = outcome.kind === "done"
                ? {
                    ...ledger,
                    headShaHandled: head,
                    ...(lastCommentAt ? { lastCommentAtHandled: lastCommentAt } : {}),
                    ...(triggers.includes("merge-conflict")
                        ? { conflictAttempt: { headSha: head, baseSha: "" } }
                        : {}),
                    updatedAt: now(),
                }
                : {
                    ...ledger,
                    failedAttempts: [
                        ...ledger.failedAttempts,
                        { headSha: snapshot.headRefOid, trigger: triggers.join("+") || "unknown", at: now() },
                    ],
                    updatedAt: now(),
                };
            await saveLedger($, directory, tasksDir, updated);
            await releaseMarker(snapshot.number);
        },
    };
};
