import assert from "node:assert/strict"
import { test } from "node:test"
import {
  CHECKS_AXIS,
  CHECK_OUTPUT_MAX,
  CHECK_TIMEOUT_EXIT,
  DEFAULT_CHECK_TIMEOUT_MS,
  anyFailed,
  checkAxis,
  checkCommands,
  checksBlock,
  checksBudgetMs,
  classifyExit,
  finalizeCheckRecord,
  runChecks,
  withCheckFloor,
  type CheckResult,
} from "./checks.js"
import { effectiveVerdict, mergeAxes, type VerdictRecord } from "./verdict.js"

/**
 * `runChecks` shells out through the host `$`, which the node+tsx runner cannot
 * provide (Bun's `$`), so inject a fake that records the command and the cwd it
 * was chained with. Mirrors the isolate.test.ts harness, plus `cwd` capture —
 * running a check in the wrong tree is the failure this feature exists to avoid.
 */
type FakeResult = { exitCode?: number; stdout?: string; stderr?: string }
type Call = { cmd: string; cwd: string | null }

const makeShell = (handler: (cmd: string) => FakeResult, log?: Call[]) => {
  const build = (strings: TemplateStringsArray, exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) {
        const e = exprs[i] as { raw?: string }
        cmd += e && typeof e === "object" && "raw" in e ? String(e.raw) : String(e)
      }
    })
    const call: Call = { cmd: cmd.trim(), cwd: null }
    log?.push(call)
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: (dir: string) => {
        call.cwd = dir
        return chain
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const r = handler(call.cmd)
        return Promise.resolve({
          exitCode: r.exitCode ?? 0,
          stdout: { toString: () => r.stdout ?? "" },
          stderr: { toString: () => r.stderr ?? "" },
        }).then(resolve, reject)
      },
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((strings: TemplateStringsArray, ...exprs: unknown[]) => build(strings, exprs)) as any
}

const result = (over: Partial<CheckResult> = {}): CheckResult => ({
  name: "tests",
  command: "npm test",
  exitCode: 0,
  outcome: "pass",
  output: "",
  ...over,
})

test("classifyExit: 0 passes, 124/126/127 error, everything else fails", () => {
  assert.equal(classifyExit(0), "pass")
  assert.equal(classifyExit(1), "fail")
  assert.equal(classifyExit(2), "fail")
  // The whole point of the split: a missing/unrunnable runner is not a red suite.
  assert.equal(classifyExit(126), "error")
  assert.equal(classifyExit(127), "error")
  // A timeout is "the check could not run" too, and listing it explicitly is
  // load-bearing: falling through to FAIL would re-fire a BUILD that hangs again.
  assert.equal(classifyExit(CHECK_TIMEOUT_EXIT), "error")
  assert.equal(classifyExit(124), "error")
})

test("runChecks runs each command in the work tree, in order, and never throws on a red one", async () => {
  const calls: Call[] = []
  const $ = makeShell((cmd) => (cmd === "npm test" ? { exitCode: 1, stderr: "1 failing" } : { exitCode: 0 }), calls)
  const results = await runChecks(
    $,
    [
      { name: "tests", command: "npm test" },
      { name: "types", command: "tsc --noEmit" },
    ],
    "/repo/.wt/add-foo",
  )
  assert.deepEqual(
    calls.map((c) => [c.cmd, c.cwd]),
    [
      ["npm test", "/repo/.wt/add-foo"],
      ["tsc --noEmit", "/repo/.wt/add-foo"],
    ],
  )
  assert.deepEqual(
    results.map((r) => [r.name, r.exitCode, r.outcome]),
    [
      ["tests", 1, "fail"],
      ["types", 0, "pass"],
    ],
  )
  assert.match(results[0]!.output, /1 failing/)
})

test("runChecks resolves a per-check cwd under the work tree", async () => {
  const calls: Call[] = []
  const $ = makeShell(() => ({ exitCode: 0 }), calls)
  await runChecks($, [{ name: "web", command: "npm test", cwd: "packages/web" }], "/repo/.wt/x/")
  assert.equal(calls[0]!.cwd, "/repo/.wt/x/packages/web")
})

test("runChecks truncates a torrential output to a tail, keeping the end", async () => {
  const noise = `${"x".repeat(CHECK_OUTPUT_MAX * 2)}THE ACTUAL FAILURE`
  const $ = makeShell(() => ({ exitCode: 1, stdout: noise }))
  const [r] = await runChecks($, [{ name: "tests", command: "npm test" }], "/repo")
  assert.ok(r!.output.length < noise.length)
  // The tail, not the head: a runner's failure summary is at the end.
  assert.match(r!.output, /THE ACTUAL FAILURE$/)
  assert.match(r!.output, /chars elided/)
})

