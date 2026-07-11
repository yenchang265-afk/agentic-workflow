import { resolveClaimPredicate } from "../manifest/registry.js";
import { claimFirst, extractPlan, findByIdIn, isRecoverable, listByStatus, releaseClaim, selectOrder, STALE_CLAIM_MINUTES, } from "../task/store.js";
/**
 * The backlog-folder work source: claimable units of work are markdown task
 * files in the manifest's status folders (`workSource.pools`, walked in
 * priority order — for engineering: build-ready `in-progress/` beats planless
 * `queued/`). Claims stay atomic via the store's `.claims/` mkdir markers;
 * orphaned markers (a claimer that died) are released and retried inline.
 */
/** A task's goal text: title headline plus its body, if any. Pure. */
export const taskGoal = (task) => (task.body ? `${task.title}\n\n${task.body}` : task.title);
/**
 * Compute why a poll claimed nothing, from what the claim walk saw across the
 * pools. Held markers win (they block otherwise-ready work); then empty
 * backlog; then started-but-unclaimed (recover); then the no-plan fallback.
 * Pure. The strings are engineering-flavored (this is the engineering
 * backlog's skip reporter); a future backlog-backed kind with different
 * folders should supply its own.
 */
export const claimSkipReason = (inProgressCount, claimableCount, queuedCount, startedIds, heldIds) => {
    if (heldIds.length) {
        return {
            message: `watch: claim marker held for ${heldIds.join(", ")} — another watcher may be working it; ` +
                `a stale marker auto-releases after ${STALE_CLAIM_MINUTES}m`,
            actionable: true,
        };
    }
    if (inProgressCount === 0 && queuedCount === 0) {
        return { message: "watch: nothing to claim — queued/ and in-progress/ are both empty", actionable: false };
    }
    if (claimableCount === 0 && startedIds.length) {
        return {
            message: `watch: 0 claimable — ${startedIds.length} in-progress task(s) already started: ` +
                `${startedIds.join(", ")} (run /agentic-loop:engineering recover <id>)`,
            actionable: true,
        };
    }
    return {
        message: "watch: 0 claimable — in-progress task(s) have no persisted plan (send them back with /agentic-loop:engineering replan <id>)",
        actionable: true,
    };
};
/** The entry LoopState for a task claimed from a pool. Pure. */
const entryState = (loaded, pool, task) => {
    const plan = extractPlan(task);
    return {
        kind: loaded.manifest.kind,
        goal: taskGoal(task),
        stage: pool.entryStage,
        iteration: 0,
        artifacts: plan ? { plan } : {},
        task: { id: task.id, path: task.path, acceptance: task.acceptance },
    };
};
/** The toast/log verb a claim announces. */
const claimVerb = (entryStage) => entryStage === "build" ? "building…" : entryStage === "plan" ? "planning…" : `${entryStage}…`;
export const makeBacklogSource = (deps) => {
    const { $, client, directory, tasksDir, log, loaded, isDriving } = deps;
    const binding = loaded.manifest.workSource;
    if (binding.type !== "backlog") {
        throw new Error(`loop kind "${loaded.manifest.kind}" does not use a backlog work source`);
    }
    const pools = binding.pools;
    const item = (pool, task) => ({
        id: task.id,
        loopKind: loaded.manifest.kind,
        title: task.title,
        entryStage: pool.entryStage,
        state: entryState(loaded, pool, task),
        claimMessage: `Watch: claimed "${task.title}" — ${claimVerb(pool.entryStage)}`,
        ref: { pool, task },
    });
    return {
        loopKind: loaded.manifest.kind,
        async claimNext() {
            const heldIds = [];
            // Engineering skip-reason inputs (primary pool = build-ready work).
            let primaryTasks = [];
            let primaryClaimable = 0;
            let lastPoolCount = 0;
            for (const [i, pool] of pools.entries()) {
                const tasks = await listByStatus(client, directory, tasksDir, pool.status, log);
                const predicate = pool.claimPredicate ? resolveClaimPredicate(pool.claimPredicate) : null;
                const candidates = selectOrder(predicate ? tasks.filter(predicate) : tasks);
                if (i === 0) {
                    primaryTasks = tasks;
                    primaryClaimable = candidates.length;
                }
                lastPoolCount = tasks.length;
                const walk = await claimFirst($, candidates, {
                    isDriving,
                    log,
                    // With a claim predicate, an orphaned marker is only released while
                    // the body is still claimable (the dead run did no durable work);
                    // without one (planless pools), a stale undriven marker is always
                    // safe to release.
                    isOrphaned: predicate
                        ? (task, opts) => predicate(task) && !opts.drivenByLiveLoop && opts.markerStale
                        : (_task, opts) => !opts.drivenByLiveLoop && opts.markerStale,
                });
                heldIds.push(...walk.heldIds);
                if (walk.claimed)
                    return { item: item(pool, walk.claimed), skip: null };
            }
            const started = primaryTasks.filter(isRecoverable).map((t) => t.id);
            return {
                item: null,
                skip: claimSkipReason(primaryTasks.length, primaryClaimable, lastPoolCount, started, heldIds),
            };
        },
        async release(work) {
            const { pool, task } = work.ref;
            const fresh = await findByIdIn($, directory, tasksDir, pool.status, task.id);
            if (!fresh)
                return;
            const predicate = pool.claimPredicate ? resolveClaimPredicate(pool.claimPredicate) : null;
            // A predicate pool's claim is only ours to release while the body is
            // still claimable — a drive that got as far as durable work (e.g. a
            // "BUILD started" audit note) must keep its marker for recovery.
            if (predicate && !predicate(fresh))
                return;
            await releaseClaim($, fresh);
        },
    };
};
