import { defaultLoopsDir } from "../manifest/dir.js"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Client, Shell } from "../host.js"
import { loadManifest } from "../manifest/load.js"
import { makeDependencyScanSource, semverImpact, upgradeCandidates } from "./dependency-scan.js"

/**
 * The dependency-scan source over the real dep-sitter manifest, against a
 * scripted npm shell. The candidate policy (floor, majors, outdated merge) is
 * covered on the pure `upgradeCandidates`; the source tests cover polling,
 * ledger dedup, claim mechanics, and terminal ledger writes.
 */

const LOOPS_DIR = defaultLoopsDir()
const sitter = loadManifest(LOOPS_DIR, "dep-sitter")

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

/** Client whose reads serve ledger files from an in-memory map. */
const ledgerClient = (ledgers: Record<string, string>): Client => ({
  file: {
    async list() {
      return { data: [] }
    },
    async read({ query }) {
      const content = ledgers[query.path]
      return { data: content ? { content } : null }
    },
  },
  app: { async log() {} },
})

const vuln = (over: Record<string, unknown> = {}) => ({
  name: "lodash",
  severity: "high",
  isDirect: true,
  fixAvailable: { name: "lodash", version: "4.17.21", isSemVerMajor: false },
  ...over,
})

const audit = (vulns: Record<string, unknown>) => JSON.stringify({ vulnerabilities: vulns })
const installed = (deps: Record<string, string>) =>
  JSON.stringify({ dependencies: Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, { version: v }])) })

const POLICY = { severityFloor: "high", autoFix: ["patch", "minor"], includeOutdated: false }

test("semverImpact classifies bumps and treats unparsable versions as major", () => {
  assert.equal(semverImpact("1.2.3", "1.2.4"), "patch")
  assert.equal(semverImpact("1.2.3", "1.3.0"), "minor")
  assert.equal(semverImpact("1.2.3", "2.0.0"), "major")
  assert.equal(semverImpact("", "1.2.3"), "major")
  assert.equal(semverImpact("next", "1.2.3"), "major")
})

test("upgradeCandidates enforces the severity floor, directness, and the majors-stay-human rule", () => {
  const report = {
    vulnerabilities: {
      lodash: vuln({}),
      // Below the floor.
      chalk: vuln({ name: "chalk", severity: "moderate", fixAvailable: { name: "chalk", version: "5.0.1", isSemVerMajor: false } }),
      // Transitive — npm audit fix territory, not a claimable direct upgrade.
      minimist: vuln({ name: "minimist", isDirect: false }),
      // Major: surfaced, never claimed.
      express: vuln({ name: "express", severity: "critical", fixAvailable: { name: "express", version: "5.0.0", isSemVerMajor: true } }),
      // fixAvailable=true carries no target version — nothing actionable to pin.
      needsfix: vuln({ name: "needsfix", fixAvailable: true }),
    },
  }
  const { claimable, skippedMajors } = upgradeCandidates(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    report as any,
    { lodash: "4.17.20", express: "4.18.0" },
    {},
    POLICY,
  )
  assert.deepEqual(claimable.map((c) => c.pkg), ["lodash"])
  assert.equal(claimable[0]?.impact, "patch")
  assert.deepEqual(skippedMajors.map((c) => c.pkg), ["express"])
})

test("upgradeCandidates merges outdated deps when enabled, vulnerable candidates winning and severity ordering first", () => {
  const report = { vulnerabilities: { lodash: vuln({}) } }
  const outdated = {
    lodash: { current: "4.17.20", wanted: "4.17.99" }, // already a vulnerable candidate — audit wins
    zod: { current: "3.22.0", wanted: "3.23.0" }, // minor — claimable
    react: { current: "17.0.0", wanted: "18.0.0" }, // major — never
  }
  const { claimable } = upgradeCandidates(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    report as any,
    { lodash: "4.17.20" },
    outdated,
    { ...POLICY, includeOutdated: true },
  )
  assert.deepEqual(claimable.map((c) => c.pkg), ["lodash", "zod"])
  assert.equal(claimable[0]?.target, "4.17.21")
  assert.equal(claimable[1]?.severity, "")
})

