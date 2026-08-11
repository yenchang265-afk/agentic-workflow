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

import { CheckDefSchema, effectiveAllowlist, type CheckDef, type StageDef, type WorkflowManifest } from "../manifest/schema.js"
import { commandAllowed, chainedGithubPrMutation, chainedGitPushViolation, isBareCd, splitSegments } from "../task/write-backstop.js"
import { bashAllowlistExtras, bashAllowlistPrefixes, checksFor, configuredChecks, discoverChecksFor, platformFor, withCommandPrefixes } from "../config.js"
import type { Config } from "./state.js"
import type { Shell } from "../host.js"

/**
 * The check stage that consumes a discovered `agentic-checks` block, if any —
 * which is also what tells the plan-writing stage to emit one.
 *
 * A manifest-level question, not a stage-level one: the flag sits on the
 * CONSUMER (verify) while the block has to be written by the PLAN stage, so
 * `composeStagePrompt` cannot derive it from its `def` the way it derives
 * `mode` and `visualize`. Exported (and re-exported by `engine.ts`, where it
 * used to live) so the hub's creator preview asks the same question of its
 * unsaved manifest — a preview that skipped it would render a plan prompt the
 * loop does not send. Lives here beside the grammar so the park-time preview
 * below cannot import it from `engine.ts`, which imports this module. `config`
 * optional, and consulted only when given, so a config with nothing set
 * composes byte-identically to none. Pure.
 */
export const discoveringStage = (manifest: WorkflowManifest, config?: Config): string | undefined =>
  manifest.stages.find((s) => s.kind === "check" && (config ? discoverChecksFor(config, manifest.kind, s) : s.discoverChecks))?.name

/** The fenced-block info string PLAN writes its discovered commands under. */
export const CHECKS_FENCE = "agentic-checks"

/**
 * Most discovered checks honored. A cap, not a preference: every check costs the
 * loop a full command run on every check-stage firing, and a plan that lists a
 * dozen is a plan that guessed.
 *
 * 8, not 5. Five was picked against a single-ecosystem repo and is exactly what
 * a polyglot one needs before it starts losing checks silently: a front end's
 * test / typecheck / lint beside a service's build and test is five already, and
 * an e2e suite makes six. 8 matches `FANOUT_MAX`, which bounds the other
 * per-stage cost multiplier for the same reason, and still catches the runaway
 * shape this exists for. Raising it further would want a real cost budget, not a
 * bigger number.
 */
export const MAX_DISCOVERED_CHECKS = 8

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
 * its parser cannot drift.
 *
 * It names WHERE to look, CI config first, because the alternative to a guess is
 * not a better guess — it is a source. A repo's CI workflow is the command set
 * the project already enforces on every push, so a plan that copies from it
 * needs almost no human judgement at the gate, and the expensive failure mode
 * (a conventional-looking `npm test` on a repo with no such script, which exits
 * 1 and reads as a real test failure) cannot arise from a command that was read
 * rather than assumed. Ordering only — never a table of commands per ecosystem,
 * which would be wrong for every repo it did not anticipate. Pure.
 */
