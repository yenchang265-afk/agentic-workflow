/**
 * Check commands DISCOVERED by the PLAN stage, frozen in the plan document.
 *
 * `checks.ts` turns "did the suite pass" from a self-report into an exit code —
 * but only for commands somebody declared. No shipped manifest declares any and
 * `stageChecks` has no default, so out of the box a check stage still takes the
 * agent's word for it. A static per-ecosystem command table cannot fix that: the
 * loop runs on arbitrary repos, a missing runner exits 127 ⇒ ERROR ⇒ the
 * engineering `verify.onError` STOP arm, and a repo whose `package.json` has no
 * `test` script answers a hardcoded `npm test` with exit 1 ⇒ FAIL ⇒ iterations
 * burned to the cap on work that was fine.
 *
 * So the commands are discovered by the model that already reads the repo — and
 * two things make that safe rather than merely convenient:
 *
 *  - **Frozen, not re-derived.** Discovery happens once, in PLAN, and lands as
 *    text in the plan document. `state.artifacts.plan` is re-extracted from the
 *    task file at claim time (`source/backlog.ts` `entryState`), engineering's
 *    `plan.onDone` is `park` so no PLAN transcript survives into a run, and
 *    `dropArtifacts` never names `plan` — so every BUILD→VERIFY→BUILD iteration
 *    reads a byte-identical command set. Re-discovering per pass would restore
 *    exactly the drift `stageChecks` exists to remove: same repo, same commit,
 *    `npm test` one iteration and `npm test` plus `npx tsc` the next, with the
 *    verdict moving while the code did not.
 *  - **Capped by the consuming stage's own allowlist.** A driver-run check
 *    bypasses `bashAllowlist` entirely (`manifest/schema.ts`), and the plan
 *    document lives in `<tasksDir>/`, which is REPO CONTENT — a merely-cloned
 *    repo can ship a task file with an `## Implementation Plan` and the first
 *    watch tick will claim it. That is the same threat `SHELL_BEARING_WORKFLOW_KEYS`
 *    closes for config `stageChecks`, so "a human approved the plan" is not the
 *    boundary. `admissibleChecks` is: a discovered command runs only if
 *    `commandAllowed` says the stage's own agent could have run it unprompted.
 *
 * The residual is stated rather than papered over: running a repo's test suite
 * runs the repo's code. That is not new — the VERIFY agent has `npm test*` on
 * its allowlist and uses it on every pass — and the driver-run form is narrower,
 * because the command is frozen text a human can read instead of an inference-time
 * choice.
 *
 * Everything here is pure except `resolvableChecks` (and `resolveStageChecks`,
 * which composes it), impure over the `Shell` port only.
 */

import { CheckDefSchema, effectiveAllowlist, type CheckDef, type StageDef } from "../manifest/schema.js"
import { commandAllowed, chainedGithubPrMutation, chainedGitPushViolation, isBareCd, splitSegments } from "../task/write-backstop.js"
import { checksFor, configuredChecks, discoverChecksFor, platformFor } from "../config.js"
import type { Config } from "./state.js"
import type { Shell } from "../host.js"

/** The fenced-block info string PLAN writes its discovered commands under. */
export const CHECKS_FENCE = "agentic-checks"

/**
 * Most discovered checks honored. A cap, not a preference: every check costs the
 * loop a full command run on every check-stage firing, and a plan that lists ten
 * is a plan that guessed.
 */
export const MAX_DISCOVERED_CHECKS = 5

/** Longest discovered command honored. */
export const MAX_DISCOVERED_COMMAND = 300

/**
 * `name` is rendered into the stage prompt (`checksBlock`) and into a `critical`
 * finding's `detail` (`checkAxis`) with no untrusted-data fence around it —
 * unlike `output`, which `verify.md` explicitly fences. So it is an injection
 * surface and gets a character class, not a length check.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/

/**
 * `cwd` is joined onto the work tree by naive string concatenation
 * (`checks.ts`), so `../..` escapes it. Relative, no leading slash.
 */
