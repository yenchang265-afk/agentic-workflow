import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-workflow/core/config"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import { projectSlug } from "./transcripts.js"
import { resolveRunTokens } from "./resolve.js"

const T0 = "2026-07-06T10:00:00.000Z"
const T0_MS = Date.parse(T0)

const makeRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-tokens-"))
  fs.mkdirSync(path.join(dir, "docs", "tasks", "runs"), { recursive: true })
  return dir
}

const depsFor = (directory: string, projectsDir: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards: [],
  config: DEFAULT_CONFIG,
  workflowsDir: "/workflows-unused",
  projectsDir,
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

const writeTranscript = (projectsDir: string, directory: string, offsetsSec: number[]): void => {
  const dir = path.join(projectsDir, projectSlug(directory))
  fs.mkdirSync(dir, { recursive: true })
  const lines = offsetsSec.map((s) =>
    JSON.stringify({
      type: "assistant",
      timestamp: new Date(T0_MS + s * 1000).toISOString(),
      message: {
        model: "claude-fable-5",
        usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 },
      },
    }),
  )
  fs.writeFileSync(path.join(dir, "session.jsonl"), lines.join("\n") + "\n")
}

test("sidecar samples with tokens resolve as exact rows", async () => {
  const repo = makeRepo()
  fs.writeFileSync(
    path.join(repo, "docs", "tasks", "runs", "fix.metrics.json"),
    JSON.stringify({
      version: 1,
      runs: [
        {
          endedAt: T0,
          outcome: "done",
          detail: "",
          host: "opencode",
          sessionID: "s1",
          samples: [
            {
              stage: "build",
              iteration: 0,
              ms: 60_000,
              startedAt: T0,
              tokens: { input: 10_000, output: 2_000, reasoning: 100, cacheRead: 50_000, cacheWrite: 1_000 },
              cost: 0.5,
              model: "claude-sonnet-5",
            },
          ],
        },
      ],
    }),
  )
  const res = await resolveRunTokens(depsFor(repo, "/nonexistent-projects"), "fix")
  assert.equal(res?.rows.length, 1)
  assert.equal(res?.rows[0]?.source, "sidecar")
  assert.equal(res?.rows[0]?.estimated, false)
  assert.equal(res?.rows[0]?.tokens.input, 10_000)
  assert.equal(res?.cost, 0.5)
  fs.rmSync(repo, { recursive: true, force: true })
})

test("claude-host sidecar entries join tokens from transcripts by stage window", async () => {
  const repo = makeRepo()
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "hub-projects-"))
  writeTranscript(projects, repo, [10, 30, 500]) // two inside the 60s build window, one far outside
  fs.writeFileSync(
    path.join(repo, "docs", "tasks", "runs", "gate.metrics.json"),
    JSON.stringify({
      version: 1,
      runs: [
        {
          endedAt: new Date(T0_MS + 60_000).toISOString(),
          outcome: "done",
          detail: "plan parked for review",
          host: "claude",
          samples: [{ stage: "plan", iteration: 0, ms: 60_000, startedAt: T0 }],
        },
      ],
    }),
  )
  const res = await resolveRunTokens(depsFor(repo, projects), "gate")
  assert.equal(res?.rows.length, 1)
  assert.equal(res?.rows[0]?.source, "transcripts")
  assert.equal(res?.rows[0]?.estimated, true)
  assert.equal(res?.rows[0]?.tokens.input, 2000)
  assert.equal(res?.rows[0]?.tokens.cacheRead, 10_000)
  assert.equal(res?.rows[0]?.model, "claude-fable-5")
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(projects, { recursive: true, force: true })
})

test("runs without a sidecar reconstruct windows from the run-log summary", async () => {
  const repo = makeRepo()
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "hub-projects-"))
  writeTranscript(projects, repo, [30]) // inside the reconstructed 60s window ending at T0+60s
  fs.writeFileSync(
    path.join(repo, "docs", "tasks", "runs", "old.md"),
    [
      "",
      "## run · done",
      "",
      `## Run summary · done · ${new Date(T0_MS + 60_000).toISOString()}`,
      "",
      "| # | stage | iter | verdict | wall-clock |",
      "|---|-------|------|---------|------------|",
      "| 1 | build | 1 | — | 60s |",
      "",
      "iterations used: 1/3 · total: 60s · outcome: done",
    ].join("\n"),
  )
  const res = await resolveRunTokens(depsFor(repo, projects), "old")
  assert.equal(res?.rows.length, 1)
  assert.equal(res?.rows[0]?.stage, "build")
  assert.equal(res?.rows[0]?.estimated, true)
  assert.ok(res?.notes.some((n) => n.includes("predates the metrics sidecar")))
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(projects, { recursive: true, force: true })
})