export const checkDiscoveryBlock = (planStage: string, consumer: string): string =>
  [
    `CHECK DISCOVERY: inside the \`### Verification\` subsection, the ${planStage} stage's plan SHOULD end with a`,
    // The info string is SPELLED OUT rather than shown as a literal fence. A
    // rendered ```` ```agentic-checks ```` inside a one-line instruction cannot be
    // written without either opening a fence in the prompt or leaving a stray
    // backtick beside the name — and a model that copies the stray one produces an
    // info string `FENCE_RE` does not match, so the block parses as absent: zero
    // checks with NO warning, the one silent degradation this module forbids.
    `fenced code block whose info string is exactly ${CHECKS_FENCE} (three backticks, then that word, nothing else on the line),`,
    "holding a JSON array of the commands that prove this task's work —",
    'shape: [{ "name": "tests", "command": "npm run test:all", "cwd": "packages/web" }] ("cwd" optional, work-tree-relative).',
    `The loop runs these ITSELF before the ${consumer.toUpperCase()} stage, in the work tree, and their exit codes`,
    `become established fact that the ${consumer.toUpperCase()} agent cannot argue down — which is the whole point:`,
    "it replaces a self-reported \"tests are green\" with a number.",
    "Take them from what this repo ALREADY declares, in this order of authority:",
    "(1) its CI workflow definition (`.github/workflows/*.yml`, `.gitlab-ci.yml`, `azure-pipelines.yml`, `.circleci/config.yml`) —",
    "the strongest source, because those are the commands the project already enforces on every push;",
    "(2) its agent instructions (`AGENTS.md`, `CLAUDE.md`) where they name the check commands;",
    "(3) the scripts or targets its package manifest declares.",
    "Take only the test/typecheck/lint/build steps — a CI job's checkout, dependency install, deploy, publish,",
    "or release steps are not this task's proof, and its matrix may run one command many ways where you want it once.",
    "Only list a command whose definition you have READ — name the file and the script, target, or job that defines it,",
    "in the prose above the block. Do not guess a conventional command:",
    "`npm test` on a repo whose package.json defines no `test` script exits 1 and reads as a genuine test failure,",
    "which sends the loop back to BUILD to fix work that was never broken.",
    "Every command must TERMINATE on its own. A dev server, a `--watch` runner, or anything that waits for input",
    "never returns: the loop waits out its timeout and records exit 124, which is an ERROR that stops the run for a human.",
    "To prove runtime behaviour, list the command that exercises it and exits — an e2e or integration run that starts",
    "and stops the server itself — never the serve command.",
    `At most ${MAX_DISCOVERED_CHECKS} commands, each on the ${consumer.toUpperCase()} stage's own bash allowlist —`,
    "anything else is dropped with a warning, and a command whose binary is not installed here is dropped too.",
    'Add "timeoutMinutes" to a command the project runs long (an integration or e2e suite): the default cap fits a',
    "unit-test run, and one slow command in the list must not force every fast one to share its budget.",
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
 * Seven independent rules, each with its own rejection reason so a warning names
 * the actual problem.
 *
 * `maxTimeoutMinutes` bounds a discovered `timeoutMinutes`: the field is what
 * lets a long integration suite outlive the default cap, which also makes it the
 * one field a hostile block could use to park the driver on a command for a day.
 * A check may not outlive the stage it belongs to, so the stage's own wall-clock
 * cap is the ceiling. Rejected rather than clamped: clamping would run something
 * other than what the plan says, and the plan is the record. Pure.
 */
export const admissibleChecks = (
  defs: readonly CheckDef[],
  globs: readonly string[],
  maxTimeoutMinutes: number,
  prefixes: readonly string[] = [],
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
    if (backgroundsItself(def.command)) {
      rejected.push({ name: def.name, reason: "the command backgrounds itself with `&` — a check must run in the foreground and exit, or the loop records the shell's exit 0 as a pass" })
      continue
    }
    if (splitSegments(def.command).every(isBareCd)) {
      // `commandAllowed` counts a bare `cd` as an allowed segment (it must, for
      // the `cd <dir> && <runner>` compound) and `commandBinaries` probes
      // nothing for it — so a cd-only command would pass every later gate, run,
      // exit 0, and fabricate a green "established fact" out of nothing.
      rejected.push({ name: def.name, reason: "the command runs nothing — every segment is a bare `cd`, so the shell exits 0 and the check records a pass it never earned" })
      continue
    }
    const climb = escapingCdTarget(def.command)
    if (climb !== null) {
      // The same escape `safeCwd` closes for the `cwd` FIELD, via the command
      // instead: `commandAllowed` must accept a bare `cd` (the sanctioned
      // `cd <dir> && <runner>` compound), so without this screen
      // `cd ../.. && npm test` ran OUTSIDE the tree the consuming stage's own
      // agent is pinned to (worktree-guard blocks exactly this walk) — the
      // trust boundary this module claims. Conservative like the rest of this
      // list: `..` anywhere is refused even where a preceding `cd` might make
      // it safe — a check that needs a subdirectory names `cwd` instead.
      rejected.push({ name: def.name, reason: `the command's \`cd ${climb}\` can leave the work tree — a check runs inside it; use a work-tree-relative directory (or the "cwd" field)` })
      continue
    }
    if (chainedGithubPrMutation(def.command, prefixes) || chainedGitPushViolation(def.command, prefixes)) {
      rejected.push({ name: def.name, reason: "the command mutates a pull request or pushes a branch" })
      continue
    }
    if (!commandAllowed(def.command, globs)) {
      rejected.push({ name: def.name, reason: `"${def.command}" is not on this stage's bash allowlist` })
      continue
    }
    if (def.timeoutMinutes !== undefined && def.timeoutMinutes > maxTimeoutMinutes) {
      rejected.push({
        name: def.name,
        reason:
          `timeoutMinutes ${def.timeoutMinutes} exceeds this stage's own cap of ${maxTimeoutMinutes} — ` +
          "raise stageTimeoutMinutes, or pin the command in stageChecks where the cap does not apply",
      })
      continue
    }
    accepted.push(def)
  }
  return { accepted, rejected }
}

/**
 * The first `cd` target in `command` that could climb out of the work tree, or
 * null when every one stays inside. Absolute paths, `~`, and any `..` path
 * segment are escapes; quotes are stripped so `cd "../x"` cannot smuggle one.
 * Judged per target rather than by resolving the walk: a check that genuinely
 * needs another directory has the `cwd` field, and a false refusal here costs
 * one named warning where a false pass runs repo-authored commands outside the
 * tree. Pure.
 */
