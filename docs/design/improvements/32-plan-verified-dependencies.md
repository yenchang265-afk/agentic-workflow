English | [繁體中文](32-plan-verified-dependencies.zh-TW.md)

# 32 — A plan may not name a dependency it did not read

**Status: implemented.** `packages/core/src/workflow/declared-deps.ts`
(`DepDeclSchema`, `parseDeclaredDeps`, `hasDepsFence`, `previewDeclaredDeps`,
`depsSummaryLine`, `unverifiedDepsCaveat`, `dependencyContractBlock`), the
compose tail in `workflow/engine.ts`, the park forecast in `workflow/terminal.ts`,
the `approvePlan` caveat in `workflow/gate.ts`, the reuse-first tier and the
`### Dependencies` vocabulary in `prompts/agents/workflow-plan-author/body.md`
+ `skills/planning-and-task-breakdown/SKILL.md`, and the plan-defect paragraph in
`workflows/engineering/stages/build.md`; `declared-deps.test.ts`,
`terminal.test.ts`, `gate.test.ts`, `engine.test.ts`.

## The problem

A plan that names a package prescribes an install BUILD will attempt, and
nothing checked that the package was reachable. On a repo pointed at an internal
mirror — `registry=` in `.npmrc`, a `<mirror>` in `settings.xml`, an `index-url`
in `pip.conf` — a plan could prescribe a package the mirror does not carry, or a
version that never existed behind it. The loop found out at install time, one
BUILD in; with `maxIterations` defaulting to 3, one such line burned a third of
the budget re-building work that was never broken.

The cause is not that the model is careless. It is that the plan author was
given **no way to check**, and nobody had noticed that the two facts compose:

- engineering's PLAN declares no `bashAllowlist`
  (`workflows/engineering/workflow.json`), and `workflow-plan-author` sets
  `permission: {bash: deny}` with the Claude/Qwen frontmatter granting only
  `Read, Grep, Glob, Write`. No shell and no network, on any host.
- So every version in a plan came from the model's memory — which is trained on
  the PUBLIC registry. Behind a corporate mirror that is not a slightly stale
  answer, it is an answer to a different question, delivered with the same
  confidence as a correct one.

The expensive part was never the failure; it was that the failure was
**invisible until it was expensive**. At the plan gate, a dependency the author
had proven and one it had guessed looked exactly alike.

## The change

Design 18's shape, one noun over: *the model that already reads the repo
declares a fact, once; the loop freezes it as text in the task file; the human
sees it at the gate.* Three of that design's rules carry over unchanged, and
each is doing work here.

**Name the SOURCE, never the answer.** No table of approved packages and no
per-ecosystem registry commands anywhere. 18 rejected a command table as "a
table of guesses about repos it has not seen"; a package allowlist is the same
object and would be wrong in every shop but the one it was written for. So
`dependencyContractBlock` names the files to READ — `.npmrc`, `.yarnrc.yml`,
`settings.xml`, `pip.conf`, Cargo's source replacement — and the mirror's
identity comes from the repo, never from us.

**Frozen, not re-derived.** The declaration lands as text in the plan document,
which `entryState` re-extracts at claim time, so every BUILD→VERIFY→BUILD
iteration reads a byte-identical set. Only `replan` changes it.

**Degrade to fewer guarantees plus a warning.** No fence, malformed JSON, a
rejected entry, or a bug in the module itself costs the forecast and nothing
else. The park proceeds exactly as it did before — the forecast is wrapped in
its own `try` for that reason, because every exit path from `runPark` must
reach `releaseClaim`, and a held marker asserts a LIVE loop that every gate verb
then refuses to act on.

The contract asks for reuse-first ordering (a dependency already in the
lockfile → the standard library → something new), a version **read and cited
`file:line`** rather than recalled, the registry the repo actually resolves
from, and — for anything it could not establish — a plain statement to that
effect. The machine-readable half is an `agentic-deps` fence:

~~~markdown
### Dependencies
- `zod` 3.23.8 — already in the lockfile (pnpm-lock.yaml:1204)
- `p-retry` — NEW; this repo resolves npm from https://nexus.corp/… (.npmrc:1); availability NOT established

```agentic-deps
[{ "name": "zod", "ecosystem": "npm", "version": "3.23.8", "status": "existing", "evidence": "pnpm-lock.yaml:1204" },
 { "name": "p-retry", "ecosystem": "npm", "status": "unverified", "registry": "nexus.corp/npm-group", "evidence": "not in pnpm-lock.yaml; could not establish from here" }]
```
~~~

Nothing installs from it and no gate refuses a plan over it. Its reader is the
human at the plan gate, who is the one who knows what the organisation's mirror
carries — so the value is delivered entirely by the park message, the audit
note, and the `approvePlan` caveat.

## Why the sharp parts are shaped this way

**A separate composed block, not a fourth clause in `planContractBlock`.** That
function's `### Verification` clause is the one heading `runPark` enforces, and
`hasVerificationSection` documents why the enforcement is kept tolerant: "the
failure mode of strictness is a livelock — every refusal releases the claim and
re-queues, and a model that persistently misses an exact-match string burns a
PLAN run per tick." A second enforced heading would double that surface to buy
nothing. `### Dependencies` is agent-judged and omittable, the posture
`planVisualizationBlock` takes. Design 24's section-vocabulary collision was
between the PERSONA's words and the CONTRACT's words, not a count of sections,
so it stays closed by naming the heading verbatim in the block, the persona, and
`planning-and-task-breakdown` in the same change.

**The section is a convention; the fence is the artifact.** `FENCE_RE` matches
the whole document, last-fence-wins, so a plan that puts the block somewhere
else still yields the machine-readable half. Same asymmetry `agentic-checks`
accepts.

**An absent fence renders NOTHING, unlike the checks forecast.** The checks
preview reports its own absence because a missing checks block means a stage
will run zero checks — a loss. A missing deps block usually means there was
nothing to declare, and a line on every park would train the reader to skip the
whole suffix, taking the checks half down with it. `hasDepsFence` exists to keep
the third case legible: a fence holding `[]` says "considered, adds none", which
is not the same statement as silence.

**The cap is on the RENDER, not the parse.** `MAX_DISCOVERED_CHECKS` is 8
because every discovered check is a command the loop RUNS on every pass — a real
per-firing cost. This block costs nothing to carry, so dropping an entry at
parse time would discard the very declaration the human needed. The pressure is
readability, and it is answered where readability lives:
`MAX_DECLARED_DEPS` is 20 (a runaway backstop), while `MAX_NAMED_DEPS` spells
out three names then counts the rest, because the suffix shares one `> …` line
with the checks forecast.

**Free text is flattened at the PARSE.** `evidence` and `registry` are
plan-authored and reach a single-line audit note with no untrusted-data fence.
A newline there detaches the bracketed stamp, `AUDIT_NOTE_LINE_RE` stops
matching, and the orphaned lines then read as plan PROSE while every last-note
parser (`extractReplanReason`, `extractRunBranch`, `extractStopContext`) goes
blind — the hazard `oneLineReason` exists for. Flattening happens once, at the
parse, rather than at each render site, because a module that flattens in three
places grows a fourth that forgets. `name`, `ecosystem` and `version` get
character classes for the same surface, and are REFUSED rather than sanitized: a
silently rewritten package name in a gate line is a worse artifact than an
absent one.

**"Unverified", never "unproven by us".** The word this feature must never use
about a self-report is *verified*. The plan is an account of what its author
read; the loop probes nothing. Every rendered string says what the plan
*claims*, and `unverifiedDepsCaveat` says "could not establish" — laundering a
declaration into a guarantee would make this strictly worse than silence, which
is `admissibleChecks`' rule about fabricated PASSes wearing different clothes.

