English | [繁體中文](18-plan-discovered-checks.zh-TW.md)

# 18 — Plan-discovered check commands

**Status: implemented.** `packages/core/src/workflow/discovered-checks.ts`
(`parseDiscoveredChecks`, `admissibleChecks`, `resolvableChecks`,
`resolveStageChecks`, `checkDiscoveryBlock`), `commandAllowed` completing the
twin in `task/write-backstop.ts`, `discoverChecks` on `StageDefSchema`,
`checksFor`/`configuredChecks`/`discoverChecksFor` + `checkTimeoutMinutes` in
`config.ts`, `discoveringStage` + the compose tail in `workflow/engine.ts`, the
`runChecks` timeout in `workflow/checks.ts` and `ShellPromise.timeout` in
`host.ts`, `runStageChecks` in both hosts, `"discoverChecks": true` on
engineering's verify stage; `discovered-checks.test.ts`, `checks.test.ts`,
`config.test.ts`, `schema.test.ts`, `engine.test.ts`,
`write-backstop.test.ts` + `check-stage-guard.test.mjs` (shared vectors).

## Context

Plan 08 replaced the self-reported "tests are green" with an exit code — for
commands somebody declared. Nobody had. No shipped manifest set `checks`,
`stageChecks` had no default, and `docs/configuration.md` was explicit that
"Unset ⇒ no checks, which is exactly today's behavior". So out of the box the
VERIFY verdict still rested on the agent's own account of what it ran, and 08's
machinery sat idle until a user hand-wrote a config block that nothing told them
how to fill.

The obvious fix — ship a default command table in the manifest — is worse than
the gap. The loop runs on arbitrary repos and the framework has **no toolchain
detection** (the only repo inspection anywhere is `detectEcosystems` in
`source/dependency-scan.ts`, a presence check feeding dep-advisory routing). A
hardcoded `npm test` is not inert where it does not apply:

- a missing runner exits 127 ⇒ `classifyExit` ERROR ⇒ engineering's
  `verify.onError` **stop** arm — every VERIFY halts the run for a human;
- a repo whose `package.json` declares no `test` script answers with exit 1 ⇒
  **FAIL** ⇒ BUILD re-fires and burns every iteration to the cap on work that
  was never broken. (This repo is that case: root has `test:all`, `test:hooks`,
  `test:scripts`, and no bare `test`.)

Predicate fields (`when: { exists: [...] }`) were considered and rejected: a
table of predicates is still a table of guesses about repos it has not seen.

## The change

