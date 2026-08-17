/**
 * Dependencies DECLARED by the PLAN stage, frozen in the plan document.
 *
 * A plan that names a package prescribes an install the BUILD stage will
 * attempt. Nothing checks that the package is reachable, so on a repo pointed
 * at an internal mirror (`registry=` in `.npmrc`, a `<mirror>` in
 * `settings.xml`, an `index-url` in `pip.conf`) a plan can prescribe a package
 * the mirror does not carry, or a version that never existed behind it. The
 * loop finds out at `pnpm add` time, one BUILD in — and with `maxIterations`
 * defaulting to 3, one such line burns a third of the budget re-building work
 * that was never broken.
 *
 * The cause is not carelessness, it is that the plan author is given no way to
 * check: engineering's PLAN declares no `bashAllowlist`, and the persona sets
 * `permission: {bash: deny}` with Claude/Qwen granting only `Read/Grep/Glob/
 * Write`. No shell, no network, on any host. So a version in a plan can only
 * come from the model's memory — which is exactly the training-shaped guess
 * that names a public-registry package behind a corporate firewall.
 *
 * The remedy is `discovered-checks.ts`'s, one noun over, and it inherits that
 * module's three rules verbatim:
 *
 *  - **Name the SOURCE, never the answer.** No table of approved packages and
 *    no per-ecosystem probe commands in any manifest. 18 rejected a command
 *    table as "a table of guesses about repos it has not seen"; a package
 *    allowlist is the same object, and would be wrong in every shop but the one
 *    it was written for. The plan cites the lockfile line it read and the
 *    registry config it read, and the mirror's identity comes from the repo.
 *  - **Frozen, not re-derived.** The declaration lands as text in the plan
 *    document, which `entryState` re-extracts at claim time, so every
 *    BUILD→VERIFY→BUILD iteration reads a byte-identical set. Only `replan`
 *    changes it.
 *  - **Degrade to fewer guarantees plus a warning.** Never a park refusal,
 *    never a stop. A missing block, malformed JSON, or a bug in here costs the
 *    forecast and nothing else — the park proceeds exactly as it does today.
 *
 * What this does NOT claim: it is not a supply-chain control. A declaration is
 * the plan author's account of what it read, and the human plan gate is what
 * reads it. The value is that an unprovable dependency is now VISIBLE at that
 * gate as unprovable, instead of being indistinguishable from a proven one
 * until BUILD fails.
 *
 * Everything here is pure.
 */

import { z } from "zod"

/** The fenced-block info string PLAN writes its dependency declaration under. */
export const DEPS_FENCE = "agentic-deps"

/**
 * Most declared dependencies honored.
 *
 * Deliberately NOT `MAX_DISCOVERED_CHECKS`'s 8. That cap bounds a per-firing
 * COST — every discovered check is a command the loop runs on every check-stage
 * pass — so a low ceiling is the right instrument there. This block costs
 * nothing to carry: it is parsed once at park and rendered onto one line. The
 * only pressure is readability, and readability is bounded at the RENDER
 * (`MAX_NAMED_DEPS`), where clamping loses nothing, instead of at the parse,
 * where dropping an entry would silently discard the very declaration a human
 * needed to see. 20 is set to sit above any plan a single reviewable slice
 * produces, so the drop path is a runaway-block backstop rather than a limit
 * real plans meet.
 */
export const MAX_DECLARED_DEPS = 20

/**
 * Most dependency NAMES spelled out in the one-line park summary before it
 * collapses to a count.
 *
 * The suffix shares a single `> …` audit-note line with the checks forecast, so
 * an unbounded list runs that line off the terminal and, worse, pushes the
 * bracketed stamp far enough right that a human stops reading before it. Three
 * names is what fits beside the checks half while still answering "which one?",
 * which is the entire question this line exists to answer.
 */
const MAX_NAMED_DEPS = 3

/** Longest package name honored — well past every real registry's own limit. */
const MAX_DEP_NAME = 214

/**
 * `name`, `ecosystem` and `version` are rendered into the park message, the
 * audit note and the gate's caveats with no untrusted-data fence around them,
 * and the plan document is REPO CONTENT — a merely-cloned repo can ship a task
 * file carrying an `## Implementation Plan`. So they get character classes
 * rather than length checks, the same reasoning `NAME_RE` carries in
 * `discovered-checks.ts`.
 *
 * The class is deliberately wide enough for every real package identifier —
 * npm scopes (`@scope/pkg`), Maven coordinates (`group:artifact`), Python
 * extras (`pkg[extra]`) — and no wider. Anything outside it is dropped with a
 * reason rather than sanitized: a silently rewritten package name in a gate
 * line is a worse artifact than an absent one.
 */
