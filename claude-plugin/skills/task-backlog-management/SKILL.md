---
name: task-backlog-management
description: The filesystem task backlog under docs/tasks/ that feeds the agentic loop in Claude Code. Use when writing, filing, or moving a task file, when running /loop next or starting a loop from a backlog task, when linking a task to an Azure DevOps work item, or when you need the task file schema and the folder-as-status lifecycle (draft/in-planning/in-progress/in-review/completed/abandoned).
---

# The task backlog

## Overview

A task is one markdown file under `docs/tasks/`. **The folder it lives in is its
status** — there is no `status:` field, so the two can never drift. The `/loop`
command can drive a goal straight from this backlog instead of a hand-typed goal.
The `agentic-loop` MCP tools move task files between folders as the loop advances;
humans make the two manual moves (`draft → in-planning` and `in-review →
completed`).

## The folders

```
docs/tasks/
  draft/        # WIP, not ready                ← you write here (/task new, /loop explore)
  in-planning/  # queued for planning            ← a human moves here (gate 1)
  in-progress/  # plan → build → verify → review ← loop_start moves here
  in-review/    # review passed, human diff gate  ← the loop moves here on a REVIEW PASS
  completed/    # shipped                         ← you move here via /loop ship <id>
  abandoned/    # won't do                        ← you move here, from any status
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
Throttle authenticated callers to 100 req/min. The body is the description; it
becomes the loop's goal, with `acceptance` threaded into the verify stage.
```

- **id** = the filename without `.md` (`add-foo.md` → `add-foo`). Stable, human-visible.
- **title** is required; everything else has a sane default.
- **acceptance** is optional but strongly recommended — it is what VERIFY checks.
- **azureId/azureProject/azureRepo/azureUrl** are independently optional.

## Lifecycle — who moves what

| Transition | Who | When |
|---|---|---|
| `draft → in-planning` | **you (human)** | the task is worth planning — the first gate |
| `in-planning → in-progress` | `loop_start({taskId})` | the loop is started on it |
| `in-progress → in-review` | the loop (`loop_advance` on REVIEW PASS) | the pipeline finished; awaiting human diff review |
| `in-review → completed` | **you**, via `/loop ship <id>` | you reviewed the diff and shipped it |
| stays `in-progress` + note | the loop | a FAIL hit the iteration cap, or the loop was stopped |
| `→ abandoned` | **you** | you decide not to do it, from any status |

Two moves are manual: `draft → in-planning` (decide to plan it) and `in-review →
completed` (decide it's shipped, via `/loop ship <id>` — an audited move). Prefer
`/loop ship` over a raw `mv` so the completion lands in the audit trail.

## Process

1. **Create a task** — by hand into `draft/`, via `/task new <idea>` (the
   `loop-task-author` subagent drafts a schema-valid file and asks about Azure
   linkage), or via `/loop explore` (the `loop-explore` subagent files up to 5
   drafts). New tasks always land in `draft/`.
2. **Review, then move it to `in-planning/`** yourself — the first human gate.
3. **Start it** — `/loop next` picks the lowest-priority un-planned task in
   `in-planning/`; or start a specific one. `loop_start` moves it to `in-progress/`
   and the main agent drives PLAN → (gate) → BUILD → VERIFY → REVIEW (see
   `loop-orchestration`).
4. **Approve the plan** at the gate — a conversational approval; the agent then
   calls `loop_approve` and proceeds. There is no `/loop go` command and no
   separate watch session in Claude Code.
5. **Ship it** — on a REVIEW PASS the task parks in `in-review/`; review the branch
   diff and run `/loop ship <id>` to complete it.

### Linking a task to Azure DevOps

Any agent authoring a task (`loop-task-author` via `/task new`, or you by hand)
should follow this exact script when the work traces to Azure DevOps. This is the
*only* place this protocol is written down.

1. **Ask** whether an Azure DevOps work item already exists for this task.
2. **If yes** — ask for **both** the **project name** and the **work item id**. Use
   the connected Azure DevOps MCP server's `work-items` tools to fetch it. Draft
   the local task from what was fetched — map the work item's title, description
   (→ body), and any acceptance-criteria-shaped fields into `acceptance` — and
   **show that draft to the user, asking whether it looks like a good fit** before
   writing anything. Only once confirmed, write the file with
   `azureId`/`azureProject`/`azureUrl` set from what was fetched.
3. **If no** — ask the user for title, description, and acceptance criteria (fold
   "what tests are needed" in as concrete bullets). Then ask which **project** and
   **repo** the new work item should be created under, and confirm the full set
   back to the user before creating anything — never create a work item silently.
   Once confirmed, create it via the MCP server's work-item tools, capture the
   returned id/url, set the `azure*` fields, and show the resulting draft for the
   same "does this look right?" confirmation before writing it.
4. **Either branch** — if the Azure DevOps MCP server isn't connected, skip linking
   gracefully: write the local task without the `azure*` fields and say so. A
   missing MCP server never blocks local task creation.

Two confirmation checkpoints, always: one before creating anything on Azure DevOps,
one before writing the local file. Neither is optional.

Linking is metadata, not scope — it does not change what the loop plans, builds, or
verifies.

## Recovering an interrupted loop

Loop state is snapshotted after every transition (`docs/tasks/runs/<id>.state.json`)
and the task file carries the audit trail. What tells you what happened:

- **A snapshot file present** — the strongest "died mid-run" signal; `/loop recover
  <id>` resumes at the exact stage it reached.
- **An unmatched `> BUILD started` note** (no matching `> BUILD finished`) — BUILD
  died mid-run; check `git status`/`git diff` for a half-finished diff before
  recovering.
- The SessionStart hook surfaces both at the start of a session.

`/loop recover <id>` re-claims an `in-progress/` task and resumes from its snapshot
(or, absent a valid one, from the persisted plan at BUILD).

## Common rationalizations

| Rationalization | Reality |
|---|---|
| "I'll add a `status:` field, it's clearer" | The folder *is* the status — a separate field can drift and lie about the real state. |
| "This failed once, delete the note and retry silently" | The note (especially an unmatched BUILD-started marker) is the audit trail for why a human should look before retrying. |
| "Skip `in-planning/`, run it straight from `draft/`" | `/loop next` only looks in `in-planning/` — moving it there is the actual trigger and the human gate. |
| "The MCP server's connected, just create the Azure work item" | Creating a work item is a write to a shared project — always confirm title/project/description first. |

## Red flags

- A task file with a `status:` key in its frontmatter — schema violation.
- A task in `in-progress/` with an unmatched `> BUILD started` note nobody has
  checked `git status` against.
- A task sitting in `in-review/` — not a stall, the human diff gate; review and run
  `/loop ship <id>`.
- A task in `completed/` with no "Shipped" note — it was moved by a raw `mv`
  instead of `/loop ship <id>`, so the completion isn't audited.
- An Azure DevOps work item created without the user confirming details first.
