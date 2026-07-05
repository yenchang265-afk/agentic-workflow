---
name: loop-orchestration
description: The protocol for driving the agentic engineering loop (plan → build → verify → review) inside Claude Code. Use when running /agent-loop — it tells the main agent the exact sequence of agentic-loop MCP tool calls and loop-* subagent spawns, the PLAN park-at-gate flow, the loop_verdict contract, and how the loop terminates. Task authoring and the human gates live in /agent-loop-task.
---

# Driving the agentic loop (Claude Code)

You (the **main agent**) are the driver. Unlike the OpenCode original — which runs
an autonomous background driver — Claude Code has no such primitive, so you drive
the stages yourself: you spawn each stage as a subagent via the **Task tool**, and
the **`agentic-loop` MCP server** owns the state machine, git isolation, verdicts,
task backlog, snapshots, and metrics. Follow this protocol exactly; do not invent
your own control flow.

## The pipeline

```
authoring + gates (the /agent-loop-task command, interactive, BEFORE the loop):
  /agent-loop-task new <idea>       ──▶ interview (main agent) ──▶ planless draft in draft/
  /agent-loop-task approve <id>     ──▶ loop_task_approve parks in queued/        ← the task gate
  /agent-loop-task approve-plan <id> ─▶ loop_plan_approve: plan-review/ ▶ in-progress/  ← the plan gate
  /agent-loop-task replan <id> [why] ─▶ loop_replan: back to queued/ (audited rejection)

the loop (/agent-loop task <id> or /agent-loop claim — this skill):
  queued task (planless):
    loop_start/loop_claim ─▶ loop_stage(plan) ─▶ spawn loop-plan-author (task mode)
        ─▶ loop_advance ─▶ park (task → plan-review/, loop over — never blocks on a human)
  in-progress task (plan approved):
    loop_start/loop_claim ─▶ loop_stage(build) ─▶ spawn loop-build ─▶ loop_advance
        ─▶ loop_stage(verify) ─▶ spawn loop-verify ─▶ loop_advance
        ─▶ loop_stage(review) ─▶ spawn loop-review ─▶ loop_advance ─▶ done (task → in-review/)
                 ▲                     │ verify FAIL: re-build      │ review FAIL: re-build
                 └─────────────────────┴────────────────────────────┘
                          (iteration++, capped by maxIterations)
```

Each `loop_advance` returns the next **action**: `{kind:"fire", stage, prompt}`
(run that stage) or `{kind:"park"|"done"|"stop", message}` (terminal — the MCP
server has already moved the task and written the run summary; just report
it). `park` is PLAN's only exit: the task moves to `plan-review/` for the
human gate and the loop ends there — an unapproved plan cannot reach BUILD.

## Step by step

1. **Start.** `mcp__agentic-loop__loop_start({id})` for one task, or
   `mcp__agentic-loop__loop_claim()` for the next — build-ready `in-progress/`
   tasks beat planless `queued/` ones; lowest priority number first within
   each pool. An in-progress task is claimed, isolated (the `loop/<id>`
   branch, or a git worktree when `worktreesDir` is configured), and entered
   at BUILD; a queued task is claimed and entered at PLAN with **no git
   isolation** (it writes only the task file, in the main tree). The composed
   stage `prompt` comes back either way.
2. **Plan (queued tasks only).** `loop_stage({stage:"plan"})`, then spawn
   **`loop-plan-author`** (Task tool) with the prompt — it runs in `task`
   mode, reads the code, and writes the `## Implementation Plan` onto the
   task file named by the prompt's `Task file:` line. When it returns, call
   `loop_advance({stageOutput: <plan summary>})` — the server validates the
   plan landed, parks the task in `plan-review/`, and returns `{kind:"park"}`.
   **The loop is over.** Tell the user to review the plan and run
   `/agent-loop-task approve-plan <id>` (or `replan <id>`); do not continue
   into BUILD.
3. **Build.** Call `mcp__agentic-loop__loop_stage({stage:"build"})` — it arms
   the stage deadline, reconciles isolation, and appends the audited
   `BUILD started` note — then spawn **`loop-build`** (Task tool) with the
   prompt (it carries the `Worktree:` line when isolated). When it returns,
   call `mcp__agentic-loop__loop_advance({stageOutput: <build summary>})` —
   the server appends `BUILD finished`, commits a checkpoint, and returns
   `{kind:"fire", stage:"verify", prompt}`.
