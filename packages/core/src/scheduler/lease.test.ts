import assert from "node:assert/strict"
import { test } from "node:test"
import { acquireLease, heartbeatLease, isLeaseStale, type LeaseOwner, readLeaseOwner, releaseLease, staleThresholdMs } from "./lease.js"

const LEASE_DIR = "/r/docs/tasks/runs/.watch-lease"
const OWNER = `${LEASE_DIR}/owner.json`

/**
 * Fake shell over a small path-based filesystem (dirs + files) with real
 * rename semantics — crucially, `mv src dst` where dst is an existing
 * directory NESTS src inside dst rather than failing, exactly like mv(1).
 * The staged-rename acquire's win/lose detection depends on that behavior,
 * so a string-matching fake can't exercise it. Mirrors the shape of
 * makeShell in ../task/store.test.ts.
 */
const makeLeaseFs = (opts?: { failCmd?: (cmd: string) => boolean; onCmd?: (cmd: string) => void }) => {
  const dirs = new Set<string>(["/", "/r"])
  const files = new Map<string, string>()
  const log: string[] = []
  /** Invariant probe: the lease dir must never be visible without its owner record. */
  let exposedBare = false
  // Synthetic inode identity, so `ls -di` can witness a directory being
  // REPLACED (rename-aside + recreate) rather than edited in place — the signal
  // heartbeatLease uses to detect a takeover across its read→write window.
  const inodes = new Map<string, number>()
  let nextInode = 1
  const setInode = (p: string): void => {
    if (!inodes.has(p)) inodes.set(p, nextInode++)
  }
  // A one-shot callback fired just before the next owner.json write lands, so a
  // test can interleave a rival takeover into the heartbeat's read→write window.
  let onBeforeWrite: (() => void) | null = null

  const parent = (p: string): string => p.slice(0, p.lastIndexOf("/")) || "/"
  const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1)
  const mkdirp = (p: string): void => {
    const parts = p.split("/").filter(Boolean)
    let cur = ""
    for (const part of parts) {
      cur += `/${part}`
      dirs.add(cur)
      setInode(cur)
    }
  }
  const rmTree = (p: string): void => {
    dirs.delete(p)
    files.delete(p)
    inodes.delete(p)
    for (const d of [...dirs]) if (d.startsWith(`${p}/`)) dirs.delete(d)
    for (const f of [...files.keys()]) if (f.startsWith(`${p}/`)) files.delete(f)
    for (const i of [...inodes.keys()]) if (i.startsWith(`${p}/`)) inodes.delete(i)
  }
  const moveTree = (src: string, dst: string): void => {
    if (files.has(src)) {
      files.set(dst, files.get(src)!)
      files.delete(src)
      return
    }
    const subDirs = [...dirs].filter((d) => d === src || d.startsWith(`${src}/`))
    const subFiles = [...files.keys()].filter((f) => f.startsWith(`${src}/`))
    for (const d of subDirs) {
      dirs.delete(d)
      const to = dst + d.slice(src.length)
      dirs.add(to)
      // A move carries the inode with it — identity follows the directory.
      if (inodes.has(d)) inodes.set(to, inodes.get(d)!)
      inodes.delete(d)
    }
    for (const f of subFiles) {
      files.set(dst + f.slice(src.length), files.get(f)!)
      files.delete(f)
    }
  }

  const handler = (cmd: string): { exitCode?: number; stdout?: string } => {
    if (opts?.failCmd?.(cmd)) return { exitCode: 1 }
    let m
    if ((m = /^mkdir -p (\S+)$/.exec(cmd))) {
      mkdirp(m[1]!)
      return { exitCode: 0 }
    }
    if ((m = /^mkdir (\S+)$/.exec(cmd))) {
      if (dirs.has(m[1]!)) return { exitCode: 1 }
      dirs.add(m[1]!)
      setInode(m[1]!)
      return { exitCode: 0 }
    }
    if ((m = /^mv (\S+) (\S+)$/.exec(cmd))) {
      const [, src, dstArg] = m
      if (!dirs.has(src!) && !files.has(src!)) return { exitCode: 1 }
      // mv into an existing directory nests the source inside it.
      const dst = dirs.has(dstArg!) ? `${dstArg!}/${base(src!)}` : dstArg!
      moveTree(src!, dst)
      return { exitCode: 0 }
    }
    if ((m = /^rm -rf (\S+)$/.exec(cmd))) {
      rmTree(m[1]!)
      return { exitCode: 0 }
    }
    if ((m = /^rm -f (\S+)$/.exec(cmd))) {
      files.delete(m[1]!)
      return { exitCode: 0 }
    }
    if ((m = /^ls -di (\S+)$/.exec(cmd))) {
      return dirs.has(m[1]!) ? { exitCode: 0, stdout: `${inodes.get(m[1]!) ?? 0} ${m[1]!}` } : { exitCode: 1 }
    }
    if ((m = /^cat (\S+)$/.exec(cmd))) {
      const content = files.get(m[1]!)
      return content === undefined ? { exitCode: 1 } : { exitCode: 0, stdout: content }
    }
    if ((m = /^printf '%s' ([\s\S]*) > (\S+)$/.exec(cmd))) {
      // A takeover can be armed to land right before our owner.json write —
      // reproducing the read→write race heartbeatLease's inode witness guards.
      // writeFileAtomic writes a `owner.json.tmp-*` first, so match the prefix.
      if (m[2]!.startsWith(OWNER) && onBeforeWrite) {
        const run = onBeforeWrite
        onBeforeWrite = null
        run()
      }
      if (!dirs.has(parent(m[2]!))) return { exitCode: 1 }
      files.set(m[2]!, m[1]!)
      return { exitCode: 0 }
    }
    if ((m = /^test -[defs] (\S+)$/.exec(cmd))) {
      return dirs.has(m[1]!) || files.has(m[1]!) ? { exitCode: 0 } : { exitCode: 1 }
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
    opts?.onCmd?.(cmd)
    log.push(cmd)
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const r = handler(cmd)
        if (dirs.has(LEASE_DIR) && !files.has(OWNER)) exposedBare = true
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
  const seedLease = (ownerJson?: string) => {
    mkdirp(LEASE_DIR)
    if (ownerJson !== undefined) files.set(OWNER, ownerJson)
  }
  // Replace the lease DIRECTORY (not just its record) with a rival's, as a real
  // takeover does — giving the dir a fresh inode.
  const replaceLeaseWith = (ownerJson: string) => {
    rmTree(LEASE_DIR)
    mkdirp(LEASE_DIR)
    files.set(OWNER, ownerJson)
  }
  const armTakeoverBeforeWrite = (ownerJson: string) => {
    onBeforeWrite = () => replaceLeaseWith(ownerJson)
  }
  return { $, dirs, files, log, seedLease, replaceLeaseWith, armTakeoverBeforeWrite, wasExposedBare: () => exposedBare }
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
  const { $, dirs } = makeLeaseFs()
  const res = await acquireLease($, "/r", "docs/tasks", me, now)
  assert.deepEqual(res, { ok: true })
  const owner = await readLeaseOwner($, "/r", "docs/tasks")
  assert.equal(owner?.pid, 100)
  assert.equal(owner?.heartbeatAt, now.toISOString())
  assert.equal(dirs.has(LEASE_DIR), true)
})

