---
name: loop-orchestration
description: Explains the automatic agentic engineering loop (plan → build → verify → review) driven by the OpenCode `/loop` plugin command. Use when you need to understand how /loop advances stages, where the human gate is, the LOOP_VERIFY/LOOP_REVIEW verdict contracts, or how the loop terminates.
---

# The agentic loop

## Overview

`/loop <goal>` drives the full engineering lifecycle — PLAN, BUILD,
VERIFY, REVIEW — as one automatic pipeline instead of four manual slash
commands. The OpenCode plugin (`src/index.ts` → `src/loop/`) advances stages on
`session.idle`, threading each stage's output into the next as context, and
pausing at one human gate so nothing gets edited without sign-off.

There used to be a separate DEFINE stage before PLAN (turning the raw goal
into a spec) and a SHIP stage after REVIEW (drafting a PR description and
rollback plan). Both have been removed: DEFINE's scoping job (problem,
non-goals, assumptions) was folded into PLAN's own output, since its spec was
only ever consumed once, by the very next stage; a REVIEW PASS now finishes
the loop directly — ship the diff yourself.

The pipeline is split across **two sessions**: PLAN is the interactive
**planning** phase; BUILD/VERIFY/REVIEW are the **execution** phase, run by
a separate `/loop watch` session that claims a parked, approved plan. See
"Planning and execution are separate sessions" below.

## When to Use

- Use when a goal or backlog task should run the whole PLAN→REVIEW lifecycle
  unattended after the gate, instead of invoking `/spec`, `/plan`, `/build`,
  `/test`, `/review` one at a time.
- Use when picking up or resuming a task from `docs/tasks/in-planning/`
  (`/loop next`, `/loop task <id>`) — see `task-backlog-management`.
- Not for a single standalone stage — `/plan`, `/build`, `/verify`, `/review`,
  etc. each work outside the loop too, for one-off use.
- Not for changes you want to hand-hold through every step — the loop's value
  is in running BUILD→VERIFY→REVIEW unattended after the gate; if you
  want to review each stage individually, drive the stage commands by hand.

## The pipeline

```
planning session:
  /loop <goal> ─▶ [clarify?] ─▶ PLAN ─GATE(/loop go)─▶ [park]
                                                                     │
                                                     durable task in in-progress/
                                                                     │
watch session (/loop watch, separate session, polls on session.idle):
                                                                     ▼
                                                       claim ─▶ BUILD ─▶ VERIFY ─▶ REVIEW ─▶ done
                                                                  ▲        │                  │
                                                                  └── VERIFY FAIL ─────────────┘
                                                                  (re-plan, iteration++, inline)
                                                                  ▲                             │
                                                                  └────────── REVIEW FAIL (re-build) ┘
                                                                              (iteration++, inline)
```

A free-text `/loop <goal>` doesn't queue PLAN directly — the `/loop`
command's own turn first judges the goal against `interview-me`'s own
criteria and, if it's underspecified, runs a live interview with the user
right there. Either way, that turn calls the `loop_begin` plugin tool with
the final goal text, which is what actually queues PLAN. This is
conditional and configurable (see `interviewBeforePlan` below) — a clear
goal skips straight through with no questions. `/loop next` / `/loop task
<id>` skip this entirely; a backlog task has already been through
`task-author`'s own interview/confirmation and the `draft/ → in-planning/`
human gate (see `task-backlog-management`).

| Stage | Writes code? | Role |
|-------|--------------|------|
| plan | no | reads the code itself; sharpens the raw goal into a bounded problem statement (problem, non-goals, assumptions), then an ordered, review-sized plan + testable acceptance criteria |
| build | **yes** | implements the approved plan test-first, or applies a REVIEW stage's fix requests on a re-build |
| verify | no | runs tests, checks acceptance criteria, emits `LOOP_VERIFY: PASS`/`FAIL` |
| review | no | five-axis code review of the diff, emits `LOOP_REVIEW: PASS`/`FAIL` |

## Process

