/**
 * Where the loop-kind manifests shipped with this repo live (loops/<kind>/).
 *
 * Resolved from THIS module's install location — `dist/manifest/dir.js` (built)
 * or `src/manifest/dir.ts` (raw) → two levels up → `<core package root>/loops`
 * — so it keeps working no matter where a consumer plugin sits on disk.
 * `AGENTIC_LOOP_LOOPS_DIR` overrides it (tests, forks carrying their own
 * kinds, or a checkout layout this resolution can't see).
 */
export declare const defaultLoopsDir: () => string;
