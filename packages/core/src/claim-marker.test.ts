import assert from "node:assert/strict"
import { test } from "node:test"
import {
  acquireMarker,
  acquireOrSweepDeadWriter,
  acquireOrSweepMarker,
  claimWriterLiveness,
  markerOlderThan,
  releaseMarker,
  releaseMarkerIfStale,
  releaseMarkerIfWriterDead,
  restampMarker,
  STALE_CLAIM_MINUTES,
  stampPath,
} from "./claim-marker.js"
import type { Shell } from "./host.js"
import { resetMachineIdCache } from "./liveness.js"

/**
 * The mkdir claim marker — the primitive every PR/CI-shaped work source trusts
 * to keep two processes off one PR — driven against a fake filesystem that
 * models directories as first-class (mkdir fails on an existing dir, which is
 * the whole atomicity argument) and lets a rival be interleaved at an exact
 * command, so the sweep race is reproducible rather than theoretical.
 */
const makeFs = (livePids: ReadonlySet<number> = new Set([process.pid])) => {
  const dirs = new Set<string>()
  const files = new Map<string, string>()
  const cmds: string[] = []
  // The writer-liveness probes ride the same fake. `/proc/<pid>` entries are
  // ordinary dirs here, so the existing `test -d` arm answers them — and seeding
  // them from `livePids` keeps the two probes (`kill -0`, `/proc`) consistent,
  // which is what `pidGone` demands before it will conclude anything.
  for (const pid of livePids) dirs.add(`/proc/${String(pid)}`)
  /** Runs before the matching command executes — the rival's window. */
  let hook: { match: string; run: () => Promise<void>; once: boolean } | null = null

  const $ = ((strings: TemplateStringsArray, ...exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
    })
    const norm = cmd.trim().replace(/\s+/g, " ")

    const exec = async (): Promise<{ exitCode: number; stdout: string }> => {
      if (hook && norm.includes(hook.match)) {
        const h = hook
        if (h.once) hook = null
        await h.run()
      }
      cmds.push(norm)
      const parts = norm.split(" ")
      const printf = /^printf '%s' (.*) > (\S+)$/.exec(norm)
      if (printf) {
        // A stamp write into a directory that no longer exists fails, like the real thing.
        const [, content, dest] = printf as unknown as [string, string, string]
        const parent = dest.slice(0, dest.lastIndexOf("/"))
        if (!dirs.has(parent)) return { exitCode: 1, stdout: "" }
        files.set(dest, content)
        return { exitCode: 0, stdout: "" }
      }
      switch (parts[0]) {
        case "mkdir": {
          if (parts[1] === "-p") {
            dirs.add(parts[2]!)
            return { exitCode: 0, stdout: "" }
          }
          if (dirs.has(parts[1]!)) return { exitCode: 1, stdout: "" } // EEXIST — the atomic loser
          dirs.add(parts[1]!)
          return { exitCode: 0, stdout: "" }
        }
        case "rmdir": {
          const dir = parts[1]!
          if ([...files.keys()].some((f) => f.startsWith(`${dir}/`))) return { exitCode: 1, stdout: "" } // not empty
          dirs.delete(dir)
          return { exitCode: 0, stdout: "" }
        }
        case "rm": {
          // Every non-flag argument is a target (releaseMarker passes the stamp
          // AND its `.tmp-*` glob); a trailing `*` models bash glob expansion.
          for (const target of parts.slice(1).filter((p) => !p.startsWith("-"))) {
            if (target.endsWith("*")) {
              const prefix = target.slice(0, -1)
              for (const f of [...files.keys()]) if (f.startsWith(prefix)) files.delete(f)
              continue
            }
            files.delete(target)
            if (parts.includes("-rf")) {
              dirs.delete(target)
              for (const f of [...files.keys()]) if (f.startsWith(`${target}/`)) files.delete(f)
            }
          }
          return { exitCode: 0, stdout: "" }
        }
        case "mv": {
          const [, src, destArg] = parts as [string, string, string]
          // A FILE move (the atomic restamp's temp→stamp rename) overwrites the
          // destination, like rename(2).
          if (files.has(src)) {
            files.set(destArg, files.get(src)!)
            files.delete(src)
            return { exitCode: 0, stdout: "" }
          }
          if (!dirs.has(src)) return { exitCode: 1, stdout: "" } // source gone — the rename race's loser
          // POSIX `mv` onto an EXISTING directory does not fail — it moves the
          // source INSIDE it (exit 0). The fake used to overwrite instead,
          // which hid the nesting branch of the restore race entirely.
          const dest = dirs.has(destArg) ? `${destArg}/${src.slice(src.lastIndexOf("/") + 1)}` : destArg
          dirs.delete(src)
          dirs.add(dest)
          for (const [f, v] of [...files.entries()]) {
            if (f.startsWith(`${src}/`)) {
              files.delete(f)
              files.set(dest + f.slice(src.length), v)
            }
          }
          return { exitCode: 0, stdout: "" }
        }
        case "test": {
          const target = parts[parts.length - 1]!
          const wantsDir = parts.includes("-d")
          const exists = wantsDir ? dirs.has(target) : dirs.has(target) || files.has(target)
          return { exitCode: exists ? 0 : 1, stdout: "" }
        }
        case "cat": {
          const v = files.get(parts[1]!)
          return v === undefined ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout: v }
        }
        case "touch": {
          // Models the one property the restamp relies on: `-c` never creates.
          const noCreate = parts.includes("-c")
          const target = parts[parts.length - 1]!
          if (!dirs.has(target) && !files.has(target) && !noCreate) files.set(target, "")
          return { exitCode: 0, stdout: "" }
        }
        case "kill":
          return { exitCode: livePids.has(Number(parts[2])) ? 0 : 1, stdout: "" }
        case "find":
          return { exitCode: 1, stdout: "" } // no mtime fallback in these tests — every marker is stamped
        default:
          return { exitCode: 0, stdout: "" }
      }
    }

    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        exec().then((out) => resolve({ exitCode: out.exitCode, stdout: { toString: () => out.stdout }, stderr: { toString: () => "" } })),
    }
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any as Shell

  return {
    $,
    dirs,
    files,
    cmds,
    interleave: (match: string, run: () => Promise<void>) => void (hook = { match, run, once: true }),
  }
}

