/**
 * Proof-of-work for a check stage's PASS.
 *
 * `requiredAxes` makes a *skipped* axis impossible; it cannot make a review
 * honest (see `AxisResult`'s note). Evidence is the next rung: a PASS must name
 * what the stage actually looked at, and — where the host can see it — that
 * claim is cross-checked against the tool calls the stage really made.
 *
 * Two channels, deliberately of different trust:
 *
 *  - **Declared** (`EvidenceItem[]`, from the `workflow_verdict` call) is the
 *    agent's own account. Same trust level as the verdict itself — it makes
 *    fabrication *explicit* and auditable, not impossible.
 *  - **Observed** (`ObservedEvidence`, from the host's tool guard) is recorded
 *    by the host as commands run and files read during the stage attempt. The
 *    agent never writes it, so it is the only channel that can contradict the
 *    declared one.
 *
 * The rule that uses both is deliberately loose (see `substantiated`): a false
 * rejection deadlocks a check stage into its retry budget and then ERROR-stops
 * the loop, which is a far worse failure than an over-generous match. This
 * catches the *wholly* unsubstantiated PASS — the fabrication mode that matters
 * — and does not pretend to catch a real command padded with an invented one.
 *
 * Driver-run check commands are a third input (`seeded`), deliberately weaker
 * than both: the DRIVER ran them, so they prove the stage attempt had real
 * work to trust — citing one is legitimate and they defeat the "did nothing"
 * rejection — but they are not the AGENT's work, so they cannot corroborate a
 * PASS on their own. Before they were split out they were merged straight into
 * `observed`, and a stage that ran nothing and read nothing could cite the
 * pre-run check command and pass the gate having observed nothing itself.
 *
 * Pure and dependency-free: hosts collect the observations, this decides.
 */

/**
 * One thing the stage claims to have observed. `kind` picks which observed
 * channel it is checked against; `result` is what the agent saw (free text,
 * never matched — it exists for the audit trail and the human gate).
 */
export interface EvidenceItem {
  /** `command` — a command it ran; `file` — a path (optionally `file:line`) it read. */
  readonly kind: "command" | "file"
  /** The command line, or the path/`path:line`. */
  readonly ref: string
  /** What it observed (e.g. "42 passed, 0 failed"). Never matched — audit only. */
  readonly result?: string
}

/**
 * What the host actually saw the stage do, gathered from its tool guard.
 *
 * `null` (rather than an empty `ObservedEvidence`) is how a host says "I do not
 * record this" — the two must not be confused, since empty means "the stage did
 * nothing" and rejects a PASS.
 */
export interface ObservedEvidence {
  /** Shell commands the guard admitted, in order. */
  readonly commands: readonly string[]
  /** Paths the stage read (Read/Grep/Glob and their per-host equivalents). */
  readonly reads: readonly string[]
}

/** An empty observation set — the shape a host starts a stage attempt with. */
export const NO_OBSERVATIONS: ObservedEvidence = { commands: [], reads: [] }

/**
 * What `admitVerdict` needs to judge a pass's evidence: whether this stage
 * demands it (manifest `requireEvidence`), and what the host saw.
 *
 * Passed by the host rather than derived, because only the host knows both — the
 * stage definition and its own observation channel. A host that records nothing
 * passes `observed: null` and gets the declared-evidence rule alone, which is
 * the honest degradation: the gate weakens, it does not silently vanish.
 */
export interface EvidenceContext {
  /** The check stage being admitted, for the rejection wording. */
  readonly stage: string
  /** Whether a PASS on this stage must cite evidence (manifest `requireEvidence`). */
  readonly required: boolean
  /** What the host observed this stage attempt do, or null when it does not record. */
  readonly observed: ObservedEvidence | null
  /**
   * Commands the DRIVER ran for this stage (`checkCommands`), established fact
   * the agent may cite but did not do. They defeat the "did nothing" rejection —
   * trusting them instead of re-running them is correct behavior — yet cannot
   * corroborate a PASS by themselves (`seededOnlyMessage`). Ignored when
   * `observed` is null: a host that does not record stays on the declared-only
   * rule rather than flipping into strict matching.
   */
  readonly seeded?: readonly string[]
}

