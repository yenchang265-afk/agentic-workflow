import path from "node:path";
import { redact } from "./redact.js";
import { buildTaskFile, parseTask } from "./schema.js";
const isMarkdown = (name) => name.toLowerCase().endsWith(".md");
/** All tasks in claim order: lowest priority number first, ties broken by id. Pure. */
export const selectOrder = (tasks) => [...tasks].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
/** Pick the next task: lowest priority number, ties broken by id. Pure. */
export const selectNext = (tasks) => selectOrder(tasks)[0] ?? null;
/** Marks a task as planned, awaiting approval — appended to its body by `appendPlan`. */
export const PLAN_HEADING = "## Implementation Plan";
/** Whether a task already has a plan persisted (appended at a prior approval gate). Pure. */
export const hasPlan = (task) => task.body.includes(PLAN_HEADING);
/**
 * Eligible for `/agent-loop watch` to claim: planned, and never had ANY
 * "> BUILD started" note — not just "last pair unmatched" (that's
 * `wasInterrupted`, below). Any marker at all means another live LoopState
 * is driving it right now, or it crashed and needs manual recovery — a
 * watch session must never silently reclaim either case. Pure.
 */
export const isClaimable = (task) => hasPlan(task) && !task.body.includes("> BUILD started");
/** The persisted plan text following `PLAN_HEADING`, or `undefined` if absent. Pure. */
export const extractPlan = (task) => {
    const idx = task.body.indexOf(PLAN_HEADING);
    if (idx === -1)
        return undefined;
    return task.body.slice(idx + PLAN_HEADING.length).trim();
};
/**
 * Planned and started at least once — no longer claimable by `/agent-loop watch`,
 * but a human can force-resume it with `/agent-loop recover <id>` once no live
 * loop is driving it (crashed runs, restarted plugins). Pure.
 */
export const isRecoverable = (task) => hasPlan(task) && task.body.includes("> BUILD started");
/**
 * Whether the task's last recorded BUILD run has no matching "finished" note —
 * i.e. the process likely died mid-build, possibly leaving a half-finished diff
 * in the working tree. Only BUILD is tracked: it's the sole stage that writes
 * code. Pure.
 */
export const wasInterrupted = (task) => {
    const lastStart = task.body.lastIndexOf("> BUILD started");
    if (lastStart === -1)
        return false;
    const lastFinish = task.body.lastIndexOf("> BUILD finished");
    return lastFinish < lastStart;
};
/** The status folders, in lifecycle order. */
export const STATUSES = [
    "draft",
    "queued",
    "plan-review",
    "in-progress",
    "in-review",
    "completed",
    "abandoned",
];
/**
 * Roll up tasks-by-status into counts and actionable flag lists. `claimedIds`
 * (ids holding a claim marker, see `listClaimIds`) splits body-claimable tasks
 * into truly claimable vs claim-held, so status never reports a task "ready"
 * that no watcher can actually claim. Pure.
 */
export const summarizeBacklog = (byStatus, claimedIds = []) => {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, byStatus[s]?.length ?? 0]));
    const ids = (tasks) => tasks.map((t) => t.id);
    const inProgress = byStatus["in-progress"] ?? [];
    const held = new Set(claimedIds);
    return {
        counts,
        awaitingPlan: ids(byStatus["queued"] ?? []),
        gated: ids((byStatus["plan-review"] ?? []).filter(hasPlan)),
        claimable: ids(inProgress.filter((t) => isClaimable(t) && !held.has(t.id))),
        claimHeld: ids(inProgress.filter((t) => isClaimable(t) && held.has(t.id))),
        interrupted: ids(inProgress.filter(wasInterrupted)),
        awaitingReview: ids(byStatus["in-review"] ?? []),
    };
};
/**
 * List and parse every task in a given status folder. Invalid files are
 * skipped (logged) rather than failing the whole pick. Returns `[]` when the
 * folder is absent.
 */