**The model that already reads the repo picks the commands, once, and the loop
freezes them.** PLAN's contract already requires a `### Verification` subsection
mapping each acceptance criterion to "the exact command or observable check that
proves it" — the discovery is not new work, only a machine-readable rendering of
it. `checkDiscoveryBlock` (composed onto the prompt, never written into the
template — `planContractBlock`'s rule) asks for a fenced block:

~~~markdown
### Verification
- AC1 "returns 429 over the limit" → `npm run test:all` (root package.json
  defines `test:all`; there is no bare `test` script)

```agentic-checks
[
  { "name": "tests", "command": "npm run test:all" },
  { "name": "types", "command": "npm run typecheck:all" }
]
```
~~~

JSON parsed by `CheckDefSchema` itself — the same shape the manifest and config
layers use, so the three cannot drift.

The block also tells PLAN **where to take the commands from**, in order of
authority: the repo's CI workflow definition, then `AGENTS.md`/`CLAUDE.md` where
they name the check commands, then the package manifest's declared scripts —
test/typecheck/lint/build steps only, never a CI job's checkout, install, deploy
or release. That ordering is the cheapest lever on the whole feature's failure
mode: the alternative to a guess is not a better guess but a SOURCE, and a CI
workflow is the command set the project already enforces on every push. A plan
that copies from it needs almost no judgement at the human gate, and the
expensive residual below — a conventional-looking `npm test` on a repo with no
such script — cannot arise from a command that was read rather than assumed.
Ordering only: a table of commands per ecosystem is the thing this design
rejected, and naming where to look is not one.

`resolveStageChecks` is the single seam both hosts call, and every branch returns
through `checksFor`, so precedence lives in one place: config (**present**, even
`[]`) → manifest `checks` → discovered → none.

## Why the two hard parts are shaped this way

**Frozen, not re-derived.** The rationale for 08 was that a stage picking its own
commands per run moves the verdict without the code moving. Discovery would
restore that exactly, so it happens once and lands as *text in the task file*:
`state.artifacts.plan` is re-extracted at claim time (`source/backlog.ts`
`entryState`), engineering's `plan.onDone` is `park` so no PLAN transcript
survives into a run, and `dropArtifacts` never names `plan`. Every
BUILD→VERIFY→BUILD iteration therefore reads a byte-identical set. The only way
it changes is `replan`, which re-runs PLAN and re-parks for the human gate.

**The allowlist is the boundary — not the human plan gate.** A driver-run check
bypasses `bashAllowlist` entirely, and the plan document lives under `tasksDir`,
which is **repo content**: a cloned repo can ship a task file carrying an
`## Implementation Plan`, and the first watch tick claims it. That is the same
threat `SHELL_BEARING_WORKFLOW_KEYS` closes for config `stageChecks`, so "a human
approved the plan" is not a security property. `admissibleChecks` is: a
discovered command runs only if `commandAllowed` says this stage's own allowlist
would have let its agent run it unprompted. The claim the design makes is
therefore narrow and checkable — *a hostile block can make the driver run exactly
what a VERIFY agent could already run in that worktree today* — and the residual
is stated rather than hidden: running a repo's test suite runs the repo's code,
which `npm test*` on the allowlist has always meant.

Three smaller rules, each with a concrete failure behind it:

- `cwd` must be a plain relative path with no `..` segment. `runChecks` joins it
  onto the work tree by string concatenation, so `../..` escapes. The `..` rule
  is deliberately **separate** from the character class: `.` is legal in a
  directory name, so a class alone matches `..` — the test caught exactly that.
- `name` gets a character class, because it reaches the prompt (`checksBlock`)
  and a `critical` finding's `detail` with no untrusted-data fence, unlike
  `output`.
- A `command -v` preflight, through `bash -c` (Bun's `$` implements only a subset
  of builtins, and a probe it could not parse would report every binary missing
  and silently kill the feature), drops a discovered command whose binary is
  absent. Configured and manifest checks keep 127-ing to ERROR — a human asserted
  those exist — but "stop the loop for a human" is the wrong price for a model's
  guess.

Everything degrades to **fewer checks plus a warning**: no block, malformed JSON,
a refused command, a missing binary, or a bug in the module itself. Never a park
refusal, never a stop. `runPark`'s tolerant `hasVerificationSection` is untouched
for the reason it documents — the failure mode of strictness there is a livelock.

Two bounds are per-check rather than per-stage. `CheckDef.timeoutMinutes`
overrides the global cap, because one cap across a stage is set by its slowest
command and leaves every faster one effectively unbounded — a 20-second lint
beside a 25-minute integration suite would share the suite's budget. A
DISCOVERED `timeoutMinutes` may not exceed the stage's own wall-clock cap: it is
the one field a hostile block could use to park the driver on a command for a
day, and a check has no business outliving the stage it belongs to. Rejected
rather than clamped — clamping would run something other than what the plan
says, and the plan is the record. And `MAX_DISCOVERED_CHECKS` is 8, not the 5
first shipped: five was picked against a single-ecosystem repo and is exactly
what a polyglot one needs before it silently loses checks (a front end's test,
typecheck and lint beside a service's build and test is five already). 8 matches
`FANOUT_MAX`, which bounds the other per-stage cost multiplier for the same
reason.

## The prerequisite this forced

`runChecks` had **no timeout on either host**, and nothing covered it:
`ShellPromise` exposed only `quiet`/`nothrow`/`cwd`, OpenCode's stage timer races
the model session (checks run outside it), and the Claude host tests its deadline
in `workflow_advance` while checks run back in `workflow_stage`. That was
survivable only because `checksFor` returned `[]` for every kind — no repo could
hang. Turning checks on by default makes a hang reachable everywhere, so the cap
ships in the same change: `checkTimeoutMinutes` (10), a host-native
`timeout(ms)` on the Claude shim that actually kills the child, and a
`Promise.race` fallback in core that bounds the drive loop for a host that
cannot. Exit 124 is listed **explicitly** in `classifyExit` rather than falling
through to FAIL: a FAIL re-fires a BUILD whose VERIFY hangs again, burning every
iteration to the cap on a stage that never produced a result.

That cap has a corollary the admission rules cannot express: a command that
never exits is not a slow check, it is a **stop**. `npm run dev` is admissible
(`npm run *` is on VERIFY's allowlist), its binary resolves, and no rule
downstream drops it — so it runs the full ten minutes and reports 124, i.e.
ERROR, i.e. `verify.onError`. Nothing static can tell a server from a suite, and
a denylist of names would be the per-ecosystem table this design already ruled
out, so the rule lives where the commands are chosen: `checkDiscoveryBlock`
tells PLAN to list only commands that terminate, and to prove runtime behaviour
with the run that boots and stops the server itself.

One shape satisfies that rule by defeating it, so it is refused in code rather
than in prose: `npm run dev &` backgrounds the server and hands back the
SHELL's exit 0, which `classifyExit` reads as a PASS and the stage prompt
renders as established fact the agent is told not to dispute — a manufactured
guarantee with more authority than the self-report checks replaced, plus an
orphaned process per iteration. `commandAllowed` cannot see it (`splitSegments`
drops the lone `&`, leaving a plain `npm run dev` to match `npm run *`), so
`admissibleChecks` gets a fifth rule, `backgroundsItself`. It is NOT mirrored
into `commandAllowed` or the hook twin: an agent that backgrounds something
loses the output and gains no verdict, while a driver-run one becomes the
verdict.

`planContractBlock` carries the same rule one level up, over the acceptance
criteria the commands are derived from — because the criterion is where the
problem is born. "Serves at `localhost:5173`" cannot be graded by any check
stage: the serve command hangs, and every shape that would make it observable
(`&` with a redirect, `nohup`, a `timeout` wrapper, a `curl` probe) is off the
allowlist and stays off — a wrapper glob would be a hole, since
`timeout * npm run *` also matches `timeout 5 bash -c "rm -rf x && npm run dev"`.
The observed failure mode was the cheap one: VERIFY marked the criterion met and
disclaimed it in prose the loop does not store. So `workflow-verify`'s step 2 now
says an unobserved criterion is **not met**, and names what to ask the next BUILD
for; PLAN is told not to write such a criterion in the first place.

## What was deliberately not done

- **No command table in any manifest.** `schema.test.ts`'s "no shipped manifest
  declares checks" flips from a backward-compat pin to the pin that enforces
  this, and says so.
- **No park-time enforcement of the block.** A plan without one is valid; the
  loop simply checks as it did before.
- **No re-discovery on VERIFY.** That is the whole point of 08.
