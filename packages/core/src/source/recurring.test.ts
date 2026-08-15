import assert from "node:assert/strict"
import { test } from "node:test"
import type { Client, Shell } from "../host.js"
import { defaultWorkflowsDir } from "../manifest/dir.js"
import { loadManifest } from "../manifest/load.js"
import { makeRecurringSource, recurringBranch, recurringGoal } from "./recurring.js"
import type { TerminalOutcome } from "./types.js"

/**
 * The recurring source over the real `recurring` manifest. This file carries
 * the scheduling contract: which definition is due, which is skipped, and what
 * a cycle's outcome writes back to the ledger.
 */

const WORKFLOWS_DIR = defaultWorkflowsDir()
const loaded = loadManifest(WORKFLOWS_DIR, "recurring")

const NOW = "2026-07-05T12:00:00Z"
const RECURRING_DIR = "docs/recurring"

type Cmd = { cmd: string; result: { exitCode?: number; stdout?: string; stderr?: string } }

/** Scripted shell: first matching prefix wins; unmatched commands succeed empty. */
const scriptedShell = (script: Cmd[], log: string[] = []): Shell => {
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
    })
    cmd = cmd.trim().replace(/\s+/g, " ")
    log.push(cmd)
    const hit = script.find((c) => cmd.startsWith(c.cmd))
    const r = hit?.result ?? { exitCode: 0, stdout: "" }
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({
          exitCode: r.exitCode ?? 0,
          stdout: { toString: () => r.stdout ?? "" },
          stderr: { toString: () => r.stderr ?? "" },
        }).then(resolve, reject),
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((strings: TemplateStringsArray, ...exprs: unknown[]) => build(strings, exprs)) as any
}

const def = (over: { title?: string; schedule?: string; paused?: boolean; body?: string } = {}): string =>
  `---\ntitle: ${over.title ?? "Weekly digest"}\n` +
  `schedule:\n${over.schedule ?? "  type: interval\n  minutes: 60"}\n` +
  `paused: ${String(over.paused ?? false)}\n---\n${over.body ?? "Do the thing."}\n`

/** Client serving definition files from `<recurringDir>/` and ledgers from `.runs/`. */
const fsClient = (files: Record<string, string>): Client => ({
  file: {
    async list({ query }) {
      const prefix = `${query.path.replace(/\/$/, "")}/`
      const data = Object.keys(files)
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => ({
          type: "file" as const,
          name: p.slice(prefix.length),
          path: p,
          absolute: `/r/${p}`,
        }))
      return { data }
    },
    async read({ query }) {
      const content = files[query.path]
      return { data: content ? { content } : null }
    },
  },
  app: { async log() {} },
})

const source = (
  files: Record<string, string>,
  opts: { log?: string[]; warnings?: string[]; script?: Cmd[]; now?: string } = {},
) =>
  makeRecurringSource({
    $: scriptedShell(opts.script ?? [], opts.log),
    client: fsClient(files),
    directory: "/r",
    recurringDir: RECURRING_DIR,
    log: (_l, m) => void opts.warnings?.push(m),
    loaded,
    now: () => opts.now ?? NOW,
  })

const ledger = (o: Record<string, unknown>): string => JSON.stringify({ consecutiveFailures: 0, updatedAt: NOW, ...o })

test("a never-run definition is due and claims at the manifest's first stage", async () => {
  const log: string[] = []
  const { item, skip } = await source({ [`${RECURRING_DIR}/f7k3-digest.md`]: def() }, { log }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "f7k3-digest")
  assert.equal(item?.workflowKind, "recurring")
  // Every cycle re-runs the WHOLE lifecycle — there is no resume-at-build.
  assert.equal(item?.entryStage, "plan")
  assert.equal(item?.state.stage, "plan")
  assert.ok(log.some((c) => c.includes(`${RECURRING_DIR}/.runs/.claims/f7k3-digest`)), "claimed under .runs/.claims")
})