export const listByStatus = async (client, directory, tasksDir, status, log) => {
    const dir = `${tasksDir}/${status}`;
    let nodes;
    try {
        const res = await client.file.list({ query: { path: dir, directory } });
        nodes = res.data ?? [];
    }
    catch {
        return []; // folder absent / not yet created
    }
    const tasks = [];
    for (const node of nodes) {
        if (node.type !== "file" || !isMarkdown(node.name))
            continue;
        const read = await client.file.read({ query: { path: node.path, directory } });
        const content = read.data?.content;
        if (!content)
            continue;
        try {
            tasks.push(parseTask(node.name, content, node.absolute));
        }
        catch (err) {
            log?.("warn", `skipping ${node.path}: ${err.message}`);
        }
    }
    return tasks;
};
/** List and parse every task in `queued/` — approved, awaiting the loop's PLAN stage. */
export const listQueued = (client, directory, tasksDir, log) => listByStatus(client, directory, tasksDir, "queued", log);
/** List and parse every task in `in-progress/` — the pool `/agent-loop watch` claims from. */
export const listInProgress = (client, directory, tasksDir, log) => listByStatus(client, directory, tasksDir, "in-progress", log);
/** Resolve a specific task by id within a status folder, or null if missing/invalid. */
export const findByIdIn = async (client, directory, tasksDir, status, id) => {
    const filename = `${id}.md`;
    const rel = `${tasksDir}/${status}/${filename}`;
    const read = await client.file.read({ query: { path: rel, directory } }).catch(() => null);
    const content = read?.data?.content;
    if (!content)
        return null;
    try {
        return parseTask(filename, content, path.join(directory, rel));
    }
    catch {
        return null;
    }
};
/** Directory of atomic claim markers, alongside the task files of one status folder. */
const claimsDir = (taskPath) => path.join(path.dirname(taskPath), ".claims");
/**
 * Atomically claim a task for execution. A plain (non-recursive) `mkdir` of
 * the marker either succeeds — claim won — or fails because another watcher
 * on this filesystem already holds it. Closes the window between listing
 * claimable tasks and appending the `> BUILD started` note.
 */
export const claimTask = async ($, task) => {
    await $ `mkdir -p ${claimsDir(task.path)}`.quiet().nothrow();
    const out = await $ `mkdir ${path.join(claimsDir(task.path), task.id)}`.quiet().nothrow();
    return out.exitCode === 0;
};
/** Release a task's claim marker, if present. Best-effort. */
export const releaseClaim = async ($, task) => {
    await $ `rmdir ${path.join(claimsDir(task.path), task.id)}`.quiet().nothrow();
};
/**
 * A claim marker older than this, on a task with no BUILD note and no live
 * loop, is treated as orphaned — its claimer died between `claimTask` and the
 * first "BUILD started" note. Must exceed the worst-case claim→BUILD-note
 * window, including a slow `worktreeSetup` (e.g. npm ci).
 */
export const STALE_CLAIM_MINUTES = 15;
/**
 * Whether a `FileRef`'s claim marker exists and is older than `minutes`.
 * `find -mmin +N` prints the path only when strictly older (GNU and BSD).
 * Any failure — marker absent, or a `find` without `-mmin` semantics — reads
 * as "not stale", degrading safely to "marker stays held".
 */
export const claimOlderThan = async ($, task, minutes) => {
    const marker = path.join(claimsDir(task.path), task.id);
    const out = await $ `find ${marker} -maxdepth 0 -mmin +${String(minutes)}`.quiet().nothrow();
    return out.exitCode === 0 && out.stdout.toString().trim().length > 0;
};
/** Ids currently holding a claim marker in a status folder's `.claims/`. `[]` when absent. */
export const listClaimIds = async ($, directory, tasksDir, status = "in-progress") => {
    const dir = path.join(directory, tasksDir, status, ".claims");
    const out = await $ `ls -1 ${dir}`.quiet().nothrow();
    if (out.exitCode !== 0)
        return [];
    return out.stdout
        .toString()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
};
/**
 * An orphaned claim: the task body never recorded a BUILD (still claimable),
 * no live loop is driving it, and the marker has aged past the crash window.
 * Only such markers may be released without racing a live claimer. Pure.
 */
export const isOrphanedClaim = (task, opts) => isClaimable(task) && !opts.drivenByLiveLoop && opts.markerStale;
/**
 * The `queued/` variant of `isOrphanedClaim`: a queued task is planless by
 * definition (no `isClaimable` gate applies) and its PLAN stage never writes
 * code, so a stale, undriven marker is always safe to release — a died PLAN
 * left at most a partial plan on the task file, which the next PLAN pass
 * overwrites. Pure.
 */
export const isOrphanedPlanClaim = (_task, opts) => !opts.drivenByLiveLoop && opts.markerStale;
/**
 * Try candidates (already in `selectOrder`) until one claim wins — a single
 * held marker must not block the tasks queued behind it. A failed claim whose
 * marker looks orphaned is released and retried ONCE; failing the retry means
 * another instance raced us — treat as held and move on.
 */