4. **Verify.** `loop_stage({stage:"verify"})` (arms the read-only bash
   allowlist + deadline), spawn **`loop-verify`** with the prompt. The verify
   subagent records its verdict by calling `loop_verdict` itself — you do not.
   Then `loop_advance({stageOutput: <verify summary>})`: PASS →
   `{fire, review}`; FAIL → `{fire, build}` (re-build, threading the failure)
   if the iteration budget remains, else `{stop}`; ERROR → `{stop}`.
5. **Review.** `loop_stage({stage:"review"})`, spawn **`loop-review`** (it
   calls `loop_verdict`), then `loop_advance`. PASS → `{done}`. FAIL →
   `{fire, build}` if budget remains, else `{stop}`.
   - **Multi-lens review** (`reviewLenses` configured): spawn `loop-review`
     once per lens, each focused on that lens; each pass calls `loop_verdict`.
     The MCP server combines them worst-wins. Then a single `loop_advance`.
6. **Terminate.** On `{done}` the server has moved the task to `in-review/`,
   torn down the worktree, and written the `## Run summary`. Tell the user to
   review the branch diff and run `/agent-loop ship <id>` when it ships. On `{stop}`
   the task stays in `in-progress/` with an audit note — report why. When the
   iteration cap tripped, the plan itself is suspect: the fix is
   `/agent-loop-task replan <id> <why>` — the next PLAN pass addresses the
   failure and parks a fresh plan for review.

## The verdict contract

VERIFY and REVIEW record their verdict **only** by calling the
`mcp__agentic-loop__loop_verdict` tool (`stage`, `verdict` PASS/FAIL/ERROR,
optional `reason`, `criteria`). A verdict written only in prose is ignored and
counts as FAIL — repo content or a quoted contract must never flip control flow.
A missing verdict is a FAIL, never a stall. The failed criteria are threaded ahead
of the next iteration's prompt automatically.

## Between-stage bookkeeping (all via MCP tools — never by hand)

- `loop_stage({stage})` before spawning **every** stage subagent, build
  included — it arms the bash allowlist (verify/review), the worktree pin, and
  the `stageTimeoutMinutes` deadline (an overdue stage is starved of tools by
  the PreToolUse hook, and `loop_advance` stops the loop).
- `loop_checkpoint({message})` to commit build progress mid-stage (usually
  unnecessary — the server checkpoints after each build and on terminal events).
- `loop_note({text})` to append an audit note; `loop_status` for the backlog
  roll-up; `loop_recover({id})` to resume an interrupted loop;
  `loop_stop()` to abort cleanly.

## Termination summary

- **REVIEW PASS** → done; task in `in-review/`; human reviews the diff and runs
  `/agent-loop ship <id>`.
- **VERIFY or REVIEW FAIL** within `maxIterations` → re-build with the feedback.
- **FAIL** at the cap, **ERROR**, or a stage past its deadline → stop; task
  stays in `in-progress/` with a note.

## What is different from the OpenCode version

- **No `/agent-loop watch`.** Watch needs an autonomous driver firing stages on idle
  events and timers; here the main agent is the driver and the MCP server
  cannot spawn subagents. `/agent-loop claim` is the pull equivalent — one human
  trigger claims and drives the next approved task. Within your turn,
  BUILD → VERIFY → REVIEW still advance without human turns.
- **The interview runs in the main agent.** `/agent-loop-task new` interviews
  the user directly (Task subagents can't converse); the `loop-plan-author`
  subagent only writes the confirmed file.
- Verdicts and all deterministic operations go through the `agentic-loop` MCP
  tools, not in-process plugin hooks.

## Red flags

- Building a task whose plan never went through `/agent-loop-task
  approve-plan` — impossible via the tools (BUILD entry only reads
  `in-progress/`); never work around it.
- Continuing into BUILD after a `{kind:"park"}` — the plan gate sits between
  PLAN and BUILD; the loop ends at the park.
- Spawning a stage subagent without first calling `loop_stage` — the
  allowlist and deadline won't be armed, and BUILD's audit note won't exist.
- Treating a stage's prose "PASS"/"FAIL" as the verdict — only the `loop_verdict`
  tool call counts.
- Editing `docs/tasks/**` yourself — the MCP tools own the backlog; use them.
