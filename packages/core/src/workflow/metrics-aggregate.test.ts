import assert from "node:assert/strict"
import { test } from "node:test"
import { firstPassYield, formatMetricsHeadline, iterationBurn, metricsHeadline, parseWindow, readRunInputs, weeklyTrend, windowInputs, type RunMetricsInput } from "./metrics-aggregate.js"
import type { RunLogSummary, RunSummaryRow } from "./runlog.js"

const row = (stage: string, verdict: string | undefined, iteration = 1): RunSummaryRow => ({ stage, iteration, verdict, duration: "1m 0s", seconds: 60, extra: {} })
const pass = (over: Partial<RunLogSummary>): RunLogSummary => ({ outcome: "done", at: "2026-08-03T10:00:00Z", rows: [row("verify", "PASS")], iterationsUsed: 1, cap: 3, ...over })
const input = (id: string, summaries: RunLogSummary[], sidecarRuns: { endedAt: string; kind?: string }[] = []): RunMetricsInput => ({
  id,
  log: { sections: [], summaries },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sidecar: sidecarRuns.length ? ({ runs: sidecarRuns.map((r) => ({ ...r, samples: [] })) } as any) : null,
})

test("parseWindow reads day counts and all, refusing anything else", () => {
  const now = Date.parse("2026-09-06T00:00:00Z")
  assert.deepEqual(parseWindow("all", now), {})
  assert.deepEqual(parseWindow(undefined, now), {})
  assert.deepEqual(parseWindow("7d", now), { since: now - 7 * 86_400_000 })
  assert.deepEqual(parseWindow("30", now), { since: now - 30 * 86_400_000 })
  for (const bad of ["7w", "-1d", "0d", "soon", "7d extra"]) assert.equal(parseWindow(bad, now), null, bad)
})

test("windowInputs narrows passes by time and kind, drops inputs left empty, and treats kind-less passes as engineering", () => {
  const inputs = [
    input("old", [pass({ at: "2026-01-01T00:00:00Z" })], [{ endedAt: "2026-01-01T00:00:00Z" }]),
    input("new", [pass({ at: "2026-09-01T00:00:00Z" }), pass({ at: "2026-09-02T00:00:00Z", kind: "pr-sitter", outcome: "stopped" })], [{ endedAt: "2026-09-02T00:00:00Z", kind: "pr-sitter" }]),
  ]
  const since = Date.parse("2026-08-01T00:00:00Z")
  const recent = windowInputs(inputs, { since })
  assert.deepEqual(recent.map((i) => i.id), ["new"])
  assert.equal(recent[0]!.log.summaries.length, 2)
  const eng = windowInputs(inputs, { kind: "engineering" })
  assert.deepEqual(eng.map((i) => i.id), ["old", "new"])
  assert.equal(eng[1]!.log.summaries.length, 1, "the pr-sitter pass is out")
  assert.equal(eng[1]!.sidecar?.runs.length, 0, "the pr-sitter sidecar entry is out too")
  const sitter = windowInputs(inputs, { kind: "pr-sitter", since })
  assert.deepEqual(sitter.map((i) => i.id), ["new"])
  assert.equal(sitter[0]!.log.summaries[0]!.outcome, "stopped")
  assert.deepEqual(windowInputs(inputs, {}), inputs, "an empty window is the identity")
})

test("iterationBurn and firstPassYield keep their pre-move semantics", () => {
  const burn = iterationBurn([pass({ iterationsUsed: 3, cap: 3 }), pass({ iterationsUsed: 1, cap: 3 }), pass({ iterationsUsed: undefined, cap: undefined })])
  assert.equal(burn.passesMeasured, 2)
  assert.equal(burn.passesUnmeasured, 1)
  assert.equal(burn.cappedPasses, 1)
  assert.equal(burn.capTripRate, 0.5)
  const fp = firstPassYield([pass({ rows: [row("verify", "PASS"), row("review", "PASS")] }), pass({ rows: [row("verify", "FAIL"), row("verify", "PASS", 2)] }), pass({ rows: [row("build", undefined)] })])
  assert.deepEqual(fp, { passesMeasured: 2, passesWithoutChecks: 1, cleanPasses: 1, rate: 0.5 })
})

