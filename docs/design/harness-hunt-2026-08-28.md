# Repeated improvements, and the harness seams still missing them

**Hunt of 2026-08-28.** This repo's improvement record (`improvements/README.md`,
plans 01–45, and the AGENTS.md rules) is dominated by a small number of
invariant classes that each had to ship **more than once** — a protection lands
on one seam, and a later design pays for the same bug again on a sibling seam
(design 42 re-applied design 21's OpenCode-only bounded gate shell to the model
hosts; design 23 re-applied design 19's task-gate ask to the plan gate; design
38 re-applied design 29's deny telemetry to check admission; the hub doctor
later mirrored both). This hunt inverts that pattern: it names the classes that
have already shipped repeatedly, then audits every harness seam — the OpenCode
plugin, the Claude/Qwen hooks and MCP server, core, and the hub — for the seams
where a class is **still** missing.

Method: four parallel source audits (OpenCode driver/impl, Claude/Qwen hooks,
core gate/store/terminal, cross-host parity), every finding verified against
source with file:line references, and each finding citing both the seam where
the class already lives and the seam where it is absent. Confidence labels:
CONFIRMED = traced end to end; PLAUSIBLE = one link unverified.

**Status.** Every finding 1–15 is now FIXED (see the per-finding markers
below), each with a regression test that fails without the fix: 1, 2, 3, 4, 6, 7
and 11 in the first pass, then 5, 8, 9, 10, 12, 13, 14 and 15 in the second,
along with three of the minor findings in §16. The rule candidates they earned
are in AGENTS.md.

## The classes that shipped repeatedly

| Class | Times paid for | Where it shipped |
|---|---|---|
| Bounded execution / total handlers — a hook, tool, or shell call that can hang or throw kills the turn silently; every one must answer, time-boxed, with the failure direction chosen | 3+ | plans 20, 21, 42; `withinDeadline`, `boundedShell`, the 50s gate-hook spawn deadline |
| The gate asks mechanically, never in prose | 2 | plans 19, 23; `gate-ask.mjs`, `promptPlanGateAsk` |
| Deny/starvation telemetry at the refusal itself | 3 | plans 29, 38, hub doctor mirror (round-2 hunt) |
| Allowlist globs declared in the shape the tool is invoked with | 4+ | `cd * &&` twins, mvn/gradle argv order, JS workspace selectors, prefix proxy (plan 22), plan 43 |
| Fail-open vs fail-closed chosen per class, and the silent exit logged | many | spawn deny (open), gate hook (closed), `questionsObservable` (open + logged) |
| Writer/matcher single source of truth, pinned by a test on the note the writer actually appends | many | `ASK_GATES`, `PARK_NO_PLAN_WHY`, `TASK_APPROVED_MARKER` pins, `REASON_BUDGET === REPLAN_REASON_MAX` |
| One choke point per shared shape | many | `oneLineReason`, `notifyTerminal`, `withLock(runLocks, …)`, the rename-aside claim helpers |
| Schema-mediated stores strip what they don't declare | 3 | `GitRefSchema.onCurrentBranch`, `epic`/`autoPlan` in `TaskFrontmatterSchema` — and finding 1 below is the third store |
| Host-agnostic protections must reach every host (and the hub is a host) | 3+ | 21→42, 19→23, 29→38→hub |

## Findings

Ranked across all four territories. "Class" cites where the protection already
lives; "seam" cites where it is missing.

### 1. The metrics sidecar is the zod-strip class's third victim: `evidence` is deleted on every read-modify-write — CONFIRMED

> **FIXED.** `MetricsSampleSchema` declares `SampleEvidenceSchema`; `metrics-file.test.ts` pins the round-trip AND parses `StageSample`'s source, so a future undeclared field fails the suite.

- **Class:** a field written at runtime that a schema round-trip strips is
  destructive, not ignored (`persist.ts:27-40` `onCurrentBranch`, and three more
  deliberate declarations there; `task/schema.ts:115-132`).