test("the entry state pre-sets a cycle-scoped branch — never a goal-derived one", async () => {
  // The regression this exists for: `addWorktree` reuses an existing branch
  // as-is, and a recurring goal is identical every cycle, so a derived name
  // would put cycle 2 on cycle 1's commits.
  const { item } = await source({ [`${RECURRING_DIR}/f7k3-digest.md`]: def() }).claimNext()
  assert.equal(item?.state.git?.branch, recurringBranch("f7k3-digest", NOW))
  assert.match(item?.state.git?.branch ?? "", /^recurring\/f7k3-digest-/)

  const later = await source({ [`${RECURRING_DIR}/f7k3-digest.md`]: def() }, { now: "2026-07-05T13:00:00Z" }).claimNext()
  assert.notEqual(later.item?.state.git?.branch, item?.state.git?.branch, "a later cycle cuts a different branch")
})

test("a definition whose interval has not elapsed is not due", async () => {
  const files = {
    [`${RECURRING_DIR}/f7k3-digest.md`]: def(),
    [`${RECURRING_DIR}/.runs/f7k3-digest.json`]: ledger({ id: "f7k3-digest", lastRunAt: "2026-07-05T11:30:00Z" }),
  }
  const { item, skip } = await source(files).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /nothing due/)
  assert.equal(skip?.actionable, false)
})

test("a definition whose interval HAS elapsed is claimed again — the same identity, a second cycle", async () => {
  const files = {
    [`${RECURRING_DIR}/f7k3-digest.md`]: def(),
    [`${RECURRING_DIR}/.runs/f7k3-digest.json`]: ledger({ id: "f7k3-digest", lastRunAt: "2026-07-05T10:30:00Z" }),
  }
  const { item } = await source(files).claimNext()
  assert.equal(item?.id, "f7k3-digest", "a completed definition becomes claimable again")
})

test("a paused definition is never claimed, and is counted in the skip", async () => {
  const { item, skip } = await source({ [`${RECURRING_DIR}/f7k3-digest.md`]: def({ paused: true }) }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /1 defined, 1 paused/)
})

test("the longest-overdue definition is claimed first", async () => {
  const files = {
    [`${RECURRING_DIR}/aaa1-recent.md`]: def({ title: "Recent" }),
    [`${RECURRING_DIR}/bbb2-stale.md`]: def({ title: "Stale" }),
    [`${RECURRING_DIR}/.runs/aaa1-recent.json`]: ledger({ id: "aaa1-recent", lastRunAt: "2026-07-05T10:55:00Z" }),
    [`${RECURRING_DIR}/.runs/bbb2-stale.json`]: ledger({ id: "bbb2-stale", lastRunAt: "2026-07-01T00:00:00Z" }),
  }
  const { item } = await source(files).claimNext()
  assert.equal(item?.id, "bbb2-stale", "earliest due wins, not alphabetical order")
})

test("a held claim marker skips that definition with an actionable reason", async () => {
  const log: string[] = []
  const { item, skip } = await source(
    { [`${RECURRING_DIR}/f7k3-digest.md`]: def() },
    { log, script: [{ cmd: `mkdir /r/${RECURRING_DIR}/.runs/.claims/f7k3-digest`, result: { exitCode: 1 } }] },
  ).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /claim marker held for f7k3-digest/)
  assert.equal(skip?.actionable, true)
})

test("a broken cron expression is warned about, never silently skipped forever", async () => {
  // The one failure mode a human cannot see from outside: the definition just
  // never runs.
  const warnings: string[] = []
  const files = { [`${RECURRING_DIR}/f7k3-digest.md`]: def({ schedule: '  type: cron\n  expression: "not a schedule"' }) }
  const { item } = await source(files, { warnings }).claimNext()
  assert.equal(item, null)
  assert.ok(warnings.some((w) => w.includes("unusable schedule")), `expected a warning, got ${JSON.stringify(warnings)}`)
})

test("an unparseable definition is skipped with a warning, leaving the others claimable", async () => {
  const warnings: string[] = []
  const files = {
    [`${RECURRING_DIR}/bad.md`]: "no frontmatter at all",
    [`${RECURRING_DIR}/f7k3-digest.md`]: def(),
  }
  const { item } = await source(files, { warnings }).claimNext()
  assert.equal(item?.id, "f7k3-digest", "one broken file must not stop every other definition")
  assert.ok(warnings.some((w) => w.includes("bad.md")))
})

test("an empty registry says so without claiming", async () => {
  const { item, skip } = await source({}).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /no recurring definitions/)
})

