import assert from "node:assert/strict"
import { test } from "node:test"
import { acquireLease, heartbeatLease, isLeaseStale, type LeaseOwner, readLeaseOwner, releaseLease, staleThresholdMs } from "./lease.js"

/**
 * Fake shell with a tiny stateful filesystem: tracks whether the lease dir
 * exists and the owner.json content, so acquire/contend/takeover sequences
 * behave like the real thing. Mirrors makeShell in ../task/store.test.ts.
 */
const makeLeaseFs = (initial?: { ownerJson?: string; mvFails?: boolean }) => {
  const state = { dirExists: initial ? true : false, ownerJson: initial?.ownerJson ?? "" }
  const log: string[] = []
  const handler = (cmd: string): { exitCode?: number; stdout?: string } => {
    if (cmd.startsWith("mkdir -p")) return { exitCode: 0 }
    if (cmd.startsWith("mkdir ")) {
      if (state.dirExists) return { exitCode: 1 }
      state.dirExists = true
      return { exitCode: 0 }
    }
    if (cmd.startsWith("mv ")) {
      // Atomic takeover rename: succeeds only if the lease dir still exists
      // (consuming it, like renaming it to the graveyard); a lost race fails.
      if (initial?.mvFails || !state.dirExists) return { exitCode: 1 }
      state.dirExists = false
      state.ownerJson = ""
      return { exitCode: 0 }
    }
    if (cmd.startsWith("rm -rf")) {
      // In the takeover path this removes the graveyard, not the live lease; the
      // single-dir model already cleared the lease on `mv`, so this is a no-op there.
      if (/\.dead-/.test(cmd)) return { exitCode: 0 }
      state.dirExists = false
      state.ownerJson = ""
      return { exitCode: 0 }
    }
    if (cmd.startsWith("cat ")) {
      return state.dirExists && state.ownerJson ? { exitCode: 0, stdout: state.ownerJson } : { exitCode: 1 }
    }
    if (cmd.startsWith("printf ")) {
      // printf '%s' <json> > <file> — the json is the second token onward, up to " > ".
      const m = /^printf '%s' (.*) > .*owner\.json$/.exec(cmd)
      if (m) state.ownerJson = m[1]!
      return { exitCode: 0 }
    }
    return { exitCode: 0 }
  }
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
    })
    cmd = cmd.trim().replace(/\s+/g, " ")
    log.push(cmd)
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const r = handler(cmd)
        return Promise.resolve({
          exitCode: r.exitCode ?? 0,
          stdout: { toString: () => r.stdout ?? "" },
          stderr: { toString: () => "" },
        }).then(resolve, reject)
      },
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const $ = ((strings: TemplateStringsArray, ...exprs: unknown[]) => build(strings, exprs)) as any
  return { $, state, log }
}

const now = new Date("2026-07-06T12:00:00.000Z")
const me = { pid: 100, host: "alpha", intervalMs: 60_000 }

const liveOwner = (heartbeatAt: string): LeaseOwner => ({
  pid: 200,
  host: "beta",
  startedAt: "2026-07-06T11:00:00.000Z",
  heartbeatAt,
  intervalMs: 60_000,
})

test("staleThresholdMs is 3 intervals floored at two minutes", () => {
  assert.equal(staleThresholdMs(60_000), 180_000)
  assert.equal(staleThresholdMs(10_000), 120_000)
})

test("isLeaseStale judges by heartbeat age; missing or garbled owners are stale", () => {
  assert.equal(isLeaseStale(liveOwner("2026-07-06T11:59:30.000Z"), now, 180_000), false)
  assert.equal(isLeaseStale(liveOwner("2026-07-06T11:00:00.000Z"), now, 180_000), true)
  assert.equal(isLeaseStale(null, now, 180_000), true)
  assert.equal(isLeaseStale(liveOwner("not-a-date"), now, 180_000), true)
})

test("acquireLease wins on a free clone and records the owner", async () => {
  const { $, state } = makeLeaseFs()
  const res = await acquireLease($, "/r", "docs/tasks", me, now)
  assert.deepEqual(res, { ok: true })
  const owner = await readLeaseOwner($, "/r", "docs/tasks")
  assert.equal(owner?.pid, 100)
  assert.equal(owner?.heartbeatAt, now.toISOString())
  assert.equal(state.dirExists, true)
})

test("acquireLease refuses when a live owner holds the lease, reporting who", async () => {
  const { $ } = makeLeaseFs({ ownerJson: JSON.stringify(liveOwner("2026-07-06T11:59:00.000Z")) })
  const res = await acquireLease($, "/r", "docs/tasks", me, now)
  assert.equal(res.ok, false)
  assert.equal(!res.ok && res.owner?.pid, 200)
})

test("acquireLease takes over a stale lease by renaming it aside atomically", async () => {
  const { $, log } = makeLeaseFs({ ownerJson: JSON.stringify(liveOwner("2026-07-06T10:00:00.000Z")) })
  const res = await acquireLease($, "/r", "docs/tasks", me, now)
  assert.deepEqual(res, { ok: true })
  const owner = await readLeaseOwner($, "/r", "docs/tasks")
  assert.equal(owner?.pid, 100)
  // Takeover goes through an atomic rename (mv), never a bare rm -rf of the live dir.
  assert.ok(
    log.some((c) => c.startsWith("mv ") && /\.dead-/.test(c)),
    "expected an atomic mv-based takeover",
  )
})

test("acquireLease that loses the takeover rename backs off and reports the winner", async () => {
  // Two takers see the same stale lease; the one whose `mv` fails (the other moved
  // it first) must NOT recreate the lease — it reports the current owner instead.
  const { $ } = makeLeaseFs({ ownerJson: JSON.stringify(liveOwner("2026-07-06T10:00:00.000Z")), mvFails: true })
  const res = await acquireLease($, "/r", "docs/tasks", me, now)
  assert.equal(res.ok, false)
  assert.equal(!res.ok && res.owner?.pid, 200)
})

test("acquireLease treats a garbled owner record as stale and takes over", async () => {
  const { $ } = makeLeaseFs({ ownerJson: "not json" })
  const res = await acquireLease($, "/r", "docs/tasks", me, now)
  assert.deepEqual(res, { ok: true })
})

test("heartbeatLease refreshes heartbeatAt but preserves startedAt", async () => {
  const { $ } = makeLeaseFs()
  await acquireLease($, "/r", "docs/tasks", me, now)
  const later = new Date("2026-07-06T12:01:00.000Z")
  await heartbeatLease($, "/r", "docs/tasks", me, later)
  const owner = await readLeaseOwner($, "/r", "docs/tasks")
  assert.equal(owner?.startedAt, now.toISOString())
  assert.equal(owner?.heartbeatAt, later.toISOString())
})

test("releaseLease frees the clone for the next acquirer", async () => {
  const { $ } = makeLeaseFs()
  await acquireLease($, "/r", "docs/tasks", me, now)
  await releaseLease($, "/r", "docs/tasks")
  const res = await acquireLease($, "/r", "docs/tasks", { ...me, pid: 300 }, now)
  assert.deepEqual(res, { ok: true })
})
