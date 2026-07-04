---
name: loop-orchestration
description: Explains the automatic agentic engineering loop (build → verify → review) driven by the OpenCode `/loop` plugin command, and the `/loop-plan` command that authors and approves plans for it. Use when you need to understand how /loop executes stages, how plans get authored/approved, the LOOP_VERIFY/LOOP_REVIEW verdict contracts, or how the loop terminates.
---

# The agentic loop

## Overview

The lifecycle is split into two commands. **`/loop-plan`** is the planning
side: its agent authors a backlog task *with* an `## Implementation Plan`
(`new <idea>`), or plans an existing task in place (`task <id>`), and
`approve <id>` is the explicit human gate that parks the task in
`in-progress/` — the approved queue. **`/loop`** is the execution side: a
pure executor that drives BUILD, VERIFY, REVIEW as one automatic pipeline
over an approved task, entering directly at BUILD with the persisted plan.
The OpenCode plugin (`src/index.ts` → `src/loop/`) advances stages on
`session.idle`, threading each stage's output into the next as context.

There used to be an in-loop PLAN stage with a `/loop go` gate; planning moved
out of the loop entirely — the plan is authored, reviewed, and approved
before the loop ever starts, so the running pipeline needs no mid-flight
human gate. (Earlier still there were DEFINE and SHIP stages; a REVIEW PASS
finishes the loop directly — ship the diff yourself.)

## When to Use

- Use when a backlog task should run the whole BUILD→REVIEW lifecycle
  unattended, instead of invoking `/build`, `/verify`, `/review` one at a time.
- Use when picking up an approved task (`/loop task <id>`, `/loop watch`) —
  see `task-backlog-management`.
- Not for a single standalone stage — `/plan`, `/build`, `/verify`, `/review`
  each work outside the loop too, for one-off use.
- Not for changes you want to hand-hold through every step — the loop's value
  is in running BUILD→VERIFY→REVIEW unattended; if you want to review each
  stage individually, drive the stage commands by hand.

## The pipeline

```
planning (the /loop-plan command, interactive):
  /loop-plan new <idea> ──▶ interview ──▶ planless draft in draft/
  /loop-plan task <id>  ──▶ moves draft to in-planning/ + writes ## Implementation Plan
  /loop-plan approve <id> ─▶ validated + parked in in-progress/   ← the human gate

execution (the /loop command, unattended):
  /loop task <id>  — claim one approved task now
  /loop watch [interval] — claim them as they appear (idle events + polling timer)
                     ▼
        claim ─▶ BUILD ─▶ VERIFY ─▶ REVIEW ─▶ done (task → in-review/)
                   ▲        │FAIL              │FAIL
                   └────────┴──────────────────┘
                   (re-build, iteration++, inline)
```

| Stage | Writes code? | Role |
|-------|--------------|------|
| build | **yes** | implements the approved plan test-first on the loop's own `loop/<id>` branch, or applies a VERIFY/REVIEW stage's feedback on a re-build; each iteration is committed as a checkpoint |
| verify | no | runs tests (bash allowlist), checks acceptance criteria, records `PASS`/`FAIL`/`ERROR` via the `loop_verdict` tool |
| review | no | five-axis code review of exactly `git diff base...branch` (read-only bash allowlist), records `PASS`/`FAIL`/`ERROR` via the `loop_verdict` tool |

## Process

1. `/loop-plan new <idea>` — the `loop-plan-author` agent **always
   interviews you** (a restate-and-confirm at minimum, a full interview when
   the idea is vague) to pin down the goal and testable acceptance criteria,
   confirms the draft with you, and writes a planless draft to `draft/`.
   Then `/loop-plan task <id>` — after you review the draft — moves it to
   `in-planning/` (plugin-side, audited + committed) and writes the
   `## Implementation Plan` onto the file in place (the same command re-plans
   a task whose loop hit the iteration cap).
2. `/loop-plan approve <id>` — the plugin validates the plan exists, moves
   the file to `in-progress/`, appends an audited note, and commits. This is
   the human sign-off before any code is written.
3. Execute: `/loop task <id>` claims that task now, in this session; or
   `/loop watch [interval]` turns this session into a standing execution
   worker that claims approved tasks as they appear — on every idle tick,
   plus a polling timer (default cadence `watchIntervalMinutes`, override
   per-session: `/loop watch 30s`). The loop enters at BUILD with the plan
   threaded in.
   - A VERIFY FAIL within `maxIterations` **re-builds** with the failure fed
     back in, inline in this same session.
   - A REVIEW FAIL within `maxIterations` re-builds with the review's
     findings fed back in, same session.
   - The cap tripping means the plan itself is suspect — the loop stops and
     a human re-plans via `/loop-plan task <id>`, then re-approves.