/** Whether the host saw the stage do anything at all. Pure. */
export const observedNothing = (observed: ObservedEvidence): boolean =>
  observed.commands.length === 0 && observed.reads.length === 0

/** Commands are matched case-insensitively on collapsed whitespace. */
const normalizeCommand = (command: string): string => command.trim().toLowerCase().replace(/\s+/g, " ")

/** A normalized command's whitespace-separated tokens. */
const commandTokens = (command: string): string[] => normalizeCommand(command).split(" ").filter(Boolean)

/** Whether `needle` appears as a CONTIGUOUS run of tokens inside `hay`. Pure. */
const containsTokenRun = (hay: readonly string[], needle: readonly string[]): boolean => {
  if (!needle.length || needle.length > hay.length) return false
  for (let start = 0; start <= hay.length - needle.length; start++) {
    if (needle.every((tok, i) => hay[start + i] === tok)) return true
  }
  return false
}

/**
 * Whether two command strings describe the same command, in either direction.
 *
 * Containment rather than equality because the worktree pin rewrites a bare
 * `npm test` into `cd <worktree> && npm test` before it runs: the agent declares
 * what it typed, the host observes what executed, and neither is wrong.
 *
 * Containment over TOKENS, not characters. Raw substring containment had no
 * floor at all, in either direction: a declared `{ kind: "command", ref: "t" }`
 * was "corroborated" by an observed `npm test`, because `"npm test".includes("t")`.
 * One character satisfied a gate whose entire job is to make a PASS provable.
 * A contiguous token run keeps every case containment exists for —
 * `npm test` inside `cd <worktree> && npm test`, `npm test` inside
 * `npm test --silent` — while requiring the declared text to be a real part of
 * the real command rather than a letter that happens to occur in it.
 */
const commandMatches = (declared: string, observed: string): boolean => {
  const a = commandTokens(declared)
  const b = commandTokens(observed)
  if (!a.length || !b.length) return false
  return containsTokenRun(a, b) || containsTokenRun(b, a)
}