export const escapingCdTarget = (command: string): string | null => {
  for (const seg of splitSegments(command)) {
    if (!isBareCd(seg)) continue
    const target = seg.trim().replace(/^cd\s+/, "")
    const bare = target.replace(/["']/g, "")
    if (bare.startsWith("/") || bare.startsWith("~") || bare.split("/").some((s) => s === "..")) return target
  }
  return null
}

/**
 * Whether any part of the command is BACKGROUNDED with a lone `&`.
 *
 * The one shape that defeats "a check must terminate" by satisfying it. A
 * driver-run `npm run dev &` returns immediately with the SHELL's exit 0, so
 * `classifyExit` reads PASS and the stage prompt renders it as an established
 * fact the agent is told not to re-run or argue with — a manufactured "the
 * server serves" with more authority than the self-report this whole feature
 * replaced, plus one orphaned process per iteration. `commandAllowed` cannot
 * catch it: `splitSegments` treats the lone `&` as an operator, so the segment
 * it matches is a plain `npm run dev`.
 *
 * Applied to DISCOVERED commands only, and deliberately not mirrored into
 * `commandAllowed` or its hook twin: an AGENT that backgrounds something loses
 * the output and gains no verdict, while a driver-run one becomes the verdict.
 *
 * Quote-aware like `hasShellExpansion`, and `&&` is skipped as the chain
 * operator it is. Residual: `|&` reads as backgrounding and is refused —
 * fail-safe, and no check needs it. Pure.
 */
export const backgroundsItself = (command: string): boolean => {
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if (c === "&") {
      if (command[i + 1] === "&") {
        i++
        continue
      }
      return true
    }
  }
  return false
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

/**
 * Whether the plan carries an `agentic-checks` fence at all. Needed because
 * `parseDiscoveredChecks` returns `{defs: [], issues: []}` identically for "no
 * fence" and for a valid empty block — and the two mean opposite things to a
 * human reading a park note: "the plan declares no checks" versus "the block
 * admitted nothing". Pure.
 */
export const hasChecksFence = (planText: string): boolean => [...planText.matchAll(FENCE_RE)].length > 0

/** What the park-time preview tells the human about the plan's checks fence. */
export interface ChecksPreview {
  /** The check stage that will consume the block (e.g. "verify"). */
  readonly consumer: string
  readonly fencePresent: boolean
  /** How many commands the consumer will actually run. */
  readonly admitted: number
  /** Parse issues + admission refusals, each naming its reason. */
  readonly issues: readonly string[]
}

/**
 * A PURE preview of what `resolveStageChecks` will decide at the consuming
 * stage's fire time — computed at PLAN park so the refusals surface on the
 * gate the human is already reading, not one gate too late in a `log("warn")`
 * nobody watches. Deliberately NOT probing binaries (`resolvableChecks`): the
 * park must never slow or fail on shell probes, and the park-time environment
 * is the main tree while the checks will run in a not-yet-created worktree —
 * a probe result here would be a lie about the consumer's environment.
 *
 * `null` when the preview has nothing to say: no discovering check stage, or
 * config/manifest checks preempt discovery entirely (then the fence is
 * irrelevant and a warning about it would be noise). The admission arguments
 * are kept textually adjacent to `resolveStageChecks` below so the two cannot
 * drift. Pure.
 */
export const previewDiscoveredChecks = (manifest: WorkflowManifest, config: Config, plan: string): ChecksPreview | null => {
  // Tolerant of a partial manifest for the same reason runPark's stage lookup
  // is (`stages?.find` there): a park must always reach its claim release,
  // never crash out of runTerminal on a manifest/state mismatch.
  if (!Array.isArray(manifest.stages)) return null
  const consumer = discoveringStage(manifest, config)
  if (!consumer) return null
  const def = manifest.stages.find((s) => s.name === consumer)
  if (!def) return null
  if (configuredChecks(config, manifest.kind, def) || def.checks.length) return null
  if (!hasChecksFence(plan)) return { consumer, fencePresent: false, admitted: 0, issues: [] }
  const { defs, issues } = parseDiscoveredChecks(plan)
  // Same allowlist + timeout + prefix arguments `resolveStageChecks` passes at
  // fire time — a preview admitting differently from the fire is worse than
  // no preview at all.
  const { accepted, rejected } = admissibleChecks(
    defs,
    withCommandPrefixes(
      [...effectiveAllowlist(def, platformFor(config, manifest.kind)), ...bashAllowlistExtras(config)],
      bashAllowlistPrefixes(config),
    ),
    def.timeoutMinutes ?? config.stageTimeoutMinutes,
    bashAllowlistPrefixes(config),
  )
  return {
    consumer,
    fencePresent: true,
    admitted: accepted.length,
    issues: [...issues, ...rejected.map((r) => `discovered check "${r.name}" refused: ${r.reason}`)],
  }
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
    // `bashAllowlistExtra` counts here too: a project whose runner is only
    // reachable through an extra glob must be able to discover checks for it.
    // So does `bashAllowlistPrefix` — under a rewriting proxy the plan names
    // the prefixed form, and admission has to recognize the same command the
    // stage's own agent would be allowed to run.
    const { accepted, rejected } = admissibleChecks(
      defs,
      withCommandPrefixes(
        [...effectiveAllowlist(def, platformFor(config, kind)), ...bashAllowlistExtras(config)],
        bashAllowlistPrefixes(config),
      ),
      def.timeoutMinutes ?? config.stageTimeoutMinutes,
      bashAllowlistPrefixes(config),
    )
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