4. On a REVIEW PASS, the loop is done and the task moves to `in-review/` —
   the human diff gate. Review `git diff <base>...loop/<id>` yourself, push
   and open the PR, then run `/loop ship <id>` to move the task to
   `completed/` (an audited move) — the loop never does those steps for you.
5. `/loop stop` aborts and exits watch mode (timer included); `/loop unwatch`
   exits watch mode alone (a build already claimed still finishes); `/loop
   status` shows the current loop plus a whole-backlog roll-up (counts +
   awaiting-approval/claimable/interrupted/in-review flags); `/loop recover
   <id>` resumes an in-progress task whose run died mid-build
   (crash/restart) — from its **state snapshot** at the exact stage it
   reached, or from the persisted plan when no valid snapshot exists. Plugin
   startup logs any interrupted tasks and leftover snapshots it finds.

## Planning is a command, execution is the loop

- **Interview (always, inside `/loop-plan new`).** The author agent runs the
  `interview-me` skill live with you on every `new` — a single
  restate-and-confirm when the idea already carries a clear goal and testable
  criteria, one question at a time until there's an explicit yes on a
  restated intent when it doesn't. It also confirms the drafted task before
  writing anything.
- **Approve (always, `/loop-plan approve <id>`).** Nothing gets executed
  until a human approves the plan — deterministic plugin code validates the
  `## Implementation Plan` heading and parks the task in `in-progress/`.
  There is no way to start the loop on an unapproved task: `/loop task <id>`
  only searches `in-progress/`.
- **Watch → claim (explicit opt-in, `/loop watch`).** No session builds
  anything just because it went idle. A human must run `/loop watch` in a
  session for it to become an execution worker; that session then claims and
  drives approved tasks unattended until `/loop unwatch`/`/loop stop`.

## Execution: `/loop watch`

A watch session claims work from two triggers: its own `session.idle` events,
and a per-session **polling timer** (`/loop watch [interval]`; default
`watchIntervalMinutes` from config, floor 10s). Each timer tick first asks
the server whether the session is actually idle (`client.session.status()`)
and does nothing otherwise — the timer exists for the case idle events miss:
a task approved in *another* session while this one sat quiet.

When it fires, the watcher scans `docs/tasks/in-progress/` for tasks where
`isClaimable(task)` is true — has a persisted plan (`## Implementation
Plan`), and has **never** had any `> BUILD started` note (not just "the last
one is unmatched" — that's `wasInterrupted`, a different check used for crash
recovery). It picks the lowest-priority claimable task (ties by id) and
claims it **atomically**: a non-recursive `mkdir` of
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
FAIL     # otherwise → re-build with the failure fed back, if iteration budget remains
ERROR    # the check itself could not run (broken environment) → stop for a human, no iteration burned
```

No tool call at all is treated as FAIL, not as a stall — the loop still
terminates via the iteration cap rather than hanging indefinitely.

The tool also accepts optional `reason` (a one-line summary) and `criteria`
(per-acceptance-criterion `{criterion, pass}` results). These steer only the
**next iteration's prompt** — the failed criteria are threaded ahead of the
stage's prose so the re-build leads with what actually failed — never
control flow, which remains `verdict` alone. They arrive through the same
trusted tool call as the verdict, so they carry no extra trust.

## Termination

- **REVIEW PASS** → loop done; the task moves to `in-review/`. Review
  `git diff <base>...loop/<id>`, push/open the PR, then run `/loop ship <id>`
  to move the task to `completed/`.
- **FAIL** (verify or review) and `iteration + 1 < maxIterations` → re-build
  with the failure feedback threaded in (a verify-FAIL re-build drops stale
  review feedback and vice versa — old feedback judged an older build).
- **FAIL** and the cap is reached → stop and report; if the plan itself is
  wrong, re-plan with `/loop-plan task <id>`. Default `maxIterations` is 3,
  shared across both feedback loops (configurable).
- **ERROR** (verify or review) → stop immediately for a human; fix the
  environment, then `/loop recover <id>`.
- A stage exceeding `stageTimeoutMinutes` fails the loop (partial work is
  checkpointed on the branch) instead of wedging the driver.

## Audit trail

Every lifecycle event — plan approved (with the approver's git identity),
build start/finish, each verdict (with its reason and any failed criteria),
stop, recovery, completion — is appended to the task file as a timestamped
note, and each stage's full output is written to `<tasksDir>/runs/<id>.md`.
On termination the run log also gets a `## Run summary` table: per-stage
wall-clock, verdict history, and iterations used. Secrets echoed into any of
these durable artifacts are shape-redacted (`AKIA…`, `sk-…`, tokens, PEM
blocks, `key/secret/token: …`) before they are written. Approval commits are
scoped to the tasks dir; execution-phase notes ride the branch checkpoints in
shared-tree mode, or are committed to the main tree per terminal event in
worktree mode. See `docs/design/threat-model.md`.