/** A path with its `:line[:col]` suffix and OS separators normalized away. */
const normalizePath = (ref: string): string =>
  ref
    .trim()
    .replace(/\\/g, "/")
    .replace(/:\d+(:\d+)?$/, "")
    .replace(/^\.\//, "")
    .toLowerCase()

/**
 * Whether two paths name the same file. One must be a path-segment suffix of the
 * other: the agent cites `src/foo.ts` while the host observes the absolute path
 * inside the loop's worktree, and a plain `endsWith` would also match
 * `other/notsrc/foo.ts`.
 */
const pathMatches = (declared: string, observed: string): boolean => {
  const a = normalizePath(declared)
  const b = normalizePath(observed)
  if (!a || !b) return false
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/**
 * Whether a command NAMED this path — matched per token, so the cited path has
 * to be an actual argument of the command.
 *
 * The old form asked whether the ref's basename appeared anywhere in the command
 * string, which is the same no-floor substring test `commandMatches` used to
 * have: a declared `{ kind: "file", ref: "e" }` matched an observed `npm test`.
 * Per-token `pathMatches` keeps what this is for — `cat src/foo.ts`,
 * `git diff -- src/foo.ts`, and the worktree-absolute rewrite of either — while
 * a token has to name the file, not merely contain its letters.
 */
const commandNamesPath = (ref: string, command: string): boolean =>
  commandTokens(command).some((token) => pathMatches(ref, token))

/**
 * Whether one declared item is corroborated by something the host observed.
 *
 * A `file` item also matches a command that names it (`cat src/foo.ts`,
 * `git diff -- src/foo.ts`): reading a file through the shell is reading it, and
 * rejecting that would push stages toward the tool that happens to be logged
 * rather than the one that fits.
 */
export const itemObserved = (item: EvidenceItem, observed: ObservedEvidence): boolean => {
  if (item.kind === "command") return observed.commands.some((c) => commandMatches(item.ref, c))
  if (observed.reads.some((r) => pathMatches(item.ref, r))) return true
  return observed.commands.some((c) => commandNamesPath(item.ref, c))
}

/**
 * Whether the declared evidence is corroborated at all: at least ONE item must
 * match something the host observed.
 *
 * "At least one" and not "every one" on purpose. Requiring every item makes the
 * gate hostage to the matcher's precision — one citation the host happened not
 * to log (a file read by a tool outside the recorded set, a command issued
 * before the stage marker armed) would reject a sound PASS, and a check stage
 * that cannot record a verdict burns its retry and ERROR-stops the loop. The
 * threat this closes is the PASS that observed *nothing*; padding a real
 * citation with an invented one is left to the human diff gate, which is where
 * the honest boundary of a machine check sits.
 */
export const substantiated = (declared: readonly EvidenceItem[], observed: ObservedEvidence): boolean =>
  declared.some((item) => itemObserved(item, observed))

/** Items the host could not corroborate — named in the rejection so a retry can fix the citation. */
export const unobservedItems = (declared: readonly EvidenceItem[], observed: ObservedEvidence): EvidenceItem[] =>
  declared.filter((item) => !itemObserved(item, observed))

/** De-dupe evidence across repeat `workflow_verdict` calls in one stage. Pure. */
export const mergeEvidence = (
  a: readonly EvidenceItem[] | undefined,
  b: readonly EvidenceItem[] | undefined,
): EvidenceItem[] => {
  const seen = new Set<string>()
  const out: EvidenceItem[] = []
  for (const item of [...(a ?? []), ...(b ?? [])]) {
    const key = `${item.kind}\u0000${normalizeCommand(item.ref)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** The rejection when a PASS cites nothing. */
export const noEvidenceMessage = (stage: string): string =>
  `Verdict NOT recorded — a PASS on the ${stage.toUpperCase()} stage must cite what you actually observed. ` +
  "Call workflow_verdict again with an `evidence` array: " +
  '[{ kind: "command", ref: "npm test", result: "42 passed, 0 failed" }, { kind: "file", ref: "src/limit.ts:88", result: "returns 429 over the limit" }]. ' +
  "Cite the commands you ran and the files you read — at least one must be something you really did this pass. " +
  "FAIL and ERROR verdicts need no evidence; if you cannot cite anything because the check could not run, record ERROR with a reason."

/** The rejection when the host saw the stage do nothing at all. */
export const noActivityMessage = (stage: string): string =>
  `Verdict NOT recorded — this ${stage.toUpperCase()} pass ran no commands and read no files, so a PASS is unsupported. ` +
  "Actually run the checks (or read the diff and the files it touches), then call workflow_verdict again with an " +
  "`evidence` array citing them. If the check genuinely cannot run here, record ERROR with a reason naming what is missing — " +
  "ERROR stops the loop for a human instead of shipping an unverified change."

/**
 * The rejection when a PASS's only corroborated citations are the check
 * commands the DRIVER ran. Samples up to three things the host DID see the
 * stage do, so the retry can cite real work instead of guessing — the same
 * make-the-retry-land principle as `axisCoverageIssue`.
 */
export const seededOnlyMessage = (stage: string, observed: ObservedEvidence): string => {
  const sample = [
    ...observed.reads.map((r) => `file "${r}"`),
    ...observed.commands.map((c) => `command "${c}"`),
  ].slice(0, 3)
  const own = sample.length
    ? `This pass's own recorded work includes: ${sample.join(", ")} — cite from it.`
    : "This pass ran no commands and read no files of its own — read the code you judged (or run a check yourself), then cite that."
  return (
    `Verdict NOT recorded — the only citations corroborated for this ${stage.toUpperCase()} PASS are the check ` +
    "commands the loop itself ran for you. Those are already established fact, not your proof of work: a PASS must " +
    "cite at least one thing YOU did this pass — a file you read, a command you ran. " +
    own +
    " Keep the check-command citations if you relied on them (never re-run them), add your own, and call workflow_verdict again."
  )
}

/** The rejection when nothing the PASS cited matches what the host observed. */
export const unobservedMessage = (stage: string, unobserved: readonly EvidenceItem[]): string =>
  `Verdict NOT recorded — none of the evidence cited for this ${stage.toUpperCase()} PASS matches what this session ` +
  `actually ran or read (${unobserved.map((i) => `${i.kind} "${i.ref}"`).join(", ")}). ` +
  "Cite the real commands and paths from this pass — copy them as you issued them — and call workflow_verdict again. " +
  "If you have not run the checks yet, run them first; if they cannot run, record ERROR with a reason."