const CWD_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/

/**
 * A work-tree-relative directory that cannot climb out of it.
 *
 * The `..` check is SEPARATE from `CWD_RE` and not folded into it: `.` is a
 * legitimate character in a directory name, so the character class alone happily
 * matches `..` and `../..` — which is exactly the escape the rule exists to
 * stop. Pure.
 */
const safeCwd = (cwd: string): boolean => CWD_RE.test(cwd) && cwd.split("/").every((seg) => seg !== "..")

/** A binary name safe to interpolate into the `command -v` probe. */
const BIN_RE = /^[A-Za-z0-9._\-/]+$/

/** The LAST fence wins — same rule as `lastMarkerIndex` for stacked plan headings. */
const FENCE_RE = /^[ \t]*```[ \t]*agentic-checks[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm

/**
 * The discovery instruction appended to a `planContract` stage's prompt when
 * some check stage of the kind consumes discovered commands.
 *
 * Composed onto the prompt rather than written into `stages/plan.md`, for the
 * reason `planContractBlock` states: a contract stated only in a template or a
 * persona file is skippable, one appended mechanically at composition survives
 * every dispatch path. Kept beside `parseDiscoveredChecks` so the grammar and
 * its parser cannot drift. Pure.
 */
export const checkDiscoveryBlock = (planStage: string, consumer: string): string =>
  [
    `CHECK DISCOVERY: inside the \`### Verification\` subsection, the ${planStage} stage's plan SHOULD end with a`,
    `\`\`\`${CHECKS_FENCE}\` fenced block holding a JSON array of the commands that prove this task's work —`,
    'shape: [{ "name": "tests", "command": "npm run test:all", "cwd": "packages/web" }] ("cwd" optional, work-tree-relative).',
    `The loop runs these ITSELF before the ${consumer.toUpperCase()} stage, in the work tree, and their exit codes`,
    `become established fact that the ${consumer.toUpperCase()} agent cannot argue down — which is the whole point:`,
    "it replaces a self-reported \"tests are green\" with a number.",
    "Only list a command whose definition you have READ — name the `package.json` script, `Makefile` target, or",
    "config file that defines it, in the prose above the block. Do not guess a conventional command:",
    "`npm test` on a repo whose package.json defines no `test` script exits 1 and reads as a genuine test failure,",
    "which sends the loop back to BUILD to fix work that was never broken.",
    "Every command must TERMINATE on its own. A dev server, a `--watch` runner, or anything that waits for input",
    "never returns: the loop waits out its timeout and records exit 124, which is an ERROR that stops the run for a human.",
    "To prove runtime behaviour, list the command that exercises it and exits — an e2e or integration run that starts",
    "and stops the server itself — never the serve command.",
    `At most ${MAX_DISCOVERED_CHECKS} commands, each on the ${consumer.toUpperCase()} stage's own bash allowlist —`,
    "anything else is dropped with a warning, and a command whose binary is not installed here is dropped too.",
    "Omit the block when you cannot name a command you have verified; the loop then checks as it does today.",
  ].join(" ")

/** One discovered command the loop refused, and why. */
export interface RejectedCheck {
  readonly name: string
  readonly reason: string
}

/**
 * The defs in the plan's last `agentic-checks` fence, plus what was dropped.
 *
 * Never throws and never returns a partial def: a malformed block degrades to
 * zero checks, which is today's behavior, rather than to a stop. Pure.
 */