export const claimFirst = async ($, candidates, opts) => {
    const heldIds = [];
    const isOrphaned = opts.isOrphaned ?? isOrphanedClaim;
    for (const task of candidates) {
        if (await claimTask($, task))
            return { claimed: task, heldIds };
        const markerStale = await claimOlderThan($, task, opts.staleMinutes ?? STALE_CLAIM_MINUTES);
        if (isOrphaned(task, { drivenByLiveLoop: opts.isDriving(task.id), markerStale })) {
            opts.log?.("warn", `releasing orphaned claim marker for ${task.id} — its claimer died before the stage started`);
            await releaseClaim($, task);
            if (await claimTask($, task))
                return { claimed: task, heldIds };
        }
        heldIds.push(task.id);
    }
    return { claimed: null, heldIds };
};
/**
 * Startup sweep: release claim markers left behind by dead runs. Two shapes —
 * a marker whose task body is still claimable (crashed between `claimTask`
 * and the BUILD note), and a marker with no task file at all (crashed between
 * `moveTask`'s `mv` and `rmdir`). Both only when stale and not live-driven.
 * Returns the released ids.
 */
export const releaseOrphanedClaims = async ($, inProgress, claimIds, inProgressDir, opts) => {
    const byId = new Map(inProgress.map((t) => [t.id, t]));
    const isOrphaned = opts.isOrphaned ?? isOrphanedClaim;
    const released = [];
    for (const id of claimIds) {
        const task = byId.get(id);
        const ref = task ?? { id, path: path.join(inProgressDir, `${id}.md`) };
        const markerStale = await claimOlderThan($, ref, opts.staleMinutes ?? STALE_CLAIM_MINUTES);
        const orphaned = task
            ? isOrphaned(task, { drivenByLiveLoop: opts.isDriving(id), markerStale })
            : markerStale && !opts.isDriving(id);
        if (!orphaned)
            continue;
        await releaseClaim($, ref);
        released.push(id);
    }
    return released;
};
/** The forward lifecycle order (excludes `abandoned`, which is a cancellation escape, not a stage). */
const FORWARD_ORDER = ["draft", "queued", "plan-review", "in-progress", "in-review", "completed"];
/**
 * Whether a task may move from `from` to `to`. Tasks advance exactly one
 * stage at a time — no skipping — with two escapes: any non-terminal stage
 * may be abandoned directly (cancellation isn't a forward skip), and a
 * replan sends `plan-review` or `in-progress` back to `queued` (the plan was
 * rejected or the loop capped out — the PLAN stage runs again). `completed`
 * and `abandoned` are terminal: nothing moves out of them. Pure.
 */
export const canTransition = (from, to) => {
    if (from === "completed" || from === "abandoned")
        return false;
    if (to === "abandoned")
        return true;
    if (to === "queued" && (from === "plan-review" || from === "in-progress"))
        return true;
    const fromIdx = FORWARD_ORDER.indexOf(from);
    const toIdx = FORWARD_ORDER.indexOf(to);
    return fromIdx !== -1 && toIdx === fromIdx + 1;
};
/** The status folder a task file currently lives in, derived from its path. */
export const statusOf = (task) => {
    const status = path.basename(path.dirname(task.path));
    if (!STATUSES.includes(status)) {
        throw new Error(`${task.path} is not inside a known status folder`);
    }
    return status;
};
/**
 * Move a task file into a new status folder. Returns its new absolute path.
 * Enforces the lifecycle order via `canTransition` — throws rather than
 * skipping a stage.
 */
export const moveTask = async ($, task, toStatus) => {
    const fromStatus = statusOf(task);
    if (!canTransition(fromStatus, toStatus)) {
        throw new Error(`cannot move ${task.id} from ${fromStatus} to ${toStatus} — tasks must advance one stage at a time`);
    }
    const root = path.dirname(path.dirname(task.path)); // …/docs/tasks
    const destDir = path.join(root, toStatus);
    const dest = path.join(destDir, `${task.id}.md`);
    await $ `mkdir -p ${destDir}`.quiet().nothrow();
    const out = await $ `mv ${task.path} ${dest}`.quiet().nothrow();
    if (out.exitCode !== 0) {
        throw new Error(`could not move ${task.id} → ${toStatus}: ${out.stderr.toString().trim()}`);
    }
    await releaseClaim($, task); // a claim belongs to the status folder it was taken in
    return dest;
};
/**
 * Rescue a stray task file (found by `auditBacklog` outside every status
 * folder — e.g. `docs/tasks/run/x.md`) back into `draft/`, the human-review
 * inbox. Deliberately bypasses `canTransition`: `statusOf` throws on unknown
 * folders, and a rescue is a repair, not a lifecycle move — `moveTask` stays
 * strict. Refuses to clobber an existing draft; returns the new path.
 */