- **Seam:** `packages/core/src/workflow/metrics-file.ts:62-89` —
  `MetricsSampleSchema` declares `criteria`/`axes`/`checksSource`/`checksRefused`
  but **not `evidence`**, while `StageSample` declares it
  (`workflow/metrics.ts:107`) and both hosts write it via `verdictStructure`
  (`driver.ts:1749`, `server.ts:1898`). The sidecar flush is read-modify-write
  through `parseRunMetrics` (`metrics-file.ts:125-134`, default strip mode).
- **Failure:** the first flush serializes evidence fine (structural typing lets
  the extra key through `JSON.stringify`); the next run's first flush re-parses
  and rewrites the file with every prior entry's `evidence` deleted. Every
  reader parses through the same schema (hub `routes/metrics.ts:41`,
  `routes/runs.ts:64`), so even surviving evidence is invisible. The
  declared-evidence citations — whose persistence is the stated point of the
  feature (`metrics.ts:56-59`) — outlive exactly one run. Worse than the persist
  variant: the RMW *rewrites history* rather than failing a resume.
  `metrics-file.test.ts` never mentions `evidence`.

### 2. Seven `await toast(…)` sites sit on the drive path, ahead of the `finally` that releases the session — CONFIRMED

> **FIXED.** All seven are `void toast(...)`; the rule moved onto the `toast` helper's own docstring and is pinned by a source lint in `driver.test.ts`.

- **Class:** toasts are fire-and-forget everywhere; `.catch()` guards a
  rejection, not a hang (plans 20/21; stated at `driver.ts:1060-1063`, and at
  `driver.ts:2879-2882`, which names this exact stake: a TUI call that never
  settles ahead of the `finally` strands the session — `onIdle` returns on
  `driving.has` forever).
- **Seam:** `plugins/opencode/src/workflow/driver.ts:2423, 2428, 2432, 2454,
  2460` (the `driveChain` terminal arms) and `:2509, 2517` (`tryClaim`) — all
  inside `onIdle`'s try, ahead of the `finally` at `:2883-2895` that releases
  `driving`, `executingDirs`, and drains deferred idles.
- **Failure:** a `tui.showToast` fetch that never settles at the end of a
  *successful* run holds the session, the shared tree, and the stage marker
  forever; every later drive on that tree defers for the life of the process.
  At `:2517` the claim was just taken and the drive never starts — the task sits
  claim-held, every gate verb refusing it as "a loop is driving this NOW", until
  the stale sweep.

### 3. Six of eight Claude/Qwen hook entry points have no top-level catch — and the gate hook, the one fail-CLOSED hook, fails OPEN on a crash — CONFIRMED (structure), PLAUSIBLE (trigger)

> **FIXED.** Every entry ends `main().catch(<direction>)` — `failOpen` (`hooks/src/crash.mjs`, which also adds the missing crash channel) for the enforcement hooks, a dispatch-scoped block for `gate-command`. `reconcile`'s `auditBacklog` await is guarded. `hook-fail-direction.test.mjs` pins each terminator and fails on a `hooks.json` command it does not list.

