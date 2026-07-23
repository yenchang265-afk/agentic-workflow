/**
 * In-process serialization for the hub's writes. Two concurrent requests that
 * both pass a read-check before either writes is a TOCTOU — gate moves hit it
 * first (double-click, two tabs), but config saves (read-modify-write of one
 * file) and kind/asset scaffolds (exists-check then write) have the same shape.
 * A promise chain per key makes check+write atomic across THIS hub's requests;
 * races against other processes stay closed by their own guards (core's
 * `moveTask` refuses when a file left its folder, writes go temp+rename).
 */
const locks = new Map<string, Promise<unknown>>()

export const withLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(key, next.catch(() => undefined))
  return next
}
