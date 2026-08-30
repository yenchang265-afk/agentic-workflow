import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { crashLine, failOpen } from "./src/crash.mjs"

/**
 * A hook's LAST LINE is where its failure direction is chosen.
 *
 * An un-caught throw exits 1, which Claude Code treats as a non-blocking error:
 * the turn proceeds. So a bare `main()` is not "no direction" — it is fail-OPEN
 * by default, silently, including in the one hook (`gate-command`) whose whole
 * reason to exist is refusing a double-move. Two entry points ended
 * `main().catch(() => allow())`; six ended bare, and nothing failed.
 *
 * Pinned at the source because the property is the ABSENCE of a terminator, and
 * a hook that crashes on every call is indistinguishable at runtime from one
 * that has nothing to say — which is exactly why it went unnoticed.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, "src")

/** Every file a `hooks.json` entry executes, and the direction its crash must take. */
const ENTRIES = [
  ["src/check-evidence.entry.mjs", "open"],
  ["src/check-spawn-stage.entry.mjs", "open"],
  ["src/check-stage-ask.entry.mjs", "open"],
  ["src/check-stage-guard.entry.mjs", "open"],
  ["src/check-verdict-guard.entry.mjs", "open"],
  ["src/reconcile.entry.mjs", "open"],
  ["src/stamp-spawn-model.entry.mjs", "open"],
  ["plan-gate-ask.mjs", "open"],
  ["gate-command.mjs", "scoped"],
]

test("every hook entry point terminates main() with a chosen fail direction", () => {
  for (const [rel, direction] of ENTRIES) {
    const text = fs.readFileSync(path.join(here, rel), "utf8")
    assert.doesNotMatch(text, /^main\(\)\s*$/m, `${rel}: a bare main() defaults its fail direction to the host's exit-1 handling`)
    if (direction === "open") {
      assert.match(text, /main\(\)\.catch\(failOpen\(/, `${rel}: must fail open through the shared terminator`)
    } else {
      // gate-command is the one non-flat choice: it sees every prompt in the
      // session (matcher ""), so a blanket block would refuse ordinary prompts,
      // while a blanket pass re-opens the double-move once the CLI has run.
      assert.match(text, /main\(\)\.catch\(\(err\) => \{/, `${rel}: must terminate main()`)
      assert.match(text, /dispatched\s*\n?\s*\?\s*block\(/, `${rel}: a crash after the dispatch must block`)
      assert.match(text, /:\s*passThrough\(\)/, `${rel}: a crash before the dispatch must pass the prompt through`)
      assert.match(text, /dispatched = label\n\s*const res = distExists/, `${rel}: the flag must be armed immediately before the spawn`)
    }
  }
})

test("every hooks.json command is an entry this suite pins", () => {
  // The list above is only worth having if a NEW hook cannot be added past it.
  const config = JSON.parse(fs.readFileSync(path.join(here, "hooks.json"), "utf8"))
  const commands = JSON.stringify(config).match(/hooks\/[\w.-]+\.mjs/g) ?? []
  const pinned = new Set(ENTRIES.map(([rel]) => path.basename(rel).replace(/\.entry\.mjs$/, ".mjs")))
  const unpinned = [...new Set(commands.map((c) => path.basename(c)))].filter((n) => !pinned.has(n))
  assert.deepEqual(unpinned, [], `hooks.json runs files with no pinned fail direction: ${unpinned.join(", ")}`)
})

test("failOpen records the crash and still exits 0", () => {
  const line = crashLine("check-stage-guard", new Error("boom"))
  assert.match(line, /check-stage-guard hook crashed and failed open/)
  assert.match(line, /boom/)
  assert.equal(line.includes("\n"), false, "the note is one line — it lands beside a tool call")

  // A non-Error rejection must not itself throw inside the terminator.
  assert.match(crashLine("reconcile", "just a string"), /just a string/)
  assert.equal(typeof failOpen("x"), "function")
})

test("the shared terminator is dependency-free and its exit is bounded", () => {
  const text = fs.readFileSync(path.join(src, "crash.mjs"), "utf8")
  assert.doesNotMatch(text, /^import /m, "crash.mjs must import nothing — it is bundled into every entry")
  // Deliberately NOT a bare `exitAfterWrite`: waiting on a write callback that
  // never fires parks the hook until the host's 60s kill, which drops the whole
  // envelope — the failure this terminator exists to end.
  assert.doesNotMatch(text, /exitAfterWrite\(/, "the crash note must not wait unboundedly on a write callback")
  assert.match(text, /setTimeout\(exit, \d+\)/, "the exit must be bounded by a timer as well as the write callback")
  assert.match(text, /timer\.unref/, "the bound must not itself hold the process open")
})

test("failOpen exits 0 even when stderr never drains", async () => {
  // The bounded half, end to end: a stream whose write callback never fires
  // must still let the hook exit — the host drops the whole envelope at its own
  // deadline, which is the failure this terminator exists to end.
  const { spawnSync } = await import("node:child_process")
  const res = spawnSync(
    process.execPath,
    [
      "-e",
      `const { failOpen } = await import(${JSON.stringify(pathToFileURL(path.join(src, "crash.mjs")).href)});
       process.stderr.write = () => {};
       failOpen("probe")(new Error("boom"));`.replace(/^\s+/gm, ""),
      "--input-type=module",
    ],
    { encoding: "utf8", timeout: 10_000 },
  )
  assert.equal(res.status, 0, `the terminator must exit 0, not hang or throw: ${res.stderr}`)
})