test("weeklyTrend buckets passes by UTC Monday, oldest first, capped at the newest weeks", () => {
  const ps = [
    pass({ at: "2026-08-04T12:00:00Z" }), // Tue → week of 2026-08-03
    pass({ at: "2026-08-09T23:00:00Z", iterationsUsed: 3, cap: 3 }), // Sun → same week
    pass({ at: "2026-08-10T00:00:00Z", outcome: "stopped", rows: [row("verify", "FAIL")] }), // Mon → week of 2026-08-10
    pass({ at: "not a date" }),
  ]
  const trend = weeklyTrend(ps)
  assert.deepEqual(trend.map((w) => w.weekStart), ["2026-08-03", "2026-08-10"])
  assert.deepEqual(trend[0], { weekStart: "2026-08-03", passes: 2, done: 2, cappedPasses: 1, capTripRate: 0.5, firstPassRate: 1 })
  assert.deepEqual(trend[1], { weekStart: "2026-08-10", passes: 1, done: 0, cappedPasses: 0, capTripRate: 0, firstPassRate: 0 })
  assert.equal(weeklyTrend(ps, 1).length, 1)
  assert.equal(weeklyTrend(ps, 1)[0]!.weekStart, "2026-08-10")
})

test("metricsHeadline and its renderer: the window narrows the numbers, the kinds list never does", () => {
  const inputs = [input("a", [pass({ at: "2026-01-01T00:00:00Z", kind: "pr-sitter" })]), input("b", [pass({ at: "2026-09-01T00:00:00Z" }), pass({ at: "2026-09-02T00:00:00Z", iterationsUsed: 3, cap: 3, outcome: "stopped" })])]
  const h = metricsHeadline(inputs, { since: Date.parse("2026-08-01T00:00:00Z") })
  assert.equal(h.runs, 1)
  assert.equal(h.passes, 2)
  assert.deepEqual(h.outcomes, { done: 1, stopped: 1 })
  assert.deepEqual(h.kinds, ["engineering", "pr-sitter"])
  const lines = formatMetricsHeadline(h, "last 30d")
  assert.equal(lines[0], "Loop metrics (last 30d): 2 pass(es) across 1 run(s)")
  assert.match(lines[1]!, /outcomes: done 1 · stopped 1/)
  assert.match(lines[2]!, /cap-trip 50% \(1\/2 measured\) · first-pass yield 100% \(2\/2\)/)
  assert.match(lines[3]!, /slowest stages: verify 1m mean over 2/)
  const empty = formatMetricsHeadline(metricsHeadline(inputs, { kind: "dep-sitter" }), "dep-sitter")
  assert.match(empty[1]!, /no passes in this window — kinds on record: engineering, pr-sitter/)
})

test("readRunInputs reads every runs/*.md with its sidecar and reports unreadable logs", async () => {
  const files: Record<string, string> = {
    "docs/tasks/runs/a.md": "## build · iteration 1 · 2026-09-01T00:00:00Z\n\nx\n\n**Run summary** — done — 2026-09-01T01:00:00Z\n\n| stage | iter | verdict | wall-clock |\n|---|---|---|---|\n| verify | 1 | PASS | 1m 0s |\n",
    "docs/tasks/runs/a.metrics.json": '{"version":1,"runs":[]}',
  }
  const client = {
    file: {
      list: async () => ({ data: [{ type: "file", name: "a.md" }, { type: "file", name: "a.metrics.json" }, { type: "file", name: "gone.md" }] }),
      read: async ({ query }: { query: { path: string } }) => ({ data: query.path in files ? { content: files[query.path] } : null }),
    },
    app: { log: async () => undefined },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  const { inputs, skipped } = await readRunInputs(client, "/repo", "docs/tasks")
  assert.deepEqual(inputs.map((i) => i.id), ["a"])
  assert.deepEqual(skipped, ["gone"])
  assert.ok(inputs[0]!.sidecar !== null, "the sidecar parsed")
})