export const parseDiscoveredChecks = (planText: string): { defs: CheckDef[]; issues: string[] } => {
  const matches = [...planText.matchAll(FENCE_RE)]
  const last = matches[matches.length - 1]
  if (!last) return { defs: [], issues: [] }
  let raw: unknown
  try {
    raw = JSON.parse(last[1] ?? "")
  } catch (e) {
    return { defs: [], issues: [`the ${CHECKS_FENCE} block is not valid JSON (${e instanceof Error ? e.message : String(e)})`] }
  }
  const parsed = CheckDefSchema.array().safeParse(raw)
  if (!parsed.success) {
    return { defs: [], issues: [`the ${CHECKS_FENCE} block does not match the check shape ({ name, command, cwd? })`] }
  }
  const issues: string[] = []
  const seen = new Set<string>()
  const defs: CheckDef[] = []
  for (const def of parsed.data) {
    if (def.command.length > MAX_DISCOVERED_COMMAND) {
      issues.push(`discovered check "${def.name}" dropped: command longer than ${MAX_DISCOVERED_COMMAND} characters`)
      continue
    }
    const key = def.name.trim().toLowerCase()
    if (seen.has(key)) {
      // A duplicate name would collapse two results into one line and one
      // finding — the same reason the manifest schema rejects them outright.
      issues.push(`discovered check "${def.name}" dropped: duplicate name`)
      continue
    }
    if (defs.length >= MAX_DISCOVERED_CHECKS) {
      issues.push(`discovered check "${def.name}" dropped: more than ${MAX_DISCOVERED_CHECKS} checks declared`)
      continue
    }
    seen.add(key)
    defs.push(def)
  }
  return { defs, issues }
}

/**
 * The discovered defs a stage's own agent could have run itself, and the ones it
 * could not.
 *
 * This is the trust boundary, not the human plan gate — see the module note.
 * Four independent rules, each with its own rejection reason so a warning names
 * the actual problem. Pure.
 */
export const admissibleChecks = (
  defs: readonly CheckDef[],
  globs: readonly string[],
): { accepted: CheckDef[]; rejected: RejectedCheck[] } => {
  const accepted: CheckDef[] = []
  const rejected: RejectedCheck[] = []
  for (const def of defs) {
    if (!NAME_RE.test(def.name)) {
      rejected.push({ name: def.name, reason: "the name is rendered into the stage prompt and must be plain text (letters, digits, spaces, . _ -)" })
      continue
    }
    if (def.cwd !== undefined && !safeCwd(def.cwd)) {
      rejected.push({ name: def.name, reason: `cwd "${def.cwd}" is not a plain relative path inside the work tree` })
      continue
    }
    if (chainedGithubPrMutation(def.command) || chainedGitPushViolation(def.command)) {
      rejected.push({ name: def.name, reason: "the command mutates a pull request or pushes a branch" })
      continue
    }
    if (!commandAllowed(def.command, globs)) {
      rejected.push({ name: def.name, reason: `"${def.command}" is not on this stage's bash allowlist` })
      continue
    }
    accepted.push(def)
  }
  return { accepted, rejected }
}

/**
 * The head binary of every runnable segment of a command — what has to exist for
 * the command not to exit 127. A bare `cd` runs nothing and is skipped. Pure.
 */
export const commandBinaries = (command: string): string[] => {
  const bins: string[] = []
  for (const seg of splitSegments(command)) {
    if (isBareCd(seg)) continue
    const head = seg.trim().split(/\s+/)[0]
    if (head && !bins.includes(head)) bins.push(head)
  }
  return bins
}

/**
 * Drop discovered defs whose binaries do not resolve in the work tree.
 *
 * Applied to DISCOVERED defs only. A configured or manifest check that 127s is
 * an environment error a human asserted should exist, so it must keep routing to
 * `onError` and stopping the run. A discovered one is a model's guess, and
 * "stop the loop for a human" is the wrong price for a guess — so the guess is
 * dropped and logged instead.
 *
 * Probes through `bash -c` rather than the host shell's own builtins: `command`
 * is a POSIX shell builtin, and Bun's `$` (the OpenCode host) implements only a
 * subset of builtins — a probe it could not parse would report "missing" for
 * every binary and silently delete the whole feature on that host. `BIN_RE`
 * gates what may be interpolated; an unusual binary name is left un-probed
 * rather than shell-escaped, since a false "missing" costs more than a 127.
 * Impure over `Shell` only.
 */
