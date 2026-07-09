---
name: loop-orchestration
description: Explains the automatic agentic loop driven by the OpenCode `/agent-loop` plugin command — declarative loop kinds under `loops/<kind>/`, with the engineering kind (plan → build → verify → review) as the default — and the `/agent-loop-task` command that authors tasks and holds the human gates. Use when you need to understand how /agent-loop plans and executes stages, how the park-at-gate plan review works, the loop_verdict contracts, how loop kinds and the scheduler work (e.g. the pr-sitter kind), or how the loop terminates.
---

# The agentic loop

## Overview

The lifecycle is split into two commands. **`/agent-loop-task`** is the
authoring-and-gates side: its agent interviews you into a planless draft
(`new <idea>`), `retask <id>` re-interviews and reshapes a draft in place,
`approve <id>` is the task gate that parks it in `queued/`, and
`approve-plan <id>` / `replan <id>` are the plan gate. **`/agent-loop`** is
the loop side: it plans a queued task **right before execution** (so plans
don't rot while tasks sit parked) and drives BUILD, VERIFY, REVIEW as one
automatic pipeline over a plan-approved task. The PLAN stage never blocks on
a human: it writes the `## Implementation Plan` onto the task file, **parks
the task in `plan-review/`, and exits** — park-at-gate, not block-at-gate.
The OpenCode plugin (`src/index.ts` → `src/loop/`) advances stages on
`session.idle`, threading each stage's output into the next as context.

The pipeline shape is **not hardcoded**. It is the **engineering loop
kind**, declared in `loops/engineering/loop.json` (stages, transitions,
iteration cap, work source, per-stage bash allowlists) with prompt templates
under `loops/engineering/stages/`, and interpreted by the pure engine in the
shared `@agentic-loop/core` package. Other kinds — like `pr-sitter` —
declare different pipelines over different work sources; see
"Loop kinds and the scheduler" below. Everything else in this skill —
PLAN/BUILD/VERIFY/REVIEW, the gates, park-at-gate, the verdict protocol —
describes the engineering kind, whose behavior is identical to the original
hardcoded loop.

(Historical note: an earlier design had planning fully outside the loop in a
`/agent-loop-plan` command, and before that an in-loop PLAN with a blocking
`/agent-loop go` gate. The current shape keeps planning in the loop for
freshness but replaces the blocking gate with the plan-review park. Earlier
still there were DEFINE and SHIP stages; a REVIEW PASS finishes the loop
directly — ship the diff yourself.)

## When to Use

- Use when a backlog task should run the whole BUILD→REVIEW lifecycle
  unattended, instead of invoking `/build`, `/verify`, `/review` one at a time.
- Use when picking up an approved task (`/agent-loop task <id>`, `/agent-loop watch`) —
  see `task-backlog-management`.
- Not for a single standalone stage — `/plan`, `/build`, `/verify`, `/review`
  each work outside the loop too, for one-off use.
- Not for changes you want to hand-hold through every step — the loop's value
  is in running BUILD→VERIFY→REVIEW unattended; if you want to review each
  stage individually, drive the stage commands by hand.

## The pipeline

```
authoring + gates (the /agent-loop-task command, interactive):
  /agent-loop-task new <idea>      ──▶ interview ──▶ planless draft in draft/
  /agent-loop-task retask <id> [note] ▶ re-interview ──▶ draft rewritten in place (same id)
  /agent-loop-task approve <id>    ──▶ parked in queued/            ← the task gate
  /agent-loop-task approve-plan <id> ▶ plan-review/ → in-progress/  ← the plan gate
  /agent-loop-task replan <id> [why] ▶ back to queued/ (audited rejection)

the loop (the /agent-loop command, unattended — never blocks on a human):
  /agent-loop task <id>  — run one task now
  /agent-loop watch [interval] — claim work as it appears (idle events + polling timer)

  queued task:      claim ─▶ PLAN ─▶ park (task → plan-review/, loop exits)
  in-progress task: claim ─▶ BUILD ─▶ VERIFY ─▶ REVIEW ─▶ done (task → in-review/)
                              ▲        │FAIL              │FAIL
                              └────────┴──────────────────┘
                              (re-build, iteration++, inline)
```

| Stage | Writes code? | Role |
|-------|--------------|------|
| plan | no (task file only) | reads the task + relevant code and writes the `## Implementation Plan` onto the task file in place, in the main tree; terminates with a park — the task moves to `plan-review/` for the human gate |
| build | **yes** | implements the approved plan test-first on the loop's own `feature/<id>` branch, or applies a VERIFY/REVIEW stage's feedback on a re-build; each iteration is committed as a checkpoint |
| verify | no | runs tests (bash allowlist), checks acceptance criteria, records `PASS`/`FAIL`/`ERROR` via the `loop_verdict` tool |
| review | no | five-axis code review of exactly `git diff base...branch` (read-only bash allowlist), records `PASS`/`FAIL`/`ERROR` via the `loop_verdict` tool |

## Process

1. `/agent-loop-task new <idea>` — the command's own agent **always
   interviews you** (a restate-and-confirm at minimum, a full interview when
   the idea is vague) to pin down the goal and testable acceptance criteria and
   confirms the draft with you; subagents can't converse, so it then hands the
   confirmed intent to the `loop-plan-author` subagent, which writes the
   planless draft to `draft/`. A **heavy idea is split into sibling drafts** —
   vertical, independently shippable slices ordered by `priority`, plus one
   `type: epic` tracking draft that is never approved. See
   `task-backlog-management` → "Slicing a heavy idea".
2. `/agent-loop-task approve <id>` — after you review the draft — the plugin
   moves it to `queued/` with an audited "Task approved" note and commits.
   No plan yet, by design.
3. The loop plans it: `/agent-loop task <id>` now, or a `/agent-loop watch`
   session when no build work remains. The PLAN stage (the
   `loop-plan-author` agent in task mode) reads the code, writes the
   `## Implementation Plan` onto the task file in place, and the driver
   parks the task in `plan-review/` — the loop exits rather than waiting.
4. `/agent-loop-task approve-plan <id>` — the plugin validates the plan
   exists, moves the file to `in-progress/`, appends an audited note, and
   commits. This is the human sign-off before any code is written.
   `/agent-loop-task replan <id> <why>` rejects instead: back to `queued/`
   with the reason audited, and the next PLAN pass must address it.
5. Execute: `/agent-loop task <id>` claims that task now, in this session; or
   `/agent-loop watch [interval]` turns this session into a standing worker
   that claims work as it appears — on every idle tick, plus a polling timer
   (default cadence `watchIntervalMinutes`, override per-session:
   `/agent-loop watch 30s`). Build-ready tasks beat queued ones. The loop
   enters at BUILD with the approved plan threaded in.
   - A VERIFY FAIL within `maxIterations` **re-builds** with the failure fed
     back in, inline in this same session.
   - A REVIEW FAIL within `maxIterations` re-builds with the review's
     findings fed back in, same session.
   - The cap tripping means the plan itself is suspect — the loop stops and
     a human sends it back via `/agent-loop-task replan <id> <why>`.
6. On a REVIEW PASS, the loop is done and the task moves to `in-review/` —
   the human diff gate. Review `git diff <base>...feature/<id>` yourself, push
   and open the PR, then run `/agent-loop ship <id>` to move the task to
   `completed/` (an audited move) — the loop never does those steps for you.
7. `/agent-loop stop` aborts and exits watch mode (timer included); `/agent-loop unwatch`
   exits watch mode alone (a build already claimed still finishes); `/agent-loop
   status` shows the current loop plus a whole-backlog roll-up (counts +
   awaiting-approval/claimable/interrupted/in-review flags); `/agent-loop recover
   <id>` resumes an in-progress task whose run died mid-build
   (crash/restart) — from its **state snapshot** at the exact stage it
   reached, or from the persisted plan when no valid snapshot exists. Plugin
   startup logs any interrupted tasks and leftover snapshots it finds.

## The gates are a command, planning and execution are the loop

- **Interview (always, inside `/agent-loop-task new`).** The command's own
  agent runs the `interview-me` skill live with you on every `new` — a single
  restate-and-confirm when the idea already carries a clear goal and testable
  criteria, one question at a time until there's an explicit yes on a
  restated intent when it doesn't. It also confirms the drafted task before
  handing it to the `loop-plan-author` subagent to write (subagents can't
  converse with you).
- **Two approvals (always, `/agent-loop-task`).** `approve <id>` gates the
  task (scope + acceptance) into `queued/`; `approve-plan <id>` gates the
  loop-written plan into `in-progress/`. Nothing gets built until a human
  has approved both — deterministic plugin code validates the
  `## Implementation Plan` heading at the plan gate. There is no way to
  build an ungated task: BUILD only ever claims from `in-progress/`.
  `/agent-loop approve` is the one-word shortcut for the plan gate (and the ship
  gate) when a single task is waiting; `/agent-loop reject` is the shortcut for
  `replan`. It does not approve drafts — the task gate stays `/agent-loop-task
  approve <id>`. The explicit `<id>` verbs stay the unambiguous path when two or
  more tasks wait.
- **Park, don't block.** The PLAN stage ends its loop by parking the task in
  `plan-review/`. A watcher can plan an entire queue overnight and exit each
  time; you batch-review the plans whenever suits and approve or replan each
  — the pipeline never sits blocked inside a live session.
- **Watch → claim (explicit opt-in, `/agent-loop watch`).** No session plans or
  builds anything just because it went idle. A human must run
  `/agent-loop watch` in a session for it to become a worker; that session then
  claims and drives work unattended until `/agent-loop unwatch`/`/agent-loop stop`.

## Execution: `/agent-loop watch`

A watch session claims work from two triggers: its own `session.idle` events,
and a per-session **polling timer** (`/agent-loop watch [interval]`; default
`watchIntervalMinutes` from config, floor 10s). Each timer tick first asks
the server whether the session is actually idle (`client.session.status()`)
and does nothing otherwise — the timer exists for the case idle events miss:
a task approved in *another* session while this one sat quiet.

When it fires, the watcher first scans `docs/tasks/in-progress/` for tasks
where `isClaimable(task)` is true — has a persisted plan (`## Implementation
Plan`), and has **never** had any `> BUILD started` note (not just "the last
one is unmatched" — that's `wasInterrupted`, a different check used for crash
recovery). With no build work, it falls back to `docs/tasks/queued/` for a
task to plan-and-park — build work always beats plan work, so tasks in
flight finish before new ones spin up. When other loop kinds are enabled in
`.agentic-loop.json`, the same tick then polls their work sources after the
engineering backlog comes up empty (e.g. pr-sitter's GitHub PR query) — see
"Loop kinds and the scheduler". Within the backlog it picks the
lowest-priority claimable task (ties by id) and claims it **atomically**: a
non-recursive `mkdir` of `<folder>/.claims/<id>` either succeeds (claim won)
or fails because another watcher on the same filesystem got there first. The
`> BUILD started` note remains the human-readable audit record; the marker
directory is the lock. (A queued claim marker orphaned by a crashed PLAN is
always safe to release once stale — PLAN writes no code.)

In **shared-tree mode** (default), a per-directory execution lock additionally
serializes drives within one opencode instance — all sessions share one
working tree and one checked-out branch, so only one loop may run stages in it
at a time. In **worktree mode** (`worktreesDir` set) each loop owns its own
worktree, so that lock is dropped and multiple `/agent-loop watch` sessions can
drive different tasks concurrently in one instance. **Not covered either way:**
separate opencode *processes* racing the same backlog clone on `index.lock`
during backlog commits (best-effort). Run additional watchers in their own
clones for hard isolation.

## Loop kinds and the scheduler

A loop kind is declared in `loops/<kind>/loop.json`: its stages (each
`work` — edits things — or `check` — records a verdict), a transition table
(effects `fire` the next stage, `park` at a human gate, `done` the loop, or
`stop` for a human), an iteration cap, a **work source** binding (where
claimable work comes from), and per-stage bash allowlists for check stages.
Stage prompts live in `loops/<kind>/stages/*.md`. The engine in
`@agentic-loop/core` interprets the manifest; adding a kind means writing a
manifest and prompts, not driver code.

A common scheduler step (`pollOnce`) runs on every claim trigger — idle
events and the watch timer — and walks the **enabled** kinds' work sources
in claim-priority order: the engineering backlog-folder source first
(atomic `.claims/` markers, semantics unchanged), then opted-in kinds. The
first source that yields a claim wins the tick. Kinds are enabled per
`loops.<kind>` sections in `.agentic-loop.json` — engineering is on by
default; every other kind is off until you add its section.

### The pr-sitter kind

`loops/pr-sitter/` sits on open pull requests matching a configured `gh`
query and keeps them green until a human merges:

```
triage (check) ─▶ fix (work) ─▶ verify (check) ─▶ publish (work) ─▶ done
                   ▲               │FAIL (re-fires fix, cap 3)
                   └───────────────┘
```

- **triage** — read-only `gh` inspection of a PR needing attention (failing
  checks, changes requested, new comments, merge conflict); emits findings
  and a `loop_verdict`: PASS = actionable, FAIL = nothing to do → done,
  ERROR = couldn't inspect → stop.
- **fix** — commits on the PR's **existing branch** in a worktree; never
  pushes.
- **verify** — tests + findings coverage, reusing the existing `loop-verify`
  agent; FAIL re-fires fix within the cap (3).
- **publish** — `git push origin <branch>` plus `gh pr comment` replies per
  addressed finding. It **never merges, closes, or approves** — merging
  stays a human call.

Dedup is a per-PR ledger under `<tasksDir>/runs/pr-sitter/pr-<n>.json`:
head-SHA and comment-timestamp watermarks plus an own-login filter, so the
sitter never reacts to its own pushes or replies; a capped/failed attempt
parks the PR until a human pushes a new head. Enable it with:

```jsonc
{ "loops": { "pr-sitter": { "enabled": true, "query": "is:open author:@me" } } }
```

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

The same contract covers every manifest **check** stage, not just VERIFY and
REVIEW: `loop_verdict` accepts any check stage of the running loop's kind
(engineering: `verify`/`review`; pr-sitter: `triage`/`verify`), validated
against that kind's manifest, and a missing verdict on a check stage is
still FAIL.

The tool also accepts optional `reason` (a one-line summary) and `criteria`
(per-acceptance-criterion `{criterion, pass}` results). These steer only the
**next iteration's prompt** — the failed criteria are threaded ahead of the
stage's prose so the re-build leads with what actually failed — never
control flow, which remains `verdict` alone. They arrive through the same
trusted tool call as the verdict, so they carry no extra trust.

## Termination

- **REVIEW PASS** → loop done; the task moves to `in-review/`. Review
  `git diff <base>...feature/<id>`, push/open the PR, then run `/agent-loop ship <id>`
  to move the task to `completed/`.
- **FAIL** (verify or review) and `iteration + 1 < maxIterations` → re-build
  with the failure feedback threaded in (a verify-FAIL re-build drops stale
  review feedback and vice versa — old feedback judged an older build).
- **FAIL** and the cap is reached → stop and report; if the plan itself is
  wrong, send it back with `/agent-loop-task replan <id> <why>`. Default
  `maxIterations` is 3, shared across both feedback loops (configurable).
- **ERROR** (verify or review) → stop immediately for a human; fix the
  environment, then `/agent-loop recover <id>`.
- A stage exceeding `stageTimeoutMinutes` fails the loop (partial work is
  checkpointed on the branch) instead of wedging the driver.

## Audit trail

Every lifecycle event — task approved, plan written/parked, plan approved or
rejected (with the approver's git identity and the rejection reason),
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
  "watchIntervalMinutes": 5,    // default /agent-loop watch polling cadence (override: /agent-loop watch 30s)
  "worktreesDir": ".loop-worktrees", // OPTIONAL: per-task git worktree isolation (unset ⇒ shared-tree branch switching)
  "worktreeSetup": "npm ci",    // OPTIONAL: command run in a fresh worktree (deps aren't checked out)
  "reviewLenses": ["correctness", "security", "test-adequacy"], // OPTIONAL: multi-pass review, worst verdict wins
  "loops": {                    // OPTIONAL: per-kind sections; engineering is on by default, other kinds off until listed
    "pr-sitter": { "enabled": true, "query": "is:open author:@me" }
  }
}
```

(`gateBeforeBuild` and `interviewBeforePlan` no longer exist — the gates are
`/agent-loop-task approve` and `approve-plan`, and interviewing lives inside
`/agent-loop-task new`. Old config files carrying them still parse; the keys
are ignored.)

**Worktree isolation** (`worktreesDir`): each loop's BUILD/VERIFY/REVIEW runs
in its own `git worktree` on the `feature/<id>` branch instead of switching the
shared checkout's branch. The human's tree is never touched, and multiple
`/agent-loop watch` sessions can drive tasks concurrently in one instance (the
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
| "The plan looks obviously right, skip approve-plan" | BUILD is the only stage that edits files — a bad plan compounds into a bad diff. `/agent-loop-task approve-plan <id>` is one command; it also writes the audit note and commit that say who approved what. |
| "Just run /build directly, the loop is overhead" | Fine for a single isolated change. Once VERIFY/REVIEW feedback loops matter (multi-step goals, backlog tasks), the loop's re-build wiring is exactly the part you'd otherwise hand-roll. |
| "The verify keeps failing, the loop should re-plan itself" | Rejected on purpose — a plan only enters BUILD through the human gate. The iteration cap stops execution; `/agent-loop-task replan <id> <why>` re-queues it and the next PLAN pass runs with the failure context, but its output parks for your review again. |
| "Any idle session should just pick up ready work" | Rejected on purpose — an ordinary chat session must never spontaneously start writing code because it went idle. `/agent-loop watch` is explicit opt-in, per session. |
| "Poll every second so pickup is instant" | The interval floor is 10s and the default 5m for a reason — each tick costs a status query and a folder scan, and the idle-event path already gives instant pickup in the common case. |

## Red Flags

- A re-build (from a VERIFY FAIL) that ignores the "Verify failure to
  address" context and repeats the previous implementation verbatim.
- A check stage that wrote a `LOOP_VERIFY`/`LOOP_REVIEW` text line but never
  called `loop_verdict` — the loop logs the discrepancy and records FAIL;
  the subagent didn't follow its contract.
- An approved task sitting in `queued/` or `in-progress/` indefinitely —
  nothing is watching it. `/agent-loop watch` in some session, or
  `/agent-loop task <id>` it directly.
- A stale `.claims/<id>` marker for a task with no live loop — the claiming
  run died; `/agent-loop recover <id>` re-claims and resumes it.
- A task sitting in `in-review/` — that's not a stall, it's the human diff
  gate; review the branch and run `/agent-loop ship <id>` when it ships.
- A task in `plan-review/` that nobody approves or rejects — the pipeline
  only moves when a human runs `/agent-loop-task approve-plan <id>` (or
  `replan <id>`).

## Verification

- [ ] `/agent-loop status` reflects the actual current stage while a loop runs, and
      the watch cadence when watching.
- [ ] Every VERIFY and REVIEW turn calls `loop_verdict` exactly once, and its
      text line matches the recorded verdict.
- [ ] No file was edited by a task that never got `/agent-loop-task
      approve-plan`d, and every build edit landed on the `feature/<id>` branch,
      never the base branch (the PLAN stage edits only the task file).
- [ ] A stopped/failed loop leaves its task (if any) in `in-progress/` with a
      timestamped note — never silently disappears or is left in `completed/`.
- [ ] A REVIEW PASS parks the task in `in-review/`; only a human moves it to
      `completed/`.
- [ ] `/agent-loop-task approve-plan <id>` refuses a task with no
      `## Implementation Plan` heading, and the PLAN stage never parks a
      planless task in `plan-review/`.
- [ ] A `/agent-loop watch` session only ever claims a build task that
      `isClaimable` returns `true` for (or a queued task for PLAN), and
      holds its `.claims/<id>` marker while driving it.
- [ ] No session builds anything without a human having run `/agent-loop watch`
      (or `/agent-loop task <id>`) in it first.
- [ ] `/agent-loop unwatch` and `/agent-loop stop` stop the polling timer — no further
      tick fires after either.