const source = (opts: { auditJson?: string; lsJson?: string; ledgers?: Record<string, string>; script?: Cmd[]; log?: string[]; warnings?: string[] } = {}) =>
  makeDependencyScanSource({
    $: scriptedShell(
      [
        { cmd: "npm audit --json", result: { exitCode: 1, stdout: opts.auditJson ?? audit({ lodash: vuln({}) }) } },
        { cmd: "npm ls --json", result: { stdout: opts.lsJson ?? installed({ lodash: "4.17.20" }) } },
        ...(opts.script ?? []),
      ],
      opts.log,
    ),
    client: ledgerClient(opts.ledgers ?? {}),
    directory: "/r",
    tasksDir: "docs/tasks",
    log: (_l, m) => void opts.warnings?.push(m),
    loaded: sitter,
    now: () => "2026-07-05T00:00:00Z",
  })

test("claims a fixable advisory: scan entry, feature-branch goal, claims under runs/dep-sitter", async () => {
  const log: string[] = []
  const { item, skip } = await source({ log }).claimNext()
  assert.equal(skip, null)
  assert.equal(item?.id, "dep-lodash")
  assert.equal(item?.entryStage, "scan")
  assert.equal(item?.state.kind, "dep-sitter")
  assert.equal(item?.state.git, undefined)
  assert.match(item?.state.goal ?? "", /^Upgrade lodash to 4\.17\.21/)
  assert.match(item?.state.goal ?? "", /DRAFT pull request/)
  assert.match(item?.state.goal ?? "", /Never merge/)
  assert.ok(log.some((c) => c.includes("runs/dep-sitter/.claims/dep-lodash")))
})

test("a major-only report claims nothing and logs the human handoff", async () => {
  const warnings: string[] = []
  const majorOnly = audit({
    express: vuln({ name: "express", severity: "critical", fixAvailable: { name: "express", version: "5.0.0", isSemVerMajor: true } }),
  })
  const { item, skip } = await source({ auditJson: majorOnly, warnings }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /^dep-sitter: no auto-fixable upgrades/)
  assert.equal(skip?.actionable, false)
  assert.ok(warnings.some((w) => w.includes("express") && w.includes("majors stay a human call")))
})

test("a handled or failed target suppresses the claim until the target moves", async () => {
  const handled = {
    "docs/tasks/runs/dep-sitter/dep-lodash.json": JSON.stringify({
      pkg: "lodash",
      versionHandled: "4.17.21",
      failedAttempts: [],
      updatedAt: "2026-07-04T00:00:00Z",
    }),
  }
  assert.equal((await source({ ledgers: handled }).claimNext()).item, null)
  const failed = {
    "docs/tasks/runs/dep-sitter/dep-lodash.json": JSON.stringify({
      pkg: "lodash",
      failedAttempts: [{ target: "4.17.21", at: "2026-07-04T00:00:00Z" }],
      updatedAt: "2026-07-04T00:00:00Z",
    }),
  }
  assert.equal((await source({ ledgers: failed }).claimNext()).item, null)
  // A newer fix version is a fresh claim.
  const newer = audit({ lodash: vuln({ fixAvailable: { name: "lodash", version: "4.17.22", isSemVerMajor: false } }) })
  assert.equal((await source({ ledgers: handled, auditJson: newer }).claimNext()).item?.id, "dep-lodash")
})

test("onTerminal(done) records the published target; stop records a failed attempt", async () => {
  const log: string[] = []
  const src = source({ log })
  const { item } = await src.claimNext()
  assert.ok(item)
  await src.onTerminal?.(item, { kind: "done", message: "draft PR opened" })
  const write = log.find((c) => c.startsWith("printf") && c.includes("dep-lodash.json"))
  assert.ok(write, "ledger written")
  assert.match(write ?? "", /versionHandled/)
  assert.match(write ?? "", /4\.17\.21/)
  assert.ok(log.some((c) => c.startsWith("rmdir") && c.includes("dep-lodash")))
})

test("an unparsable audit report is an actionable skip, not a crash", async () => {
  const { item, skip } = await source({ auditJson: "not json" }).claimNext()
  assert.equal(item, null)
  assert.match(skip?.message ?? "", /^dep-sitter: could not parse npm audit output/)
  assert.equal(skip?.actionable, true)
})
