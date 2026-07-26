import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  clearOpencodeStageMarker,
  hostStageMarkerPath,
  opencodeMarkerPath,
  opencodeStageMarker,
  STAGE_MARKER_HOSTS,
  stageMarkerFile,
  writeOpencodeStageMarker,
} from "./stage-marker.js"
import type { WorkflowState } from "./state.js"

/**
 * The OpenCode host's live-stage marker. Same fake-shell approach as
 * persist.test.ts: write/clear shell out via `$` (mkdir/printf/mv/rm), faked
 * over a real temp dir so the round-trip runs without a running opencode.
 */
const fakeShell = () => {
  const run = (strings: TemplateStringsArray, exprs: unknown[]) => {
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      then: (resolve: (v: unknown) => unknown) => {
        const raw = strings.join("\0")
        if (raw.startsWith("mkdir -p ")) {
          fs.mkdirSync(String(exprs[0]), { recursive: true })
        } else if (raw.startsWith("printf '%s' ")) {
          fs.writeFileSync(String(exprs[1]), String(exprs[0]))
        } else if (raw.startsWith("mv ")) {
          fs.renameSync(String(exprs[0]), String(exprs[1]))
        } else if (raw.startsWith("rm -f ")) {
          fs.rmSync(String(exprs[0]), { force: true })
        }
        return Promise.resolve({ exitCode: 0 }).then(resolve)
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
  })
})

test("a kind-less, task-less, unisolated state markers as engineering with nulls", () => {
  const m = opencodeStageMarker({ goal: "g", stage: "plan", iteration: 0, artifacts: {} }, null)
  assert.equal(m.kind, "engineering")
  assert.equal(m.taskId, null)
  assert.equal(m.worktree, null)
  assert.equal(m.deadline, null)
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