const DEP_NAME_RE = /^[@A-Za-z0-9][A-Za-z0-9._\-/:[\]]{0,213}$/

/** An ecosystem label. Free-form by design — the plan discovers it, we do not enumerate it. */
const ECOSYSTEM_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,31}$/

/**
 * A version, or a range. Not semver-validated: Maven ranges, Python specifiers
 * and npm dist-tags are all legitimate here and a semver parser would drop
 * them. The class exists for the injection surface only.
 */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9 .,()[\]|<>=^~*+_-]{0,63}$/

/**
 * Evidence is prose the author wrote — a `file:line` citation for a proven
 * dependency, a reason for an unproven one. It reaches the same unfenced
 * surfaces as the fields above, so it is length-bounded AND stripped of the
 * characters that could break out of a one-line audit note.
 *
 * Newlines especially: `oneLineReason` exists because a newline in a gate
 * reason detaches the audit note's bracketed stamp and blinds every last-note
 * parser (`extractReplanReason`, `extractRunBranch`, `extractStopContext`).
 * The same hazard applies to anything this module lets into that line, so the
 * flattening happens HERE, at the parse, rather than at each render site.
 */
const MAX_EVIDENCE = 200

/** The declared status of one dependency, as the plan author assessed it. */
export const DEP_STATUSES = ["existing", "new", "unverified"] as const
export type DepStatus = (typeof DEP_STATUSES)[number]

/**
 * One dependency the plan turns on.
 *
 * `status` is the plan author's own assessment and the whole point of the
 * block:
 *  - `existing` — already in the repo's lockfile or package manifest, cited.
 *    The cheapest and the only one guaranteed installable behind a mirror.
 *  - `new` — not currently present, but the author proved it resolves in the
 *    registry the repo is configured against, and says how.
 *  - `unverified` — the author could not prove it. This is the value-bearing
 *    case: it is what a human at the plan gate needs to see, and what BUILD
 *    would otherwise discover by failing.
 */
export const DepDeclSchema = z
  .object({
    name: z.string().regex(DEP_NAME_RE).max(MAX_DEP_NAME),
    ecosystem: z.string().regex(ECOSYSTEM_RE),
    // Optional, and legitimately so on a `new` or `unverified` entry: a plan
    // that cannot name a resolvable version must be able to SAY that rather
    // than invent one, which is the exact failure this module exists to stop.
    version: z.string().regex(VERSION_RE).optional(),
    status: z.enum(DEP_STATUSES),
    /**
     * The registry the repo is configured against, as the author read it.
     *
     * A field rather than prose because prose is unauditable at the gate: with
     * this, the park line can say `registry: none cited`, which on a repo
     * behind an internal mirror is the single most useful thing it can report —
     * a plan that never looked at `.npmrc` is a plan reasoning about the public
     * registry, and that is precisely the wrong answer here.
     */
    registry: z.string().max(MAX_EVIDENCE).optional(),
    evidence: z.string().max(MAX_EVIDENCE),
  })
  .strict()

export type DepDecl = z.infer<typeof DepDeclSchema>

/** The LAST fence wins — same rule `FENCE_RE` uses for stacked plan headings. */
const FENCE_RE = /^[ \t]*```[ \t]*agentic-deps[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm

/**
 * The dependency contract appended to a `planContract` stage's prompt.
 *
 * A SEPARATE composed block rather than a fourth clause inside
 * `planContractBlock`, for two reasons that both live in that function's own
 * rationale. First, its `### Verification` clause is the one heading `runPark`
 * enforces, and `hasVerificationSection` documents why that enforcement is kept
 * deliberately tolerant: "the failure mode of strictness is a livelock — every
 * refusal releases the claim and re-queues, and a model that persistently
 * misses an exact-match string burns a PLAN run per tick." A second enforced
 * heading would double that surface to buy nothing. `### Dependencies` is
 * agent-judged and omittable, the posture `planVisualizationBlock` takes.
 * Second, the section-vocabulary collision design 24 had to fix was between the
 * PERSONA's words and the CONTRACT's words, not a count of sections; it stays
 * closed by naming the heading verbatim in both places.
 *
 * Composed onto the prompt rather than written into `stages/plan.md` for
 * `planContractBlock`'s stated reason: a contract stated only in a template or
 * a persona file is skippable, one appended mechanically at composition
 * survives every dispatch path. Kept beside `parseDeclaredDeps` so the grammar
 * and its parser cannot drift. Pure.
 */