const MARKER = "/repo/docs/tasks/runs/pr-sitter/.claims/pr-42"
const T0 = new Date("2026-07-05T00:00:00Z")
const later = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000)

test("acquireMarker is exclusive and stamps the winner", async () => {
  const { $, files } = makeFs()
  assert.equal(await acquireMarker($, MARKER, T0), true)
  assert.equal(await acquireMarker($, MARKER, T0), false, "a held marker cannot be won twice")
  assert.equal(JSON.parse(files.get(stampPath(MARKER))!).claimedAt, T0.toISOString())
})

test("acquireMarker stamps the WRITER, not only the time", async () => {
  // The age is a proxy for "did the claimer die"; the writer identity answers it
  // outright, which is what lets recover skip the wall-clock wait.
  resetMachineIdCache()
  const { $, files } = makeFs()
  await acquireMarker($, MARKER, T0)
  const stamp = JSON.parse(files.get(stampPath(MARKER))!)
  assert.equal(stamp.pid, process.pid)
  assert.equal(typeof stamp.host, "string")
  assert.equal(stamp.claimedAt, T0.toISOString(), "the original field is untouched — older readers keep working")
  resetMachineIdCache()
})

test("restampMarker rewrites the writer identity, not just the timestamp", async () => {
  // A marker handed over by a takeover must stop naming the dead claimer, or the
  // new owner's own live claim would keep reading "writer dead" to the next recover.
  resetMachineIdCache()
  const { $, files } = makeFs()
  await acquireMarker($, MARKER, T0)
  files.set(stampPath(MARKER), JSON.stringify({ claimedAt: T0.toISOString(), pid: 999_001, host: "someone-else" }))
  await restampMarker($, MARKER, later(1))
  const stamp = JSON.parse(files.get(stampPath(MARKER))!)
  assert.equal(stamp.pid, process.pid)
  assert.equal(stamp.claimedAt, later(1).toISOString())
  resetMachineIdCache()
})

