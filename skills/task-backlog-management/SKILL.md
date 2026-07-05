---
name: task-backlog-management
description: Explains the filesystem task backlog under docs/tasks/ that feeds the agentic loop. Use when writing, filing, or moving a task file, when running /agent-loop-plan or /agent-loop task <id>, or when you need the task file schema and the folder-as-status lifecycle (draft/in-planning/in-progress/in-review/completed/abandoned).
---

# The task backlog

## Overview

A task is one markdown file under `docs/tasks/`. **The folder it lives in is
its status** — there is no `status:` field, so the two can never drift. The
`/agent-loop-plan` command drafts (via interview), plans, and approves tasks here;
the `/agent-loop` command (see `loop-orchestration`) executes the approved ones.

## When to Use

- Use when you want a goal to persist across sessions as a durable, auditable
  backlog record.
- Use before running `/agent-loop-plan task <id>`, `/agent-loop-plan approve <id>`, or
  `/agent-loop task <id>` — all read from this backlog.
- Use when reviewing what `/explore` or `/agent-loop-plan new` filed, or when moving
  a task to `abandoned/`.

## The folders

```
docs/tasks/
  draft/        # interviewed stubs, no plan (from /agent-loop-plan new, /explore, or hand-written)
  in-planning/  # being planned / planned, awaiting approval     ← /agent-loop-plan task moves + writes here
  in-progress/  # approved queue + build → verify → review       ← /agent-loop-plan approve moves here
  in-review/    # review passed, human diff gate                 ← the driver moves here automatically
  completed/    # shipped                                        ← you move here (/agent-loop ship), once the PR merges
  abandoned/    # won't do                                       ← you move here, from any status
```

## Task file schema

One file per task. YAML frontmatter + a free-form markdown body:

```md
---
title: Add rate limiting to the API     # required
priority: 2                             # optional; lower runs first (default 0)
acceptance:                             # optional; testable criteria → verify
  - Returns 429 over the limit
  - Limit is configurable per route
---
Throttle authenticated callers to 100 req/min. The body is the description /
context; it becomes the loop's goal, with `acceptance` threaded into the build
and verify stages so the verdict checks each criterion.

## Implementation Plan

The plan — written by /agent-loop-plan task <id>. Its presence (this exact
heading) is what makes the task approvable and, once approved, claimable.
```

- **id** = the filename without `.md` (`add-foo.md` becomes `add-foo`). Stable, human-visible.
- **title** is required; everything else has a sane default.
- **acceptance** is optional but strongly recommended — it is what VERIFY checks.
  "What tests are needed" folds in here as concrete bullets rather than a
  separate field.
- **`## Implementation Plan`** — the literal heading the plugin greps for.
  Without it, `/agent-loop-plan approve` refuses and the loop can never claim the task.

## Process

