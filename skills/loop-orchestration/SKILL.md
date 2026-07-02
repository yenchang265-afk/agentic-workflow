---
name: loop-orchestration
description: Explains the automatic agentic engineering loop (define → plan → build → verify → review → ship) driven by the OpenCode `/loop` plugin command. Use when you need to understand how /loop advances stages, where the two human gates are, the LOOP_VERIFY/LOOP_REVIEW verdict contracts, or how the loop terminates.
---

# The agentic loop

## Overview

`/loop <goal>` drives the full engineering lifecycle — DEFINE, PLAN, BUILD,
VERIFY, REVIEW, SHIP — as one automatic pipeline instead of six manual slash
commands. The OpenCode plugin (`src/index.ts` → `src/loop/`) advances stages on
`session.idle`, threading each stage's output into the next as context, and
pausing at two human gates so nothing gets edited or shipped without sign-off.

## When to Use

- Use when a goal or backlog task should run the whole DEFINE→SHIP lifecycle
  unattended between gates, instead of invoking `/spec`, `/plan`, `/build`,
  `/test`, `/review`, `/ship` one at a time.
- Use when picking up or resuming a task from `docs/tasks/in-planning/`
  (`/loop next`, `/loop task <id>`) — see `task-backlog-management`.
- Not for a single standalone stage — `/plan`, `/build`, `/verify`, `/review`,
  etc. each work outside the loop too, for one-off use.
- Not for changes you want to hand-hold through every step — the loop's value
  is in running BUILD→VERIFY→REVIEW unattended between the two gates; if you
  want to review each stage individually, drive the stage commands by hand.

## The pipeline

```
/loop <goal> ─▶ DEFINE ─▶ PLAN ─GATE(/loop go)─▶ BUILD ─▶ VERIFY ─▶ REVIEW ─GATE(/loop go)─▶ SHIP ─▶ done
                                    ▲                         │                  │
                                    └──── VERIFY FAIL ─────────┘                  │
                                    (re-plan, iteration++)                        │
                                    ▲                                             │
                                    └──────────── REVIEW FAIL (re-build) ─────────┘
                                                   (iteration++)
```

| Stage | Writes code? | Role |
|-------|--------------|------|
| define | no | turns the raw goal into a short spec (problem, goals, non-goals, acceptance boundaries) |
| plan | no | reads the code itself; ordered, review-sized plan + testable acceptance criteria |
| build | **yes** | implements the approved plan test-first, or applies a REVIEW stage's fix requests on a re-build |
| verify | no | runs tests, checks acceptance criteria, emits `LOOP_VERIFY: PASS`/`FAIL` |
| review | no | five-axis code review of the diff, emits `LOOP_REVIEW: PASS`/`FAIL` |
| ship | no* | runs the pre-launch checklist, drafts a PR description + rollback plan (never pushes/opens a PR itself) |

## Process

