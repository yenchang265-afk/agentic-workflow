import type { Shell } from "../host.js";
/**
 * Single-watcher lease: at most one watch-mode process per clone. The lease
 * is an atomically-created directory (`mkdir`, the same primitive the claim
 * markers trust) holding an `owner.json` with liveness timestamps. Liveness
 * is judged from the JSON's `heartbeatAt`, never fs mtime — DrvFS/WSL mtime
 * is unreliable. A dead watcher's lease is taken over once its heartbeat
 * ages past the stale threshold.
 *
 * This protects the cross-process races the claim markers cannot: git
 * `index.lock` contention, in-place appends, and branch switches from two
 * watchers sharing one clone (threat-model T3).
 */
export interface LeaseOwner {
    readonly pid: number;
    readonly host: string;
    readonly startedAt: string;
    readonly heartbeatAt: string;
    readonly intervalMs: number;
}
export type AcquireResult = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly owner: LeaseOwner | null;
};
export declare const leaseDir: (directory: string, tasksDir: string) => string;
/** Stale threshold: several missed heartbeats, floored so slow ticks don't cause takeover storms. */
export declare const staleThresholdMs: (intervalMs: number) => number;
/** Whether an owner record reads as dead. A missing/garbled record is stale (safe to take over). Pure. */
export declare const isLeaseStale: (owner: LeaseOwner | null, now: Date, staleMs: number) => boolean;
/** Read and validate the current owner record; null when absent or unparseable. */
export declare const readLeaseOwner: ($: Shell, directory: string, tasksDir: string) => Promise<LeaseOwner | null>;
/**
 * Acquire the clone's watch lease. Wins the atomic `mkdir`, or takes over a
 * stale lease (`rm -rf` + one retry — losing the retry means another process
 * raced the takeover; report the winner). On refusal, returns the live owner
 * so the caller can say who holds it.
 */
export declare const acquireLease: ($: Shell, directory: string, tasksDir: string, owner: {
    readonly pid: number;
    readonly host: string;
    readonly intervalMs: number;
}, now: Date) => Promise<AcquireResult>;
/** Refresh the lease's heartbeat, preserving its `startedAt`. Best-effort. */
export declare const heartbeatLease: ($: Shell, directory: string, tasksDir: string, owner: {
    readonly pid: number;
    readonly host: string;
    readonly intervalMs: number;
}, now: Date) => Promise<void>;
/** Drop the lease. Best-effort — callers release on unwatch/stop/dispose. */
export declare const releaseLease: ($: Shell, directory: string, tasksDir: string) => Promise<void>;
