import type { HubDeps } from "./deps.js"

/** Read a repo-relative file's text through the host client, or null. The
 * one spelling of a pattern that metrics/runs/tokens/driving all need. */
export const readText = async (deps: HubDeps, rel: string): Promise<string | null> => {
  const res = await deps.client.file.read({ query: { path: rel, directory: deps.directory } }).catch(() => null)
  return res?.data?.content ?? null
}

/**
 * Map with bounded concurrency, preserving order. The routes that walk all of
 * `runs/` need this: a serial loop scales latency with the backlog's whole
 * history, an unbounded fan-out materializes every file in memory at once.
 * A worker pool (not fixed batches) so one slow item doesn't stall its batch.
 */
export const mapBounded = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