- **Class:** a hook's failure must resolve to its class's chosen direction, and
  the choice is deliberate (plan 20's total hooks; design 42's ETIMEDOUT arm
  BLOCKS at `hooks/gate-result.mjs:41-48` precisely because "the move may or
  may not have landed"). Applied twice: `check-spawn-stage.entry.mjs:56` and
  `stamp-spawn-model.entry.mjs:115` end `main().catch(() => allow())`.
- **Seam:** the other six entry points end with a bare `main()`
  (`gate-command.mjs:214`, `check-stage-guard.entry.mjs:320`,
  `check-verdict-guard.entry.mjs:68`, `check-evidence.entry.mjs:51`,
  `reconcile.entry.mjs:172`, `plan-gate-ask.mjs:115`; Qwen bundles mirror the
  2-of-8 split). An escaped throw exits 1, which Claude Code treats as a
  non-blocking error: the turn **proceeds**.
- **Failure:** a throw in `gate-command.mjs` *after* `spawnSync` returned (the
  `decideGateOutcome` → `gateAsk` → `verbContext` → `block` stretch,
  `:147-211`) lets the prompt through — the model runs the verb via the MCP
  fallback after the CLI already moved the task, the exact double-move the
  block exists to prevent, in the direction design 42 explicitly rejected. For
  the enforcement hooks a crash is fail-open (the documented direction) but
  **silent and unlogged** — there is no crash channel at all (the deny log
  records only allowlist denies), versus OpenCode's total `log` +
  `failurePrompt`. One real unguarded await already exists:
  `reconcile.entry.mjs:120` awaits `auditBacklog` outside any try, so one
  rejection silently drops every session-start recovery warning.

### 4. The bounded gate shell (21/42) never reached the hub — the third surface making the same gate moves — CONFIRMED

> **FIXED.** The hub's `ShellPromise` gained `.timeout` (SIGTERM then SIGKILL, exit 124, matching the Claude shim) and `gateCtx` wires `boundedGateSh`. Tested in `fsclient.test.ts` and `gatectx.test.ts`.

- **Class:** a gate move cannot hang forever (design 21 on OpenCode:
  `boundedShell` in `gateCtx`, `driver.ts:3101-3118`; design 42 on the model
  hosts: `boundedGateSh`, `server.ts:973-981`, because "the hang class is
  host-agnostic").
- **Seam:** `packages/hub/src/server/gatectx.ts:17-27` hands core's `GateCtx`
  the raw `deps.sh`; that shell (`fsclient.ts`) has no `timeout` method and no
  deadline. `routes/gate.ts` runs `approveTask`/`approvePlan`/`replanTask`/
  `shipTask` — the ship arm does `git push` + `gh pr create` — on it, inside an
  HTTP request.
- **Failure:** the design-21 incident replayed with a mouse: Approve/Ship
  clicked in the monitor on a slow tree, one git command hangs, the request
  pends forever with the task file possibly already moved — a spinner over work
  that is done. No outer 60s killer exists here, nothing degrades to exit 124,
  nothing reports.

### 5. Three newer `client.session.get` walks are unbounded — one of them on the ESC path — CONFIRMED

> **FIXED.** All three walks are time-boxed — `withTimeout(…, SESSION_WALK_TIMEOUT_MS)` on both `impl.ts` hook paths (the deadline lands in the same arm a session-API failure does, so the edit guard still fails CLOSED) and `withinCallDeadline` on the ESC path, which also bounds `onInterrupt`'s pass aborts. Tested with a client that never answers.

- **Class:** every client call a hook awaits is time-boxed, "above all the
  `client.session.get` walk" (`impl.ts:260-266, 300-304`; applied via
  `withinDeadline` at `impl.ts:1231, 1279` and via the bounded gate tools).
- **Seam:** the same `findDrivingWorkflow` walk (`driver.ts:1024-1038`, one
  unbounded `session.get` per hop) is awaited with rejection handling but no
  deadline at `impl.ts:899` (`tool.execute.before` — runs for every tool call
  of every unattributed session while any loop is live), `impl.ts:1114`
  (`permission.ask`), and `driver.ts:2640` (`onInterrupt`, which the event hook
  **awaits**, followed by unbounded `session.abort` calls at `:2703`).
- **Failure:** a stalled server fetch wedges a human's tool call in a different
  session (the plan-21 spinner class, now in a hook), wedges a permission
  decision behind best-effort telemetry, or — worst — parks the event hook's
  ESC path, the one event the hook's own comments say must always get through:
  the interrupt is lost and the trailing idle re-claims the work the user just
  ESC'd.

### 6. The ship gate's publish-record parsers read unstamped body prose — CONFIRMED

> **FIXED.** Both parsers go through `auditNoteRecorded` (`task/plan-section.ts`), the new choke point for "was this ever recorded". `gate.test.ts` pins that a body quoting a publish note still publishes under `--pr`.

- **Class:** only a `> …` line closed by the bracketed stamp is lifecycle
  state; a body merely quoting the words must not count (enforced five times in
  `store.ts`: `runDoneField` :296 — "so a plan or a comment merely quoting the
  line cannot inject a ref" — `extractRunDiffstat` :341, `pendingPlanRejection`
  :396, `extractStopContext` :460, `unaddressedRejectionCount` :536).
- **Seam:** `gate.ts:1183-1184` — `prAlreadyRecorded =
  /\bPR (opened|already open) — /.test(done.body)` and
  `PUBLISH_RECORDED_RE.test(done.body)` run against the raw task body, no stamp,
  no line anchor.
- **Failure:** a completed task whose body *quotes* "PR opened — https://…"
  anywhere (this backlog is full of tasks about the loop — `store.ts:556` names
  the hazard) makes `prAlreadyRecorded` true forever: the publish-later retry
  arm is dead, **including an explicit `approve <id> --pr`** — a `local`/`push`
  ship can never be published, and the gate reports "already completed. Nothing
  to do."

### 7. Failure-correction notes and model-authored verdict reasons reach `appendNote` unflattened — CONFIRMED

> **FIXED.** The flatten moved into `appendNote` itself, which ends the class for every seam at once — `oneLineReason` stays for its clamp. Pinned in `store.test.ts`.

- **Class:** every free text landing on a one-line `> …` note flattens at a
  choke point (`oneLineReason` `gate.ts:857-883`; `flattenEvidence`
  `declared-deps.ts:110-119`; `clampedChecksDetail` `discovered-checks.ts:694`;
  the suggestions note's explicit flatten `terminal.ts:430-432`). A newline
  breaks `AUDIT_NOTE_LINE_RE`: the tail run is cut, every earlier note becomes
  hub-editable prose, the trail rides into every later `{{goal}}`, and the
  last-note parsers go blind.
- **Seams**, each interpolating text not provably single-line:
  `gate.ts:220` (`Move to ${to}/ failed — ${err.message}` — mv stderr);
  `terminal.ts:360` and `:453` (the two park-failure arms, same source);
  `gate.ts:1082-1114` (`publishNote`'s `${pr.reason}`, raw `err.message` from
  the ADO gateway path); `terminal.ts:526` (`runStop` writes `action.message`
  raw — today's producers are fixed strings, so this is an unguarded seam, not
  a live break); and the host twins interpolating **model-authored**
  `workflow_verdict`/`workflow_blocked` reason text raw (`driver.ts:2325, 2346`;
  `server.ts:2134`) — the tool schema caps length at 500 but permits newlines;
  "one-line reason" is contract prose, which is exactly what never carries a
  rule.
- **Failure:** worst on the correction arms — the preceding note asserting the
  move stays the trail's last well-formed line while the retraction is
  illegible, so the backlog claims a transition that never landed, the precise
  outcome `noteThenMove` exists to prevent. The blocked-note case fires exactly
  when a human is being asked to replan off the task file.

### 8. The runtime stage-ask denial exists only on OpenCode; on Claude/Qwen the `tools:` enumeration is the only wall — CONFIRMED

> **FIXED.** `check-stage-ask.entry.mjs` is the marker-gated PreToolUse deny, routed on each host's own ask tool and failing OPEN on every uncertainty; `refuseDuringStage` (`stageDeadline !== null`, process-local, so a human's separate session is untouched) is the MCP gate tools' caller check, the server-side twin of `refuseIfDriven`.

- **Class:** three layers deny a stage agent the ask tool, and the third —
  the plugin refusal that depends on no host config key — is "the only one
  covering a user-added kind's agent" (`impl.ts:913-935`; AGENTS.md).
- **Seam:** on Claude/Qwen, no PreToolUse matcher can ever see the ask tool
  (`hooks.json:26,36,46,56,68` — `AskUserQuestion` matches none), and
  `agent-ask-deny.test.mjs` runs only in this repo. A user-added kind's agent
  in a consuming repo that omits `tools:` inherits **every** tool. The same gap
  one seam over: the MCP server's gate tools have no caller-identity check —
  OpenCode's `refuseIfDriven` fails closed so a BUILD agent cannot approve its
  own task (`driver.ts:3404`); on Claude/Qwen, enumeration is the only thing
  standing between a stage subagent and `workflow_approve`.
- **Failure:** a stage agent opens `AskUserQuestion` mid-VERIFY on an
  unattended run — the run stalls on a dialog with nobody at the terminal, the
  loop's uncertainty contract (FAIL/ERROR verdict, `workflow_blocked`)
  bypassed with nothing to refuse it; or a confused stage subagent crosses its
  own task's gate. The natural seam is a marker-gated PreToolUse deny sharing
  `check-stage-guard`'s live-marker reading, plus a driving-check on the MCP
  gate tools.

### 9. The SessionStart reconcile is unbounded under the host's envelope-dropping 60s kill, and blind to `in-progress/.claims` — CONFIRMED

> **FIXED.** `RECONCILE_BUDGET_MS` bounds the scan — checked between the synchronous sweeps, raced against the one async call — and a truncated report SAYS it is partial. `in-progress/.claims` is swept and named alongside `queued/.claims`. `reconcile.test.mjs` is new: the hook had no tests at all.

- **Class:** work under a host deadline that drops the whole envelope gets its
  own tighter bound (design 42's 50s spawn timeout, `gate-command.mjs:142`;
  plan 20's `RECONCILE_TIMEOUT_MS = 30_000` + degrade-to-toast on OpenCode,
  `impl.ts:268, 613-616` — the same job, bounded, on the other host).
- **Seam:** `reconcile.entry.mjs` has no deadline of any kind and `hooks.json`
  sets no per-hook `timeout`; its work scales with the repo (a full read of
  every `in-progress/*.md`, three readdir sweeps, `auditBacklog`'s reads). It
  also lists only `queued/.claims` (`:113-118`), so a run that died between
  `claimTask` and the first `> BUILD started` note leaves an
  `in-progress/.claims` marker that is neither released (OpenCode's
  `releaseOrphanedClaims` sweep, `impl.ts:527-562`, has no twin here) nor even
  reported.
- **Failure:** on a large or slow backlog (the WSL `/mnt/c` class design 42
  itself cites) the hook is killed at 60s and every crashed-loop recovery
  notice is dropped, silently, on exactly the repos most likely to have crashed
  loops. After a claim-window crash, every gate verb refuses the task with no
  session-start hint; `workflow_doctor fix` does handle it (`server.ts:2643`),
  so this half is friction, not a wedge.

### 10. OpenCode lacks the `workflowWorktree`/`worktree` split — an unisolated stage's writes are silently relocated, not refused — CONFIRMED

> **FIXED.** `stageRunsIsolated` derives this stage's isolation from the manifest per call (no state field, so no staleness), and both pin arms REFUSE rather than relocate when it is false — same wording as the Claude guard's twin, so an operator who has seen one refusal recognises the other.

- **Class:** a stage that runs unisolated after a worktree exists must have its
  stray writes refused, not corrected into the work branch
  (`check-stage-guard.entry.mjs:228-233, 246-251, 306-311` — "the PLAN stage
  does not build").
- **Seam:** `impl.ts:1054-1060` documents the gap itself: OpenCode's state
  carries no equivalent of the marker's split, so the pin arms
  (`impl.ts:1013-1018, 1076-1081`) only ever correct into `loop.git.worktree`.
- **Failure:** PLAN re-entered on a replanned task whose worktree persists (or
  an unisolated sitter stage) writes a code file; OpenCode rewrites the path
  onto the loop's build branch silently, contaminating the next REVIEW
  `base...branch` diff and the PR with a write that stage was never allowed to
  make. Claude refuses the same write with a message naming the rule.

### 11. The load-failure fallback hook is the plan-20 bug, verbatim, on the fail-loud path — CONFIRMED

> **FIXED.** `overrideCommandPrompt` runs first; both reports are fired, not awaited. `index.test.ts` races the hook against a client that never answers.

- **Class:** override the prompt FIRST, then report; never await a TUI call on
  the way out (`impl.ts:851-860`).
- **Seam:** `plugins/opencode/src/load-failure.ts:36-41` awaits `client.app.log`
  then `client.tui.showToast` (`.catch` = rejection only, no time-box) and only
  then calls `overrideCommandPrompt`.
- **Failure:** stale core dist (the module's own reason to exist) plus a
  stalled server: the fallback hangs before writing the refusal, the command
  dies with zero output — the exact "first invocation swallowed, retry works"
  symptom plan 20 fixed — and index.ts's "fails LOUDLY" contract fails silently.

### 12. Stage-marker liveness has neither of `liveness.ts`'s disciplines, and its hook consumers enforce on a false "alive" — CONFIRMED (code), scenario environmental

> **FIXED.** `writeStageMarker` stamps `machine: machineIdSync()`, and `markerWriterAlive` now proves aliveness: same machine (an absent stamp is not provably local), self-validating probe, EPERM still alive. `liveMarker` is the one expression of the dead-marker rule, shared by the guard and `check-evidence`; `decideSpawnGuard` takes the probe as an argument, which makes its "same liveness rule" docstring true.

- **Class:** `pidGone` must prove death positively with a self-validating probe,
  and a pid is only meaningful beside its machine identity
  (`liveness.ts:45-65, 84-118`; AGENTS.md "A stale window is a proxy").
  `liveness.ts:19-23` blesses bare `pidAlive` **only** for callers that relax a
  guard on a false reading.
- **Seam:** `writeStageMarker` stamps `pid` only — no host, no boot id
  (`server.ts:894-897`); the hook probe `markerWriterAlive`
  (`hooks/src/marker.mjs:109-117`) is a bare local `kill(pid, 0)` with
  EPERM→alive, no self-validation — and the expired-marker arm **keeps
  enforcing** on "alive" (`check-stage-guard.entry.mjs:111, 206-213`), the
  direction the blessing excludes. Related drift: `spawn-guard.mjs:69-73`
  claims "same liveness rule as check-stage-guard" but implements a weaker one
  (no writer-alive arm at `:78`).
- **Failure:** sibling containers or a bind-mounted repo (the setups
  `machineId`'s own docstring names): a crashed container's marker pid exists
  in the next session's namespace, the expired marker reads live, and the
  deadline-starve blocks Bash/Write repo-wide, addressed to nobody — the wedge
  `dead-marker.test.mjs` shipped to end, reopened one environment over. Half
  the fix is server-side (stamp host/boot id on the marker).

### 13. Four writer/matcher pairs have no shared constant or no writer-side pin — CONFIRMED

> **FIXED.** `PLAN_APPROVED_MARKER` is pinned on `approvePlan`'s own note; `BUILD_STARTED_MARKER`/`BUILD_FINISHED_MARKER` and their formatters are exported from core and used by both hosts (the reconcile hook keeps a copy — importing `task/store.js` drags `yaml` into that bundle and esbuild's CJS shim throws at load — and `reconcile.test.mjs` asserts the copy character for character); a server-side test pins the plan-park descriptor against the literal both hosts' `plan-gate-ask.mjs` matches.

- **Class:** a marker is a contract with the note's writer; each anchor's
  writer is pinned by a test on the note it actually appends (AGENTS.md;
  applied for `TASK_APPROVED_MARKER`, `TASK_RESHAPED_MARKER`,
  `PLAN_WRITTEN_MARKER`, the done-note fields).
- **Seams:**
  - `PLAN_APPROVED_MARKER` (`store.ts:89`) anchors `lifecycleWindow` and hence
    `isClaimable`/`isRecoverable`/`wasInterrupted`, but no test runs
    `approvePlan` (`gate.ts:831`) and asserts its note opens with the marker —
    every store-side use is a hand-built fixture.
  - `> BUILD started` / `> BUILD finished` are inline literals in three core
    parsers (`store.ts:223, 615, 627-630`) and a bundled-hook twin
    (`reconcile.entry.mjs:48`, guarded only by a "MUST stay in sync" comment
    with **zero** reconcile tests), while two hosts hand-build the note
    (`driver.ts:2288`, `server.ts:1780`). No exported constant, no writer pin;
    one reword and that host's runs read as never-started — claims handed back
    mid-build.
  - The plan-park `gate: {kind: "plan", id}` descriptor is a literal at
    `server.ts:2314, 2332, 2342` matched by a second literal in
    `plan-gate-ask.mjs:62-67`; no shared constant, and no server-side test pins
    the shape (the hook's fixture tests itself). The hook fails open by design,
    so a harmonizing reshape of `server.ts` silently degrades the plan-gate ask
    back to prose-inside-data — the failure design 23 shipped to fix — with
    every test green.

### 14. `check-evidence` ignores the dead-marker rule its sibling declares mandatory, and its ledger has no byte cap — CONFIRMED

> **FIXED.** `check-evidence` reads the marker through `liveMarker`, so a crashed stage's ledger stops collecting every later session's reads, and `noteEvidence` stops appending past `EVIDENCE_MAX_BYTES` (the deny log's cap, for the deny log's reason).

- **Class:** "every marker-scoped control below must read [an expired marker
  with a dead writer] as NO marker" (`check-stage-guard.entry.mjs:97-112`,
  enforced by `dead-marker.test.mjs`); durable append-only files are byte-capped
  (`deny.mjs:24-35`, `DENY_LOG_MAX_BYTES`).
- **Seam:** `check-evidence.entry.mjs:43-47` gates only on
  `marker.check === true` — no deadline, no liveness; and `evidence.mjs:133-145`
  appends with no byte cap (`EVIDENCE_MAX` caps only the read-side fold).
- **Failure:** a SIGKILLed check stage leaves `.stage.json` (check:true,
  expired, writer gone); every later session's Read/Grep/Glob appends to the
  evidence ledger under the dead stage's name, unboundedly, until the next
  `writeStageMarker` arm clears it.

### 15. `tasksDir`/`worktreesDir` pick write destinations from the repo layer with no rail — CONFIRMED

> **FIXED.** Both keys parse through `WriteDirSchema` (no `..` segment, on either separator), and `tasksDir` must be repo-relative. The rail is on the VALUE, not a drop of the key: a repo choosing its own backlog location is legitimate, which is why `droppedRepoKeys` could never express this.

- **Class:** a key that picks the directory a write lands in is authority, and
  the repo layer may not hold it (AGENTS.md; `ALLOWLIST_WIDENING_KEYS`,
  `SHELL_BEARING_KEYS`); comparable values are railed one seam over (`safeCwd`
  refuses `..`/absolute for a plan's cwd, `discovered-checks.ts:111-125`;
  `GitRefNameSchema`, `SAFE_TASK_ID_RE`).
- **Seam:** `tasksDir: z.string().min(1)` (`config.ts:150`) and `worktreesDir`
  (`config.ts:181`) — no `..` refusal, honoured from the repo layer, joined raw
  everywhere (`store.ts:868, 908, 1055`, `persist.ts:134`, the deny log,
  `initRepo`'s mkdirs).
- **Failure:** a merely-cloned repo ships `"tasksDir": "../../…"`; the first
  init, gate verb, or watch tick creates the status folders **outside the
  repo** and writes task/state/log files there. Content is loop-shaped, so this
  is bounded — but the destination is repo-chosen, exactly the authority the
  rule denies that layer. The fix shape already exists (`safeCwd`).

### 16. Lower-confidence and minor findings

> **FIXED, except the first.** The pass-session calls are bounded
> (`PASS_SESSION_TIMEOUT_MS`, degrading to the shared-session path the create's
> catch already had), `disposeWatch`'s release has its sink, the replan-retry arm
> fuses the stop digest (and `extractStopContext` retires on
> `TASK_RESHAPED_MARKER` like its siblings), and the stale prose is gone. The
> deny-telemetry item stays open on purpose: it wants an e2e probe against a real
> OpenCode version, not code.

- **OpenCode's deny telemetry may be inert** (PLAUSIBLE): the `permission.ask`
  observer's own header concedes "whether a hard `\"*\": deny` consults this
  hook is a host detail that may vary by version" (`impl.ts:1104-1107`). On a
  version that doesn't, stages starve with a clean deny log — the
  transcript-archaeology loop design 29 exists to end, back on one host. Worth
  an e2e probe pin rather than code.
- **Pass-session open/close is unbounded** (CONFIRMED, opt-in exposure): under
  `stageConcurrency > 1`, `openPassSession`'s `session.create`
  (`driver.ts:1578`) runs before any stage timer exists; a hang wedges the
  drive un-ESC-ably (the halt is only consulted between passes).
- **`disposeWatch` fires `releaseLease` with no rejection sink**
  (`driver.ts:3066`) — the only `void`ed call in the plugin without `.catch`.
- **A cap-stop's attempts digest is lost on the replan-retry arm**
  (`gate.ts:926, 982`): a second `replan <id>` via `replanQueued` supersedes the
  fused rejection while the `Run stopped` note stays pending — the next PLAN
  pass loses the digest. `extractStopContext` is also the one parser of its
  trio that does not retire on `TASK_RESHAPED_MARKER`.
- **Stale prose describing controls that don't exist**: the
  `check-stage-guard.entry.mjs:36-42` header still describes an `az repos`/`az
  pipelines` CLI rail no code implements on either host, plus an orphaned
  comment for the removed curl classifier (`allowlist.mjs:278`) — the inverse
  of prose-vs-mechanism, and it will misdirect the next auditor.

## Rule candidates for AGENTS.md

Each of these is a mistake now made at least twice that the current rules,
as scoped, permitted:

1. **Every awaited `client.*` call on a hook, event, or drive path is either
   time-boxed or `void`ed with a `.catch` sink — `.catch()` guards a rejection,
   not a hang.** The current rules are scoped to "hook paths" and
   "model-callable tools", and that scoping is exactly what findings 2, 5, and
   11 slipped through (seven awaited toasts, three unbounded walks, the
   load-failure ordering — all written after plan 20). Like the literal-glob
   and ask-deny rules, this one wants a source-parsing test, because the prose
   form has now been violated seven times in one file.
2. **A hook's last line chooses its fail direction: `main().catch(<direction>)`.**
   Applied twice, absent six times (finding 3). The catch is where the
   direction is *chosen* rather than defaulted to whatever the host does with
   exit 1.
3. **A schema-mediated store strips what it doesn't declare — and a
   read-modify-write store rewrites history with the stripped shape.** Recorded
   today for `persist.ts` and task frontmatter; the metrics sidecar is the
   third store and the worst variant (finding 1). The rule: adding a field to
   any type a zod store round-trips means adding it to the schema in the same
   change, pinned by a round-trip test.
4. **Lifecycle state is parsed only from stamped audit lines, never from body
   prose.** Stated per-parser in `store.ts`, never as a rule; the publish-record
   parsers were written after those docstrings without it (finding 6).
5. **Anything reaching `appendNote` flattens** — or the flatten moves into
   `appendNote` itself, which ends the class (finding 7: three copies of the
   same unflattened `err.message` interpolation were written after
   `oneLineReason`'s section, each author reading "gate reasons" as not
   covering error text).
6. **A new surface that makes gate moves gets the bounded gate shell before it
   ships** (finding 4: OpenCode → model hosts → hub is the same lesson three
   times; the hub was the surviving gap).

## Verified already covered

Checked during this hunt and found sound — listed so the next hunt doesn't
re-chase them: the write-backstop twins (classifiers, one-hop prefix strip,
protected-branch floor) are true twins with shared vectors; the docs/tasks
edit guard, ADO scoping, model binding (fan-out and sitters included), verdict
admission (`RejectedVerdict` retry, `rejectedFallback` never salvaging a PASS,
both `noAdmissibleVerdictReason` arms), check-admission deny telemetry,
stale-claim recover/doctor logic, cross-process status, notifications, the
auto-plan caveat guard, and `approve --all` are line-for-line parallel across
hosts; the hub screens edits with `redact()` and `unknownFrontmatterKeys` and
flattens its reasons; every gate-family reason passes `oneLineReason`;
`GateResult.data` is set on every success arm and nothing regexes `message`;
claim discipline (release on every terminal exit incl. `fresh ?? state.task`,
rename-aside everywhere, no zero-window release) holds; `persist.ts` covers
every `WorkflowState` field except the two documented-intentional omissions;
the OpenCode onIdle prologue is still synchronous, halt discipline and
`runLocks` hold, pass-session identity and question-window bookkeeping are
sound; `hooks.json` matcher↔dialect pairs are test-pinned; Qwen bundles are
generated in lockstep. Structural non-parity that needs no fix: spawn-stage
deny and the SubagentStop nag have no OpenCode counterpart because the driver
sequences stages itself; marker-deadline starvation has no OpenCode analogue
because the driver aborts the stage session; the question-window machinery is
OpenCode-only by construction; Qwen model stamping is baked at install because
its spawn tool has no `model` parameter.