test("acquireLease never exposes the lease dir without its owner record (T3 acquire race)", async () => {
  // The old acquire won with `mkdir` and wrote owner.json in a SEPARATE call;
  // a rival reading in that window saw a missing record, judged the fresh
  // lease stale, and took it over. The staged rename must close that window.
  const { $, wasExposedBare } = makeLeaseFs()
  await acquireLease($, "/r", "docs/tasks", me, now)
  assert.equal(wasExposedBare(), false, "lease dir was observable without owner.json")
})

test("acquireLease refuses when a live owner holds the lease, reporting who", async () => {
  const { $, dirs, files, seedLease } = makeLeaseFs()
  seedLease(JSON.stringify(liveOwner("2026-07-06T11:59:00.000Z")))
  const res = await acquireLease($, "/r", "docs/tasks", me, now)
  assert.equal(res.ok, false)
  assert.equal(!res.ok && res.owner?.pid, 200)
  // The loser's staging dir was nested into the holder's lease by `mv` — it
  // must clean up its own debris and leave the holder's record untouched.
  assert.equal(JSON.parse(files.get(OWNER)!).pid, 200)
  const debris = [...dirs, ...files.keys()].filter((p) => p.includes(".new-"))
  assert.deepEqual(debris, [], "loser left staging debris behind")
})

