import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Where the workflow-kind manifests shipped with this repo live (workflows/<kind>/).
 *
 * Resolved from THIS module's install location — `dist/manifest/dir.js` (built)
 * or `src/manifest/dir.ts` (raw) → two levels up → `<core package root>/workflows`
 * — so it keeps working no matter where a consumer plugin sits on disk.
 * `AGENTIC_WORKFLOW_WORKFLOWS_DIR` overrides it (tests, forks carrying their own
 * kinds, or a checkout layout this resolution can't see).
 */
export const defaultWorkflowsDir = (): string =>
  process.env.AGENTIC_WORKFLOW_WORKFLOWS_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows")
