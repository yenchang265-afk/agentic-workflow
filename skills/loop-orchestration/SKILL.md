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
| build | **yes** | implements the approved plan test-first on the loop's own `loop/<id>` branch, or applies a REVIEW stage's fix requests on a re-build; each iteration is committed as a checkpoint |
| verify | no | runs tests (bash allowlist), checks acceptance criteria, records `PASS`/`FAIL`/`ERROR` via the `loop_verdict` tool |
| review | no | five-axis code review of exactly `git diff base...branch` (read-only bash allowlist), records `PASS`/`FAIL`/`ERROR` via the `loop_verdict` tool |

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
4. On a REVIEW PASS, the loop is done and the task moves to `in-review/` —
   the human diff gate. Review `git diff <base>...loop/<id>` yourself, push
   and open the PR, then run `/loop ship <id>` to move the task to
   `completed/` (an audited move) — the loop never does those steps for you.
5. `/loop stop` aborts, cancels a clarification, and exits watch mode, all at
   once; `/loop unwatch` exits watch mode alone (a build already claimed still
   finishes); `/loop status` shows the current loop plus a whole-backlog
   roll-up (counts + gated/claimable/interrupted/in-review flags); `/loop
   recover <id>` resumes an in-progress task whose run died mid-build
   (crash/restart) — from its **state snapshot** at the exact stage it
   reached, or from the persisted plan when no valid snapshot exists. Plugin
   startup logs any interrupted tasks and leftover snapshots it finds.

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
lowest-priority claimable task (same `selectNext` tie-break as `/loop next`)
and claims it **atomically**: a non-recursive `mkdir` of
`in-progress/.claims/<id>` either succeeds (claim won) or fails because
another watcher on the same filesystem got there first. The
`> BUILD started` note remains the human-readable audit record; the marker
directory is the lock.

In **shared-tree mode** (default), a per-directory execution lock additionally
serializes drives within one opencode instance — all sessions share one
working tree and one checked-out branch, so only one loop may run stages in it
at a time. In **worktree mode** (`worktreesDir` set) each loop owns its own
worktree, so that lock is dropped and multiple `/loop watch` sessions can
drive different tasks concurrently in one instance. **Not covered either way:**
separate opencode *processes* racing the same backlog clone on `index.lock`
during backlog commits (best-effort). Run additional watchers in their own
clones for hard isolation.

## The verdict contracts

VERIFY and REVIEW each record their verdict by calling the **`loop_verdict`
plugin tool** — the loop's only trusted verdict channel. The driver accepts
a verdict only from the session whose loop is currently sitting in that
exact check stage; a `LOOP_VERIFY:`/`LOOP_REVIEW:` line in the stage's text
is a human-readable echo for the transcript and is deliberately **ignored**
(free text is untrusted — a quoted contract or echoed repo content must
never flip control flow):

```
PASS     # verify: every criterion met, tests green → review; review: no Critical/Important findings → done
FAIL     # otherwise → re-plan (verify) / re-build (review), if iteration budget remains
ERROR    # the check itself could not run (broken environment) → stop for a human, no iteration burned
```

No tool call at all is treated as FAIL, not as a stall — the loop still
terminates via the iteration cap rather than hanging indefinitely.

The tool also accepts optional `reason` (a one-line summary) and `criteria`
(per-acceptance-criterion `{criterion, pass}` results). These steer only the
**next iteration's prompt** — the failed criteria are threaded ahead of the
stage's prose so the re-plan/re-build leads with what actually failed — never
control flow, which remains `verdict` alone. They arrive through the same
trusted tool call as the verdict, so they carry no extra trust.

## Termination

- **REVIEW PASS** → loop done; the task moves to `in-review/`. Review
  `git diff <base>...loop/<id>`, push/open the PR, then run `/loop ship <id>`
  to move the task to `completed/`.
- **FAIL** (verify or review) and `iteration + 1 < maxIterations` → loop back
  (re-plan or re-build) with the failure feedback threaded in.
- **FAIL** and the cap is reached → stop and report. Default `maxIterations`
  is 3, shared across both feedback loops (configurable).
- **ERROR** (verify or review) → stop immediately for a human; fix the
  environment, then `/loop recover <id>`.
- A stage exceeding `stageTimeoutMinutes` fails the loop (partial work is
  checkpointed on the branch) instead of wedging the driver.

## Audit trail

