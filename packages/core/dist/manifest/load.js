import fs from "node:fs";
import path from "node:path";
import { parseManifest } from "./schema.js";
/**
 * Load loop-kind manifests from a `loops/` directory:
 *
 *   loops/<kind>/loop.json      — the manifest (schema.ts)
 *   loops/<kind>/stages/*.md    — per-stage prompt templates (template.ts)
 *
 * Loading is synchronous, once, at host startup — manifests are plugin
 * assets, not runtime state. A malformed manifest throws with the offending
 * path so a broken loop kind fails loud instead of driving garbage.
 */
/** Load one loop kind's manifest + stage prompts. Throws on missing/invalid files. */
export const loadManifest = (loopsDir, kind) => {
    const dir = path.join(loopsDir, kind);
    const manifestPath = path.join(dir, "loop.json");
    let manifest;
    try {
        manifest = parseManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    }
    catch (err) {
        throw new Error(`could not load loop manifest ${manifestPath}: ${err.message}`);
    }
    if (manifest.kind !== kind) {
        throw new Error(`loop manifest ${manifestPath} declares kind "${manifest.kind}" but lives in loops/${kind}/`);
    }
    const prompts = {};
    for (const stage of manifest.stages) {
        const promptPath = path.join(dir, stage.prompt);
        try {
            prompts[stage.name] = fs.readFileSync(promptPath, "utf8");
        }
        catch (err) {
            throw new Error(`could not load stage prompt ${promptPath}: ${err.message}`);
        }
    }
    return { manifest, prompts };
};
/** Every loop kind defined under `loopsDir` (any directory holding a loop.json). */
export const listLoopKinds = (loopsDir) => {
    let entries;
    try {
        entries = fs.readdirSync(loopsDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    return entries
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(loopsDir, e.name, "loop.json")))
        .map((e) => e.name)
        .sort();
};
