---
name: task-backlog-management
description: Explains the filesystem task backlog under docs/tasks/ that feeds the agentic loop. Use when writing, filing, or moving a task file, when running the /agentic-loop:engineering authoring or execution verbs, or when you need the task file schema and the folder-as-status lifecycle (draft/queued/plan-review/in-progress/in-review/completed/abandoned).
---

# The task backlog

## Overview

A task is one markdown file under `docs/tasks/`. **The folder it lives in is
its status** — there is no `status:` field, so the two can never drift. The
`/agentic-loop:engineering` command carries the whole lifecycle: `new` drafts via
interview, the unified folder-driven `approve` verb holds every human gate
(task, plan, ship), and the loop side (see
`loop-orchestration`) plans a queued task right before execution and builds
plan-approved ones.

This folder lifecycle is the **engineering loop kind's work source** (bound
via `packages/core/loops/engineering/loop.json`). Other loop kinds don't use these folders
— e.g. `pr-sitter` keeps its state on GitHub itself plus a per-PR dedup
ledger under `<tasksDir>/runs/pr-sitter/`. Everything below (statuses, gates,
who moves what) is the engineering backlog, unchanged.

## When to Use

- Use when you want a goal to persist across sessions as a durable, auditable
  backlog record.
- Use before running `/agentic-loop:engineering approve <id>`,
  `/agentic-loop:engineering replan <id>`, or `/agentic-loop:engineering plan <id>` —
  all read from this backlog.
- Use when reviewing what `/agentic-loop:engineering new` filed, reshaping a draft with
  `/agentic-loop:engineering retask <id>`, or moving a task to `abandoned/`.

## The folders

```
docs/tasks/
  draft/        # interviewed stubs, no plan (from /agentic-loop:engineering new, or hand-written)
  queued/       # task approved, planless — awaits the loop's PLAN stage      ← /agentic-loop:engineering approve moves here
  plan-review/  # plan written by the loop, parked for the human plan gate    ← the loop's PLAN stage moves here
  in-progress/  # plan approved: build-ready queue + build → verify → review  ← /agentic-loop:engineering approve moves here
  in-review/    # review passed, human diff gate                              ← the driver moves here automatically
  completed/    # shipped                                                     ← you move here (/agentic-loop:engineering approve), once the PR merges
  abandoned/    # won't do                                                    ← you move here, from any status
```

## Task file schema

One file per task. YAML frontmatter + a free-form markdown body:

```md
---
title: Add rate limiting to the API     # required
type: story                             # optional; issue/work-item type
priority: 2                             # optional; lower runs first (default 0)
estimate: 3                             # optional; story points / effort
assignee: jdoe@example.com              # optional; assignee / assigned-to
labels:                                 # optional; Jira labels / ADO tags
  - backend
acceptance:                             # optional; testable criteria → verify
  - Returns 429 over the limit
  - Limit is configurable per route
tracker:                                # optional; manually pair to a tracker item
  system: jira                          #   jira | azure-devops
  key: PROJ-123                         #   Jira issue key / ADO work item id
  url: https://acme.atlassian.net/browse/PROJ-123   # optional deep link
  parent: PROJ-100                      # optional; Jira Epic Link / ADO parent
---
Throttle authenticated callers to 100 req/min. The body is the description /
context; it becomes the loop's goal, with `acceptance` threaded into the build
and verify stages so the verdict checks each criterion.

## Implementation Plan

The plan — written by the loop's PLAN stage, right before execution. Its
presence (this exact heading) is what makes the plan approvable and, once
approved, buildable.
```

- **id** = the filename without `.md` (`add-foo.md` becomes `add-foo`). Stable, human-visible.
- **title** is required; everything else has a sane default.
- **acceptance** is optional but strongly recommended — it is what VERIFY checks.
  "What tests are needed" folds in here as concrete bullets rather than a
  separate field.