test("claimWriterLiveness: alive when the stamped writer still exists", async () => {
  resetMachineIdCache()
  const { $ } = makeFs()
  await acquireMarker($, MARKER, T0)
  assert.equal(await claimWriterLiveness($, MARKER), "alive")
  resetMachineIdCache()
})

test("claimWriterLiveness: dead when the stamped writer is provably gone", async () => {
  // The whole point: a crashed claimer is recoverable NOW, whatever the clock says.
  resetMachineIdCache()
  const { $, files } = makeFs()
  await acquireMarker($, MARKER, T0)
  const stamp = JSON.parse(files.get(stampPath(MARKER))!)
  files.set(stampPath(MARKER), JSON.stringify({ ...stamp, pid: 999_002 }))
  assert.equal(await claimWriterLiveness($, MARKER), "dead")
  resetMachineIdCache()
})

test("claimWriterLiveness fails CLOSED on every unprovable stamp", async () => {
  // Each of these is a case where concluding "dead" would sweep a claim that may
  // be live — a second drive on one branch, the exact bug the window prevents.
  resetMachineIdCache()
  const self = await (async () => {
    const { $, files } = makeFs()
    await acquireMarker($, MARKER, T0)
    return JSON.parse(files.get(stampPath(MARKER))!) as { host: string; boot?: string }
  })()

  const cases: ReadonlyArray<readonly [string, string | null]> = [
    ["no stamp at all", null],
    ["a garbled stamp (a torn restamp)", "{not json"],
    ["an older stamp naming no writer", JSON.stringify({ claimedAt: T0.toISOString() })],
    ["a non-integer pid", JSON.stringify({ claimedAt: T0.toISOString(), pid: "1234", host: self.host })],
    ["a dead pid claimed on ANOTHER host", JSON.stringify({ claimedAt: T0.toISOString(), pid: 999_003, host: "other-box" })],
    [
      "a dead pid from a sibling container (same host, own boot id)",
      JSON.stringify({ claimedAt: T0.toISOString(), pid: 999_004, host: self.host, boot: "some-other-boot-id" }),
    ],
  ]

  for (const [why, stamp] of cases) {
    const { $, files } = makeFs()
    await acquireMarker($, MARKER, T0)
    if (stamp === null) files.delete(stampPath(MARKER))
    else files.set(stampPath(MARKER), stamp)
    assert.equal(await claimWriterLiveness($, MARKER), "unknown", why)
  }
  resetMachineIdCache()
})

test("claimWriterLiveness refuses an EPERM writer — unsignalable but present", async () => {
  // `kill -0` fails on another user's LIVE process exactly as it does on a dead
  // one, so "unsignalable" must never mean "gone". Reading it that way is how a
  // sudo-launched or other-user loop would lose its claim mid-run.
  resetMachineIdCache()
  const eperm = 999_005

  const gone = makeFs() // unsignalable AND absent from /proc
  await acquireMarker(gone.$, MARKER, T0)
  const stamp = JSON.parse(gone.files.get(stampPath(MARKER))!)
  gone.files.set(stampPath(MARKER), JSON.stringify({ ...stamp, pid: eperm }))
  assert.equal(await claimWriterLiveness(gone.$, MARKER), "dead", "baseline: absent from /proc really is dead")

  const denied = makeFs() // unsignalable, but /proc still lists it — EPERM
  await acquireMarker(denied.$, MARKER, T0)
  denied.files.set(stampPath(MARKER), JSON.stringify({ ...stamp, pid: eperm }))
  denied.dirs.add(`/proc/${String(eperm)}`)
  assert.equal(await claimWriterLiveness(denied.$, MARKER), "unknown", "a live process we cannot signal is not evidence of death")
  resetMachineIdCache()
})

