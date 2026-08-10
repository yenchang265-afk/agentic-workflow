import assert from "node:assert/strict"
import { test } from "node:test"
import type { Shell } from "../host.js"
import { machineId, resetMachineIdCache } from "../liveness.js"
import { claimForTakeover } from "./takeover.js"

/**
 * The one fail-closed judgement behind `recover` and `waive`. It is shared
 * precisely because it was copied wrong once: a caller wrote
 * `claimTaskSweepingStale(task, 0)` with no evidence at all, which sweeps the
 * brand-new claim of a run still inside its pre-marker setup window and starts a
 * second drive on one `feature/<id>` branch. The no-evidence case below is that
 * regression; the rest pin the arms that make an immediate takeover legitimate.
 *
 * Driven against a fake filesystem where directories are first-class (mkdir fails
 * on an existing dir — the atomicity the marker rests on) and `kill`/`/proc`
 * agree, since `pidGone` refuses to conclude anything from a single probe.
 */
const TASKS = "docs/tasks"
const DIR = "/repo"
const TASK = { id: "add-foo", path: "/repo/docs/tasks/in-progress/add-foo.md" }
const MARKER = "/repo/docs/tasks/in-progress/.claims/add-foo"
const STAMP = `${MARKER}/claim.json`

const makeFs = (livePids: ReadonlySet<number> = new Set([process.pid])) => {
  const dirs = new Set<string>()
  const files = new Map<string, string>()
  const cmds: string[] = []
  for (const pid of livePids) dirs.add(`/proc/${String(pid)}`)

  const $ = ((strings: TemplateStringsArray, ...exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
    })
    const norm = cmd.trim().replace(/\s+/g, " ")
    const exec = async (): Promise<{ exitCode: number; stdout: string }> => {
      cmds.push(norm)
      const parts = norm.split(" ")
      const printf = /^printf '%s' (.*) > (\S+)$/.exec(norm)
      if (printf) {
        const [, content, dest] = printf as unknown as [string, string, string]
        const parent = dest.slice(0, dest.lastIndexOf("/"))
        if (!dirs.has(parent)) return { exitCode: 1, stdout: "" }
        files.set(dest, content)
        return { exitCode: 0, stdout: "" }
      }
      switch (parts[0]) {
        case "mkdir":
          if (parts[1] === "-p") {
            dirs.add(parts[2]!)
            return { exitCode: 0, stdout: "" }
          }
          if (dirs.has(parts[1]!)) return { exitCode: 1, stdout: "" } // EEXIST — the atomic loser
          dirs.add(parts[1]!)
          return { exitCode: 0, stdout: "" }
        case "rmdir": {
          const dir = parts[1]!
          if ([...files.keys()].some((f) => f.startsWith(`${dir}/`))) return { exitCode: 1, stdout: "" }
          dirs.delete(dir)
          return { exitCode: 0, stdout: "" }
        }
        case "rm":
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
        case "mv": {
          const [, src, destArg] = parts as [string, string, string]
          if (files.has(src)) {
            files.set(destArg, files.get(src)!)
            files.delete(src)
            return { exitCode: 0, stdout: "" }
          }
          if (!dirs.has(src)) return { exitCode: 1, stdout: "" }
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
          return { exitCode: (wantsDir ? dirs.has(target) : dirs.has(target) || files.has(target)) ? 0 : 1, stdout: "" }
        }
        case "cat": {
          const v = files.get(parts[1]!)
          return v === undefined ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout: v }
        }
        case "touch":
          return { exitCode: 0, stdout: "" }
        case "kill":
          return { exitCode: livePids.has(Number(parts[2])) ? 0 : 1, stdout: "" }
        case "find":
          return { exitCode: 1, stdout: "" }
        default:
          return { exitCode: 0, stdout: "" }
      }
    }
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        exec().then((o) => resolve({ exitCode: o.exitCode, stdout: { toString: () => o.stdout }, stderr: { toString: () => "" } })),
    }
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any as Shell

  return { $, dirs, files, cmds }
}

const OPTS = { verb: "waive", doctorHint: "run doctor fix" }

/**
 * Put a claim marker in place, stamped by `pid` on this machine.
 *
 * The stamp's machine identity is taken from `machineId` itself rather than
 * hand-written, because `isSameMachine` fails CLOSED: a boot id on one side and
 * not the other is an unprovable comparison, so a hand-built stamp that got the
 * shape slightly wrong would read "unknown" and quietly test the fallback arm
 * instead of the one named in the test. Seeding `boot_id` makes both sides agree.
 */
