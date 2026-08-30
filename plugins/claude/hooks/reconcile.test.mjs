import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * The SessionStart reconciler, end-to-end over the BUILT bundle.
 *
 * It had no tests at all, which is how two things went unnoticed: it swept only
 * `queued/.claims`, so a run that died between `claimTask` and its first
 * `> BUILD started` note left a marker in `in-progress/.claims` that nothing
 * released and nothing even mentioned — every gate verb then refused the task as
 * "a loop is driving this NOW" with no hint at session start; and its work is
 * unbounded while the host kills a hook at 60s and drops the WHOLE envelope, so
 * on a large or slow backlog every recovery notice vanished silently, on exactly
 * the repos most likely to have crashed loops.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOOK = path.join(HERE, "reconcile.mjs")

const makeRepo = (files) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aw-reconcile-"))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(cwd, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    if (content === null) fs.mkdirSync(abs, { recursive: true })
    else fs.writeFileSync(abs, content)
  }
  return cwd
}

/** The additionalContext the hook emitted, or "" when it emitted nothing. */
const run = (cwd) => {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd }),
    encoding: "utf8",
    env: {
      ...process.env,
      // Isolate from the developer's own layers, and satisfy the "server not
      // built" banner with a file that certainly exists.
      AGENTIC_WORKFLOW_USER_CONFIG: "",
      AGENTIC_WORKFLOW_DIR: cwd,
      AGENTIC_WORKFLOW_SERVER_JS: HOOK,
    },
  })
  assert.equal(res.status, 0, `the reconciler must never fail a session start: ${res.stderr}`)
  if (!res.stdout.trim()) return ""
  return JSON.parse(res.stdout).hookSpecificOutput?.additionalContext ?? ""
}

const task = (body) => `---\ntitle: Do the thing\n---\n\n${body}\n`

test("a build-claim marker with no live loop is named, with the verb that frees it", () => {
  const cwd = makeRepo({
    "docs/tasks/in-progress/f7k3-do-the-thing.md": task("> Plan approved [2026-01-01T00:00:00.000Z]"),
    "docs/tasks/in-progress/.claims/f7k3-do-the-thing": null,
  })
  const out = run(cwd)
  assert.match(out, /in-progress\/\.claims/)
  assert.match(out, /f7k3-do-the-thing/)
  assert.match(out, /workflow_doctor/, "the notice is only useful if it names what releases the marker")
})

test("a plan-claim marker is still named — the folder this hook already knew about", () => {
  const cwd = makeRepo({ "docs/tasks/queued/.claims/abcd-plan-me": null })
  assert.match(run(cwd), /queued\/\.claims: abcd-plan-me/)
})

test("an interrupted build is reported with recover, and a finished one is not", () => {
  const started = "> Plan approved [2026-01-01T00:00:00.000Z]\n> BUILD started (iteration 1) [2026-01-01T00:01:00.000Z]"
  const cwd = makeRepo({ "docs/tasks/in-progress/f7k3-half-built.md": task(started) })
  assert.match(run(cwd), /recover <id>/)

  const done = makeRepo({
    "docs/tasks/in-progress/f7k3-built.md": task(`${started}\n> BUILD finished (iteration 1) [2026-01-01T00:02:00.000Z]`),
  })
  assert.equal(run(done), "", "a matched start/finish pair is not an interruption")
})

test("a healthy backlog emits nothing at all", () => {
  assert.equal(run(makeRepo({ "docs/tasks/queued/f7k3-later.md": task("nothing yet") })), "")
})

// The budget is a wall-clock check between units of synchronous fs work plus a
// race on the one async call — a timer cannot interrupt a `readdirSync` that has
// already started, and there is no seam to inject a slow filesystem through. So
// the wiring is pinned at the source, the way the toast and glob rules are.
test("the hook's copies of the lifecycle markers are core's, character for character", async () => {
  // They cannot be imported: `task/store.js` drags `yaml` into this bundle and
  // esbuild's CJS shim then throws at load. So the copy is checked instead —
  // the mechanism the "MUST stay in sync" comment was standing in for.
  const store = await import("@agentic-workflow/core/task/store")
  const src = fs.readFileSync(path.join(HERE, "src", "reconcile.entry.mjs"), "utf8")
  for (const name of ["PLAN_APPROVED_MARKER", "BUILD_STARTED_MARKER", "BUILD_FINISHED_MARKER"]) {
    const copied = src.match(new RegExp(`const ${name} = "([^"]+)"`))?.[1]
    assert.equal(copied, store[name], `${name} drifted from core`)
  }
})

test("the scan is bounded, and says so when it degrades", () => {
  const src = fs.readFileSync(path.join(HERE, "src", "reconcile.entry.mjs"), "utf8")
  assert.match(src, /RECONCILE_BUDGET_MS/, "the budget exists")
  assert.match(src, /if \(Date\.now\(\) > deadline\) \{\s*truncated = true\s*break/, "the per-file read loop checks it")
  assert.match(src, /Promise\.race\(\[\s*auditBacklog\(/, "the one async call is raced, not merely awaited")
  assert.match(src, /is PARTIAL/, "a truncated report must say it is truncated — a silent one reads as a healthy backlog")
})