1. `/loop <goal>` — start; runs PLAN, then pauses at the plan gate.
2. `/loop go` — approve the plan. **The first approval parks it**: a
   task-driven loop's plan was already persisted at the gate, so parking just
   moves the file to `in-progress/`; a free-text loop is promoted into a real
   task file for the first time. Either way this session's job is done —
   nothing builds here.
3. In a **separate** session, `/loop watch` — on every idle tick it looks for
   one claimable task (`isClaimable`: has a persisted plan, never started) in
   `in-progress/` and, if found, claims it and drives BUILD → VERIFY → REVIEW.
   - A VERIFY FAIL within `maxIterations` re-plans with the failure fed back
     in, **inline in this same watch session** (the plan itself is in
     question).
   - A REVIEW FAIL within `maxIterations` re-builds with the review's
     findings fed back in, same session (the plan is assumed sound).
   - A re-plan gate reached this way (`iteration > 0`) resumes with `/loop go`
     in that same watch session — only the *first* approval parks.
4. On a REVIEW PASS, the loop is done. Review the diff yourself, then push and
   open the PR — the loop never does that step for you.
5. `/loop stop` aborts, cancels a clarification, and exits watch mode, all at
   once; `/loop unwatch` exits watch mode alone (a build already claimed still
   finishes); `/loop status` shows the current stage, iteration, pause state,
   and whether this session is watching.

## Planning and execution are separate sessions

- **Clarify (conditional, before PLAN).** Only for a free-text `/loop
  <goal>` judged underspecified. Runs live in `/loop`'s own turn, backed by
  the `interview-me` skill — one question at a time until there's an
  explicit yes on a restated intent. Nothing is queued until that turn calls
  `loop_begin`. Configurable (`interviewBeforePlan`); off entirely for
  task-driven starts, which already went through `task-author` and the
  `draft/ → in-planning/` gate instead.
- **Plan → park (always on by default).** PLAN never touches a
  file. Nothing gets edited until a human runs `/loop go` at the plan gate —
  that is the sign-off before any code is written. The first `/loop go`
  parks the approved plan as a task in `in-progress/` rather than continuing
  into BUILD in this session (see `task-backlog-management`).
- **Watch → claim (explicit opt-in, `/loop watch`).** No session builds
  anything just because it went idle. A human must run `/loop watch` in a
  session for it to become an execution worker; that session then claims and
  drives parked tasks unattended until `/loop unwatch`/`/loop stop`, or until
  it hits a mid-execution re-plan gate, which still needs a human `/loop go`
  in that same session.

The plan→park gate defaults on and is configurable (`gateBeforeBuild` in
`.agentic-loop.json`). If it's off, no gate ever fires, so nothing parks —
`/loop <goal>` / `/loop next` / `/loop task <id>` collapse back to a single
session end-to-end, same as before this split existed.

## Execution: `/loop watch`

A watch session's own `session.idle` handler, when it isn't already driving
a loop, scans `docs/tasks/in-progress/` for tasks where `isClaimable(task)`
is true — has a persisted plan (`## Implementation Plan`), and has **never**
had any `> BUILD started` note (not just "the last one is unmatched" — that's
`wasInterrupted`, a different check used for crash recovery). It picks the
lowest-priority claimable task (same `selectNext` tie-break as `/loop next`),
and claims it by doing the same thing `drive()` already does when a build
starts: appending a `> BUILD started (iteration 1)` note to the task file.
That append **is** the claim — there's no separate lock.

**Accepted risk:** two watch sessions polling on the same idle tick can both
see the same task as claimable before either has appended its claim note.
There's no lock around this, by design — it matches this codebase's existing
posture on other best-effort, non-atomic filesystem operations (`mv`/`printf`
based moves and appends throughout `task/store.ts`). If you're running
multiple watchers, treat a double-claim as a rare, visible-in-the-diff
possibility, not an impossibility.

## The verdict contracts

VERIFY and REVIEW each end their output with exactly one machine-readable line
that the driver greps to decide what happens next:

