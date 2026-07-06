import path from "node:path";
export const leaseDir = (directory, tasksDir) => path.join(directory, tasksDir, "runs", ".watch-lease");
const ownerFile = (directory, tasksDir) => path.join(leaseDir(directory, tasksDir), "owner.json");
/** Stale threshold: several missed heartbeats, floored so slow ticks don't cause takeover storms. */
export const staleThresholdMs = (intervalMs) => Math.max(3 * intervalMs, 120_000);
/** Whether an owner record reads as dead. A missing/garbled record is stale (safe to take over). Pure. */
export const isLeaseStale = (owner, now, staleMs) => {
    if (!owner)
        return true;
    const beat = Date.parse(owner.heartbeatAt);
    if (!Number.isFinite(beat))
        return true;
    return now.getTime() - beat > staleMs;
};
/** Read and validate the current owner record; null when absent or unparseable. */
export const readLeaseOwner = async ($, directory, tasksDir) => {
    const out = await $ `cat ${ownerFile(directory, tasksDir)}`.quiet().nothrow();
    if (out.exitCode !== 0)
        return null;
    try {
        const parsed = JSON.parse(out.stdout.toString());
        const o = parsed;
        if (typeof o.pid !== "number" || typeof o.heartbeatAt !== "string")
            return null;
        return {
            pid: o.pid,
            host: typeof o.host === "string" ? o.host : "unknown",
            startedAt: typeof o.startedAt === "string" ? o.startedAt : o.heartbeatAt,
            heartbeatAt: o.heartbeatAt,
            intervalMs: typeof o.intervalMs === "number" ? o.intervalMs : 0,
        };
    }
    catch {
        return null;
    }
};
const writeOwner = async ($, directory, tasksDir, owner) => {
    await $ `printf '%s' ${JSON.stringify(owner)} > ${ownerFile(directory, tasksDir)}`.quiet().nothrow();
};
/**
 * Acquire the clone's watch lease. Wins the atomic `mkdir`, or takes over a
 * stale lease (`rm -rf` + one retry — losing the retry means another process
 * raced the takeover; report the winner). On refusal, returns the live owner
 * so the caller can say who holds it.
 */
export const acquireLease = async ($, directory, tasksDir, owner, now) => {
    const dir = leaseDir(directory, tasksDir);
    const record = {
        ...owner,
        startedAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
    };
    await $ `mkdir -p ${path.dirname(dir)}`.quiet().nothrow();
    const won = await $ `mkdir ${dir}`.quiet().nothrow();
    if (won.exitCode === 0) {
        await writeOwner($, directory, tasksDir, record);
        return { ok: true };
    }
    const current = await readLeaseOwner($, directory, tasksDir);
    if (isLeaseStale(current, now, staleThresholdMs(current?.intervalMs || owner.intervalMs))) {
        await $ `rm -rf ${dir}`.quiet().nothrow();
        const retry = await $ `mkdir ${dir}`.quiet().nothrow();
        if (retry.exitCode === 0) {
            await writeOwner($, directory, tasksDir, record);
            return { ok: true };
        }
        return { ok: false, owner: await readLeaseOwner($, directory, tasksDir) };
    }
    return { ok: false, owner: current };
};
/** Refresh the lease's heartbeat, preserving its `startedAt`. Best-effort. */
export const heartbeatLease = async ($, directory, tasksDir, owner, now) => {
    const current = await readLeaseOwner($, directory, tasksDir);
    await writeOwner($, directory, tasksDir, {
        ...owner,
        startedAt: current?.startedAt ?? now.toISOString(),
        heartbeatAt: now.toISOString(),
    });
};
/** Drop the lease. Best-effort — callers release on unwatch/stop/dispose. */
export const releaseLease = async ($, directory, tasksDir) => {
    await $ `rm -rf ${leaseDir(directory, tasksDir)}`.quiet().nothrow();
};
