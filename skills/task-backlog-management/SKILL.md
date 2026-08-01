---
name: task-backlog-management
description: Explains the filesystem task backlog under docs/tasks/ — folder-as-status, the task file schema, and who moves what. Use when writing, filing, or moving a task file, or running the /agentic-workflow:engineering authoring verbs.
---

# The task backlog

A task is one markdown file under `docs/tasks/`. **Folder-as-status**: the
folder it lives in is its status — there is no `status:` field, so the two can
never drift. Every
move is made by a verb of `/agentic-workflow:engineering`, which leaves an
audited note and a commit behind it; a raw `mv` skips the validation, the note,
and the record of who decided.

This folder lifecycle is the **engineering kind's work source** (bound in
`packages/core/workflows/engineering/workflow.json`). Other kinds keep their
state elsewhere — `pr-sitter` on GitHub itself plus a per-PR dedup ledger under
`<tasksDir>/runs/pr-sitter/`. Everything here is the engineering backlog. The
stages, gates, and verdicts that drive it are `workflow-orchestration`.

## The folders

```
docs/tasks/
  draft/        # interviewed stubs, no plan (/agentic-workflow:engineering new, or hand-written)
  queued/       # task approved, planless — awaits the loop's PLAN stage      ← approve moves here
  plan-review/  # plan written by the loop, parked for the human plan gate    ← the PLAN stage moves here
  in-progress/  # plan approved: build-ready queue + build → verify → review  ← approve moves here
  in-review/    # review passed, human diff gate                              ← the driver moves here
  completed/    # shipped                                                     ← you (approve), once the PR merges
  abandoned/    # won't do                                                    ← abandon, from any non-terminal status
```

## Task file schema

YAML frontmatter plus a free-form markdown body:

```md
---
title: Add rate limiting to the API     # required
type: story                             # optional; issue/work-item type
priority: 2                             # optional; lower runs first (default 0)
estimate: 3                             # optional; story points / effort
assignee: jdoe@example.com              # optional
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
The body is the description; it becomes the loop's goal, with `acceptance`
threaded into the build and verify stages so the verdict checks each criterion.

## Implementation Plan

Written by the loop's PLAN stage, right before execution.
```

- **id** = the filename without `.md` (`add-foo.md` → `add-foo`). Stable and
  human-visible.
- **`## Implementation Plan`** is the literal heading the plugin greps for.
  Without it `approve` refuses and the loop can never build the task.
- **acceptance** is what VERIFY checks, so "what tests are needed" folds in
  here as concrete bullets rather than becoming a field of its own.
- **YAML footgun — quote risky values.** Double-quote any `title:` or
  `acceptance:`/`labels:` bullet containing `: ` or opening with a YAML
  reserved character (backtick, `@`, `*`, `[`, `{`, `|`, `>`, `%`, `&`, `!`).
  ``- `calc --help` prints usage`` is invalid YAML; write
  `- "'calc --help' prints usage"` instead. Unquoted, YAML either mis-parses
  the value or rejects the whole file — the parser repairs the common cases,
  which is not a reason to rely on it.
- **type / estimate / assignee / labels / tracker** align with the fields Jira
  and Azure DevOps share, so a task can be **manually paired** to a tracker
  item via `tracker.system` + `tracker.key`:

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

## Lifecycle — who moves what

| Transition | Who | When |
|------------|-----|------|
| into `draft/` | `/agentic-workflow:engineering new` or you | an interviewed (or hand-written) planless stub — `new` always interviews, then hands the confirmed intent to the `workflow-task-author` subagent |
| ends in `draft/` (rewritten in place) | **`retask <id> [note]`** | reshape a planless task — re-interview, overwrite the same file, keep the id. A `draft/` task never moves; a `queued/` one is sent back to `draft/` first (approval withdrawn — approve it again). Refused from `plan-review/`: use `replan` |
| `draft → queued` | **`approve <id>`** | the human task gate — scope + acceptance approved, planless by design |
| `queued → plan-review` | driver | the PLAN stage wrote the plan and parked it |
| `plan-review → in-progress` | **`approve <id>`** | the human plan gate — the sign-off before any code is written |
| `plan-review (or in-progress) → queued` | **`replan <id> [reason]`** | plan rejected, or a cap-tripped task sent back — the next PLAN pass addresses the audited reason |
| `in-progress → in-review` | driver | automatic, the instant REVIEW returns PASS — the human diff gate |
| `in-review → completed` | **you** | you reviewed the diff and shipped it — `approve <id>`; the loop never makes this move |
| stays `in-progress` + note | driver | the loop failed (iteration cap) or was stopped mid-build |
| `→ abandoned` | **you** | **`abandon <id> [reason]`** — from any non-terminal status; the file is kept, so it is reversible |
| task file deleted | **you** | **`remove <id> --force`** — the one destructive verb; a bare `remove` is a dry run. Usually permanent (`ignoreBacklog` defaults to true), so prefer `abandon` |