export const dependencyContractBlock = (planStage: string): string =>
  [
    `DEPENDENCY CONTRACT: when this task turns on any third-party dependency, the ${planStage} stage's plan MUST carry a`,
    "`### Dependencies` subsection. Work in this order, and say which tier you landed on and why the cheaper ones were rejected:",
    "(1) a dependency ALREADY in this repo's lockfile or package manifest; (2) the language's standard library;",
    "(3) something new. Tier 1 is not merely cheapest — on a repo pointed at an internal mirror it is the only tier",
    "guaranteed installable, so reaching tier 3 for something tier 1 already covers is how a plan becomes unbuildable.",
    "CITE, NEVER REMEMBER: give each dependency's version as you READ it — from the lockfile, the package manifest,",
    "`pom.xml`, `requirements.txt`, a vendored directory — and name that file and line in the prose.",
    "A version you recall rather than read is the specific failure this contract exists to stop: it is drawn from",
    "public-registry knowledge, and a repo behind an internal mirror may carry neither that package nor that version.",
    "For anything NOT already present, first read where this repo's toolchain actually resolves from",
    "(`.npmrc`, `.yarnrc.yml`, `settings.xml`, `pip.conf`, `Cargo.toml`'s source replacement, `go.mod`'s GOPROXY notes,",
    "or whatever its ecosystem uses), name that registry in the prose, and cite the file you read it from.",
    "If this repo pins an internal mirror, say so — a plan that assumes the public registry on such a repo is already wrong.",
    "You have no shell and no network here, so where you CANNOT prove a dependency resolves, say exactly that",
    'and mark it "unverified" with the reason. Do not promote a guess to a fact: an unverified dependency the human sees',
    "at the plan gate costs one line, and the same dependency discovered at BUILD costs an iteration.",
    `End the subsection with a fenced code block whose info string is exactly ${DEPS_FENCE}`,
    // The info string is SPELLED OUT rather than rendered, for the reason
    // `checkDiscoveryBlock` gives: a literal fence inside a one-line
    // instruction either opens a fence in the prompt or leaves a stray
    // backtick beside the name, and a model that copies the stray one produces
    // an info string `FENCE_RE` does not match — so the block parses as absent,
    // which is the one silent degradation this module forbids.
    "(three backticks, then that word, nothing else on the line), holding a JSON array —",
    'shape: [{ "name": "zod", "ecosystem": "npm", "version": "3.23.8", "status": "existing", "evidence": "pnpm-lock.yaml:1204" }].',
    '"status" is one of "existing" (present in this repo already, evidence cites where),',
    '"new" (absent, and evidence says what you read that says this repo can resolve it),',
    'or "unverified" (you could not establish it, evidence says why).',
    'Carry "registry" on every entry that is not already present, holding the registry you read for that ecosystem;',
    'put the file you read it from in "evidence".',
    '"version" may be omitted when you cannot name one you actually read — that is the honest answer, and inventing one is not.',
    `At most ${MAX_DECLARED_DEPS} entries.`,
    "The loop does not install anything from this block and does not refuse a plan over it; it is read by the human",
    "at the plan gate, who is the one who knows what this organisation's mirror carries.",
    "Omit the subsection and the block entirely when the task adds no dependency — say nothing rather than declaring an empty list.",
  ].join(" ")

/** One declared dependency the loop refused, and why. */
export interface RejectedDep {
  readonly name: string
  readonly reason: string
}

/**
 * Flatten evidence to something an audit note can hold on one line.
 *
 * The note's shape is `> … [stamp]`, and `AUDIT_NOTE_LINE_RE` stops matching
 * the moment a newline lands inside it — after which the orphaned lines read as
 * plan PROSE and the last-note parsers go blind. `oneLineReason` closes that
 * for gate reasons; this closes it for the other text that reaches the same
 * line. Backticks go too: evidence is rendered inside a message that already
 * uses them as delimiters. Pure.
 */
