import { attentionTriggers, loadLedger, saveLedger } from "./ledger.js";
import { fetchHead, makeClaimMarkers, prWorkItem, terminalLedgerUpdate } from "./pr-shared.js";
import { AdoPolicySchema, AdoPrListSchema, AdoThreadsSchema, failingPolicyNames, flattenThreadComments, newerThan, sameLogin, stripRef, } from "./ado-shared.js";
const defaultHttp = (url, init) => fetch(url, init);
/** The env var holding the Azure DevOps PAT — the same name the `az` extension used, for continuity. */
const PAT_ENV = "AZURE_DEVOPS_EXT_PAT";
const API_VERSION = "api-version=7.1";
export const makeAdoPrSource = (deps) => {
    const { $, client, directory, tasksDir, log, loaded, ado } = deps;
    const binding = loaded.manifest.workSource;
    if (binding.type !== "github-pr") {
        throw new Error(`loop kind "${loaded.manifest.kind}" does not use a hosted-PR work source`);
    }
    const now = deps.now ?? (() => new Date().toISOString());
    const http = deps.http ?? defaultHttp;
    const pat = deps.pat ?? process.env[PAT_ENV] ?? "";
    const org = ado.organization.replace(/\/+$/, "");
    const project = encodeURIComponent(ado.project);
    const login = ado.selfLogin ?? "";
    const markers = makeClaimMarkers($, directory, tasksDir);
    const authHeader = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
    /** One authenticated GET. Never throws — a network error reads as a non-ok response, like the CLI's `nothrow()`. */
    const get = async (url) => {
        try {
            const res = await http(url, { headers: { Authorization: authHeader, Accept: "application/json" } });
            const body = await res.text().catch(() => "");
            return { ok: res.ok, status: res.status, statusText: res.statusText, body };
        }
        catch (err) {
            return { ok: false, status: 0, statusText: err.message, body: "" };
        }
    };
    /** Names of blocking policies currently failing on the PR (ADO's nearest equivalent of failing checks). */
    const failingPolicies = async (projectId, pr) => {
        if (!projectId)
            return [];
        const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${pr}`;
        const url = `${org}/${project}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifactId)}&${API_VERSION}`;
        const out = await get(url);
        if (!out.ok)
            return [];
        try {
            const json = JSON.parse(out.body || "{}");
            return failingPolicyNames(AdoPolicySchema.parse(json.value ?? []));
        }
        catch {
            return [];
        }
    };
    /** Non-system PR thread comments, flattened to `{ author, at }`, from the `pullRequestThreads` resource. */
    const threadComments = async (repositoryId, pr) => {
        if (!repositoryId)
            return [];
        const url = `${org}/${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pr}/threads?${API_VERSION}`;
        const out = await get(url);
        if (!out.ok)
            return [];
        try {
            const threads = AdoThreadsSchema.parse(JSON.parse(out.body || "{}"));
            return flattenThreadComments(threads.value ?? []);
        }
        catch {
            return [];
        }
    };
    return {
        loopKind: loaded.manifest.kind,
        async claimNext() {
            if (!pat) {
                return {
                    item: null,
                    skip: {
                        message: `pr-sitter: Azure DevOps PAT not set — export ${PAT_ENV} with a token that has Code (read) scope so the ` +
                            `sitter can call the ADO REST API.`,
                        actionable: true,
                    },
                };
            }
            if (!login) {
                // A PAT can't resolve the sitter's own identity; config.ts enforces this,
                // and this is the defensive guard for direct construction.
                return {
                    item: null,
                    skip: {
                        message: "pr-sitter: could not resolve the sitter's own ADO identity (a PAT cannot) — " +
                            "set ado.selfLogin in .agentic-loop.json so the sitter only claims its own PRs.",
                        actionable: true,
                    },
                };
            }
            const listUrl = ado.repository
                ? `${org}/${project}/_apis/git/repositories/${encodeURIComponent(ado.repository)}/pullrequests?searchCriteria.status=active&$top=100&${API_VERSION}`
                : `${org}/${project}/_apis/git/pullrequests?searchCriteria.status=active&$top=100&${API_VERSION}`;
            const out = await get(listUrl);
            if (!out.ok) {
                return {
                    item: null,
                    skip: {
                        message: `pr-sitter: Azure DevOps pull-request list failed — HTTP ${out.status} ${out.statusText}. ` +
                            `Is ${PAT_ENV} a valid token with Code (read) scope, and are ado.organization/project correct?`,
                        actionable: true,
                    },
                };
            }
            let prs;
            try {
                const json = JSON.parse(out.body || "{}");
                prs = AdoPrListSchema.parse(json.value ?? []);
            }
            catch (err) {
                return {
                    item: null,
                    skip: { message: `pr-sitter: could not parse the ADO response — ${err.message}`, actionable: true },
                };
            }
            const heldIds = [];
            for (const pr of prs.sort((a, b) => a.pullRequestId - b.pullRequestId)) {
                if (pr.isDraft)
                    continue;
                if (pr.forkSource != null)
                    continue; // fork PRs: can't push the head branch — a human's PR to sit on later
                if (!sameLogin(pr.createdBy?.uniqueName ?? "", login))
                    continue; // parity with gh's author:@me
                const number = pr.pullRequestId;
                const headRefOid = pr.lastMergeSourceCommit?.commitId ?? "";
                // No head SHA yet (merge evaluation queued / never run): the snapshot
                // isn't ready — a "" head would poison the ledger's dedup. Next poll.
                if (!headRefOid)
                    continue;
                const ledger = await loadLedger(client, directory, tasksDir, number, now());
                const watermark = ledger.lastCommentAtHandled ?? "";
                const enabled = binding.triggers;
                const repositoryId = pr.repository?.id || pr.repository?.name || "";
                const comments = enabled.includes("new-comments") ? await threadComments(repositoryId, number) : [];
                const snapshot = {
                    number,
                    title: pr.title,
                    headRefName: stripRef(pr.sourceRefName),
                    baseRefName: stripRef(pr.targetRefName),
                    headRefOid,
                    mergeable: (pr.mergeStatus ?? "").toLowerCase() === "conflicts" ? "CONFLICTING" : "MERGEABLE",
                    reviewDecision: (pr.reviewers ?? []).some((r) => r.vote < 0) ? "CHANGES_REQUESTED" : "",
                    failingChecks: enabled.includes("failing-checks")
                        ? await failingPolicies(pr.repository?.project?.id ?? "", number)
                        : [],
                    newComments: comments.filter((c) => !sameLogin(c.author, login) && newerThan(c.at, watermark)),
                };
                const triggers = attentionTriggers(snapshot, ledger, binding.triggers);
                if (triggers.length === 0)
                    continue;
                if (!(await markers.claim(number))) {
                    heldIds.push(`pr-${number}`);
                    continue;
                }
                if (!(await fetchHead($, directory, snapshot.headRefName))) {
                    await log("warn", `pr-sitter: could not fetch ${snapshot.headRefName} for PR #${number} — skipping`);
                    await markers.release(number);
                    continue;
                }
                return { item: prWorkItem(loaded, "ado", snapshot, triggers), skip: null };
            }
            if (heldIds.length) {
                return {
                    item: null,
                    skip: { message: `pr-sitter: claim marker held for ${heldIds.join(", ")}`, actionable: true },
                };
            }
            return {
                item: null,
                skip: { message: `pr-sitter: no PRs need attention (${prs.length} active in the project)`, actionable: false },
            };
        },
        async release(work) {
            const { snapshot } = work.ref;
            await markers.release(snapshot.number);
        },
        async onTerminal(work, outcome) {
            const { snapshot, triggers } = work.ref;
            const ledger = await loadLedger(client, directory, tasksDir, snapshot.number, now());
            // Re-read the PR head: after a publish it is the sitter's own push, and
            // recording it as handled is exactly what prevents self-triggering.
            const fresh = await get(`${org}/${project}/_apis/git/pullrequests/${snapshot.number}?${API_VERSION}`);
            let head = snapshot.headRefOid;
            let repositoryId = "";
            if (fresh.ok) {
                try {
                    const data = JSON.parse(fresh.body);
                    head = data.lastMergeSourceCommit?.commitId ?? head;
                    repositoryId = data.repository?.id ?? data.repository?.name ?? "";
                }
                catch {
                    /* keep snapshot values */
                }
            }
            let lastCommentAt = ledger.lastCommentAtHandled ?? "";
            if (repositoryId) {
                for (const c of await threadComments(repositoryId, snapshot.number)) {
                    if (newerThan(c.at, lastCommentAt))
                        lastCommentAt = c.at;
                }
            }
            const updated = terminalLedgerUpdate(ledger, outcome, triggers, snapshot.headRefOid, head, lastCommentAt, now());
            await saveLedger($, directory, tasksDir, updated);
            await markers.release(snapshot.number);
        },
    };
};
