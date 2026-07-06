import type { Client } from "../host.js";
import { type TaskStatus } from "./store.js";
export interface BacklogAnomalies {
    /** Backlog-root subdirs that are neither a status folder nor `runs/`. */
    readonly unknownDirs: readonly string[];
    /** Repo-relative paths of `.md` files at the backlog root or inside unknown dirs. */
    readonly strayFiles: readonly string[];
    /** Task ids present in more than one status folder, with where they were seen. */
    readonly duplicates: readonly {
        readonly id: string;
        readonly statuses: readonly TaskStatus[];
    }[];
}
export declare const hasAnomalies: (a: BacklogAnomalies) => boolean;
/** One human-readable warning line per finding. Pure. */
export declare const formatAnomalies: (a: BacklogAnomalies, tasksDir: string) => string[];
/** Sweep the backlog for structural anomalies. Read-only. */
export declare const auditBacklog: (client: Client, directory: string, tasksDir: string) => Promise<BacklogAnomalies>;