const flattenEvidence = (s: string): string =>
  s
    .replace(/[\r\n`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

/**
 * The declarations in the plan's last `agentic-deps` fence, plus what was
 * dropped.
 *
 * Never throws and never returns a partial entry: a malformed block degrades to
 * zero declarations, which is exactly today's behavior, rather than to a stop.
 * Pure.
 */
export const parseDeclaredDeps = (planText: string): { deps: DepDecl[]; issues: string[] } => {
  const matches = [...planText.matchAll(FENCE_RE)]
  const last = matches[matches.length - 1]
  if (!last) return { deps: [], issues: [] }
  let raw: unknown
  try {
    raw = JSON.parse(last[1] ?? "")
  } catch (e) {
    return { deps: [], issues: [`the ${DEPS_FENCE} block is not valid JSON (${e instanceof Error ? e.message : String(e)})`] }
  }
  const parsed = DepDeclSchema.array().safeParse(raw)
  if (!parsed.success) {
    return {
      deps: [],
      issues: [`the ${DEPS_FENCE} block does not match the dependency shape ({ name, ecosystem, version?, status, evidence })`],
    }
  }
  const issues: string[] = []
  const seen = new Set<string>()
  const deps: DepDecl[] = []
  for (const dep of parsed.data) {
    // Keyed by name AND ecosystem: `pkg` on npm and `pkg` on pypi are different
    // packages, and collapsing them would hide one behind the other in the very
    // line this block exists to produce. Same reasoning as `depKey`'s digest in
    // `source/dependency-scan.ts`, one scope down.
    //
    // The separator is an ESCAPED NUL, never a raw one. Escaped because
    // `scripts/source-control-chars.test.mjs` refuses a raw control character in
    // shipped source — git stops treating the file as textual, and greps then
    // silently miss every symbol in it. NUL because neither character class
    // admits one, so two halves can never re-parse into a different pair.
    const key = `${dep.ecosystem.trim().toLowerCase()}\u0000${dep.name.trim().toLowerCase()}`
    if (seen.has(key)) {
      issues.push(`declared dependency "${dep.name}" dropped: duplicate name for ecosystem "${dep.ecosystem}"`)
      continue
    }
    if (deps.length >= MAX_DECLARED_DEPS) {
      issues.push(`declared dependency "${dep.name}" dropped: more than ${MAX_DECLARED_DEPS} dependencies declared`)
      continue
    }
    seen.add(key)
    // Both free-text fields flattened at the PARSE, not at each render site:
    // every one of them reaches the single-line audit note, and a module that
    // flattens in three places eventually grows a fourth that forgets.
    deps.push({
      ...dep,
      evidence: flattenEvidence(dep.evidence),
      ...(dep.registry === undefined ? {} : { registry: flattenEvidence(dep.registry) }),
    })
  }
  return { deps, issues }
}

/**
 * Whether the plan carries an `agentic-deps` fence at all.
 *
 * Needed for `hasChecksFence`'s reason: the parser returns `{deps: [], issues:
 * []}` identically for "no fence" and for a valid empty block, and the two mean
 * opposite things to a human reading a park note — "this plan never considered
 * dependencies" versus "this plan considered them and adds none". Pure.
 */
export const hasDepsFence = (planText: string): boolean => [...planText.matchAll(FENCE_RE)].length > 0

/** What the park-time preview tells the human about the plan's dependency block. */
export interface DepsPreview {
  readonly fencePresent: boolean
  readonly existing: number
  readonly added: number
  /** The entries the plan itself could not prove — the value-bearing case. */
  readonly unverified: readonly DepDecl[]
  /** Whether every entry being FETCHED names the registry it was resolved against. */
  readonly registryCited: boolean
  /** Parse issues, each naming its reason. */
  readonly issues: readonly string[]
}

/**
 * A PURE preview of what the plan declares about its dependencies, computed at
 * PLAN park so it surfaces on the gate the human is already reading.
 *
 * `null` when the plan says nothing about dependencies at all — no fence. That
 * is the overwhelmingly common case (most tasks add none), and a line saying
 * "no dependency block" on every one of them would train the reader to skip the
 * whole suffix, taking the checks forecast down with it. This differs
 * deliberately from `previewDiscoveredChecks`, which DOES report its absent
 * fence: a missing checks block means a stage will run zero checks, which is a
 * loss; a missing deps block usually means there was nothing to declare.
 *
 * Deliberately NOT probing any registry: the park must never slow or fail on a
 * shell probe, and the whole point of `unverified` is that the plan author
 * already said it could not prove this. Pure.
 */
export const previewDeclaredDeps = (plan: string): DepsPreview | null => {
  if (!hasDepsFence(plan)) return null
  const { deps, issues } = parseDeclaredDeps(plan)
  const added = deps.filter((d) => d.status === "new")
  return {
    fencePresent: true,
    existing: deps.filter((d) => d.status === "existing").length,
    added: added.length,
    unverified: deps.filter((d) => d.status === "unverified"),
    // Only entries the repo does not already have need a registry: an
    // `existing` one resolves from the lockfile whatever the mirror says. So an
    // uncited registry is only worth reporting when something is actually being
    // fetched.
    registryCited: added.every((d) => !!d.registry),
    issues,
  }
}

/** Longest dependency suffix rendered onto a park note — `clampedChecksDetail`'s bound, for its reason. */
const MAX_DEPS_DETAIL = 300

/**
 * The one-line dependency summary suffixed onto the park note and the park
 * message, or `""` when there is nothing to say.
 *
 * Named entries, not just a count: "1 unverified" sends the human back to the
 * task file to find out which, and the entire value of this forecast is that
 * the answer fits on the line they are already reading. Clamped for
 * `clampedChecksDetail`'s reason — the note is one line and an unbounded plan
 * would run it off the terminal. Pure.
 */
export const depsSummaryLine = (preview: DepsPreview | null): string => {
  if (!preview) return ""
  const parts: string[] = []
  if (preview.existing) parts.push(`${preview.existing} existing`)
  if (preview.added) parts.push(`${preview.added} new`)
  if (preview.unverified.length) parts.push(`${preview.unverified.length} UNVERIFIED (${namedList(preview.unverified)})`)
  if (preview.added && !preview.registryCited) {
    // Reported even when nothing is unverified: a plan that added a package
    // without ever reading where this repo resolves from reasoned about the
    // PUBLIC registry, and behind a mirror that is the wrong question answered
    // confidently — the shape a gate reader cannot otherwise detect.
    parts.push("no registry cited")
  }
  if (preview.issues.length) parts.push(`${preview.issues.length} malformed (${preview.issues.join("; ")})`)
  // A fence holding `[]` — the plan considered dependencies and adds none.
  // Distinct from no fence at all, which renders no line whatsoever; the two
  // mean opposite things and `hasDepsFence` exists to tell them apart.
  if (!parts.length) parts.push("none declared")
  const joined = parts.join(", ").replace(/\s+/g, " ").trim()
  return ` — dependencies: ${joined.length > MAX_DEPS_DETAIL ? `${joined.slice(0, MAX_DEPS_DETAIL)}…` : joined}`
}

/**
 * Up to `MAX_NAMED_DEPS` names, then a count of the rest.
 *
 * Names, not just a number: "1 unverified" sends the human back to the task
 * file to find out which, and the whole value of this forecast is that the
 * answer fits on the line they are already reading. Pure.
 */
const namedList = (deps: readonly DepDecl[]): string => {
  const shown = deps.slice(0, MAX_NAMED_DEPS).map((d) => (d.evidence ? `${d.name} — ${d.evidence}` : d.name))
  const rest = deps.length - shown.length
  return rest > 0 ? `${shown.join("; ")}; +${rest} more` : shown.join("; ")
}

/**
 * The `approvePlan` caveat for a plan resting on a dependency its own author
 * could not prove, or `undefined` when there is nothing to say.
 *
 * Kept here rather than in `gate.ts` for this module's standing rule — the
 * grammar, the prose that asks for it, and everything that renders it stay
 * textually adjacent or they drift. Warn-only at the call site, for
 * `approvePlan`'s stated reason: that gate is kind-agnostic and a refusal
 * strands the task with no verb better than the `replan` the human just
 * declined. Pure.
 */
export const unverifiedDepsCaveat = (planText: string): string | undefined => {
  const preview = previewDeclaredDeps(planText)
  if (!preview?.unverified.length) return undefined
  const n = preview.unverified.length
  const named = namedList(preview.unverified.map((d) => ({ ...d, evidence: "" })))
  return `the plan rests on ${n} dependenc${n === 1 ? "y" : "ies"} it could not establish (${named}) — confirm this environment can install ${n === 1 ? "it" : "them"} before BUILD tries`
}
