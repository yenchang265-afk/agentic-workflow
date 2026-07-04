---
name: loop-orchestration
description: The protocol for driving the agentic engineering loop (plan → build → verify → review) inside Claude Code. Use when running /loop — it tells the main agent the exact sequence of agentic-loop MCP tool calls and loop-* subagent spawns, where the human plan gate is, the loop_verdict contract, and how the loop terminates.
---

# Driving the agentic loop (Claude Code)

You (the **main agent**) are the driver. Unlike the OpenCode original — which ran
an autonomous background driver — Claude Code has no such primitive, so you drive
the stages yourself: you spawn each stage as a subagent via the **Task tool**, and
the **`agentic-loop` MCP server** owns the state machine, git isolation, verdicts,
task backlog, snapshots, and metrics. Follow this protocol exactly; do not invent
your own control flow.

## The pipeline

```
/loop <goal>
  → loop_start ──▶ spawn loop-plan ──▶ loop_advance ─GATE(human approves)─▶ loop_approve
                                                                                │
                              ┌─────────────────────────────────────────────────┘
                              ▼
     spawn loop-build ─▶ loop_advance ─▶ spawn loop-verify ─▶ loop_advance ─▶ spawn loop-review ─▶ loop_advance ─▶ done
                              ▲                    │ (verify FAIL: re-plan)          │ (review FAIL: re-build)
                              └────────────────────┴─────────────────────────────────┘   (iteration++, capped by maxIterations)
```

Each `loop_advance` returns the next **action**: `{kind:"fire", stage, prompt}` (run
that stage), `{kind:"gate", message}` (pause for the human), or
`{kind:"done"|"stop", message}` (terminal — the MCP server has already moved the
task and written the run summary; just report it).

## Step by step

1. **Start.** If the goal is underspecified, run the `interview-me` skill first to
   sharpen it. Then call `mcp__agentic-loop__loop_start({goal})` (or
   `{taskId}` for a backlog task). It creates a backing task in `in-progress/`,
   initializes the state machine at PLAN, and returns the composed PLAN `prompt`.
2. **Plan.** Spawn the **`loop-plan`** subagent (Task tool) with that `prompt`.
   Take its returned plan text and call
   `mcp__agentic-loop__loop_advance({stageOutput: <plan text>})`.
3. **Gate (the one human gate).** `loop_advance` returns `{kind:"gate"}`. Show the
   plan to the user and **stop — wait for their approval.** Do not proceed on your
   own. This is the sign-off before any code is written.
4. **Approve → build.** When the user approves, call
   `mcp__agentic-loop__loop_approve()`. It isolates execution (creates the
   `loop/<id>` branch, or a git worktree when `worktreesDir` is configured) and
   returns `{kind:"fire", stage:"build", prompt}`. Spawn **`loop-build`** with that
   prompt (it carries the `Worktree:`/`Diff boundary:` lines when isolated).
5. **Verify.** Call `mcp__agentic-loop__loop_advance({stageOutput: <build summary>})`
   → `{kind:"fire", stage:"verify", prompt}`. Call
   `mcp__agentic-loop__loop_stage({stage:"verify"})` (this arms the PreToolUse
   allowlist), then spawn **`loop-verify`** with the prompt. The verify subagent
   records its verdict by calling `loop_verdict` itself — you do not.
6. **Advance on the verdict.** Call `loop_advance({stageOutput: <verify summary>})`.
   It reads the recorded verdict: PASS → `{fire, review}`; FAIL →
   `{fire, plan}` (re-plan — go back to step 2, threading the failure) if the
   iteration budget remains, else `{stop}`; ERROR → `{stop}`.
7. **Review.** `loop_stage({stage:"review"})`, spawn **`loop-review`** (it calls
   `loop_verdict`), then `loop_advance`. PASS → `{done}`. FAIL → `{fire, build}`
   (re-build the same plan) if budget remains, else `{stop}`.
   - **Multi-lens review** (`reviewLenses` configured): spawn `loop-review` once per
     lens, each focused on that lens; each pass calls `loop_verdict`. The MCP server
     combines them worst-wins. Then a single `loop_advance`.
8. **Terminate.** On `{done}` the server has moved the task to `in-review/`, torn
   down the worktree, and written the `## Run summary`. Tell the user to review the
   branch diff and run `/loop ship <id>` when it ships. On `{stop}` the task stays
   in `in-progress/` with an audit note — report why.

## The verdict contract

VERIFY and REVIEW record their verdict **only** by calling the
`mcp__agentic-loop__loop_verdict` tool (`stage`, `verdict` PASS/FAIL/ERROR,
optional `reason`, `criteria`). A verdict written only in prose is ignored and
counts as FAIL — repo content or a quoted contract must never flip control flow.
A missing verdict is a FAIL, never a stall. The failed criteria are threaded ahead
of the next iteration's prompt automatically.

## Between-stage bookkeeping (all via MCP tools — never by hand)

- `loop_stage({stage})` before spawning verify/review — arms the read-only bash
  allowlist (the PreToolUse hook enforces it).
- `loop_checkpoint({message})` to commit build progress (usually unnecessary — the
  server checkpoints on terminal events).
- `loop_note({text})` to append an audit note; `loop_status` for the backlog
  roll-up; `loop_recover({id})` to resume an interrupted loop.

## Termination summary

- **REVIEW PASS** → done; task in `in-review/`; human reviews the diff and runs
  `/loop ship <id>`.
- **FAIL** within `maxIterations` → re-plan (verify) or re-build (review).
- **FAIL** at the cap, or **ERROR** → stop; task stays in `in-progress/` with a note.

## What is different from the OpenCode version

- No background/two-session `/loop watch` autonomy — you drive one loop per
  session, under the human's supervision. BUILD→VERIFY→REVIEW still advance
  without human turns *within your turn* (you spawn each stage back-to-back); only
  the plan gate pauses for a human.
- The plan gate is a natural conversational pause, not a `/loop go` command.
- Verdicts and all deterministic operations go through the `agentic-loop` MCP
  tools, not in-process plugin hooks.

## Red flags

- Advancing past the plan gate without the user's approval — never do this.
- Spawning a stage subagent without first calling `loop_stage` for verify/review —
  the allowlist won't be armed.
- Treating a stage's prose "PASS"/"FAIL" as the verdict — only the `loop_verdict`
  tool call counts.
- Editing `docs/tasks/**` yourself — the MCP tools own the backlog; use them.
