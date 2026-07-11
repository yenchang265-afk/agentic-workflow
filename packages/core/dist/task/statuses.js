/**
 * The backlog status vocabulary, in its own leaf module so dependency-light
 * consumers (the bundled Claude PreToolUse guard hook inlines
 * `task/guard.ts`) don't drag the whole store — and its yaml/zod schema
 * machinery — into their bundle. `task/store.ts` re-exports both names, so
 * existing imports keep working.
 */
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
