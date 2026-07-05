import { type LoadedManifest } from "./schema.js";
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
export declare const loadManifest: (loopsDir: string, kind: string) => LoadedManifest;
/** Every loop kind defined under `loopsDir` (any directory holding a loop.json). */
export declare const listLoopKinds: (loopsDir: string) => string[];