- **type / estimate / assignee / labels / tracker** align with the fields Jira
  issues and Azure DevOps work items share, so you can **manually pair** a task
  to a tracker item. Fill `tracker.system` (`jira` | `azure-devops`) and
  `tracker.key` (Jira issue key `PROJ-123` / ADO work item id `1234`) to link
  them; `url` and `parent` (Epic Link / parent) are optional. Field mapping:

  | task file    | Jira             | Azure DevOps          |
  | ------------ | ---------------- | --------------------- |
  | `title`      | Summary          | Title                 |
  | `type`       | Issue Type       | Work Item Type        |
  | `priority`   | Priority *(loop scheduling int, not the tracker's named scale — map by hand)* | Priority |
  | `estimate`   | Story Points     | Story Points / Effort |
  | `assignee`   | Assignee         | Assigned To           |
  | `labels`     | Labels           | Tags                  |
  | `acceptance` | Acceptance Crit. | Acceptance Criteria   |
  | `tracker`    | Issue Key + link | Work Item ID + link   |
- **`## Implementation Plan`** — the literal heading the plugin greps for.
  Without it, `/agentic-loop:engineering approve` refuses and the loop can never
  build the task.

## Process

1. **Draft** — `/agentic-loop:engineering new <idea>`: the calling agent **always
   interviews you** (a single restate-and-confirm when the idea is already
   sharp, a full interview when it's vague) to pin down the goal and
   testable acceptance criteria, confirms the draft with you, and hands it
   to the `loop-plan-author` subagent to write a **planless draft** to `draft/`.
   - You can also write a stub into `draft/` by hand.
2. **Approve the task** — `/agentic-loop:engineering approve <id>`: deterministic
   plugin code moves the reviewed draft to `queued/` with an audited
   "Task approved" note and commits. No plan exists yet, by design — the
   plan is written right before execution so it can't rot while the task
   sits parked.
3. **Plan (inside the loop)** — `/agentic-loop:engineering plan <id>` or a watch tick
   claims the queued task and runs the PLAN stage: `loop-plan-author` reads
   the relevant code and writes the `## Implementation Plan` onto the file
   in place, then the driver parks it in `plan-review/` and the loop exits —
   it never blocks waiting on a human.
4. **Approve the plan** — `/agentic-loop:engineering approve <id>`: deterministic
   plugin code checks the `## Implementation Plan` heading exists, moves the
   file to `in-progress/` (the build-ready queue), appends an audited
   "Plan approved" note, and commits. This is the human sign-off before any
   code is written. To reject instead, `/agentic-loop:engineering replan <id> <why>`
   sends it back to `queued/` with the reason on the audit trail.
5. **Build** — `/agentic-loop:engineering claim` (one pull, now) or `/agentic-loop:engineering watch
   [interval]` (standing worker; build-ready tasks beat queued ones). See
   `loop-orchestration`.

## Slicing a heavy idea into sibling drafts

Each task is planned, built, verified, and reviewed by **one agent in one
worktree context** (often a cheaper/degraded model), so a heavy idea won't fit
in a working context. The backlog *is* the decomposition primitive: at
`/agentic-loop:engineering new` the calling agent judges scope and, when the idea spans
slices (more than one independent deliverable, more than ~5 acceptance
criteria, or more than one subsystem/layer), splits it into **sibling drafts**
— each a **vertical, independently shippable slice** with its own acceptance
subset — plus one **epic tracking draft** (`type: epic`) whose body lists the
children in order. There is no token metering; "fits the context window" is a
scope judgement, not a measured limit.

- Children are ordered by `priority` (0, 1, 2 …). `priority` orders claims but
  does **not** block. A worktree branches from `origin/main`, so a child that
  builds on a sibling's code can't see it until that sibling ships — the human
  approves and ships stacked children one at a time, which *is* the dependency
  gate. Genuinely independent slices can run in any order.
- The **epic file is never approved** — an un-approved draft is inert, so the
  loop never claims it. It is a human-facing index; close it (move to
  `abandoned/` or `completed/`) once every child has shipped.

## Lifecycle — who moves what

| Transition | Who | When |
|------------|-----|------|
| into `draft/` | `/agentic-loop:engineering new` or you | an interviewed (or hand-written) planless stub |
| stays `draft/` (rewritten in place) | **`/agentic-loop:engineering retask <id> [note]`** | reshape a draft before approval — re-interview, overwrite the same file, keep the id; no folder move, drafts only |
| `draft → queued` | **`/agentic-loop:engineering approve <id>`** | the human task gate — scope + acceptance approved, planless by design; audited note + commit |
| `queued → plan-review` | driver | the loop's PLAN stage wrote the plan and parked it for review; audited note + commit |
| `plan-review → in-progress` | **`/agentic-loop:engineering approve <id>`** | the human plan gate; audited note + commit |
| `plan-review (or in-progress) → queued` | **`/agentic-loop:engineering replan <id> [reason]`** | plan rejected, or a cap-tripped task sent back — the next PLAN pass addresses the audited reason |
| `in-progress → in-review` | driver | automatic, the instant REVIEW returns PASS — parks it as the human diff gate |
| `in-review → completed` | **you** | you've reviewed the diff and shipped it — run `/agentic-loop:engineering approve <id>` (an audited move + commit) or move the file by hand; the loop never does this move on its own |
| stays `in-progress` + note | driver | loop fails (iteration cap) or is stopped while building |
| `→ abandoned` | **you** | you decide not to do it, from any status |

The gate verb is one and the same at every stop: **`/agentic-loop:engineering approve [id]`**
advances a task by the gate its folder implies (parked plan → build, finished
review → completed), and id-less it resolves the single task waiting at a
loop wait-gate — it never advances a draft without an explicit id.
**`/agentic-loop:engineering replan [id] [reason]`** is the matching rejection verb.

A failed or stopped task is **left in `in-progress/`** with a note appended, so
it is visibly stuck for a human rather than silently re-queued. `/agentic-loop:engineering recover
<id>` resumes it; if the plan itself was the problem, send it back with
`/agentic-loop:engineering replan <id> <why>` and gate the new plan again; or move it
to `abandoned/` to give up on it.

The `## Implementation Plan` section is the durable on-disk record — it
survives a `/agentic-loop:engineering stop` or an opencode restart, when the in-memory loop state
does not (state snapshots under `runs/` cover exact-stage crash recovery).

### Identifying an interrupted loop

What's on the task file tells you what happened:

- **A blockquote note** (`> ...`) — either a manual `/agentic-loop:engineering stop`/`/agentic-loop:engineering abort`,
  or an automatic iteration-cap stop (from a VERIFY or a REVIEW failure).
- **An unmatched `> BUILD started` note** (no matching `> BUILD finished` after
  it) — the only stage that edits files died mid-run, most likely a crash or a
  `/agentic-loop:engineering stop` issued while BUILD was active. Treat this as "check `git
  status`/`git diff` before doing anything else" — there may be a
  half-finished diff. `/agentic-loop:engineering recover <id>` resumes it (snapshot-exact, or at
  BUILD from the persisted plan).
- **No markers at all, just `## Implementation Plan`** — safe: approved and
  waiting, nothing has written code yet. This is exactly the `isClaimable`
  predicate a `/agentic-loop:engineering watch` session uses to pick its next task: has a plan,
  and has never had *any* `> BUILD started` note — not just "the last one is
  unmatched" (that's `wasInterrupted`, above). A task with any build marker
  at all, matched or not, is either being driven by a live watch session
  right now, or crashed and needs `/agentic-loop:engineering recover` — a watcher must never
  silently reclaim either case.

## Notes & limits

- The backlog path defaults to `docs/tasks` and is configurable via `tasksDir`
  in `.agentic-loop.json`.
- Execution is isolated on a `feature/<id>` branch (or per-task worktree, when
  configured); after the loop finishes, review the diff, then open the PR
  yourself.
- `→ abandoned` is a manual file move — there is no abandon command.
  `plan-review → in-progress` is `/agentic-loop:engineering approve`'s move;
  `in-progress → in-review` is the driver recording a review PASS. Neither is
  a second layer of file-moving bureaucracy — each records a decision that
  already happened.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll add a status: field, it's clearer" | The whole point is that the folder *is* the status — a separate field can drift from the folder and lie about the task's real state. |
| "This task failed once, just delete the note and retry silently" | The note is the audit trail for why a human needs to look before retrying (especially an unmatched BUILD-started marker, which can mean a half-finished diff). Deleting it hides that signal from the next person. |
| "Just mv the file to in-progress/, approve is bureaucracy" | A raw `mv` skips the plan validation, the audit note, and the commit that records who approved what. The command is one line and is the gate. |
| "Add another status for 'plan approved, waiting for a watcher'" | That moment is already visible: an in-progress task with a plan and no build markers is exactly `isClaimable`. It doesn't need its own folder. |
| "Skip the plan gate — the loop wrote the plan, just build it" | Plan-review park is the point of planning in the loop: the plan is fresh, but a human still signs off before any code is written. `approve <id>` is one line and is the gate. |

## Red Flags

- A task file with a `status:` key in its frontmatter — schema violation; the
  folder is the only source of truth.
- A task sitting in `in-progress/` with an unmatched `> BUILD started` note
  that nobody has checked `git status` against yet.
- A task sitting in `in-review/` — that's not a stall, it's the human diff
  gate; review the branch and run `/agentic-loop:engineering approve <id>` when it ships.
- A task in `completed/` whose diff was never actually reviewed/PR'd by a
  human — only a human moves a task into `completed/`, so this means someone
  moved the file (or ran `/agentic-loop:engineering approve`) without doing the review step first.
- A task in `completed/` with no "Shipped" audit note — it was moved by a raw
  `mv` instead of `/agentic-loop:engineering approve <id>`, so the completion isn't in the audit
  trail.
- A task in `in-progress/` with no "Plan approved" audit note — it was moved
  by a raw `mv` instead of `/agentic-loop:engineering approve <id>`.
- A task in `queued/` with no "Task approved" audit note — it was moved by a
  raw `mv` instead of `/agentic-loop:engineering approve <id>`.
- A task in `plan-review/` without an `## Implementation Plan` — the PLAN
  stage never parks a planless task, so someone raw-`mv`ed it there.
- A task sitting in `queued/` for a long time with a watcher running — check
  `/agentic-loop:engineering status`: build work always outranks plan work, so a busy queue
  is normal, but a stuck one may mean a held claim marker.
- A local task file written without ever showing its draft to the user for
  a "does this look right?" confirmation.

## Verification

- [ ] Every task file in `docs/tasks/**/*.md` parses against the schema
      (`title` required, `priority` an integer, `acceptance` a list of strings).
- [ ] No task file has a `status:` frontmatter key.
- [ ] Every task in `in-progress/` carries an `## Implementation Plan`
      heading and a "Plan approved" audit note.
- [ ] `docs/tasks/{draft,queued,plan-review,in-progress,in-review,completed,abandoned}/`
      all exist (even if empty, via `.gitkeep`) so the `/agentic-loop:engineering` verbs
      and the driver never fail on a missing folder.
- [ ] Every locally-drafted task was shown to the user for confirmation
      before being written to disk.
