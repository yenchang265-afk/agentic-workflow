---
name: task-backlog-management
description: Explains the filesystem task backlog under docs/tasks/ that feeds the agentic loop. Use when writing, filing, or moving a task file, when running /loop-plan or /loop task <id>, when linking a task to an Azure DevOps work item, or when you need the task file schema and the folder-as-status lifecycle (draft/in-planning/in-progress/in-review/completed/abandoned).
---

# The task backlog

## Overview

A task is one markdown file under `docs/tasks/`. **The folder it lives in is
its status** — there is no `status:` field, so the two can never drift. The
`/loop-plan` command drafts (via interview), plans, and approves tasks here;
the `/loop` command (see `loop-orchestration`) executes the approved ones.

## When to Use

- Use when you want a goal to persist across sessions as a durable, auditable
  backlog record.
- Use before running `/loop-plan task <id>`, `/loop-plan approve <id>`, or
  `/loop task <id>` — all read from this backlog.
- Use when reviewing what `/explore` or `/loop-plan new` filed, or when moving
  a task to `abandoned/`.

## The folders

```
docs/tasks/
  draft/        # interviewed stubs, no plan (from /loop-plan new, /explore, or hand-written)
  in-planning/  # being planned / planned, awaiting approval     ← /loop-plan task moves + writes here
  in-progress/  # approved queue + build → verify → review       ← /loop-plan approve moves here
  in-review/    # review passed, human diff gate                 ← the driver moves here automatically
  completed/    # shipped                                        ← you move here (/loop ship), once the PR merges
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
azureId: '1234'                         # optional; linked Azure DevOps work item id
azureProject: Platform                  # optional; the ADO project it lives in
azureRepo: platform-api                 # optional; the ADO repo it was created under
azureUrl: https://dev.azure.com/acme/Platform/_workitems/edit/1234  # optional
---
Throttle authenticated callers to 100 req/min. The body is the description /
context; it becomes the loop's goal, with `acceptance` threaded into the build
and verify stages so the verdict checks each criterion.

## Implementation Plan

The plan — written by /loop-plan task <id>. Its presence (this exact
heading) is what makes the task approvable and, once approved, claimable.
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
- **`## Implementation Plan`** — the literal heading the plugin greps for.
  Without it, `/loop-plan approve` refuses and the loop can never claim the task.

## Process