test("qwen-host sidecar entries join tokens from transcripts, never the opencode-db branch", async () => {
  // `=== "claude"` sent qwen entries down the opencode-db path, where a missing
  // sessionID earned them "opencode run predates token capture and recorded no
  // sessionID" — a factually wrong note on a run that was never an opencode run
  // — and zero attribution. Qwen never calls the LLM itself (metrics-file.ts),
  // so its tokens join from transcripts exactly like claude's.
  const repo = makeRepo()
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "hub-projects-"))
  writeTranscript(projects, repo, [10, 30])
  fs.writeFileSync(
    path.join(repo, "docs", "tasks", "runs", "qwen.metrics.json"),
    JSON.stringify({
      version: 1,
      runs: [
        {
          endedAt: new Date(T0_MS + 60_000).toISOString(),
          outcome: "done",
          detail: "",
          host: "qwen",
          samples: [{ stage: "plan", iteration: 0, ms: 60_000, startedAt: T0 }],
        },
      ],
    }),
  )
  const res = await resolveRunTokens(depsFor(repo, projects), "qwen")
  assert.equal(res?.rows.length, 1)
  assert.equal(res?.rows[0]?.source, "transcripts")
  assert.ok(!res?.notes.some((n) => n.includes("opencode")), `no opencode note on a qwen run: ${JSON.stringify(res?.notes)}`)
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(projects, { recursive: true, force: true })
})

test("a mixed opencode entry never stacks the session total on observed stage rows", async () => {
  // The backfill was gated on `unobserved.length > 0` instead of "nothing
  // observed": an entry with four token-bearing stages and one token-less one
  // (a stage that errored before its first LLM turn) got per-stage rows PLUS a
  // whole-session total — totals and cost read ~2× in /api/tokens and the
  // metrics tab.
  const repo = makeRepo()
  fs.writeFileSync(
    path.join(repo, "docs", "tasks", "runs", "mixed.metrics.json"),
    JSON.stringify({
      version: 1,
      runs: [
        {
          endedAt: T0,
          outcome: "done",
          detail: "",
          host: "opencode",
          sessionID: "s3",
          samples: [
            {
              stage: "build",
              iteration: 0,
              ms: 60_000,
              tokens: { input: 10_000, output: 2_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
              cost: 0.5,
            },
            { stage: "verify", iteration: 0, ms: 1000 }, // no tokens — errored before its first LLM turn
          ],
        },
      ],
    }),
  )
  const res = await resolveRunTokens(depsFor(repo, "/nonexistent-projects"), "mixed")
  assert.equal(res?.rows.length, 1, JSON.stringify(res?.rows))
  assert.ok(!res?.rows.some((r) => r.stage === "(session total)"), "no session total beside observed rows")
  assert.equal(res?.totals.input, 10_000)
  assert.ok(res?.notes.some((n) => n.includes("recorded no tokens")), JSON.stringify(res?.notes))
  fs.rmSync(repo, { recursive: true, force: true })
})

test("opencode legacy entries degrade with a note when node:sqlite or the db is unavailable", async () => {
  const repo = makeRepo()
  fs.writeFileSync(
    path.join(repo, "docs", "tasks", "runs", "legacy.metrics.json"),
    JSON.stringify({
      version: 1,
      runs: [
        {
          endedAt: T0,
          outcome: "done",
          detail: "",
          host: "opencode",
          sessionID: "s2",
          samples: [{ stage: "build", iteration: 0, ms: 1000 }],
        },
      ],
    }),
  )
  const res = await resolveRunTokens(depsFor(repo, "/nonexistent-projects"), "legacy")
  assert.equal(res?.rows.length, 0)
  assert.ok(res?.notes.some((n) => n.includes("opencode.db")))
  fs.rmSync(repo, { recursive: true, force: true })
})

test("resolveRunTokens returns null for an unknown run", async () => {
  const repo = makeRepo()
  assert.equal(await resolveRunTokens(depsFor(repo, "/nonexistent-projects"), "nope"), null)
  fs.rmSync(repo, { recursive: true, force: true })
})

test("projectSlug matches Claude Code's directory slugging", () => {
  assert.equal(
    projectSlug("/mnt/c/Users/User/Desktop/Claude Code/agentic-workflow"),
    "-mnt-c-Users-User-Desktop-Claude-Code-agentic-workflow",
  )
})