test("runChecks gives up on a hanging check and reports the timeout exit, not success", async () => {
  // No `timeout` on this shell — the core race fallback, which is what a host
  // that cannot kill its child (Bun's `$`) gets. Bounding the DRIVE LOOP is the
  // point: with no cap a hanging check wedges the run with no way out, since
  // neither host's stage deadline covers the check phase.
  const hangs = (() => {
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: () => new Promise(() => {}),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (() => chain) as any
  })()
  const [r] = await runChecks(hangs, [{ name: "tests", command: "npm test" }], "/repo", 20)
  assert.equal(r!.exitCode, CHECK_TIMEOUT_EXIT)
  // ERROR, not FAIL: a FAIL re-fires a BUILD whose VERIFY hangs again, burning
  // every iteration to the cap on a stage that never produced a result.
  assert.equal(r!.outcome, "error")
  assert.equal(checkAxis([r!])?.verdict, "ERROR")
  assert.match(r!.output, /timed out/)
})

test("runChecks prefers the host's own timeout when it has one — only the host can kill the child", async () => {
  let asked: number | null = null
  const killer = (() => {
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      timeout: (ms: number) => {
        asked = ms
        return Promise.resolve({ exitCode: 124, stdout: { toString: () => "" }, stderr: { toString: () => "killed" } })
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ exitCode: 0, stdout: { toString: () => "" }, stderr: { toString: () => "" } }).then(resolve),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (() => chain) as any
  })()
  const [r] = await runChecks(killer, [{ name: "tests", command: "npm test" }], "/repo", 1_234)
  assert.equal(asked, 1_234)
  assert.equal(r!.outcome, "error", "the host's 124 classifies the same as the fallback's")
})

test("a check's own timeoutMinutes wins over the stage-wide cap", async () => {
  // One cap across a stage is set by its slowest check, which leaves every
  // faster one effectively unbounded — a 20s lint beside a 25min integration
  // suite would otherwise have to share the suite's budget.
  const asked: number[] = []
  const shell = (() => {
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      timeout: (ms: number) => {
        asked.push(ms)
        return Promise.resolve({ exitCode: 0, stdout: { toString: () => "" }, stderr: { toString: () => "" } })
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ exitCode: 0, stdout: { toString: () => "" }, stderr: { toString: () => "" } }).then(resolve),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (() => chain) as any
  })()
  await runChecks(
    shell,
    [
      { name: "lint", command: "npm run lint" },
      { name: "it", command: "mvn verify", timeoutMinutes: 25 },
    ],
    "/repo",
    60_000,
  )
  assert.deepEqual(asked, [60_000, 25 * 60_000])
})

test("checksBudgetMs sums each check's own cap, defaulting the cap-less ones", () => {
  assert.equal(checksBudgetMs([], 10_000), 0)
  assert.equal(
    checksBudgetMs(
      [
        { name: "tests", command: "npm test" },
        { name: "e2e", command: "npm run e2e", timeoutMinutes: 3 },
      ],
      60_000,
    ),
    60_000 + 3 * 60_000,
  )
  // A host that forgets the knob still gets a bounded budget — the same
  // omission-safety rule runChecks applies to its own timeout parameter.
  assert.equal(checksBudgetMs([{ name: "tests", command: "npm test" }]), DEFAULT_CHECK_TIMEOUT_MS)
})

test("runChecks fires onCheck before each check with its effective cap — the liveness restamp seam", async () => {
  const events: string[] = []
  const $ = makeShell((cmd) => {
    events.push(`run:${cmd}`)
    return { exitCode: 0 }
  })
  await runChecks(
    $,
    [
      { name: "lint", command: "one" },
      { name: "it", command: "two", timeoutMinutes: 2 },
    ],
    "/repo",
    60_000,
    (def, capMs) => {
      events.push(`stamp:${def.name}:${capMs}`)
    },
  )
  // Before EACH check, not once up front: the whole point is that the gap
  // between restamps another process can observe is one check's cap, never the
  // phase's compounded budget.
  assert.deepEqual(events, ["stamp:lint:60000", "run:one", "stamp:it:120000", "run:two"])
})

test("checkAxis is null when every check passed — nothing is merged into the verdict", () => {
  assert.equal(checkAxis([]), null)
  assert.equal(checkAxis([result(), result({ name: "types" })]), null)
  assert.equal(anyFailed([result()]), false)
})

