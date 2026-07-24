---
name: agentic-workflow:engineering
description: The engineering loop — author tasks, gate them, and drive them through plan → build → verify → review
argument-hint: new <idea> | retask <id> [note] | approve [id] | replan [id] [reason] | remove <id> | plan <id> | claim | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | recover <id> | kinds | doctor [fix] | stop | status
---

The engineering agentic loop — one command for authoring, the human gates,
and execution, scoped to the engineering kind. The plugin intercepts this
command; `$ARGUMENTS` selects the verb. Everything except `new` and `retask`
is deterministic plugin work: **invoke nothing, write nothing** on those
verbs — report the toast's outcome and stop. `new` is entirely yours;
`retask` is split — the plugin has already placed the task (or refused) before
your turn, and the interview + rewrite are yours. (The PR sitter has its own
command: `/agentic-workflow:pr-sitter`.)

**$ARGUMENTS**

**Read the verb from the FIRST whitespace-delimited token of the argument;
everything after it is that verb's literal payload.** Match only that first
token against the verb list below. A verb-like word (`plan`, `status`,
`approve`, `replan`, `claim`, `doctor`, `retask`, `new`, …) appearing *inside*
the payload is part of the idea/note/reason, never the verb — e.g.
`new add a status dashboard` is the `new` verb with idea "add a status
dashboard", not `status`.

Dispatch:

## Authoring (you run the interview)

