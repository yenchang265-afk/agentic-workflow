import assert from "node:assert/strict"
import { test } from "node:test"
import {
  acquireMarker,
  acquireOrSweepMarker,
  markerOlderThan,
  releaseMarker,
  releaseMarkerIfStale,
  restampMarker,
  STALE_CLAIM_MINUTES,
  stampPath,
} from "./claim-marker.js"
import type { Shell } from "./host.js"

/**
 * The mkdir claim marker — the primitive every PR/CI-shaped work source trusts
 * to keep two processes off one PR — driven against a fake filesystem that
 * models directories as first-class (mkdir fails on an existing dir, which is
 * the whole atomicity argument) and lets a rival be interleaved at an exact
 * command, so the sweep race is reproducible rather than theoretical.
 */
const makeFs = () => {
  const dirs = new Set<string>()
  const files = new Map<string, string>()
  const cmds: string[] = []
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