test("acquireLease takes over a stale lease by renaming it aside atomically", async () => {
  const { $, log, seedLease } = makeLeaseFs()
  seedLease(JSON.stringify(liveOwner("2026-07-06T10:00:00.000Z")))
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
  const { $, seedLease } = makeLeaseFs({ failCmd: (cmd) => cmd.startsWith("mv ") && /\.dead-/.test(cmd) })
  seedLease(JSON.stringify(liveOwner("2026-07-06T10:00:00.000Z")))
  const res = await acquireLease($, "/r", "docs/tasks", me, now)
  assert.equal(res.ok, false)
  assert.equal(!res.ok && res.owner?.pid, 200)
})

test("acquireLease re-judges what it renamed aside and restores a rival's fresh lease (T3)", async () => {
  // Winning the rename does not prove the thing renamed was the stale lease we
  // judged. A rival whose stagedAcquire completed between our judgement and our
  // `mv` owns a FRESH lease at that path — and the unconditional `rm -rf` that
  // followed destroyed it while we acquired our own, leaving two watchers each
  // believing they held the clone (the exact T3 breach the lease prevents, and
  // the re-judge claim-marker.ts already applies to the same idiom).
  const rival = JSON.stringify({ ...liveOwner("2026-07-06T11:59:45.000Z"), pid: 300, host: "gamma" })
  const fs = makeLeaseFs({
    onCmd: (cmd) => {
      // Fires BEFORE the handler runs, so the rival owns the path at the very
      // moment our takeover renames it aside.
      if (cmd.startsWith("mv ") && /\.dead-/.test(cmd)) fs.replaceLeaseWith(rival)
    },
  })
  fs.seedLease(JSON.stringify(liveOwner("2026-07-06T10:00:00.000Z")))

  const res = await acquireLease(fs.$, "/r", "docs/tasks", me, now)

  assert.equal(res.ok, false, "must stand down — the lease it moved aside was alive")
  assert.equal(!res.ok && res.owner?.pid, 300, "reports the rival that really holds it")
  const owner = await readLeaseOwner(fs.$, "/r", "docs/tasks")
  assert.equal(owner?.pid, 300, "the rival's fresh lease is restored, not destroyed")
  const debris = [...fs.dirs, ...fs.files.keys()].filter((p) => p.includes(".dead-") || p.includes(".new-"))
  assert.deepEqual(debris, [], "no graveyard or staging debris left behind")
})

test("acquireLease treats a garbled owner record as stale and takes over", async () => {
  const { $, seedLease } = makeLeaseFs()
  seedLease("not-json")
  const res = await acquireLease($, "/r", "docs/tasks", me, now)
  assert.deepEqual(res, { ok: true })
})

test("acquireLease recovers a crashed winner's empty lease dir via takeover", async () => {
  // A record-less lease dir can only be crash debris (a live winner's dir is
  // never observable without owner.json) — it must be take-overable.
  const { $, seedLease } = makeLeaseFs()
  seedLease()
  const res = await acquireLease($, "/r", "docs/tasks", me, now)
  assert.deepEqual(res, { ok: true })
  const owner = await readLeaseOwner($, "/r", "docs/tasks")
  assert.equal(owner?.pid, 100)
})

test("heartbeatLease refreshes heartbeatAt but preserves startedAt", async () => {
  const { $ } = makeLeaseFs()
  await acquireLease($, "/r", "docs/tasks", me, now)
  const later = new Date("2026-07-06T12:01:00.000Z")
  assert.equal(await heartbeatLease($, "/r", "docs/tasks", me, later), true)
  const owner = await readLeaseOwner($, "/r", "docs/tasks")
  assert.equal(owner?.startedAt, now.toISOString())
  assert.equal(owner?.heartbeatAt, later.toISOString())
})