export const rescueStray = async ($, directory, tasksDir, relPath) => {
    const id = path.basename(relPath).replace(/\.md$/i, "");
    const src = path.join(directory, relPath);
    const dest = path.join(directory, tasksDir, "draft", `${id}.md`);
    const exists = await $ `test -e ${dest}`.quiet().nothrow();
    if (exists.exitCode === 0) {
        throw new Error(`cannot rescue ${relPath}: draft/${id}.md already exists — resolve the collision manually`);
    }
    await $ `mkdir -p ${path.join(directory, tasksDir, "draft")}`.quiet().nothrow();
    const out = await $ `mv ${src} ${dest}`.quiet().nothrow();
    if (out.exitCode !== 0) {
        throw new Error(`could not rescue ${relPath} → draft/: ${out.stderr.toString().trim()}`);
    }
    return { id, path: dest };
};
/** Warn about redaction hits without ever echoing the secret (names only). */
const warnRedaction = (hits, where, log) => {
    if (!hits.length || !log)
        return;
    const summary = hits.map((h) => `${h.pattern} ×${h.count}`).join(", ");
    log("warn", `redacted secret-shaped strings from ${where}: ${summary}`);
};
/** Append a blockquote note to a task file in place. Secrets redacted. Best-effort. */
export const appendNote = async ($, task, note, log) => {
    const { text, hits } = redact(note);
    warnRedaction(hits, `note on ${task.id}`, log);
    await $ `printf '\n> %s\n' ${text} >> ${task.path}`.quiet().nothrow();
};
/**
 * Render an audit event note: the event text with a timestamp-and-actor
 * suffix. The suffix comes last so marker greps (`> BUILD started`, …) keep
 * matching. Pure.
 */
export const auditNote = (text, at, actor) => `${text} [${at.toISOString()}${actor ? ` by ${actor}` : ""}]`;
/**
 * Append a stage's captured output to the loop's run log,
 * `<tasksDir>/runs/<id>.md` — the durable record of what each stage actually
 * said (verdict evidence, review findings), which the in-memory artifacts
 * are not. Best-effort.
 */
export const appendRunLog = async ($, directory, tasksDir, id, header, text, log) => {
    const dir = path.join(directory, tasksDir, "runs");
    await $ `mkdir -p ${dir}`.quiet().nothrow();
    const file = path.join(dir, `${id}.md`);
    const clean = redact(text);
    warnRedaction(clean.hits, `run log ${id}.md`, log);
    await $ `printf '\n## %s\n\n%s\n' ${header} ${clean.text} >> ${file}`.quiet().nothrow();
};
/** Append a plan under `PLAN_HEADING` to a task file in place. Secrets redacted. Best-effort. */
export const appendPlan = async ($, task, plan, log) => {
    const { text, hits } = redact(plan);
    warnRedaction(hits, `plan on ${task.id}`, log);
    await $ `printf '\n%s\n\n%s\n' ${PLAN_HEADING} ${text} >> ${task.path}`.quiet().nothrow();
};
/** Existing task ids (filenames without `.md`) in a status folder; `[]` if absent. */
const listIds = async (client, directory, rel) => {
    try {
        const res = await client.file.list({ query: { path: rel, directory } });
        return (res.data ?? [])
            .filter((n) => n.type === "file" && isMarkdown(n.name))
            .map((n) => n.name.replace(/\.md$/i, ""));
    }
    catch {
        return [];
    }
};
/**
 * Create a task file programmatically from *inside the plugin runtime* (a
 * future in-plugin sync adapter — see docs/design/explore-task-fetch-and-pr-gating.md).
 * Needs an opencode `client` and Bun `$`, so it can't run as a plain terminal
 * command. For creating a task today, use `/agent-loop-task new <idea>` — the
 * `loop-plan-author` subagent, which runs inside OpenCode; see the
 * `task-backlog-management` skill. Serializes + validates via `buildTaskFile`,
 * picks a non-colliding filename against what's already in the folder, and
 * writes it. Returns the new task's id and absolute path.
 */
export const writeTask = async ($, client, loc, input) => {
    const tasksDir = loc.tasksDir ?? "docs/tasks";
    const status = loc.status ?? "draft";
    const rel = `${tasksDir}/${status}`;
    const taken = await listIds(client, loc.directory, rel);
    const { id, filename, content } = buildTaskFile(input, taken);
    const destDir = path.join(loc.directory, rel);
    const dest = path.join(destDir, filename);
    await $ `mkdir -p ${destDir}`.quiet().nothrow();
    const out = await $ `printf '%s' ${content} > ${dest}`.quiet().nothrow();
    if (out.exitCode !== 0) {
        throw new Error(`could not write task ${filename}: ${out.stderr.toString().trim()}`);
    }
    return { id, path: dest };
};