test("releaseMarkerIfWriterDead frees a BRAND-NEW marker whose writer is gone", async () => {
  // Age is irrelevant here — that is the point. This marker is one minute old.
  resetMachineIdCache()
  const { $, dirs, files } = makeFs()
  await acquireMarker($, MARKER, T0)
  const stamp = JSON.parse(files.get(stampPath(MARKER))!)
  files.set(stampPath(MARKER), JSON.stringify({ ...stamp, pid: 999_006 }))
  assert.equal(await releaseMarkerIfWriterDead($, MARKER, later(1)), true)
  assert.ok(!dirs.has(MARKER), "the wedged marker is gone")
  assert.equal([...dirs].filter((d) => d.includes(".dead-")).length, 0, "no graveyard debris")
  resetMachineIdCache()
})

test("releaseMarkerIfWriterDead leaves a live or unprovable writer's marker alone", async () => {
  resetMachineIdCache()
  const live = makeFs()
  await acquireMarker(live.$, MARKER, T0)
  assert.equal(await releaseMarkerIfWriterDead(live.$, MARKER, later(600)), false, "alive — even ten hours on")
  assert.ok(live.dirs.has(MARKER))

  const legacy = makeFs()
  await acquireMarker(legacy.$, MARKER, T0)
  legacy.files.set(stampPath(MARKER), JSON.stringify({ claimedAt: T0.toISOString() }))
  assert.equal(await releaseMarkerIfWriterDead(legacy.$, MARKER, later(600)), false, "unknown is not permission")
  assert.ok(legacy.dirs.has(MARKER))
  resetMachineIdCache()
})

test("a rival that re-claims mid-sweep keeps its claim — the dead-writer judge re-checks identity", async () => {
  // The reason this release is identity-judged and not `releaseMarkerIfStale(…, 0)`:
  // a zero age window degrades the re-judge to a bare existence test, so the
  // rival's brand-new LIVE claim would be judged sweepable and deleted.
  resetMachineIdCache()
  const { $, dirs, files, interleave } = makeFs()
  await acquireMarker($, MARKER, T0)
  const stamp = JSON.parse(files.get(stampPath(MARKER))!)
  files.set(stampPath(MARKER), JSON.stringify({ ...stamp, pid: 999_007 }))

  // Between our judgement and our rename, a rival sweeps and re-claims.
  interleave(`mv ${MARKER} `, async () => {
    dirs.delete(MARKER)
    files.delete(stampPath(MARKER))
    await acquireMarker($, MARKER, later(2)) // stamps the rival's own LIVE pid
  })

  assert.equal(await acquireOrSweepDeadWriter($, MARKER, later(2)), false, "we must stand down")
  assert.ok(dirs.has(MARKER), "the rival's claim survives")
  assert.equal(JSON.parse(files.get(stampPath(MARKER))!).pid, process.pid, "and it is the rival's stamp, not ours")
  resetMachineIdCache()
})

test("acquireOrSweepDeadWriter takes over a dead writer's marker and re-stamps it", async () => {
  resetMachineIdCache()
  const { $, files } = makeFs()
  await acquireMarker($, MARKER, T0)
  const stamp = JSON.parse(files.get(stampPath(MARKER))!)
  files.set(stampPath(MARKER), JSON.stringify({ ...stamp, pid: 999_008 }))
  assert.equal(await acquireOrSweepDeadWriter($, MARKER, later(1)), true)
  const fresh = JSON.parse(files.get(stampPath(MARKER))!)
  assert.equal(fresh.pid, process.pid, "the new owner is stamped — the next recover must not read it dead")
  assert.equal(fresh.claimedAt, later(1).toISOString())
  resetMachineIdCache()
})