Every lifecycle event — plan recorded, plan approved (with the approver's
git identity), build start/finish, each verdict (with its reason and any
failed criteria), stop, recovery, completion — is appended to the task file
as a timestamped note, and each stage's full output is written to
`<tasksDir>/runs/<id>.md`. On termination the run log also gets a
`## Run summary` table: per-stage wall-clock, verdict history, and iterations
used. Secrets echoed into any of these durable artifacts are shape-redacted
(`AKIA…`, `sk-…`, tokens, PEM blocks, `key/secret/token: …`) before they are
written. Planning-phase backlog mutations are committed scoped to the tasks
dir; execution-phase notes ride the branch checkpoints in shared-tree mode, or
are committed to the main tree per terminal event in worktree mode. See
`docs/design/threat-model.md`.

## Config

Optional `.agentic-loop.json` at the repo root — every field has a default:

```jsonc
{
  "maxIterations": 3,           // shared cap on verify-FAIL re-plans + review-FAIL re-builds
  "gateBeforeBuild": true,      // pause for plan approval before build edits anything
  "interviewBeforePlan": true,  // allow interview-me on an underspecified free-text goal, before PLAN
  "tasksDir": "docs/tasks",     // root of the task backlog — see task-backlog-management
  "stageTimeoutMinutes": 60,    // wall-clock cap per stage; exceeding it fails the loop
  "worktreesDir": ".loop-worktrees", // OPTIONAL: per-task git worktree isolation (unset ⇒ shared-tree branch switching)
  "worktreeSetup": "npm ci",    // OPTIONAL: command run in a fresh worktree (deps aren't checked out)
  "reviewLenses": ["correctness", "security", "test-adequacy"] // OPTIONAL: multi-pass review, worst verdict wins
}
```

**Worktree isolation** (`worktreesDir`): each loop's BUILD/VERIFY/REVIEW runs
in its own `git worktree` on the `loop/<id>` branch instead of switching the
shared checkout's branch. The human's tree is never touched, and multiple
`/loop watch` sessions can drive tasks concurrently in one instance (the
per-directory serialization lock is dropped in this mode). Stage prompts carry
a `Worktree:` line pinning all reads/edits/tests there; VERIFY/REVIEW
allowlists accept `cd <worktree> && <runner>` and `git -C <worktree> …`. The
task backlog stays canonical in the main tree — audit notes and moves are
committed there per terminal event. Off by default. See
`docs/design/improvements/01`.

**Multi-lens review** (`reviewLenses`): REVIEW runs once per lens, each pass
focused on that lens, and the loop takes the **worst** verdict across passes —
a single prompt-injected reviewer can't wave a change through (threat model
T1). Costs ~N× review time. Off by default (single review).

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
- A check stage that wrote a `LOOP_VERIFY`/`LOOP_REVIEW` text line but never
  called `loop_verdict` — the loop logs the discrepancy and records FAIL;
  the subagent didn't follow its contract.
- A parked task sitting in `in-progress/` indefinitely — nothing is watching
  it. `/loop watch` in some session, or check that a watcher hasn't hit a
  mid-execution re-plan gate waiting on a human `/loop go`.
- A stale `.claims/<id>` marker for a task with no live loop — the claiming
  run died; `/loop recover <id>` re-claims and resumes it.
- A task sitting in `in-review/` — that's not a stall, it's the human diff
  gate; review the branch and run `/loop ship <id>` when it ships.

## Verification

- [ ] `/loop status` reflects the actual current stage after each `/loop go`.
- [ ] Every VERIFY and REVIEW turn calls `loop_verdict` exactly once, and its
      text line matches the recorded verdict.
- [ ] No file was edited before the plan gate was approved, and every build
      edit landed on the `loop/<id>` branch, never the base branch.
- [ ] A stopped/failed loop leaves its task (if any) in `in-progress/` with a
      timestamped note — never silently disappears or is left in `completed/`.
- [ ] A REVIEW PASS parks the task in `in-review/`; only a human moves it to
      `completed/`.
- [ ] The first `/loop go` on a plan parks it (task moved/created in
      `in-progress/`) and does **not** produce a BUILD in the planning session.
- [ ] A `/loop watch` session only ever claims a task that `isClaimable`
      would return `true` for, and holds its `.claims/<id>` marker while
      driving it.
- [ ] No session builds anything without a human having run `/loop watch` in
      it first.