test("the goal carries the acceptance criteria and the never-merge rule", async () => {
  const src =
    `---\ntitle: Weekly digest\nschedule:\n  type: interval\n  minutes: 60\n` +
    `acceptance:\n  - A digest is posted\n---\nSummarize the merges.\n`
  const { item } = await source({ [`${RECURRING_DIR}/f7k3-digest.md`]: src }).claimNext()
  assert.match(item?.state.goal ?? "", /^Weekly digest/)
  assert.match(item?.state.goal ?? "", /A digest is posted/)
  assert.match(item?.state.goal ?? "", /DRAFT pull request/)
  assert.match(item?.state.goal ?? "", /never merge it/i)
  // Acceptance rides in the goal, NOT in state.task — this source sets none.
  assert.equal(item?.state.task, undefined)
})

const terminal = (kind: TerminalOutcome["kind"], retryable?: boolean): TerminalOutcome => ({
  kind,
  message: `${kind} message`,
  ...(retryable === undefined ? {} : { retryable }),
})

/** Capture what `onTerminal` wrote to the ledger, by reading the atomic write. */
const ledgerWrite = (log: string[]): Record<string, unknown> | null => {
  const write = log.find((c) => c.startsWith("printf '%s' ") && c.includes(".runs/f7k3-digest.json"))
  if (!write) return null
  const json = /printf '%s' ([\s\S]*?) > /.exec(write)?.[1]
  return json ? (JSON.parse(json) as Record<string, unknown>) : null
}

test("a done cycle stamps lastRunAt so the next cycle waits for the schedule", async () => {
  const log: string[] = []
  const files = { [`${RECURRING_DIR}/f7k3-digest.md`]: def() }
  const src = source(files, { log })
  const { item } = await src.claimNext()
  await src.onTerminal!(item!, terminal("done"))

  const written = ledgerWrite(log)
  assert.equal(written?.["lastRunAt"], NOW)
  assert.equal(written?.["lastOutcome"], "done")
  assert.equal(written?.["consecutiveFailures"], 0)
  assert.ok(log.some((c) => c.startsWith("rmdir") || c.includes(".claims/f7k3-digest")), "claim released")
})

test("a RETRYABLE stop leaves the ledger untouched, so the next poll re-claims it", async () => {
  // The same contract every sitter's ledger has: a transient environment error
  // must not consume this definition's scheduled occurrence.
  const log: string[] = []
  const files = { [`${RECURRING_DIR}/f7k3-digest.md`]: def() }
  const src = source(files, { log })
  const { item } = await src.claimNext()
  await src.onTerminal!(item!, terminal("stop", true))

  assert.equal(ledgerWrite(log), null, "no ledger write on a retryable stop")
})

test("a cap-stop DOES advance lastRunAt and counts the failure — no hammering every tick", async () => {
  const log: string[] = []
  const warnings: string[] = []
  const files = {
    [`${RECURRING_DIR}/f7k3-digest.md`]: def(),
    [`${RECURRING_DIR}/.runs/f7k3-digest.json`]: ledger({ id: "f7k3-digest", consecutiveFailures: 1 }),
  }
  const src = source(files, { log, warnings })
  const { item } = await src.claimNext()
  await src.onTerminal!(item!, terminal("stop"))

  const written = ledgerWrite(log)
  assert.equal(written?.["lastRunAt"], NOW)
  assert.equal(written?.["lastOutcome"], "stop")
  assert.equal(written?.["consecutiveFailures"], 2, "counted, so a persistently broken order is visible")
  assert.ok(warnings.some((w) => w.includes("keeps its schedule")))
})

test("release drops the claim marker without touching the ledger", async () => {
  const log: string[] = []
  const files = { [`${RECURRING_DIR}/f7k3-digest.md`]: def() }
  const src = source(files, { log })
  const { item } = await src.claimNext()
  await src.release(item!)
  assert.equal(ledgerWrite(log), null)
})

test("recurringGoal names the cadence so a cycle knows it is not a one-off", () => {
  const goal = recurringGoal({
    id: "x",
    title: "T",
    schedule: { type: "interval", minutes: 60 },
    paused: false,
    acceptance: [],
    labels: [],
    body: "B",
    path: "/r/x.md",
  })
  assert.match(goal, /RECURRING work order \(every 60m\)/)
})