test("releaseMarker clears a stray restamp temporary and still removes the marker", async () => {
  const { $, dirs, files } = makeFs()
  await acquireMarker($, MARKER, T0)
  // A crash between the atomic restamp's write and rename leaves this behind;
  // rmdir needs the marker empty, and the debris must not wedge the release.
  files.set(`${stampPath(MARKER)}.tmp-123-4`, "torn")
  await releaseMarker($, MARKER)
  assert.ok(!dirs.has(MARKER), "marker released despite the temp debris")
})

test("releaseMarker is loud, never silent, when foreign entries wedge the marker", async () => {
  const { $, dirs, files } = makeFs()
  await acquireMarker($, MARKER, T0)
  files.set(`${MARKER}/foreign.txt`, "not ours")
  const warnings: string[] = []
  await releaseMarker($, MARKER, (level, message) => void warnings.push(`${level}: ${message}`))
  assert.ok(dirs.has(MARKER), "foreign content is never rm -rf'd away")
  assert.equal(warnings.length, 1, "the wedged release is reported")
  assert.match(warnings[0]!, /could not release/)
})

test("restampMarker goes through temp+rename — no truncate window on the live stamp", async () => {
  const { $, files, cmds } = makeFs()
  await acquireMarker($, MARKER, T0)
  await restampMarker($, MARKER, later(30))
  assert.equal(JSON.parse(files.get(stampPath(MARKER))!).claimedAt, later(30).toISOString(), "the stamp advanced")
  const directWrites = cmds.filter((c) => /^printf '%s' .* > \S*claim\.json$/.test(c))
  assert.equal(directWrites.length, 1, "only acquireMarker writes the stamp path directly (fresh dir, no reader yet)")
  assert.ok([...files.keys()].every((f) => !f.includes(".tmp-")), "no temp residue after the rename")
})

test("a live claim never reads stale across repeated restamps", async () => {
  // The long-run liveness contract: restamped at every stage/pass boundary, a
  // healthy multi-stage run must never be judged dead by another process's
  // sweep, whatever interleaving the reads land in.
  const { $ } = makeFs()
  await acquireMarker($, MARKER, T0)
  for (let i = 1; i <= 50; i++) {
    await restampMarker($, MARKER, later(i * 10))
    assert.equal(await markerOlderThan($, MARKER, STALE_CLAIM_MINUTES, later(i * 10 + 1)), false, `stale read after restamp ${i}`)
  }
})

test("markerOlderThan reads the stamp, not the clock alone", async () => {
  const { $ } = makeFs()
  await acquireMarker($, MARKER, T0)
  assert.equal(await markerOlderThan($, MARKER, STALE_CLAIM_MINUTES, later(STALE_CLAIM_MINUTES - 1)), false)
  assert.equal(await markerOlderThan($, MARKER, STALE_CLAIM_MINUTES, later(STALE_CLAIM_MINUTES + 1)), true)
})

test("acquireOrSweepMarker wins a free marker and refuses a live one", async () => {
  const { $ } = makeFs()
  assert.equal(await acquireOrSweepMarker($, MARKER, STALE_CLAIM_MINUTES, T0), true)
  assert.equal(await acquireOrSweepMarker($, MARKER, STALE_CLAIM_MINUTES, later(1)), false, "a live claim is left alone")
})

test("acquireOrSweepMarker sweeps a stale marker and re-stamps it", async () => {
  const { $, files } = makeFs()
  await acquireMarker($, MARKER, T0)
  const now = later(STALE_CLAIM_MINUTES + 5)
  assert.equal(await acquireOrSweepMarker($, MARKER, STALE_CLAIM_MINUTES, now), true, "a dead claimer's marker is recoverable")
  assert.equal(JSON.parse(files.get(stampPath(MARKER))!).claimedAt, now.toISOString(), "the sweeper's own stamp replaces it")
})