1. `/loop <goal>` — start; runs DEFINE then PLAN, then pauses at the plan gate.
2. `/loop go` — approve the plan; runs BUILD → VERIFY → REVIEW.
   - A VERIFY FAIL within `maxIterations` re-plans with the failure fed back in
     (the plan itself is what's in question).
   - A REVIEW FAIL within `maxIterations` re-builds with the review's findings
     fed back in (the plan is assumed sound; the implementation isn't).
3. On a REVIEW PASS, the loop pauses again at the ship gate.
4. `/loop go` — approve; runs SHIP, then the loop finishes. Review the PR
   draft and rollback plan SHIP produced, then push and open the PR yourself —
   the loop never does that step for you.
5. `/loop stop` aborts and clears state at any point; `/loop status` shows the
   current stage, iteration, and whether it's paused at a gate.

## The two human gates

- **Plan → build.** DEFINE and PLAN never touch a file. Nothing gets edited
  until a human runs `/loop go` at the plan gate — that is the sign-off before
  any code is written. When the loop is driven from a backlog task, this same
  `/loop go` also moves the task file `in-planning/ → in-progress/` (see
  `task-backlog-management`) — the folder move just records the approval
  that already happened, not a second gate.
- **Review → ship.** VERIFY and REVIEW never edit a file either. Nothing gets
  shipped until a human runs `/loop go` at the review gate, after reading the
  five-axis review findings and the passing verdict.

Both gates default on and are configurable (`gateBeforeBuild`, `gateBeforeShip`
in `.agentic-loop.json`).

## The verdict contracts

VERIFY and REVIEW each end their output with exactly one machine-readable line
that the driver greps to decide what happens next:

```
LOOP_VERIFY: PASS    # every acceptance criterion met, tests green → advance to review
LOOP_VERIFY: FAIL    # otherwise → re-plan (if iteration budget remains)

LOOP_REVIEW: PASS    # no Critical/Important findings on any axis → gate before ship
LOOP_REVIEW: FAIL    # otherwise → re-build (if iteration budget remains)
```

A missing or garbled verdict is treated as FAIL, not as a stall — the loop
still terminates via the iteration cap rather than hanging indefinitely.

## Termination

- **SHIP finishes** → loop done. Review the draft, then push/open the PR.
- **FAIL** (verify or review) and `iteration + 1 < maxIterations` → loop back
  (re-plan or re-build) with the failure feedback threaded in.
- **FAIL** and the cap is reached → stop and report. Default `maxIterations`
  is 3, shared across both feedback loops (configurable).

## Config

Optional `.agentic-loop.json` at the repo root — every field has a default:

```jsonc
{
  "maxIterations": 3,        // shared cap on verify-FAIL re-plans + review-FAIL re-builds
  "gateBeforeBuild": true,   // pause for plan approval before build edits anything
  "gateBeforeShip": true,    // pause for review approval before ship prepares release artifacts
  "tasksDir": "docs/tasks"   // root of the task backlog — see task-backlog-management
}
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The plan looks obviously right, skip the gate" | `gateBeforeBuild` exists because BUILD is the only stage that edits files — a bad plan compounds into a bad diff. Turn the gate off deliberately in config if you truly want unattended builds; don't skip it ad hoc. |
| "REVIEW passed, ship it without looking" | The ship gate is the last chance to catch something a five-axis review missed (business context, deploy timing). Read the PR draft before approving. |
| "Just run /build directly, the loop is overhead" | Fine for a single isolated change. Once VERIFY/REVIEW feedback loops matter (multi-step goals, backlog tasks), the loop's re-plan/re-build wiring is exactly the part you'd otherwise hand-roll. |
| "REVIEW FAIL, just re-plan from scratch" | REVIEW FAIL routes to BUILD, not PLAN, on purpose — the plan already passed VERIFY. Re-planning throws away a working implementation over a quality finding. |

## Red Flags

- A loop stuck at a gate with no toast/status update — check `/loop status`;
  the plugin may have failed to fire (see plugin logs via `client.app.log`).
- SHIP output that includes an actual `git push`/`gh pr create` — the ship
  subagent's hard rule is violated; it should only draft, never execute.
- A re-plan (from VERIFY FAIL) that ignores the "Verify failure to address"
  context and repeats the previous plan verbatim.
- `LOOP_VERIFY`/`LOOP_REVIEW` verdict lines appearing more than once, or not
  at the very end of a stage's output — the driver takes the last match, but
  an ambiguous verdict usually means the subagent didn't follow its contract.

## Verification

- [ ] `/loop status` reflects the actual current stage after each `/loop go`.
- [ ] Every VERIFY and REVIEW response ends with exactly one verdict line.
- [ ] No file was edited before the plan gate was approved.
- [ ] No `git push`/PR/deploy command ran before a human acted on the SHIP draft.
- [ ] A stopped/failed loop leaves its task (if any) in `in-progress/` with a
      note — never silently disappears or is left in `completed/`.