- **`new <idea>`** — turn a rough idea into one or more **planless drafts** in
  `docs/tasks/draft/`. YOU (the current agent) run the interview — subagents
  cannot converse with the user:
  1. **Always** invoke the `interview-me` skill first (never silently skip):
     if the idea already states a clear goal and testable criteria, a single
     restate-and-confirm question suffices; when anything is vague, run the
     full one-question-at-a-time interview. Pin down the goal and 2–5
     testable acceptance criteria.
  2. **Judge scope — one draft, or a slice set?** A single task is built,
     verified, and reviewed by **one agent in one worktree context** (often a
     cheaper/degraded model), so a heavy idea won't fit in a working context
     and should be split into sibling drafts, each a **vertical, independently
     shippable slice**. Split when the idea shows any of: **more than one
     independent deliverable**, **more than ~5 acceptance criteria**, or it
     **touches more than one subsystem/layer**. Otherwise keep it as one draft.
     There is no token metering — "fits the context window" is a scope
     judgement (one reviewable slice), not a measured limit.
  3. Show what you'll write and get an explicit "looks right" from the user:
     - **One draft** — title, priority, acceptance, body.
     - **A slice set** — the epic (parent) title, and the ordered children,
       each with its own acceptance subset. Prefer **independent** slices;
       when slices must stack (a child builds on another's merged code), order
       them by `priority` (0, 1, 2 …). A worktree branches from `origin/main`
       and can't see an unmerged sibling's code, so the human approves and
       ships stacked children one at a time in that order — `priority` orders
       claims but does **not** block, so this human sequencing is the
       dependency gate.
  4. Invoke the **`workflow-plan-author`** subagent once with the confirmed set to
     write the draft file(s) — one draft, or N child drafts plus one epic
     tracking file. No plan is written now — the loop's PLAN stage plans each
     task right before execution, so plans don't rot while it sits parked. The
     next step is `/agentic-workflow:engineering approve <id>` per child.
     - **The epic file is a tracking draft only** (frontmatter `type: epic`,
       body listing the children in order). **Never approve it** — an
       un-approved draft is inert, so the loop never claims it. Close it by
       hand with the loop move tool (to `abandoned/` or `completed/`) once
       every child has shipped.
- **`retask <id> [note]`** — reshape a planless task when the drafted goal or
  acceptance came out wrong: one still in `draft/`, or one already approved
  into `queued/` but not yet planned. YOU (the current agent) run the
  interview, same as `new`:
  1. The plugin has already run the deterministic half before your turn: a
     `queued/` task was moved **back to `draft/`** (its approval withdrawn — the
     reshaped goal has to be re-approved, and the toast says so), and a task
     from `plan-review/` onward was refused with a pointer at `replan`. So
     resolve `<id>` in `docs/tasks/draft/` **only**; if it isn't there, the
     plugin refused or the id is wrong — report that and stop.
  2. Read the existing draft and show its current title, priority, acceptance,
     body (and any `tracker` block) to the user.
  3. **Always** invoke the `interview-me` skill to reshape it, seeding it with
     the optional `note` and the current draft. Re-confirm the goal and 2–5
     testable acceptance criteria, then get an explicit "looks right".
  4. Invoke the **`workflow-plan-author`** subagent in **`retask` mode** with the
     id and the confirmed title/priority/acceptance/body (carry forward the
     `tracker` block if the draft had one) to rewrite `docs/tasks/draft/<id>.md`
     **in place** — the id/filename never changes. Still no plan. The next step
     is unchanged: `/agentic-workflow:engineering approve <id>` (required again if
     the task came back from `queued/`).

## Human gates (deterministic — the plugin moves the file before your turn)

- **`approve [id]`** — THE gate verb, unified and folder-driven. With an
  explicit `<id>` it advances that task by the gate its folder implies:
  - a reviewed `draft/` → `queued/` (task gate, no plan needed — the loop
    plans on claim);
  - a parked `plan-review/` plan → `in-progress/` (plan gate,
    `## Implementation Plan` required);
  - a finished `in-review/` task → `completed/` (ship — do this only after
    reviewing the branch diff).
  A task lives in exactly one folder, so the gate is never ambiguous. Without
  an id it advances the single task at a loop wait-gate (`plan-review/` or
  `in-review/`), falling back to a lone `draft/` task only when neither has
  anything waiting — loop gates outrank the authoring gate, and never-approved
  epic tracking drafts are skipped, so the loop never guesses.
- **`replan [id] [reason]`** — the sole rejection verb: send a parked plan
  (or a cap-tripped `in-progress/` task, by id) back to `queued/` for
  re-planning; the reason is audited and the next PLAN pass must address it.
- **`remove <id>`** — hard-delete a task from **any** folder. Unlike
  replan/retask it does **not** move the file: it deletes it and commits the
  removal, so the task is gone for good (git history retains it if the backlog
  is tracked). The plugin refuses a task a live loop is driving or one holding
  a claim marker, and releases any worktree it owned. **Destructive and cannot
  be undone from the working tree** — only run it when the user wants the task
  gone.

**Verify before you report a gate — `approve` and `replan` ONLY.** Their move
happens in the plugin's command hook *before* your turn, so by the time you
run the file must ALREADY sit in its target folder — glob
`docs/tasks/*/<id>*` and check. If it is still in its old folder, the plugin
did not run (not loaded, or its `@agentic-workflow/core` build is stale) — report
**that**, with the fix (`npm install` at the agentic-workflow repo root, then
restart opencode), and never claim the gate happened. A gate is only "done"
when you observed the file in its new folder.

This check applies to NOTHING but those two gate verbs. `claim`, `plan`,
`watch`, and `recover` defer their work until this turn settles — a task
still sitting in its folder right after them is EXPECTED, not a plugin
failure. For those verbs report the toast's outcome and stop; never prescribe
a rebuild from an unmoved file on an execution verb.

## Everything else is deterministic plugin work

`plan <id>` · `claim` · `watch [trigger]` · `unwatch` · `recover <id>` ·
`stop` (alias `abort`) · `status` · `kinds` · `doctor [fix]` — the plugin runs
each of these itself and reports a toast; on these verbs you **invoke nothing
and write nothing**. If the plugin ran, you'll receive an override carrying the
real outcome — report exactly that and stop. If instead you're reading this
text, the plugin did not intercept the command (not loaded, or a stale
`@agentic-workflow/core` build): say so, with the fix (`npm install` at the
agentic-workflow repo root, then restart opencode), and do **not** improvise
any of the work these verbs describe.

Their full behavior — the PLAN → BUILD → VERIFY → REVIEW pipeline, the
`feature/<id>` branch isolation, the iteration cap and re-build feedback loop,
the `in-review/` diff gate, watch cadence/triggers and the one-watcher-per-clone
lease, and the `doctor` repairs — lives in the `workflow-orchestration` skill.

Never move, create, or delete files under `docs/tasks/` yourself — no bash
`mv`/`mkdir`/`rm`, no direct writes into status folders (the plugin blocks
them). The folder a task lives in IS its state; these verbs and the loop own
every move. If the backlog looks damaged, run
`/agentic-workflow:engineering doctor`.
