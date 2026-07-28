import assert from "node:assert/strict"
import { test } from "node:test"
import { appendRunMetrics, parseRunMetrics, upsertRunMetrics, type RunEntry } from "./metrics-file.js"

const entry: RunEntry = {
  endedAt: "2026-07-06T10:00:00.000Z",
  outcome: "done",
  detail: "review passed",
  host: "opencode",
  sessionID: "ses_123",
  samples: [
    {
      stage: "build",
      iteration: 0,
      ms: 20_000,
      startedAt: "2026-07-06T09:59:40.000Z",
      tokens: { input: 1000, output: 200, reasoning: 50, cacheRead: 5000, cacheWrite: 100 },
      cost: 0.1234,
      model: "claude-sonnet-5",
    },
    { stage: "verify", iteration: 0, ms: 16_000, verdict: "PASS" },
  ],
}

test("appendRunMetrics starts a fresh document and round-trips through parse", () => {
  const raw = appendRunMetrics(null, entry)
  const parsed = parseRunMetrics(raw)
  assert.equal(parsed?.version, 1)
  assert.equal(parsed?.runs.length, 1)
  assert.deepEqual(parsed?.runs[0], entry)
})

test("appendRunMetrics appends to existing content and recovers from corrupt files", () => {
  const first = appendRunMetrics(null, entry)
  const second = appendRunMetrics(first, { ...entry, outcome: "error", detail: "boom" })
  const parsed = parseRunMetrics(second)
  assert.equal(parsed?.runs.length, 2)
  assert.equal(parsed?.runs[1]?.outcome, "error")

  const recovered = parseRunMetrics(appendRunMetrics("{not json", entry))
  assert.equal(recovered?.runs.length, 1)
})

test("per-stage tool/file activity round-trips through the sidecar", () => {
  const withActivity: RunEntry = {
    ...entry,
    samples: [
      {
        stage: "build",
        iteration: 0,
        ms: 20_000,
        tools: [
          { tool: "bash", count: 12, errors: 1 },
          { tool: "edit", count: 3, errors: 0 },
        ],
        files: ["src/a.ts", "src/b.ts"],
      },
    ],
  }
  const parsed = parseRunMetrics(appendRunMetrics(null, withActivity))
  assert.deepEqual(parsed?.runs[0]?.samples[0]?.tools, withActivity.samples[0]?.tools)
  assert.deepEqual(parsed?.runs[0]?.samples[0]?.files, withActivity.samples[0]?.files)
})

test("negative tool/file counts fail the schema closed", () => {
  const bad = {
    version: 1,
    runs: [{ endedAt: "t", detail: "", host: "opencode", samples: [{ stage: "build", iteration: 0, ms: 1, tools: [{ tool: "bash", count: -1, errors: 0 }] }] }],
  }
  assert.equal(parseRunMetrics(JSON.stringify(bad)), null)
})

test("parseRunMetrics fails closed on invalid shape or version", () => {
  assert.equal(parseRunMetrics("null"), null)
  assert.equal(parseRunMetrics('{"version":2,"runs":[]}'), null)
  assert.equal(parseRunMetrics('{"version":1,"runs":[{"bad":true}]}'), null)
  assert.equal(parseRunMetrics("not json at all"), null)
})

test("upsertRunMetrics replaces a trailing open entry across the live flush cycle", () => {
  const open1: RunEntry = { ...entry, endedAt: "t1", outcome: undefined, open: true, samples: entry.samples.slice(0, 1) }
  const open2: RunEntry = { ...entry, endedAt: "t2", outcome: undefined, open: true, samples: entry.samples }
  const final: RunEntry = { ...entry, endedAt: "t3", outcome: "done", open: undefined }

  // open → open: the second flush replaces the first (one entry, still open, latest samples).
  const afterFlush = upsertRunMetrics(upsertRunMetrics(null, open1), open2)
  const flushed = parseRunMetrics(afterFlush)
  assert.equal(flushed?.runs.length, 1)
  assert.equal(flushed?.runs[0]?.open, true)
  assert.equal(flushed?.runs[0]?.samples.length, 2)

  // open → final: the terminal write replaces the open entry (one entry, no open flag).
  const afterFinal = parseRunMetrics(upsertRunMetrics(afterFlush, final))
  assert.equal(afterFinal?.runs.length, 1)
  assert.equal(afterFinal?.runs[0]?.open, undefined)
  assert.equal(afterFinal?.runs[0]?.outcome, "done")
})

test("upsertRunMetrics appends when the last entry is already finalized (re-run of a task)", () => {
  const final1 = upsertRunMetrics(null, entry) // no open flag
  const openNext: RunEntry = { ...entry, endedAt: "t9", outcome: undefined, open: true }
  const parsed = parseRunMetrics(upsertRunMetrics(final1, openNext))
  assert.equal(parsed?.runs.length, 2) // prior finalized run preserved; new open run appended
  assert.equal(parsed?.runs[0]?.open, undefined)
  assert.equal(parsed?.runs[1]?.open, true)
})

test("claude-host entries carry no tokens and no sessionID", () => {
  const claudeEntry: RunEntry = {
    endedAt: "2026-07-06T10:00:00.000Z",
    outcome: "done",
    detail: "",
    host: "claude",
    samples: [{ stage: "verify", iteration: 0, ms: 1000, verdict: "PASS" }],
  }
  const parsed = parseRunMetrics(appendRunMetrics(null, claudeEntry))
  assert.equal(parsed?.runs[0]?.sessionID, undefined)
  assert.equal(parsed?.runs[0]?.samples[0]?.tokens, undefined)
})