**BUILD closes it from the other end**, and this is the cheapest half of the
whole design. BUILD has unrestricted bash and WILL discover an unresolvable
package on its first install. The expensive failure was never the discovery — it
was that BUILD then *improvised*: substituted a package, hand-rolled a
replacement, widened a range, and the cost surfaced at REVIEW or later as a diff
nobody had reviewed for it. `build.onError` already routes "the approved plan
cannot be implemented as written" to a stop-and-replan, so `build.md` now names
a non-resolving dependency as exactly that condition. Three sentences, no
machinery, and it converts a burned iteration into a stop.

## What was deliberately not done

**No driver-run registry probe, on any host.** The obvious next step — have the
loop run `npm view <pkg> versions` itself and turn the declaration into an exit
code — was designed, then abandoned on three independent findings:

- **A PLAN `bashAllowlist` is not an admission boundary.** `stageBashGlobs`
  returns `[]` for a stage with no list, and `config.ts` states the rule
  verbatim: "`[]` therefore means 'unrestricted', never 'nothing is allowed'."
  The Claude MCP server writes that list onto the live stage marker on every
  fire, and the PreToolUse guard's allowlist branch fires on ANY stage with a
  non-empty marker list, not only check stages. So giving PLAN a narrow list to
  admit probes would narrow **every Bash call in the session** for the whole
  PLAN window on two of three hosts — and PLAN is `isolation: "none"`, i.e. the
  human's own checkout, in the session they are most likely typing in. Its
  refusals would even tell them "the PLAN stage is read-only".
- **`runPark` has no bounded shell.** It uses the unbounded driver `$`;
  `boundedShell` is wired only into `gateCtx`. An `npm view` against an
  unreachable internal Nexus — VPN off, which is precisely this feature's
  environment — hangs with no deadline, and `runPark` is reached inside
  `workflow_advance`. That is the "plugin tool that hangs, only exit is ESC"
  failure the repo already carries a rule about.
- **A green probe at park would be a lie with authority.** The park inherits the
  human's interactive environment — proxy vars, an auth token, a live VPN — none
  of which BUILD's worktree is guaranteed to have. A PASS here that BUILD cannot
  reproduce launders a guess into established fact, which is the inversion
  `admissibleChecks` exists to prevent. Design 24 refused a park-time binary
  probe on the environment argument, and it transfers intact.

If the machine fact is wanted later, the only defensible placement is BUILD
fire, through the `runStageChecks` seam that already runs before every fire with
isolation done — and it needs its own answer to a problem this design surfaced:
`admissibleChecks` with an empty glob list refuses everything, so BUILD's
"unrestricted" empty allowlist is fail-CLOSED for driver-run commands. That is a
real design decision, not a wiring detail, and it belongs in its own record.

**No config key, no manifest change, no host change.** Nothing here is optional,
so nothing needs a knob: the contract costs one composed block on a stage that
runs once per task, and the forecast costs a regex on a string already in
memory. That also keeps the blast radius at zero — no stage marker, no
allowlist, no `knobs.ts` drift.

**No park-time enforcement.** A plan without the block is valid, and a plan with
an unverified dependency still parks and still approves. Design 18's rule
stands: the failure mode of strictness at this gate is a livelock.

## Adjacent defect, noted not fixed

`packages/hub/src/server/knobs.ts` lints `workflows.<kind>` sections against
`UNIVERSAL` + `BY_SOURCE` + `STRUCTURED_KEYS`, which between them cover only
`enabled`, `codePlatform`, `trigger`, `stageModels` and `maxDiffLines`. Core's
per-kind schema also defines `prBase`, `stageContext`, `stageFanout`,
`stageConcurrency`, `stageChecks`, `discoverChecks` and `planVisualization`, so
the hub's Config tab reports every one of those as `unknown knob "…" — it is
silently ignored`, which is the opposite of true. The drift alarm in
`knobs.test.ts` does not catch it because it only mirrors `BY_SOURCE`, i.e. the
knobs `orchestrate.ts` reads positionally. Found while confirming this design
needed no knob; left for its own task.
