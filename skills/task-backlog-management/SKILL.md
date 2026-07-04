---
name: task-backlog-management
description: Explains the filesystem task backlog under docs/tasks/ that feeds the agentic loop. Use when writing, filing, or moving a task file, when running /loop next or /loop task <id>, when linking a task to an Azure DevOps work item, or when you need the task file schema and the folder-as-status lifecycle (draft/in-planning/in-progress/in-review/completed/abandoned).
---

# The task backlog

## Overview

A task is one markdown file under `docs/tasks/`. **The folder it lives in is
its status** — there is no `status:` field, so the two can never drift. The
`/loop` command (see `loop-orchestration`) can drive the loop straight from
this backlog instead of a hand-typed goal.

## When to Use

- Use when you want a goal to persist across sessions instead of being a
  one-off `/loop <goal>` invocation that's lost if the session restarts.
- Use before running `/loop next` or `/loop task <id>` — both read from this
  backlog.
- Use when reviewing what `/explore` or `/task new` filed, or when moving a
  task between `draft/`, `in-planning/`, and `abandoned/`.
- A free-text `/loop <goal>` doesn't need one to *start* — but once its plan
  is approved, it's promoted into a real task file in `in-progress/` too (see
  `loop-orchestration`'s planning/execution split), so it isn't entirely
  outside this backlog after all; only the draft/in-planning stage is skipped.

## The folders

```
docs/tasks/
  draft/        # WIP, not ready                ← you write here
  in-planning/  # queued for / undergoing plan   ← you move here (gate 1)
  in-progress/  # build → verify → review        ← the driver moves here (on plan approval)
  in-review/    # review passed, human diff gate ← the driver moves here automatically
  completed/    # shipped                        ← you move here, once the PR merges
  abandoned/    # won't do                       ← you move here, from any status
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
azureId: '1234'                         # optional; linked Azure DevOps work item id
azureProject: Platform                  # optional; the ADO project it lives in
azureRepo: platform-api                 # optional; the ADO repo it was created under
azureUrl: https://dev.azure.com/acme/Platform/_workitems/edit/1234  # optional
---
Throttle authenticated callers to 100 req/min. The body is the description /
context; it becomes the loop's goal, with `acceptance` threaded into the verify
stage so the verdict checks each criterion.
```

- **id** = the filename without `.md` (`add-foo.md` becomes `add-foo`). Stable, human-visible.
- **title** is required; everything else has a sane default.
- **acceptance** is optional but strongly recommended — it is what VERIFY checks.
  "What tests are needed" folds in here as concrete bullets rather than a
  separate field.
- **azureId/azureProject/azureRepo/azureUrl** are independently optional — a
  task can carry none, just an id, or the full set. When `azureId` is set,
  `/loop` threads a `Linked Azure DevOps work item: #<id> — <url>` line into
  every stage's context (see "Linking a task to Azure DevOps" below).

## Process