test("a rival that re-claims mid-sweep keeps its claim — the sweeper stands down", async () => {
  // The race the unconditional `rmdir` lost: both processes judged the SAME
  // stale marker, and the second one removed the first's brand-new marker and
  // took the work too. Two sitters then drove one PR, both pushing the same
  // head and both writing the ledger.
  const fs = makeFs()
  const { $ } = fs
  await acquireMarker($, MARKER, T0)
  const now = later(STALE_CLAIM_MINUTES + 5)

  // The rival completes its whole claim inside our window between judging the
  // marker stale and acting on it.
  fs.interleave("mv " + MARKER, async () => {
    await releaseMarker($, MARKER)
    await acquireMarker($, MARKER, now)
  })

  assert.equal(await acquireOrSweepMarker($, MARKER, STALE_CLAIM_MINUTES, now), false, "the marker is live now — do not take it")
  assert.equal(fs.dirs.has(MARKER), true, "the rival's marker still exists")
  assert.equal(JSON.parse(fs.files.get(stampPath(MARKER))!).claimedAt, now.toISOString(), "and still carries the RIVAL's stamp")
})

test("losing the takeover rename outright is a refusal, not a second claim", async () => {
  // The other interleaving: the rival's own takeover renamed the stale marker
  // away first, so our `mv` finds no source.
  const fs = makeFs()
  const { $ } = fs
  await acquireMarker($, MARKER, T0)
  const now = later(STALE_CLAIM_MINUTES + 5)
  fs.interleave("mv " + MARKER, async () => {
    await $`mv ${MARKER} ${`${MARKER}.taken`}`.quiet().nothrow()
  })
  assert.equal(await acquireOrSweepMarker($, MARKER, STALE_CLAIM_MINUTES, now), false)
})

test("restampMarker refreshes a held marker so a long multi-stage run never reads stale", async () => {
  const { $, files } = makeFs()
  await acquireMarker($, MARKER, T0)
  const midRun = later(STALE_CLAIM_MINUTES + 5)
  await restampMarker($, MARKER, midRun)
  assert.equal(JSON.parse(files.get(stampPath(MARKER))!).claimedAt, midRun.toISOString())
  assert.equal(await markerOlderThan($, MARKER, STALE_CLAIM_MINUTES, later(STALE_CLAIM_MINUTES + 6)), false, "freshly restamped — not stale")
})

test("restampMarker never re-creates a released marker", async () => {
  const fs = makeFs()
  await acquireMarker(fs.$, MARKER, T0)
  await releaseMarker(fs.$, MARKER)
  await restampMarker(fs.$, MARKER, later(1))
  assert.equal(fs.dirs.has(MARKER), false)
  assert.equal(fs.files.has(stampPath(MARKER)), false, "no orphan stamp for a marker nobody holds")
})

test("a release landing mid-restamp never resurrects the marker as a file", async () => {
  // The `test -d` guard at the top of restampMarker is three subprocess
  // round-trips stale by the time the trailing touch runs. A bare `touch`
  // there re-created a released marker as an empty regular FILE — un-mkdir-able
  // by every claimer, and reported "already gone" by releaseMarker (test -d
  // fails on a file). `touch -c` is what makes this window harmless.
  const fs = makeFs()
  await acquireMarker(fs.$, MARKER, T0)
  fs.interleave("touch", async () => {
    await releaseMarker(fs.$, MARKER)
  })
  await restampMarker(fs.$, MARKER, later(1))
  assert.equal(fs.files.has(MARKER), false, "the marker path came back as a regular file")
  assert.equal(fs.dirs.has(MARKER), false)
  assert.equal(await acquireMarker(fs.$, MARKER, later(2)), true, "the next claimer can still win the path")
})

test("markerOlderThan with a zero window judges a stampless marker by existence — the unconditional takeover", async () => {
  // `find -mmin +0` matches only strictly older than a whole minute, so a
  // stampless marker touched seconds ago read "not stale" and recover refused
  // a takeover it had already justified (claimTaskSweepingStale's minutes: 0).
  const fs = makeFs()
  fs.dirs.add(MARKER) // an old-version marker: held, no claim.json
  assert.equal(await markerOlderThan(fs.$, MARKER, 0, later(0)), true, "held ⇒ takeable at minutes: 0")
  assert.equal(await acquireOrSweepMarker(fs.$, MARKER, 0, later(0)), true, "the takeover wins")
  fs.dirs.delete(MARKER)
  fs.files.delete(stampPath(MARKER))
  assert.equal(await markerOlderThan(fs.$, MARKER, 0, later(1)), false, "absent ⇒ nothing to take over")
})