## Config

Optional `.agentic-loop.json` at the repo root — every field has a default:

```jsonc
{
  "maxIterations": 3,           // shared cap on verify-FAIL + review-FAIL re-builds
  "tasksDir": "docs/tasks",     // root of the task backlog — see task-backlog-management
  "stageTimeoutMinutes": 60,    // wall-clock cap per stage; exceeding it fails the loop
  "watchIntervalMinutes": 5,    // default /loop watch polling cadence (override: /loop watch 30s)
  "worktreesDir": ".loop-worktrees", // OPTIONAL: per-task git worktree isolation (unset ⇒ shared-tree branch switching)
  "worktreeSetup": "npm ci",    // OPTIONAL: command run in a fresh worktree (deps aren't checked out)
  "reviewLenses": ["correctness", "security", "test-adequacy"] // OPTIONAL: multi-pass review, worst verdict wins
}
```

(`gateBeforeBuild` and `interviewBeforePlan` no longer exist — the gate is
`/loop-plan approve`, and interviewing lives inside `/loop-plan new`. Old
config files carrying them still parse; the keys are ignored.)

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
| "The plan looks obviously right, skip approve" | BUILD is the only stage that edits files — a bad plan compounds into a bad diff. `/loop-plan approve <id>` is one command; it also writes the audit note and commit that say who approved what. |
| "Just run /build directly, the loop is overhead" | Fine for a single isolated change. Once VERIFY/REVIEW feedback loops matter (multi-step goals, backlog tasks), the loop's re-build wiring is exactly the part you'd otherwise hand-roll. |
| "The verify keeps failing, the loop should re-plan itself" | Rejected on purpose — planning needs a human in the loop. The iteration cap stops execution, and `/loop-plan task <id>` re-plans with you watching. |
| "Any idle session should just pick up ready work" | Rejected on purpose — an ordinary chat session must never spontaneously start writing code because it went idle. `/loop watch` is explicit opt-in, per session. |
| "Poll every second so pickup is instant" | The interval floor is 10s and the default 5m for a reason — each tick costs a status query and a folder scan, and the idle-event path already gives instant pickup in the common case. |

## Red Flags

- A re-build (from a VERIFY FAIL) that ignores the "Verify failure to
  address" context and repeats the previous implementation verbatim.
- A check stage that wrote a `LOOP_VERIFY`/`LOOP_REVIEW` text line but never
  called `loop_verdict` — the loop logs the discrepancy and records FAIL;
  the subagent didn't follow its contract.
- An approved task sitting in `in-progress/` indefinitely — nothing is
  watching it. `/loop watch` in some session, or `/loop task <id>` it directly.
- A stale `.claims/<id>` marker for a task with no live loop — the claiming
  run died; `/loop recover <id>` re-claims and resumes it.
- A task sitting in `in-review/` — that's not a stall, it's the human diff
  gate; review the branch and run `/loop ship <id>` when it ships.
- A task in `in-planning/` with a plan that nobody approves or rejects —
  the queue only moves when a human runs `/loop-plan approve <id>`.

## Verification

- [ ] `/loop status` reflects the actual current stage while a loop runs, and
      the watch cadence when watching.
- [ ] Every VERIFY and REVIEW turn calls `loop_verdict` exactly once, and its
      text line matches the recorded verdict.
- [ ] No file was edited by a task that never got `/loop-plan approve`d, and
      every build edit landed on the `loop/<id>` branch, never the base branch.
- [ ] A stopped/failed loop leaves its task (if any) in `in-progress/` with a
      timestamped note — never silently disappears or is left in `completed/`.
- [ ] A REVIEW PASS parks the task in `in-review/`; only a human moves it to
      `completed/`.
- [ ] `/loop-plan approve <id>` refuses a task with no `## Implementation
      Plan` heading.
- [ ] A `/loop watch` session only ever claims a task that `isClaimable`
      would return `true` for, and holds its `.claims/<id>` marker while
      driving it.
- [ ] No session builds anything without a human having run `/loop watch`
      (or `/loop task <id>`) in it first.
- [ ] `/loop unwatch` and `/loop stop` stop the polling timer — no further
      tick fires after either.