const hold = async (fs: ReturnType<typeof makeFs>, pid: number, ageMinutes = 2) => {
  resetMachineIdCache()
  fs.files.set("/proc/sys/kernel/random/boot_id", "boot-abc\n")
  const { host, boot } = await machineId(fs.$)
  fs.dirs.add(MARKER)
  // Stamped in the PAST by default: a real crashed run's claim is minutes old, and
  // the zero-window sweep is an age comparison — a claimedAt of exactly `now` is
  // not older than a zero window, which would test the wrong arm.
  const claimedAt = new Date(Date.now() - ageMinutes * 60_000).toISOString()
  fs.files.set(STAMP, JSON.stringify({ claimedAt, pid, host, ...(boot ? { boot } : {}) }))
}

/** A stage marker for one host, naming the task, with `deadline` and `pid`. */
const stageMarker = (fs: ReturnType<typeof makeFs>, opts: { pid: number; deadline: number }) => {
  fs.files.set(
    `/repo/docs/tasks/runs/.stage.json`,
    JSON.stringify({ taskId: TASK.id, stage: "verify", deadline: opts.deadline, pid: opts.pid }),
  )
}

test("an uncontested claim is taken with nothing to judge", async () => {
  const fs = makeFs()
  const r = await claimForTakeover(fs.$, DIR, TASKS, TASK, OPTS)
  assert.equal(r.ok, true)
  assert.ok(fs.dirs.has(MARKER), "the marker is now ours")
})

test("a LIVE stage marker naming the task is refused — another process is mid-stage", async () => {
  const fs = makeFs()
  await hold(fs, process.pid)
  stageMarker(fs, { pid: process.pid, deadline: Date.now() + 600_000 })
  const r = await claimForTakeover(fs.$, DIR, TASKS, TASK, OPTS)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.message : "", /driven by a live .* loop/)
  assert.ok(fs.dirs.has(MARKER), "a refusal never disturbs the holder's marker")
})

test("a held claim whose writer is ALIVE and has written no stage marker is REFUSED, marker intact", async () => {
  // THE regression. A run that just claimed spends minutes in isolation and
  // dependency install before its first stage marker; the old waive code swept
  // that marker unconditionally with a zero window and started a second drive on
  // the same branch. There is no evidence of death here, so there is no takeover.
  const fs = makeFs()
  await hold(fs, process.pid)
  const r = await claimForTakeover(fs.$, DIR, TASKS, TASK, OPTS)
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.message : "", /held by a live process/)
  assert.ok(fs.dirs.has(MARKER), "the live claimer keeps its claim")
  assert.ok(fs.files.has(STAMP), "and its stamp")
})

test("a held claim whose writer is provably GONE is taken over at once", async () => {
  // The case #262 exists for: died before the first stage marker, so the stamp's
  // own writer identity is the only evidence — and it is enough.
  const fs = makeFs(new Set([process.pid])) // the dead pid below is absent from /proc and kill
  await hold(fs, 999_001)
  const r = await claimForTakeover(fs.$, DIR, TASKS, TASK, OPTS)
  assert.equal(r.ok, true, r.ok === false ? r.message : "")
  assert.ok(fs.dirs.has(MARKER), "we hold it now")
})

test("a DEAD stage marker naming the task authorizes the takeover", async () => {
  const fs = makeFs()
  await hold(fs, process.pid) // writer alive: only the expired stage marker can carry this
  stageMarker(fs, { pid: process.pid, deadline: Date.now() - 1_000 })
  const r = await claimForTakeover(fs.$, DIR, TASKS, TASK, OPTS)
  assert.equal(r.ok, true, r.ok === false ? r.message : "")
})

test("a refusal names the caller's verb and that host's doctor command", async () => {
  // The prose is the only thing a caller supplies, and both halves are the
  // human's next step: which verb they just typed, and how to clear a marker they
  // know is dead on THIS host (the two hosts spell doctor differently).
  const fs = makeFs(new Set())
  resetMachineIdCache()
  fs.dirs.add(MARKER) // held, but unstamped ⇒ writer unidentifiable ⇒ fail closed
  const r = await claimForTakeover(fs.$, DIR, TASKS, TASK, { verb: "recover", doctorHint: "run workflow_doctor with fix:true" })
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.message : "", /cannot be identified/)
  assert.match(r.ok === false ? r.message : "", /run workflow_doctor with fix:true/)
})
