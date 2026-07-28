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
          const target = parts[parts.length - 1]!
          files.delete(target)
          if (parts.includes("-rf")) {
            dirs.delete(target)
            for (const f of [...files.keys()]) if (f.startsWith(`${target}/`)) files.delete(f)
          }
          return { exitCode: 0, stdout: "" }
        }
        case "mv": {
          const [, src, dest] = parts as [string, string, string]
          if (!dirs.has(src)) return { exitCode: 1, stdout: "" } // source gone — the rename race's loser
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
        case "cat": {
          const v = files.get(parts[1]!)
          return v === undefined ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout: v }
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
