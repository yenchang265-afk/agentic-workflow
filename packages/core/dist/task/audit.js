import { STATUSES } from "./store.js";
/**
 * Backlog reconciliation sweep: detect the damage a confused agent can do
 * despite the guard — stray folders (`docs/tasks/run/`…), task files outside
 * any status folder, and one id present in several status folders at once.
 * Report-only: repair lives in `rescueStray` (store.ts) behind the explicit
 * `loop_doctor` / `/agent-loop doctor` verbs.
 */
/** Non-status dirs that legitimately live at the backlog root. */
const KNOWN_NON_STATUS_DIRS = ["runs"];
export const hasAnomalies = (a) => a.unknownDirs.length > 0 || a.strayFiles.length > 0 || a.duplicates.length > 0;
/** One human-readable warning line per finding. Pure. */
export const formatAnomalies = (a, tasksDir) => [
    ...a.unknownDirs.map((d) => `unknown folder ${tasksDir}/${d}/ — not a status folder; a confused agent likely created it`),
    ...a.strayFiles.map((f) => `stray task file ${f} — outside every status folder, invisible to the loop`),
    ...a.duplicates.map((d) => `duplicate task "${d.id}" in ${d.statuses.join(", ")} — resolve manually (keep one, abandon the rest)`),
];
const isMarkdown = (name) => name.toLowerCase().endsWith(".md");
const listDir = async (client, directory, rel) => {
    try {
        const res = await client.file.list({ query: { path: rel, directory } });
        return res.data ?? [];
    }
    catch {
        return [];
    }
};
/** Sweep the backlog for structural anomalies. Read-only. */
export const auditBacklog = async (client, directory, tasksDir) => {
    const root = await listDir(client, directory, tasksDir);
    const unknownDirs = root
        .filter((n) => n.type === "directory" && !n.name.startsWith("."))
        .map((n) => n.name)
        .filter((name) => !STATUSES.includes(name) && !KNOWN_NON_STATUS_DIRS.includes(name))
        .sort();
    const strayFiles = root
        .filter((n) => n.type === "file" && isMarkdown(n.name))
        .map((n) => `${tasksDir}/${n.name}`);
    for (const dir of unknownDirs) {
        const nodes = await listDir(client, directory, `${tasksDir}/${dir}`);
        for (const n of nodes) {
            if (n.type === "file" && isMarkdown(n.name))
                strayFiles.push(`${tasksDir}/${dir}/${n.name}`);
        }
    }
    const seen = new Map();
    for (const status of STATUSES) {
        const nodes = await listDir(client, directory, `${tasksDir}/${status}`);
        for (const n of nodes) {
            if (n.type !== "file" || !isMarkdown(n.name))
                continue;
            const id = n.name.replace(/\.md$/i, "");
            seen.set(id, [...(seen.get(id) ?? []), status]);
        }
    }
    const duplicates = [...seen.entries()]
        .filter(([, statuses]) => statuses.length > 1)
        .map(([id, statuses]) => ({ id, statuses }))
        .sort((a, b) => a.id.localeCompare(b.id));
    return { unknownDirs, strayFiles, duplicates };
};