One verb runs every forward gate: **`approve [id]`** advances by whatever gate
the task's folder implies, and id-less it resolves the single task waiting at a
loop wait-gate, falling back to a lone draft only when no loop gate is waiting
(tracking epics are never candidates). **`replan [id] [reason]`** is the
matching rejection verb, always back to `queued/`.

The plan is written **right before execution** rather than at approval time, so
it cannot rot while a task sits parked. Its `## Implementation Plan` section is
the durable on-disk record, surviving a `stop` or an opencode restart when
in-memory loop state does not (snapshots under `runs/` cover exact-stage crash
recovery).

## Slicing a heavy idea into sibling drafts

Each task is planned, built, verified, and reviewed by **one agent in one
worktree context** (often a cheaper model), so a heavy idea will not fit. The
backlog *is* the decomposition primitive: at `new`, the calling agent judges
scope and — when the idea spans slices (more than one independent deliverable,
more than ~5 acceptance criteria, or more than one subsystem) — splits it into
**sibling drafts**, each a vertical, independently shippable slice with its own
acceptance subset, plus one **epic tracking draft** (`type: epic`) whose body
lists the children in order. There is no token metering; this is a scope
judgement, not a measured limit.

- Children are ordered by `priority` (0, 1, 2 …), which orders claims but does
  **not** block. A worktree branches from `origin/main`, so a child building on
  a sibling's code cannot see it until that sibling ships — the human approving
  and shipping stacked children one at a time *is* the dependency gate.
  Genuinely independent slices run in any order.
- The **epic file is never approved.** An un-approved draft is inert, so the
  loop never claims it; it is a human-facing index, closed with `abandon <id>`
  once every child has shipped.

## Identifying an interrupted loop

What is on the task file says what happened:

- **A blockquote note** (`> …`) — a manual `stop`/`abort`, or an automatic
  iteration-cap stop from a VERIFY or REVIEW failure.
- **An unmatched `> BUILD started`** (no `> BUILD finished` after it) — the only
  stage that edits files died mid-run. Read `git status`/`git diff` before
  doing anything else; there may be a half-finished diff. `recover <id>`
  resumes it, snapshot-exact or at BUILD from the persisted plan.
- **No markers, just `## Implementation Plan`** — approved and waiting, nothing
  has written code. This is exactly `isClaimable`: has a plan, and has **never**
  had *any* `> BUILD started` note — not merely "the last one is unmatched",
  which is `wasInterrupted`. A task with any build marker at all is either
  being driven by a live watch session right now or crashed and needs
  `recover`; a watcher must never silently reclaim either.

A failed or stopped task is **left in `in-progress/`** with its note, visibly
stuck for a human rather than silently re-queued. A task resting in
`in-review/` is not stalled either — it is the diff gate, waiting on you.

## Verification

- [ ] Every task file parses against the schema (`title` required, `priority` an
      integer, `acceptance` a list of strings), and none carries a `status:` key
- [ ] Every task in `in-progress/` has an `## Implementation Plan` and a "Plan
      approved" note; every task in `queued/`, `in-review/`, and `completed/`
      carries the audit note its gate writes — a missing note means the file was
      raw-`mv`ed past the gate that validates it
- [ ] Nothing sits in `plan-review/` without an `## Implementation Plan`
- [ ] `docs/tasks/{draft,queued,plan-review,in-progress,in-review,completed,abandoned}/`
      all exist (via `.gitkeep` when empty), so the verbs and the driver never
      fail on a missing folder
- [ ] Every locally-drafted task was shown to the user for confirmation before
      being written to disk
- [ ] No task in `in-progress/` carries an unmatched `> BUILD started` that
      nobody has checked `git status` against