test("a sidecar written before promptChars still parses — the fail-closed pin", () => {
  // `parseRunMetrics` fails closed to null and both writers treat null as "start
  // fresh", so a REQUIRED new field would silently discard every run's history.
  const legacy = JSON.stringify({
    version: 1,
    runs: [
      {
        endedAt: "2026-01-01T00:00:00.000Z",
        outcome: "done",
        host: "opencode",
        samples: [{ stage: "build", iteration: 0, ms: 1_000 }],
      },
    ],
  })
  const parsed = parseRunMetrics(legacy)
  assert.ok(parsed, "a pre-promptChars sidecar failed to parse")
  assert.equal(parsed?.runs[0]?.samples[0]?.promptChars, undefined)
})

test("promptChars and promptElided round-trip through a sidecar", () => {
  const raw = JSON.stringify({
    version: 1,
    runs: [
      {
        endedAt: "2026-01-01T00:00:00.000Z",
        outcome: "done",
        host: "claude",
        samples: [{ stage: "build", iteration: 0, ms: 1_000, promptChars: 12_345, promptElided: 678 }],
      },
    ],
  })
  const sample = parseRunMetrics(raw)?.runs[0]?.samples[0]
  assert.equal(sample?.promptChars, 12_345)
  assert.equal(sample?.promptElided, 678)
})

// The sidecar's `host` is a closed enum, so a host missing from it does not
// degrade — every entry it writes fails validation and the run vanishes from
// the hub entirely.
test("a qwen-host entry round-trips; an unknown host is rejected", () => {
  const entry: RunEntry = {
    endedAt: "2026-07-26T10:00:00.000Z",
    outcome: "done",
    detail: "",
    host: "qwen",
    samples: [{ stage: "review", iteration: 1, ms: 1000, verdict: "PASS" }],
  }
  assert.equal(parseRunMetrics(appendRunMetrics(null, entry))?.runs[0]?.host, "qwen")
  const bogus = JSON.stringify({ version: 1, runs: [{ ...entry, host: "gemini" }] })
  assert.equal(parseRunMetrics(bogus), null)
})

// --- additive-at-v1 schema evolution (kind / retryable / structured verdicts) ---

test("new optional fields (kind, retryable, criteria, axes) round-trip at version 1", () => {
  const withNew: RunEntry = {
    endedAt: "2026-07-28T00:00:00.000Z",
    outcome: "stopped",
    detail: "transient env fault",
    host: "opencode",
    kind: "pr-sitter",
    retryable: true,
    samples: [
      {
        stage: "review",
        iteration: 0,
        ms: 1000,
        verdict: "FAIL",
        criteria: [{ criterion: "tests pass", pass: false }],
        axes: [
          {
            axis: "correctness",
            verdict: "FAIL",
            findings: [{ severity: "critical", detail: "off-by-one in pager", location: "src/pager.ts:42" }],
          },
        ],
      },
    ],
  }
  const parsed = parseRunMetrics(appendRunMetrics(null, withNew))
  assert.equal(parsed?.runs[0]?.kind, "pr-sitter")
  assert.equal(parsed?.runs[0]?.retryable, true)
  assert.equal(parsed?.runs[0]?.samples[0]?.axes?.[0]?.findings?.[0]?.severity, "critical")
})

test("an old sidecar (no new fields) still parses under the new schema", () => {
  const old = JSON.stringify({
    version: 1,
    runs: [{ endedAt: "2026-01-01T00:00:00.000Z", outcome: "done", detail: "", host: "claude", samples: [] }],
  })
  const parsed = parseRunMetrics(old)
  assert.ok(parsed)
  assert.equal(parsed.runs[0]?.kind, undefined)
  assert.equal(parsed.runs[0]?.retryable, undefined)
})

// REGRESSION PIN for the additive-at-v1 policy (see the module doc): a
// new-format document must still parse under a copy of the ORIGINAL v1 schema.
// zod's default strip mode drops the unknown keys; if that ever changes (e.g.
// someone adds .strict()), old writers would treat every new sidecar as
// corrupt and silently discard the whole history on their next append.
test("a new-format document parses under a strict copy of the original v1 schema (strip-mode pin)", async () => {
  const { z } = await import("zod")
  const originalV1 = z.object({
    version: z.literal(1),
    runs: z.array(
      z.object({
        endedAt: z.string(),
        outcome: z.enum(["done", "stopped", "error"]).optional(),
        detail: z.string().default(""),
        host: z.enum(["opencode", "claude", "qwen"]),
        sessionID: z.string().optional(),
        samples: z.array(
          z.object({
            stage: z.string(),
            iteration: z.number().int().min(0),
            ms: z.number(),
            verdict: z.string().optional(),
          }),
        ),
        open: z.boolean().optional(),
      }),
    ),
  })
  const newFormat: RunEntry = {
    endedAt: "2026-07-28T00:00:00.000Z",
    outcome: "done",
    detail: "",
    host: "opencode",
    kind: "engineering",
    retryable: false,
    samples: [{ stage: "build", iteration: 0, ms: 5, criteria: [{ criterion: "c", pass: true }] }],
  }
  const doc: unknown = JSON.parse(appendRunMetrics(null, newFormat))
  assert.equal(originalV1.safeParse(doc).success, true)
})