1. **Create a task** — by hand (write the file above into `draft/`), via
   `/task new <idea>` (the `task-author` subagent drafts a schema-valid file
   into `draft/`, and asks about Azure DevOps linkage — see below), or via
   `/explore` (scans the repo for improvement opportunities and files up to
   5 as draft tasks, deduped against what's already there). New tasks always
   land in `draft/`, never straight into `in-planning/` — a human decides
   what's worth planning.
2. **Review**, then move it to `in-planning/` yourself — that move is the
   first human gate; it's the decision to start planning it.
3. **Plan it** — `/loop next` picks the lowest-`priority` task in
   `in-planning/` that doesn't already have a plan (ties by id) and starts
   the loop on it (PLAN). `/loop task <id>` runs one specific task; if
   it already has a persisted plan, this resumes straight to the
   plan-approval gate instead of re-planning. The task stays in
   `in-planning/` through this whole step, including while the generated
   plan waits for your review — there's no separate folder for that; check
   `/loop status` or the toast message to see it's waiting.
4. **Approve the plan** (`/loop go`) — this is the second gate, and the only
   one that's automatic on the folder side: the driver moves the file
   `in-planning/ → in-progress/` itself. This **parks** it — nothing builds
   in this session anymore. A separate `/loop watch` session claims it later
   and runs BUILD→VERIFY→REVIEW. See `loop-orchestration` for the full
   planning/execution split.

### Linking a task to Azure DevOps

Any agent authoring a task (`task-author` via `/task new`, or you writing one
by hand) should follow this exact script when the work traces to Azure
DevOps. This is the *only* place this protocol is written down — don't
duplicate it into an agent's own prompt; have the agent invoke this skill
instead.

1. **Ask** whether an Azure DevOps work item already exists for this task.

2. **If yes** — ask for **both** the **project name** and the **work item
   id** (not just the id). Use the connected Azure DevOps MCP server's
   `work-items` tools to fetch it. Draft the local task from what was
   fetched — map the work item's title, description (→ body), and any
   acceptance-criteria-shaped fields into `acceptance` — and **show that
   draft to the user, asking whether it looks like a good fit** before
   writing anything. Revise on feedback; only once confirmed, write the file
   with `azureId`/`azureProject`/`azureUrl` set from what was fetched.

3. **If no** — ask the user for the task's details: title, description, and
   acceptance criteria (fold "what tests are needed" in as concrete
   acceptance bullets — no separate field for it). Then ask which
   **project** and **repo** the new work item should be created under, and
   confirm the full set of details back to the user before creating
   anything — never create a work item silently. Once confirmed, create it
   via the MCP server's work-item tools, capture the returned id/url, and
   set `azureId`/`azureProject`/`azureRepo`/`azureUrl`. Show the resulting
   local task draft for the same "does this look right?" confirmation as
   step 2 before writing it.

4. **Either branch** — if the Azure DevOps MCP server isn't connected or
   configured, skip linking gracefully: write the local task file without
   the `azure*` fields and say so in your output. A missing MCP server is
   not a reason to block local task creation; a human can add the linkage by
   hand later.

Two confirmation checkpoints, always: one before creating anything on Azure
DevOps (step 3), one before writing the local file (steps 2 and 3 both end
here). Neither is optional, and neither can be skipped because "the details
seem obvious."

Linking is metadata, not scope — it does not change what the loop plans,
builds, or verifies. It only threads a `Linked Azure DevOps work item: #<id>`
line into every stage's context (see `loop-orchestration`) so the eventual
PR description can reference the source work item.

## Lifecycle — who moves what

| Transition | Who | When |
|------------|-----|------|
| `draft → in-planning` | **you** | the task is worth planning; this is the first human gate |
| `in-planning → in-progress` | driver | automatic, the instant a plan is approved (`/loop go` at the plan gate) — parks it; a later `/loop watch` session claims and builds it |
| `in-progress → in-review` | driver | automatic, the instant REVIEW returns PASS, from inside whichever `/loop watch` session claimed it — parks it as the human diff gate |
| `in-review → completed` | **you** | you've reviewed the diff and shipped it — run `/loop ship <id>` (an audited move + commit) or move the file by hand; the loop never does this move on its own |
| stays `in-progress` + note | driver | loop fails (iteration cap) or is stopped while building |
| `→ abandoned` | **you** | you decide not to do it, from any status |

Only two status transitions are manual: `draft → in-planning` (the
decision to plan it) and `in-review → completed` (the decision that it's
actually shipped). Everything in between — `in-planning → in-progress` on
plan approval, `in-progress → in-review` on a review PASS — is the driver
recording a decision that already happened (a human ran `/loop go`, or the
pipeline finished), not a second layer of file-moving bureaucracy.

A failed or stopped task is **left in `in-progress/`** with a note appended, so
it is visibly stuck for a human rather than silently re-queued. Run `/loop task
<id>` yourself to retry, or move it to `abandoned/` to give up on it — but see
the recovery boundary below: `/loop task <id>` only looks in `in-planning/`.

The first time a task's plan gates for approval, it is also **persisted onto
the task file** under a `## Implementation Plan` heading — the on-disk marker
that the task is planned and awaiting a human. This survives a `/loop stop` or
an opencode restart, when the in-memory loop state does not — only the plan
is durable.

### Identifying an interrupted loop

Loop state is in-memory only — a crash or restart mid-loop leaves no trace by
itself. What's on the task file tells you what happened:

- **A blockquote note** (`> ...`) — either a manual `/loop stop`/`/loop abort`,
  or an automatic iteration-cap stop (from a VERIFY or a REVIEW failure).
- **An unmatched `> BUILD started` note** (no matching `> BUILD finished` after
  it) — the only stage that edits files died mid-run, most likely a crash or a
  `/loop stop` issued while BUILD was active. Treat this as "check `git
  status`/`git diff` before doing anything else" — there may be a
  half-finished diff in the working tree. `/loop task <id>` surfaces this as a
  warning when resuming an already-planned task.
- **No markers at all, just `## Implementation Plan`** — safe: planned and
  waiting for approval, nothing has written code yet. This is exactly the
  `isClaimable` predicate a `/loop watch` session uses to pick its next task:
  has a plan, and has never had *any* `> BUILD started` note — not just "the
  last one is unmatched" (that's `wasInterrupted`, above). A task with any
  build marker at all, matched or not, is either being driven by a live
  watch session right now, or crashed and needs the manual recovery below —
  a watcher must never silently reclaim either case.

**Recovery boundary:** `/loop task <id>` only searches `in-planning/`. If a
session dies while a task is already in `in-progress/` (mid-BUILD, VERIFY, or
REVIEW), `/loop task <id>` won't find it there — the loop has no way
to resume exactly where it left off past the plan gate. The recovery is
manual: check `git status`/`git diff` against the BUILD markers above, then
move the file back to `in-planning/` and run `/loop task <id>` again to
re-plan and restart it cleanly (or finish/fix it up by hand).

## Notes & limits

- The backlog path defaults to `docs/tasks` and is configurable via `tasksDir`
  in `.agentic-loop.json`.
- The loop edits the current working tree; after it finishes, review the diff,
  then open the PR yourself. There is no per-task branch/worktree.
- Promotion (`draft → in-planning`, `→ abandoned`) is a manual file move —
  there is no approve command. `in-planning → in-progress` is the one
  automatic move on the "start" side, driven by `/loop go` — it parks the
  task; nothing builds it until a human explicitly runs `/loop watch` in
  some session (see `loop-orchestration`).
- Azure DevOps linking depends on the `microsoft/azure-devops-mcp` server
  being connected in your OpenCode setup. It's optional — task creation
  never blocks on it (see "Linking a task to Azure DevOps" above).

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll add a status: field, it's clearer" | The whole point is that the folder *is* the status — a separate field can drift from the folder and lie about the task's real state. |
| "This task failed once, just delete the note and retry silently" | The note is the audit trail for why a human needs to look before retrying (especially an unmatched BUILD-started marker, which can mean a half-finished diff). Deleting it hides that signal from the next person. |
| "Skip in-planning/, edit the task straight in draft/ to 'run' it" | `/loop next` and `/loop task <id>` only look in `in-planning/` — moving it there isn't bureaucracy, it's the actual trigger and the human gate. |
| "The MCP server's connected, just create the Azure work item without asking" | Creating a work item is a write to a real, shared Azure DevOps project — always confirm title/project/description first, same as every other external-write gate in this repo (plan gate). |
| "The fetched Azure work item is obviously right, skip showing the draft" | The draft-then-confirm checkpoint exists precisely because ADO fields don't map 1:1 onto acceptance criteria — a human needs to see what got inferred before it becomes the loop's goal. |
| "Add another status for 'plan ready, waiting on /loop go'" | That moment is already visible via `hasPlan()`/the toast message inside `in-planning/` — it doesn't need its own folder. `in-review` earned its own status because it's a real, driver-driven transition (review PASS), not because every gate needs one. |

## Red Flags

- A task file with a `status:` key in its frontmatter — schema violation; the
  folder is the only source of truth.
- A task sitting in `in-progress/` with an unmatched `> BUILD started` note
  that nobody has checked `git status` against yet.
- More than ~5 new draft tasks appearing from a single `/explore` run — the
  subagent is supposed to cap at 5 and name the overflow instead.
- A task sitting in `in-review/` — that's not a stall, it's the human diff
  gate; review the branch and run `/loop ship <id>` when it ships.
- A task in `completed/` whose diff was never actually reviewed/PR'd by a
  human — only a human moves a task into `completed/`, so this means someone
  moved the file (or ran `/loop ship`) without doing the review step first.
- A task in `completed/` with no "Shipped" audit note — it was moved by a raw
  `mv` instead of `/loop ship <id>`, so the completion isn't in the audit
  trail.
- An Azure DevOps work item created without the user confirming title,
  project, and description first.
- A local task file written without ever showing its draft to the user for
  a "does this look right?" confirmation.
- A task file with `azureProject`/`azureRepo`/`azureUrl` set but no
  `azureId` — the id is the anchor; the others are only meaningful alongside it.
- A task found sitting in `in-progress/` that a human is trying to resume
  with `/loop task <id>` — that command only searches `in-planning/`; see
  the recovery boundary above.

## Verification

- [ ] Every task file in `docs/tasks/**/*.md` parses against the schema
      (`title` required, `priority` an integer, `acceptance` a list of strings).
- [ ] No task file has a `status:` frontmatter key.
- [ ] Every task in `in-planning/` with a `## Implementation Plan` heading is
      either paused at the gate or actively being planned — not silently
      abandoned.
- [ ] `docs/tasks/{draft,in-planning,in-progress,in-review,completed,abandoned}/`
      all exist (even if empty, via `.gitkeep`) so `/explore`, `/task new`, and
      the driver never fail on a missing folder.
- [ ] Every task with `azureId` set was linked (or created) only after the
      user confirmed the details — never silently.
- [ ] Every locally-drafted task, whether Azure-linked or not, was shown to
      the user for confirmation before being written to disk.
- [ ] A task authored with no Azure DevOps MCP server connected still got
      written successfully, just without `azure*` fields.
