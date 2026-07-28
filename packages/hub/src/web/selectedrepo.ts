/**
 * The currently selected repo id, as a module-level cell.
 *
 * `EventsProvider` has to know which repo the user is looking at in order to
 * ignore events from the others, but it *wraps* `RepoProvider` (which reads
 * `versions.repos` to refetch /api/repos), so it cannot read that context.
 * Rather than invert the providers — which would break the repo list's own
 * live update — the selection is published here and read there. A tiny shared
 * module rather than an import between the two, so neither depends on the
 * other and there is no cycle.
 */
export const selectedRepo: { current: string | null } = { current: null }

/** Whether an event tagged with `repo` concerns the repo currently on screen. */
export const isForSelectedRepo = (repo: string): boolean =>
  // Before /api/repos answers, nothing is selected and the server is serving
  // its own default — filtering then would drop every event of the first paint.
  selectedRepo.current === null || selectedRepo.current === repo