export const resolvableChecks = async (
  $: Shell,
  defs: readonly CheckDef[],
  dir: string,
): Promise<{ runnable: CheckDef[]; missing: RejectedCheck[] }> => {
  const runnable: CheckDef[] = []
  const missing: RejectedCheck[] = []
  const resolved = new Map<string, boolean>()
  for (const def of defs) {
    let ok = true
    let absent = ""
    for (const bin of commandBinaries(def.command)) {
      if (!BIN_RE.test(bin)) continue
      let found = resolved.get(bin)
      if (found === undefined) {
        const out = await $`${{ raw: `bash -c 'command -v ${bin} >/dev/null 2>&1'` }}`.cwd(dir).quiet().nothrow()
        found = out.exitCode === 0
        resolved.set(bin, found)
      }
      if (!found) {
        ok = false
        absent = bin
        break
      }
    }
    if (ok) runnable.push(def)
    else missing.push({ name: def.name, reason: `"${absent}" is not installed here` })
  }
  return { runnable, missing }
}

/** Where a stage's check commands came from. */
export type ChecksSource = "config" | "manifest" | "discovered" | "none"

export interface ResolvedChecks {
  readonly defs: readonly CheckDef[]
  readonly source: ChecksSource
  /** Human-facing lines the host logs at `warn`; never empty-but-meaningful. */
  readonly warnings: readonly string[]
}

const NO_CHECKS: ResolvedChecks = { defs: [], source: "none", warnings: [] }

/**
 * The ONE seam both hosts call to decide what a check stage runs.
 *
 * Precedence is config → manifest → discovered → none, and discovery is only
 * REACHED when the first two are empty: a user who wrote `stageChecks` said
 * "these are my project's checks", and `stageChecks: { verify: [] }` says
 * "…and there are none", which must suppress discovery too or the opt-out would
 * not be one.
 *
 * Never throws. Every failure — no plan, no block, bad JSON, an inadmissible
 * command, a missing binary — degrades to fewer checks (at worst zero, today's
 * behavior) plus a warning, never to a park refusal and never to a stop.
 */
export const resolveStageChecks = async (args: {
  readonly $: Shell
  readonly config: Config
  readonly kind: string
  readonly def: StageDef
  readonly plan: string | undefined
  readonly dir: string
}): Promise<ResolvedChecks> => {
  const { $, config, kind, def, plan, dir } = args
  // Every branch returns through `checksFor`, so the precedence rule lives in
  // exactly one place and this module cannot drift from it.
  if (configuredChecks(config, kind, def)) return { defs: checksFor(config, kind, def), source: "config", warnings: [] }
  if (def.checks.length) return { defs: checksFor(config, kind, def), source: "manifest", warnings: [] }
  if (!discoverChecksFor(config, kind, def) || !plan) return NO_CHECKS
  try {
    const { defs, issues } = parseDiscoveredChecks(plan)
    if (!defs.length) return { ...NO_CHECKS, warnings: issues }
    const { accepted, rejected } = admissibleChecks(defs, effectiveAllowlist(def, platformFor(config, kind)))
    const { runnable, missing } = await resolvableChecks($, accepted, dir)
    const warnings = [
      ...issues,
      ...rejected.map((r) => `discovered check "${r.name}" refused: ${r.reason}`),
      ...missing.map((m) => `discovered check "${m.name}" skipped: ${m.reason}`),
    ]
    return runnable.length ? { defs: checksFor(config, kind, def, runnable), source: "discovered", warnings } : { ...NO_CHECKS, warnings }
  } catch (e) {
    // Discovery is an enhancement over "no checks"; a bug in it must never be
    // the thing that stops a run.
    return { ...NO_CHECKS, warnings: [`check discovery failed: ${e instanceof Error ? e.message : String(e)}`] }
  }
}