1. **Draft** — `/agent-loop-plan new <idea>`: the calling agent **always
   interviews you** (a single restate-and-confirm when the idea is already
   sharp, a full interview when it's vague) to pin down the goal and
   testable acceptance criteria, confirms the draft with you, and hands it
   to the `loop-plan-author` subagent to write a **planless draft** to `draft/`.
   - Stubs also land in `draft/` from `/explore` (up to 5 per run, deduped
     against what's already there), and you can write one by hand.
2. **Plan** — `/agent-loop-plan task <id>`: the plugin first moves the file
   `draft/ → in-planning/` (audited note + commit), then the subagent reads
   the relevant code and writes the `## Implementation Plan` onto the file in
   place. Drafting and planning are two steps by design — you review the
   draft before plan effort is spent.
3. **Approve** — `/agent-loop-plan approve <id>`: deterministic plugin code checks
   the `## Implementation Plan` heading exists, moves the file (from
   `in-planning/` or `draft/`) to `in-progress/`, appends an audited
   "Plan approved" note, and commits. This is the human sign-off before any
   code is written.
4. **Execute** — `/agent-loop task <id>` (one task, now) or `/agent-loop watch [interval]`
   (standing worker). See `loop-orchestration`.

## Lifecycle — who moves what

| Transition | Who | When |
|------------|-----|------|
| into `draft/` | `/agent-loop-plan new`, you, or `/explore` | an interviewed (or filed) planless stub |
| `draft → in-planning` | **`/agent-loop-plan task <id>`** | the plugin moves it (audited note + commit) the moment planning starts; the plan is then written in place |
| `in-planning (or draft) → in-progress` | **`/agent-loop-plan approve <id>`** | the human plan-approval gate; audited note + commit |
| `in-progress → in-review` | driver | automatic, the instant REVIEW returns PASS — parks it as the human diff gate |
| `in-review → completed` | **you** | you've reviewed the diff and shipped it — run `/agent-loop ship <id>` (an audited move + commit) or move the file by hand; the loop never does this move on its own |
| stays `in-progress` + note | driver | loop fails (iteration cap) or is stopped while building |
| `→ abandoned` | **you** | you decide not to do it, from any status |

A failed or stopped task is **left in `in-progress/`** with a note appended, so
it is visibly stuck for a human rather than silently re-queued. `/agent-loop recover
<id>` resumes it; if the plan itself was the problem, re-plan with `/agent-loop-plan
task <id>` and approve again; or move it to `abandoned/` to give up on it.

The `## Implementation Plan` section is the durable on-disk record — it
survives a `/agent-loop stop` or an opencode restart, when the in-memory loop state
does not (state snapshots under `runs/` cover exact-stage crash recovery).

### Identifying an interrupted loop

What's on the task file tells you what happened:

- **A blockquote note** (`> ...`) — either a manual `/agent-loop stop`/`/agent-loop abort`,
  or an automatic iteration-cap stop (from a VERIFY or a REVIEW failure).
- **An unmatched `> BUILD started` note** (no matching `> BUILD finished` after
  it) — the only stage that edits files died mid-run, most likely a crash or a
  `/agent-loop stop` issued while BUILD was active. Treat this as "check `git
  status`/`git diff` before doing anything else" — there may be a
  half-finished diff. `/agent-loop recover <id>` resumes it (snapshot-exact, or at
  BUILD from the persisted plan).
- **No markers at all, just `## Implementation Plan`** — safe: approved and
  waiting, nothing has written code yet. This is exactly the `isClaimable`
  predicate a `/agent-loop watch` session uses to pick its next task: has a plan,
  and has never had *any* `> BUILD started` note — not just "the last one is
  unmatched" (that's `wasInterrupted`, above). A task with any build marker
  at all, matched or not, is either being driven by a live watch session
  right now, or crashed and needs `/agent-loop recover` — a watcher must never
  silently reclaim either case.

## Notes & limits

- The backlog path defaults to `docs/tasks` and is configurable via `tasksDir`
  in `.agentic-loop.json`.
- Execution is isolated on a `loop/<id>` branch (or per-task worktree, when
  configured); after the loop finishes, review the diff, then open the PR
  yourself.
- `→ abandoned` is a manual file move — there is no abandon command.
  `in-planning → in-progress` is `/agent-loop-plan approve`'s move; `in-progress →
  in-review` is the driver recording a review PASS. Neither is a second layer
  of file-moving bureaucracy — each records a decision that already happened.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll add a status: field, it's clearer" | The whole point is that the folder *is* the status — a separate field can drift from the folder and lie about the task's real state. |
| "This task failed once, just delete the note and retry silently" | The note is the audit trail for why a human needs to look before retrying (especially an unmatched BUILD-started marker, which can mean a half-finished diff). Deleting it hides that signal from the next person. |
| "Just mv the file to in-progress/, approve is bureaucracy" | A raw `mv` skips the plan validation, the audit note, and the commit that records who approved what. The command is one line and is the gate. |
| "Add another status for 'approved, waiting for a watcher'" | That moment is already visible: an in-progress task with a plan and no build markers is exactly `isClaimable`. It doesn't need its own folder. |

## Red Flags

- A task file with a `status:` key in its frontmatter — schema violation; the
  folder is the only source of truth.
- A task sitting in `in-progress/` with an unmatched `> BUILD started` note
  that nobody has checked `git status` against yet.
- More than ~5 new draft tasks appearing from a single `/explore` run — the
  subagent is supposed to cap at 5 and name the overflow instead.
- A task sitting in `in-review/` — that's not a stall, it's the human diff
  gate; review the branch and run `/agent-loop ship <id>` when it ships.
- A task in `completed/` whose diff was never actually reviewed/PR'd by a
  human — only a human moves a task into `completed/`, so this means someone
  moved the file (or ran `/agent-loop ship`) without doing the review step first.
- A task in `completed/` with no "Shipped" audit note — it was moved by a raw
  `mv` instead of `/agent-loop ship <id>`, so the completion isn't in the audit
  trail.
- A task in `in-progress/` with no "Plan approved" audit note — it was moved
  by a raw `mv` instead of `/agent-loop-plan approve <id>`.
- A task in `in-planning/` with no "Planning started" audit note — it was
  moved by a raw `mv` instead of `/agent-loop-plan task <id>`.
- A local task file written without ever showing its draft to the user for
  a "does this look right?" confirmation.

## Verification

- [ ] Every task file in `docs/tasks/**/*.md` parses against the schema
      (`title` required, `priority` an integer, `acceptance` a list of strings).
- [ ] No task file has a `status:` frontmatter key.
- [ ] Every task in `in-progress/` carries an `## Implementation Plan`
      heading and a "Plan approved" audit note.
- [ ] `docs/tasks/{draft,in-planning,in-progress,in-review,completed,abandoned}/`
      all exist (even if empty, via `.gitkeep`) so `/explore`, `/agent-loop-plan`, and
      the driver never fail on a missing folder.
- [ ] Every locally-drafted task was shown to the user for confirmation
      before being written to disk.