1. **Draft** — `/loop-plan new <idea>`: the `loop-plan-author` subagent
   **always interviews you** (a single restate-and-confirm when the idea is
   already sharp, a full interview when it's vague) to pin down the goal and
   testable acceptance criteria, asks about Azure DevOps linkage (see below),
   confirms the draft with you, and writes a **planless draft** to `draft/`.
   - Stubs also land in `draft/` from `/explore` (up to 5 per run, deduped
     against what's already there), and you can write one by hand.
2. **Plan** — `/loop-plan task <id>`: the plugin first moves the file
   `draft/ → in-planning/` (audited note + commit), then the subagent reads
   the relevant code and writes the `## Implementation Plan` onto the file in
   place. Drafting and planning are two steps by design — you review the
   draft before plan effort is spent.
3. **Approve** — `/loop-plan approve <id>`: deterministic plugin code checks
   the `## Implementation Plan` heading exists, moves the file (from
   `in-planning/` or `draft/`) to `in-progress/`, appends an audited
   "Plan approved" note, and commits. This is the human sign-off before any
   code is written.
4. **Execute** — `/loop task <id>` (one task, now) or `/loop watch [interval]`
   (standing worker). See `loop-orchestration`.

### Linking a task to Azure DevOps

Any agent authoring a task (`loop-plan-author` via `/loop-plan new`, or you
writing one by hand) should follow this exact script when the work traces to
Azure DevOps. This is the *only* place this protocol is written down — don't
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

Linking is metadata, not scope — it does not change what the loop builds or
verifies. It only threads a `Linked Azure DevOps work item: #<id>` line into
every stage's context (see `loop-orchestration`) so the eventual PR
description can reference the source work item.

## Lifecycle — who moves what

| Transition | Who | When |
|------------|-----|------|
| into `draft/` | `/loop-plan new`, you, or `/explore` | an interviewed (or filed) planless stub |
| `draft → in-planning` | **`/loop-plan task <id>`** | the plugin moves it (audited note + commit) the moment planning starts; the plan is then written in place |
| `in-planning (or draft) → in-progress` | **`/loop-plan approve <id>`** | the human plan-approval gate; audited note + commit |
| `in-progress → in-review` | driver | automatic, the instant REVIEW returns PASS — parks it as the human diff gate |
| `in-review → completed` | **you** | you've reviewed the diff and shipped it — run `/loop ship <id>` (an audited move + commit) or move the file by hand; the loop never does this move on its own |
| stays `in-progress` + note | driver | loop fails (iteration cap) or is stopped while building |
| `→ abandoned` | **you** | you decide not to do it, from any status |

A failed or stopped task is **left in `in-progress/`** with a note appended, so
it is visibly stuck for a human rather than silently re-queued. `/loop recover
<id>` resumes it; if the plan itself was the problem, re-plan with `/loop-plan
task <id>` and approve again; or move it to `abandoned/` to give up on it.

The `## Implementation Plan` section is the durable on-disk record — it
survives a `/loop stop` or an opencode restart, when the in-memory loop state
does not (state snapshots under `runs/` cover exact-stage crash recovery).

### Identifying an interrupted loop

What's on the task file tells you what happened:

- **A blockquote note** (`> ...`) — either a manual `/loop stop`/`/loop abort`,
  or an automatic iteration-cap stop (from a VERIFY or a REVIEW failure).
- **An unmatched `> BUILD started` note** (no matching `> BUILD finished` after
  it) — the only stage that edits files died mid-run, most likely a crash or a
  `/loop stop` issued while BUILD was active. Treat this as "check `git
  status`/`git diff` before doing anything else" — there may be a
  half-finished diff. `/loop recover <id>` resumes it (snapshot-exact, or at
  BUILD from the persisted plan).
- **No markers at all, just `## Implementation Plan`** — safe: approved and
  waiting, nothing has written code yet. This is exactly the `isClaimable`
  predicate a `/loop watch` session uses to pick its next task: has a plan,
  and has never had *any* `> BUILD started` note — not just "the last one is
  unmatched" (that's `wasInterrupted`, above). A task with any build marker
  at all, matched or not, is either being driven by a live watch session
  right now, or crashed and needs `/loop recover` — a watcher must never
  silently reclaim either case.

## Notes & limits

- The backlog path defaults to `docs/tasks` and is configurable via `tasksDir`
  in `.agentic-loop.json`.
- Execution is isolated on a `loop/<id>` branch (or per-task worktree, when
  configured); after the loop finishes, review the diff, then open the PR
  yourself.
- `→ abandoned` is a manual file move — there is no abandon command.
  `in-planning → in-progress` is `/loop-plan approve`'s move; `in-progress →
  in-review` is the driver recording a review PASS. Neither is a second layer
  of file-moving bureaucracy — each records a decision that already happened.
- Azure DevOps linking depends on the `microsoft/azure-devops-mcp` server
  being connected in your OpenCode setup. It's optional — task creation
  never blocks on it (see "Linking a task to Azure DevOps" above).

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll add a status: field, it's clearer" | The whole point is that the folder *is* the status — a separate field can drift from the folder and lie about the task's real state. |
| "This task failed once, just delete the note and retry silently" | The note is the audit trail for why a human needs to look before retrying (especially an unmatched BUILD-started marker, which can mean a half-finished diff). Deleting it hides that signal from the next person. |
| "Just mv the file to in-progress/, approve is bureaucracy" | A raw `mv` skips the plan validation, the audit note, and the commit that records who approved what. The command is one line and is the gate. |
| "The MCP server's connected, just create the Azure work item without asking" | Creating a work item is a write to a real, shared Azure DevOps project — always confirm title/project/description first, same as every other external-write gate in this repo (plan approval). |
| "The fetched Azure work item is obviously right, skip showing the draft" | The draft-then-confirm checkpoint exists precisely because ADO fields don't map 1:1 onto acceptance criteria — a human needs to see what got inferred before it becomes the loop's goal. |
| "Add another status for 'approved, waiting for a watcher'" | That moment is already visible: an in-progress task with a plan and no build markers is exactly `isClaimable`. It doesn't need its own folder. |

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
- A task in `in-progress/` with no "Plan approved" audit note — it was moved
  by a raw `mv` instead of `/loop-plan approve <id>`.
- A task in `in-planning/` with no "Planning started" audit note — it was
  moved by a raw `mv` instead of `/loop-plan task <id>`.
- An Azure DevOps work item created without the user confirming title,
  project, and description first.
- A local task file written without ever showing its draft to the user for
  a "does this look right?" confirmation.
- A task file with `azureProject`/`azureRepo`/`azureUrl` set but no
  `azureId` — the id is the anchor; the others are only meaningful alongside it.

## Verification

- [ ] Every task file in `docs/tasks/**/*.md` parses against the schema
      (`title` required, `priority` an integer, `acceptance` a list of strings).
- [ ] No task file has a `status:` frontmatter key.
- [ ] Every task in `in-progress/` carries an `## Implementation Plan`
      heading and a "Plan approved" audit note.
- [ ] `docs/tasks/{draft,in-planning,in-progress,in-review,completed,abandoned}/`
      all exist (even if empty, via `.gitkeep`) so `/explore`, `/loop-plan`, and
      the driver never fail on a missing folder.
- [ ] Every task with `azureId` set was linked (or created) only after the
      user confirmed the details — never silently.
- [ ] Every locally-drafted task, whether Azure-linked or not, was shown to
      the user for confirmation before being written to disk.
- [ ] A task authored with no Azure DevOps MCP server connected still got
      written successfully, just without `azure*` fields.