test("heartbeatLease refuses to clobber a lease it no longer owns (post-takeover resurrection, T3)", async () => {
  // A new owner took over — the old watcher's heartbeat must not overwrite it.
  const { $, seedLease } = makeLeaseFs()
  seedLease(JSON.stringify(liveOwner("2026-07-06T11:59:00.000Z")))
  assert.equal(await heartbeatLease($, "/r", "docs/tasks", me, now), false)
  const owner = await readLeaseOwner($, "/r", "docs/tasks")
  assert.equal(owner?.pid, 200, "the new owner's record survives")
})

test("heartbeatLease detects a takeover that lands in its read→write window and stands down (T3)", async () => {
  // The dangerous ordering: a rival takeover replaces the lease dir AFTER our
  // ownership read but BEFORE our write, so our write clobbers the rival's
  // fresh record and reads back as "still ours". The owner read-back alone
  // can't see the theft — the dir-inode witness must, so this watcher reports
  // a lost heartbeat and removes the record it wrongly wrote.
  const { $, files, armTakeoverBeforeWrite } = makeLeaseFs()
  await acquireLease($, "/r", "docs/tasks", me, now)
  armTakeoverBeforeWrite(JSON.stringify(liveOwner("2026-07-06T12:00:59.000Z")))
  const later = new Date("2026-07-06T12:01:00.000Z")
  assert.equal(await heartbeatLease($, "/r", "docs/tasks", me, later), false, "must report the lease lost, not resurrected")
  assert.equal(files.has(OWNER), false, "our wrongly-written record was removed, leaving the lease re-acquirable")
})

test("heartbeatLease reports false when the write never landed (lease dir yanked mid-beat)", async () => {
  // A takeover renames the dir aside BETWEEN our ownership read and the write:
  // the write fails against the missing dir — that must read as "lost", not
  // "landed", or the watcher keeps driving a clone it no longer owns.
  let failWrites = false
  const { $ } = makeLeaseFs({ failCmd: (cmd) => failWrites && cmd.startsWith("printf") })
  await acquireLease($, "/r", "docs/tasks", me, now)
  failWrites = true
  const later = new Date("2026-07-06T12:01:00.000Z")
  assert.equal(await heartbeatLease($, "/r", "docs/tasks", me, later), false)
})

test("heartbeatLease refuses when the lease is gone (released or renamed aside)", async () => {
  const { $ } = makeLeaseFs()
  assert.equal(await heartbeatLease($, "/r", "docs/tasks", me, now), false)
  assert.equal(await readLeaseOwner($, "/r", "docs/tasks"), null, "nothing resurrected")
})

test("releaseLease frees the clone for the next acquirer", async () => {
  const { $ } = makeLeaseFs()
  await acquireLease($, "/r", "docs/tasks", me, now)
  await releaseLease($, "/r", "docs/tasks", me)
  const res = await acquireLease($, "/r", "docs/tasks", { ...me, pid: 300 }, now)
  assert.deepEqual(res, { ok: true })
})

test("releaseLease refuses to drop a lease it no longer owns (post-takeover, T3)", async () => {
  // Mirror of the heartbeatLease guard above. A watcher judged stale and taken
  // over may still run its unwatch/dispose path; without an ownership check its
  // `rm -rf` deletes the NEW owner's lease, a third watcher then acquires
  // cleanly, and two watchers drive one clone — the exact race the lease exists
  // to prevent.
  const { $, seedLease } = makeLeaseFs()
  seedLease(JSON.stringify(liveOwner("2026-07-06T11:59:00.000Z")))
  await releaseLease($, "/r", "docs/tasks", me)
  const owner = await readLeaseOwner($, "/r", "docs/tasks")
  assert.equal(owner?.pid, 200, "the new owner's lease survives")
})

test("releaseLease is a no-op when the lease is already gone", async () => {
  const { $ } = makeLeaseFs()
  await releaseLease($, "/r", "docs/tasks", me)
  assert.equal(await readLeaseOwner($, "/r", "docs/tasks"), null)
})
