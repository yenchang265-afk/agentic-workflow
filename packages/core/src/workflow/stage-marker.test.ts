import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  clearOpencodeStageMarker,
  hostStageMarkerPath,
  hostVerdictNagPath,
  liveStageMarkers,
  opencodeMarkerPath,
  opencodeStageMarker,
  STAGE_MARKER_HOSTS,
  stageMarkerFile,
  taskDrivenByStageMarker,
  taskNamedByStageMarker,
  verdictNagFile,
  writeOpencodeStageMarker,
} from "./stage-marker.js"
import type { WorkflowState } from "./state.js"

/**
 * The OpenCode host's live-stage marker. Same fake-shell approach as
 * persist.test.ts: write/clear shell out via `$` (mkdir/printf/mv/rm), faked
 * over a real temp dir so the round-trip runs without a running opencode.
 */
const fakeShell = (livePids: ReadonlySet<number> = new Set([process.pid])) => {
  const run = (strings: TemplateStringsArray, exprs: unknown[]) => {
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      then: (resolve: (v: unknown) => unknown) => {
        const raw = strings.join("\0")
        let out: { exitCode: number; stdout?: string } = { exitCode: 0 }
        if (raw.startsWith("mkdir -p ")) {
          fs.mkdirSync(String(exprs[0]), { recursive: true })
        } else if (raw.startsWith("printf '%s' ")) {
          fs.writeFileSync(String(exprs[1]), String(exprs[0]))
        } else if (raw.startsWith("mv ")) {
          fs.renameSync(String(exprs[0]), String(exprs[1]))
        } else if (raw.startsWith("rm -f ")) {
          fs.rmSync(String(exprs[0]), { force: true })
        } else if (raw.startsWith("cat ")) {
          try {
            out = { exitCode: 0, stdout: fs.readFileSync(String(exprs[0]), "utf8") }
          } catch {
            out = { exitCode: 1 }
          }
        } else if (raw.startsWith("kill -0 ")) {
          out = { exitCode: livePids.has(Number(exprs[0])) ? 0 : 1 }
        }
        return Promise.resolve({ exitCode: out.exitCode, stdout: { toString: () => out.stdout ?? "" } }).then(resolve)
      },
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((strings: TemplateStringsArray, ...exprs: unknown[]) => run(strings, exprs)) as any
}

const state: WorkflowState = {
  kind: "engineering",
  goal: "add rate limiting",
  stage: "build",
  iteration: 2,
  artifacts: {},
  task: { id: "f7k3-add-rate-limit", path: "docs/tasks/in-progress/f7k3-add-rate-limit.md", acceptance: [] },
  git: { base: "main", branch: "feature/f7k3-add-rate-limit", worktree: "/wt/f7k3" },
}

// Each host's marker must be its OWN file: a marker is a control input to its
// own host's hooks, so a shared path would subject a human's interactive session
// on another host to guards meant for the loop's agents.
test("every host's stage marker is a distinct file under runs/", () => {
  const files = STAGE_MARKER_HOSTS.map(stageMarkerFile)
  assert.equal(new Set(files).size, files.length, `two hosts share a marker file: ${files.join(", ")}`)
  for (const host of STAGE_MARKER_HOSTS) {
    assert.equal(hostStageMarkerPath("/repo", "docs/tasks", host), path.join("/repo/docs/tasks/runs", stageMarkerFile(host)))
  }
})

// Claude's marker predates the others and its SHIPPED hook bundles read this
// literal path. Renaming it does not error — it silently disarms every installed
// Claude hook, so the asymmetry with the suffixed siblings is pinned here.
test("the Claude marker keeps its unsuffixed historical filename", () => {
  assert.equal(stageMarkerFile("claude"), ".stage.json")
  assert.equal(stageMarkerFile("opencode"), ".stage-opencode.json")
  assert.equal(stageMarkerFile("qwen"), ".stage-qwen.json")
})

// Claude and Qwen share this server/hook source, so an unscoped nag path let a
// stale sentinel from one host's run suppress (or falsely arm) the other
// host's SubagentStop reminder on the same repo.
test("every host's verdict-nag sentinel is a distinct file under runs/", () => {
  const files = STAGE_MARKER_HOSTS.map(verdictNagFile)
  assert.equal(new Set(files).size, files.length, `two hosts share a verdict-nag file: ${files.join(", ")}`)
  for (const host of STAGE_MARKER_HOSTS) {
    assert.equal(hostVerdictNagPath("/repo", "docs/tasks", host), path.join("/repo/docs/tasks/runs", verdictNagFile(host)))
  }
})

// Same reason the Claude stage marker stays unsuffixed: it came first and its
// shipped hook bundle reads this literal path.
test("the Claude verdict-nag sentinel keeps its unsuffixed historical filename", () => {
  assert.equal(verdictNagFile("claude"), ".verdict-nag")
  assert.equal(verdictNagFile("opencode"), ".verdict-nag-opencode")
  assert.equal(verdictNagFile("qwen"), ".verdict-nag-qwen")
})

test("opencodeMarkerPath stays a thin wrapper over the generic path", () => {
  assert.equal(opencodeMarkerPath("/repo", "docs/tasks"), hostStageMarkerPath("/repo", "docs/tasks", "opencode"))
})

test("opencodeStageMarker snapshots the state's driving facts", () => {
  const m = opencodeStageMarker(state, 1234)
  assert.deepEqual(m, {
    host: "opencode",
    kind: "engineering",
    stage: "build",
    taskId: "f7k3-add-rate-limit",
    worktree: "/wt/f7k3",
    deadline: 1234,
    iteration: 2,
    pid: process.pid,
  })
})

test("a kind-less, task-less, unisolated state markers as engineering with nulls", () => {
  const m = opencodeStageMarker({ goal: "g", stage: "plan", iteration: 0, artifacts: {} }, null)
  assert.equal(m.kind, "engineering")
  assert.equal(m.taskId, null)
  assert.equal(m.worktree, null)
  assert.equal(m.deadline, null)
})

test("taskDrivenByStageMarker: live marker names the host; expired deadline or dead pid reads dead", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stage-marker-live-"))
  const now = 1_000_000
  const $ = fakeShell()
  await writeOpencodeStageMarker($, dir, "docs/tasks", opencodeStageMarker(state, now + 60_000))

  assert.equal(await taskDrivenByStageMarker($, dir, "docs/tasks", "f7k3-add-rate-limit", now), "opencode", "fresh deadline + live pid = driven")
  assert.equal(await taskDrivenByStageMarker($, dir, "docs/tasks", "other-task", now), null, "a different task is not driven by this marker")
  assert.equal(await taskDrivenByStageMarker($, dir, "docs/tasks", "f7k3-add-rate-limit", now + 61_000), null, "past the deadline the stage window is over")

  // A SIGKILLed writer leaves the marker with a fresh deadline — but its pid is
  // gone, and recover must not be locked out for the rest of the stage window.
  const deadPidShell = fakeShell(new Set())
  assert.equal(await taskDrivenByStageMarker(deadPidShell, dir, "docs/tasks", "f7k3-add-rate-limit", now), null, "dead writer pid = not driven")

  await clearOpencodeStageMarker($, dir, "docs/tasks")
  assert.equal(await taskDrivenByStageMarker($, dir, "docs/tasks", "f7k3-add-rate-limit", now), null, "no marker = not driven")

  // Garbled marker degrades to "not driven", never a throw.
  fs.mkdirSync(path.join(dir, "docs/tasks/runs"), { recursive: true })
  fs.writeFileSync(opencodeMarkerPath(dir, "docs/tasks"), "not json")
  assert.equal(await taskDrivenByStageMarker($, dir, "docs/tasks", "f7k3-add-rate-limit", now), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("liveStageMarkers: reports every LIVE marker with its driving facts, under the same liveness rule", async () => {
  // The cross-process status witness: a marker that taskDrivenByStageMarker
  // would call live must appear here with the fields a status line renders,
  // and a marker it would call dead (expired, dead pid, garbled) must not.
  const dir = await mkdtemp(path.join(tmpdir(), "stage-marker-live-list-"))
  const now = 1_000_000
  const $ = fakeShell()
  await writeOpencodeStageMarker($, dir, "docs/tasks", opencodeStageMarker(state, now + 60_000))

  const live = await liveStageMarkers($, dir, "docs/tasks", now)
  assert.deepEqual(live, [
    { host: "opencode", taskId: "f7k3-add-rate-limit", stage: "build", kind: "engineering", deadline: now + 60_000, pid: process.pid },
  ])
  assert.deepEqual(await liveStageMarkers($, dir, "docs/tasks", now + 61_000), [], "an expired marker is not a live drive")
  assert.deepEqual(await liveStageMarkers(fakeShell(new Set()), dir, "docs/tasks", now), [], "a dead writer pid is not a live drive")

  fs.writeFileSync(opencodeMarkerPath(dir, "docs/tasks"), "not json")
  assert.deepEqual(await liveStageMarkers($, dir, "docs/tasks", now), [], "a garbled marker degrades to nothing, never a throw")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("taskNamedByStageMarker: names the task live or dead, but never a different task", async () => {
  // Recover's crash-evidence probe: given taskDrivenByStageMarker already said
  // "not driven", a marker still NAMING the task means a run reached a stage
  // and died — safe to take its claim over now. No marker at all may instead
  // be a live run inside its pre-marker setup window, where a takeover steals
  // the claim.
  const dir = await mkdtemp(path.join(tmpdir(), "stage-marker-named-"))
  const now = 1_000_000
  const $ = fakeShell()
  await writeOpencodeStageMarker($, dir, "docs/tasks", opencodeStageMarker(state, now - 1)) // expired: dead
  assert.equal(await taskNamedByStageMarker($, dir, "docs/tasks", "f7k3-add-rate-limit"), true, "an expired marker still names its task")
  assert.equal(await taskNamedByStageMarker($, dir, "docs/tasks", "other-task"), false)
  await clearOpencodeStageMarker($, dir, "docs/tasks")
  assert.equal(await taskNamedByStageMarker($, dir, "docs/tasks", "f7k3-add-rate-limit"), false, "no marker names nothing")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("write → read → clear round-trips through the runs dir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stage-marker-"))
  const $ = fakeShell()
  const marker = opencodeStageMarker(state, 99)
  await writeOpencodeStageMarker($, dir, "docs/tasks", marker)
  const file = opencodeMarkerPath(dir, "docs/tasks")
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), marker)

  await clearOpencodeStageMarker($, dir, "docs/tasks")
  assert.equal(fs.existsSync(file), false)
  // Idempotent on an absent file.
  await clearOpencodeStageMarker($, dir, "docs/tasks")
  fs.rmSync(dir, { recursive: true, force: true })
})