```
LOOP_VERIFY: PASS    # every acceptance criterion met, tests green → advance to review
LOOP_VERIFY: FAIL    # otherwise → re-plan (if iteration budget remains)

LOOP_REVIEW: PASS    # no Critical/Important findings on any axis → loop done
LOOP_REVIEW: FAIL    # otherwise → re-build (if iteration budget remains)
```

A missing or garbled verdict is treated as FAIL, not as a stall — the loop
still terminates via the iteration cap rather than hanging indefinitely.

## Termination

- **REVIEW PASS** → loop done. Review the diff, then push/open the PR.
- **FAIL** (verify or review) and `iteration + 1 < maxIterations` → loop back
  (re-plan or re-build) with the failure feedback threaded in.
- **FAIL** and the cap is reached → stop and report. Default `maxIterations`
  is 3, shared across both feedback loops (configurable).

## Config

Optional `.agentic-loop.json` at the repo root — every field has a default:

```jsonc
{
  "maxIterations": 3,           // shared cap on verify-FAIL re-plans + review-FAIL re-builds
  "gateBeforeBuild": true,      // pause for plan approval before build edits anything
  "interviewBeforePlan": true,  // allow interview-me on an underspecified free-text goal, before PLAN
  "tasksDir": "docs/tasks"      // root of the task backlog — see task-backlog-management
}
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The plan looks obviously right, skip the gate" | `gateBeforeBuild` exists because BUILD is the only stage that edits files — a bad plan compounds into a bad diff. Turn the gate off deliberately in config if you truly want unattended builds; don't skip it ad hoc. |
| "Just run /build directly, the loop is overhead" | Fine for a single isolated change. Once VERIFY/REVIEW feedback loops matter (multi-step goals, backlog tasks), the loop's re-plan/re-build wiring is exactly the part you'd otherwise hand-roll. |
| "REVIEW FAIL, just re-plan from scratch" | REVIEW FAIL routes to BUILD, not PLAN, on purpose — the plan already passed VERIFY. Re-planning throws away a working implementation over a quality finding. |
| "I approved the plan, why isn't it building?" | The first approval parks it — it doesn't build in the planning session anymore. Run `/loop watch` in a session (this one or another) to actually build it. |
| "Any idle session should just pick up ready work" | Rejected on purpose — an ordinary chat session must never spontaneously start writing code because it went idle. `/loop watch` is explicit opt-in, per session. |

## Red Flags

- A loop stuck at the gate with no toast/status update — check `/loop status`;
  the plugin may have failed to fire (see plugin logs via `client.app.log`).
- A re-plan (from VERIFY FAIL) that ignores the "Verify failure to address"
  context and repeats the previous plan verbatim.
- `LOOP_VERIFY`/`LOOP_REVIEW` verdict lines appearing more than once, or not
  at the very end of a stage's output — the driver takes the last match, but
  an ambiguous verdict usually means the subagent didn't follow its contract.
- A parked task sitting in `in-progress/` indefinitely — nothing is watching
  it. `/loop watch` in some session, or check that a watcher hasn't hit a
  mid-execution re-plan gate waiting on a human `/loop go`.
- A task claimed by two different sessions at once (both appended `> BUILD
  started` close together) — the accepted claim-race risk; check `git
  status`/`git diff` before trusting either one's work.

## Verification

- [ ] `/loop status` reflects the actual current stage after each `/loop go`.
- [ ] Every VERIFY and REVIEW response ends with exactly one verdict line.
- [ ] No file was edited before the plan gate was approved.
- [ ] A stopped/failed loop leaves its task (if any) in `in-progress/` with a
      note — never silently disappears or is left in `completed/`.
- [ ] The first `/loop go` on a plan parks it (task moved/created in
      `in-progress/`) and does **not** produce a BUILD in the planning session.
- [ ] A `/loop watch` session only ever claims a task that `isClaimable`
      would return `true` for — never one with any `> BUILD started` note.
- [ ] No session builds anything without a human having run `/loop watch` in
      it first.