test("releaseMarkerIfStale releases only a stale marker, atomically", async () => {
  const { $ } = makeFs()
  await acquireMarker($, MARKER, T0)
  assert.equal(await releaseMarkerIfStale($, MARKER, STALE_CLAIM_MINUTES, later(1)), false, "a live claim is left alone")
  assert.equal(await releaseMarkerIfStale($, MARKER, STALE_CLAIM_MINUTES, later(STALE_CLAIM_MINUTES + 5)), true)
  assert.equal(await acquireMarker($, MARKER, later(STALE_CLAIM_MINUTES + 6)), true, "the marker is free after the release")
})

test("releaseMarkerIfStale stands down when a rival re-claims mid-release", async () => {
  // The sweep race releaseOrphanedClaims used to lose: judge stale, then a
  // legitimate claimer wins the marker, then the sweeper's blind rm/rmdir
  // deleted the live claim and a second claimer took the task.
  const fs = makeFs()
  const { $ } = fs
  await acquireMarker($, MARKER, T0)
  const now = later(STALE_CLAIM_MINUTES + 5)
  fs.interleave("mv " + MARKER, async () => {
    await releaseMarker($, MARKER)
    await acquireMarker($, MARKER, now)
  })
  assert.equal(await releaseMarkerIfStale($, MARKER, STALE_CLAIM_MINUTES, now), false, "what it moved aside was live — restored")
  assert.equal(fs.dirs.has(MARKER), true, "the rival's claim survives")
  assert.equal(JSON.parse(fs.files.get(stampPath(MARKER))!).claimedAt, now.toISOString(), "with the RIVAL's stamp")
})

test("releaseMarkerIfStale never nests its restore inside a rival's re-created marker", async () => {
  // The double race: rival A restamps the marker fresh between our stale
  // judgement and our rename-aside (so the moved-aside copy re-judges FRESH
  // and we try to restore it), and rival B mkdir's the marker path before our
  // restore `mv` lands. POSIX `mv` onto that existing directory does not fail
  // — it NESTS our copy inside rival B's live marker, and the debris makes
  // B's own stamp-then-rmdir release fail forever: a held claim with no owner
  // that every gate verb refuses.
  const fs = makeFs()
  const { $ } = fs
  await acquireMarker($, MARKER, T0)
  const now = later(STALE_CLAIM_MINUTES + 5)
  fs.interleave(`mv ${MARKER} `, async () => {
    await restampMarker($, MARKER, now) // rival A: the marker is live again
    fs.interleave(`mv ${MARKER}.dead`, async () => {
      await acquireMarker($, MARKER, now) // rival B: re-takes the path pre-restore
    })
  })
  assert.equal(await releaseMarkerIfStale($, MARKER, STALE_CLAIM_MINUTES, now), false)
  assert.equal(fs.dirs.has(MARKER), true, "rival B's marker survives")
  assert.deepEqual(
    [...fs.dirs].filter((d) => d.startsWith(`${MARKER}/`)),
    [],
    "no copy nested inside the rival's marker",
  )
  await releaseMarker($, MARKER)
  assert.equal(fs.dirs.has(MARKER), false, "the rival can still release its claim")
})

test("a swept marker leaves no graveyard directory behind", async () => {
  const fs = makeFs()
  await acquireMarker(fs.$, MARKER, T0)
  await acquireOrSweepMarker(fs.$, MARKER, STALE_CLAIM_MINUTES, later(STALE_CLAIM_MINUTES + 5))
  assert.deepEqual(
    [...fs.dirs].filter((d) => d !== MARKER && d.startsWith(MARKER)),
    [],
    "no .dead-* debris",
  )
})