test("checkAxis reports FAIL for a red check and ERROR when any check could not run", () => {
  const failed = checkAxis([result({ outcome: "fail", exitCode: 1 })])
  assert.equal(failed?.axis, CHECKS_AXIS)
  assert.equal(failed?.verdict, "FAIL")
  // ERROR outranks FAIL even alongside one: a missing runner means the check
  // never happened, which must route to onError rather than burn an iteration.
  const both = checkAxis([
    result({ name: "tests", outcome: "fail", exitCode: 1 }),
    result({ name: "types", command: "tsc", outcome: "error", exitCode: 127 }),
  ])
  assert.equal(both?.verdict, "ERROR")
  assert.equal(both?.findings?.length, 2)
  assert.ok(both?.findings?.every((f) => f.severity === "critical"))
})

test("withCheckFloor is identity on all-pass — the backward-compat pin", () => {
  const record: VerdictRecord = { verdict: "PASS", reason: "all good" }
  assert.equal(withCheckFloor(record, []), record)
  assert.equal(withCheckFloor(record, [result()]), record)
  // A null record stays null: "the stage recorded no verdict" keeps meaning that.
  assert.equal(withCheckFloor(null, [result({ outcome: "fail", exitCode: 1 })]), null)
})

test("withCheckFloor turns a declared PASS into a derived FAIL, and 127 into ERROR", () => {
  const record: VerdictRecord = { verdict: "PASS" }
  const failed = withCheckFloor(record, [result({ outcome: "fail", exitCode: 1 })])!
  assert.equal(failed.verdict, "PASS") // the DECLARED verdict is untouched…
  assert.equal(effectiveVerdict(failed), "FAIL") // …and the derived one is not
  const errored = withCheckFloor(record, [result({ outcome: "error", exitCode: 127 })])!
  assert.equal(effectiveVerdict(errored), "ERROR")
})

test("withCheckFloor keeps the agent's own axes and replaces only a stale checks axis", () => {
  const record: VerdictRecord = {
    verdict: "PASS",
    axes: [
      { axis: "correctness", verdict: "PASS" },
      { axis: CHECKS_AXIS, verdict: "FAIL", findings: [{ severity: "critical", detail: "an older run" }] },
    ],
  }
  const floored = withCheckFloor(record, [result({ name: "types", outcome: "error", exitCode: 127 })])!
  assert.deepEqual(
    floored.axes?.map((a) => a.axis),
    ["correctness", CHECKS_AXIS],
  )
  assert.equal(floored.axes?.find((a) => a.axis === CHECKS_AXIS)?.verdict, "ERROR")
  // And it survives the merge the hosts run over multi-pass records.
  const merged = mergeAxes(floored.axes, [{ axis: "security", verdict: "PASS" }])
  assert.equal(merged.length, 3)
})

test("finalizeCheckRecord refuses a green-check PASS whose every axis was unassessed", () => {
  const allUnassessed: VerdictRecord = {
    verdict: "PASS",
    axes: ["correctness", "security"].map((axis) => ({ axis, verdict: "ERROR" as const })),
  }
  const finalized = finalizeCheckRecord(allUnassessed, [result()])!
  assert.equal(finalized.verdict, "ERROR", "a review that assessed nothing must not ship")
  assert.match(finalized.reason ?? "", /assessed nothing/)
})

test("finalizeCheckRecord: a red check floors first, so its assessed axis wins over the guard", () => {
  const allUnassessed: VerdictRecord = { verdict: "PASS", axes: [{ axis: "correctness", verdict: "ERROR" }] }
  const finalized = finalizeCheckRecord(allUnassessed, [result({ name: "types", command: "tsc", outcome: "fail", exitCode: 2 })])!
  // The checks axis carries critical findings ⇒ assessed ⇒ the guard does not
  // fire; the record keeps its declared PASS and derives FAIL through the axis.
  assert.equal(finalized.verdict, "PASS")
  assert.equal(effectiveVerdict(finalized), "FAIL")
})

test("finalizeCheckRecord is identity on a healthy record and on null", () => {
  const healthy: VerdictRecord = { verdict: "PASS", axes: [{ axis: "correctness", verdict: "PASS" }] }
  assert.equal(finalizeCheckRecord(healthy, [result()]), healthy)
  assert.equal(finalizeCheckRecord(null, [result({ outcome: "fail", exitCode: 1 })]), null, "null stays null — no verdict keeps meaning that")
})

test("checksBlock lists every check and the failing ones' output; checkCommands feeds the evidence seed", () => {
  const results = [result(), result({ name: "types", command: "tsc", outcome: "fail", exitCode: 2, output: "boom" })]
  const block = checksBlock(results)
  assert.match(block, /- tests \(npm test\) → PASS \(exit 0\)/)
  assert.match(block, /- types \(tsc\) → FAIL \(exit 2\)/)
  assert.match(block, /--- types output ---\nboom/)
  assert.deepEqual(checkCommands(results), ["npm test", "tsc"])
})
