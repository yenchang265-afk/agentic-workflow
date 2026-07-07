import { attentionTriggers, loadLedger, saveLedger } from "./ledger.js";
import { fetchHead, makeClaimMarkers, prWorkItem, terminalLedgerUpdate } from "./pr-shared.js";
import { AdoPolicySchema, AdoPrListSchema, AdoThreadsSchema, failingPolicyNames, flattenThreadComments, newerThan, sameLogin, stripRef, } from "./ado-shared.js";
export const makeAdoPrSource = (deps) => {
    const { $, client, directory, tasksDir, log, loaded, ado } = deps;
    const binding = loaded.manifest.workSource;
    if (binding.type !== "github-pr") {
        throw new Error(`loop kind "${loaded.manifest.kind}" does not use a hosted-PR work source`);
    }
    const now = deps.now ?? (() => new Date().toISOString());
    const org = ado.organization;
    const project = ado.project;
    let viewerLogin = null;
    /** The sitter's own login: config override, else the az identity, else "" (degrades like the gh path). */
    const viewer = async () => {
        if (viewerLogin !== null)
            return viewerLogin;
        if (ado.selfLogin)
            return (viewerLogin = ado.selfLogin);
        const aad = await $ `az ad signed-in-user show --query userPrincipalName -o tsv`.cwd(directory).quiet().nothrow();
        if (aad.exitCode === 0 && aad.stdout.toString().trim())
            return (viewerLogin = aad.stdout.toString().trim());
        const acct = await $ `az account show --query user.name -o tsv`.cwd(directory).quiet().nothrow();
        viewerLogin = acct.exitCode === 0 ? acct.stdout.toString().trim() : "";
        return viewerLogin;
    };
    const markers = makeClaimMarkers($, directory, tasksDir);
    /** Names of blocking policies currently failing on the PR (ADO's nearest equivalent of failing checks). */
    const failingPolicies = async (pr) => {
        const out = await $ `az repos pr policy list --id ${String(pr)} --organization ${org} --project ${project} -o json`
            .cwd(directory)
            .quiet()
            .nothrow();
        if (out.exitCode !== 0)
            return [];
        try {
            return failingPolicyNames(AdoPolicySchema.parse(JSON.parse(out.stdout.toString() || "[]")));
        }
        catch {
            return [];
        }
    };
    /** Non-system PR thread comments, flattened to `{ author, at }`, newest state from the REST resource. */
    const threadComments = async (repositoryId, pr) => {
        const out = await $ `az devops invoke --area git --resource pullRequestThreads --route-parameters ${`project=${project}`} ${`repositoryId=${repositoryId}`} ${`pullRequestId=${String(pr)}`} --organization ${org} --api-version 7.1 -o json`
            .cwd(directory)
            .quiet()
            .nothrow();
        if (out.exitCode !== 0)
            return [];
        try {
            const threads = AdoThreadsSchema.parse(JSON.parse(out.stdout.toString() || "{}"));
            return flattenThreadComments(threads.value ?? []);
        }
        catch {
            return [];
        }
    };
    return {
        loopKind: loaded.manifest.kind,
        async claimNext() {
            // Two branches instead of a conditional fragment: the Shell quotes every
            // interpolation as a single argument, so "--repository x" can't be spliced.
            const out = ado.repository
                ? await $ `az repos pr list --status active --top 100 --organization ${org} --project ${project} --repository ${ado.repository} -o json`
                    .cwd(directory)
                    .quiet()
                    .nothrow()
                : await $ `az repos pr list --status active --top 100 --organization ${org} --project ${project} -o json`
                    .cwd(directory)
                    .quiet()
                    .nothrow();
            if (out.exitCode !== 0) {
                return {
                    item: null,
                    skip: {
                        message: `pr-sitter: az repos pr list failed — ${out.stderr.toString().trim() || "unknown error"}. ` +
                            `Is the azure-devops az extension installed and authenticated (az devops login / AZURE_DEVOPS_EXT_PAT)?`,
                        actionable: true,
                    },
                };
            }
            let prs;
            try {
                prs = AdoPrListSchema.parse(JSON.parse(out.stdout.toString() || "[]"));
            }
            catch (err) {
                return {
                    item: null,
                    skip: { message: `pr-sitter: could not parse az output — ${err.message}`, actionable: true },
                };
            }
            const login = await viewer();
            if (!login) {
                // Unlike gh's server-side `author:@me`, the author filter here is
                // client-side — with no identity it would sit on EVERY active PR in
                // the project. Fail actionably instead of degrading.
                return {
                    item: null,
                    skip: {
                        message: "pr-sitter: could not resolve the sitter's own ADO identity (PAT-only auth can't) — " +
                            "set ado.selfLogin in .agentic-loop.json so the sitter only claims its own PRs.",
                        actionable: true,
                    },
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
                const comments = enabled.includes("new-comments")
                    ? await threadComments(pr.repository?.id || pr.repository?.name || "", number)
                    : [];
                const snapshot = {
                    number,
                    title: pr.title,
                    headRefName: stripRef(pr.sourceRefName),
                    baseRefName: stripRef(pr.targetRefName),
                    headRefOid,
                    mergeable: (pr.mergeStatus ?? "").toLowerCase() === "conflicts" ? "CONFLICTING" : "MERGEABLE",
                    reviewDecision: (pr.reviewers ?? []).some((r) => r.vote < 0) ? "CHANGES_REQUESTED" : "",
                    failingChecks: enabled.includes("failing-checks") ? await failingPolicies(number) : [],
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
            const fresh = await $ `az repos pr show --id ${String(snapshot.number)} --organization ${org} -o json`
                .cwd(directory)
                .quiet()
                .nothrow();
            let head = snapshot.headRefOid;
            let repositoryId = "";
            if (fresh.exitCode === 0) {
                try {
                    const data = JSON.parse(fresh.stdout.toString());
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
