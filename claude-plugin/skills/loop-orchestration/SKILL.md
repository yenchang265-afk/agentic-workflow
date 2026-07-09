---
name: loop-orchestration
description: The protocol for driving the agentic loop inside Claude Code — declarative loop kinds under loops/<kind>/, with the engineering kind (plan → build → verify → review) as the default. Use when running /agent-loop — it tells the main agent the exact sequence of agentic-loop MCP tool calls and loop-* subagent spawns, the PLAN park-at-gate flow, the loop_verdict contract, loop kinds (e.g. pr-sitter), and how the loop terminates. Task authoring and the human gates live in /agent-loop-task.
---

# Driving the agentic loop (Claude Code)

You (the **main agent**) are the driver. Unlike the OpenCode original — which runs
an autonomous background driver — Claude Code has no such primitive, so you drive
the stages yourself: you spawn each stage as a subagent via the **Task tool**, and
the **`agentic-loop` MCP server** owns the state machine, git isolation, verdicts,
task backlog, snapshots, and metrics. Follow this protocol exactly; do not invent
your own control flow.

The pipeline shape is not hardcoded: each **loop kind** is declared in
`loops/<kind>/loop.json` (stages, transitions, iteration cap, work source,
per-stage bash allowlists) and interpreted by the shared `@agentic-loop/core`
engine. The engineering kind below is the default and behaves exactly as it
always has; other kinds (e.g. `pr-sitter`) are enabled per `loops.<kind>`
sections in `.agentic-loop.json` — see "Loop kinds" at the end.

## The pipeline

```
authoring + gates (the /agent-loop-task command, interactive, BEFORE the loop):
  /agent-loop-task new <idea>       ──▶ interview (main agent) ──▶ planless draft in draft/
  /agent-loop-task retask <id> [note] ▶ re-interview (main agent) ──▶ draft rewritten in place (same id)
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
   `mcp__agentic-loop__loop_claim()` for the next — it polls **all enabled
   loop kinds** in claim-priority order: the engineering backlog first
   (build-ready `in-progress/` tasks beat planless `queued/` ones; lowest
   priority number first within each pool), then opted-in kinds (e.g.
   pr-sitter PRs). An in-progress task is claimed, isolated (the `feature/<id>`
   branch, or a git worktree when `worktreesDir` is configured), and entered
   at BUILD; a queued task is claimed and entered at PLAN with **no git
   isolation** (it writes only the task file, in the main tree). The composed
   stage `prompt` comes back either way.
2. **Plan (queued tasks only).** `loop_stage({stage:"plan"})`, then spawn
   **`loop-plan-author`** (Task tool) with the prompt — it runs in `task`
   mode, reads the code, and writes the `## Implementation Plan` onto the
   task file named by the prompt's `Task file:` line. When it returns, call
   `loop_advance({stageOutput: <plan summary>})` — the server validates the
   plan landed, parks the task in `plan-review/`, and returns `{kind:"park"}`
   with a `gate` field. **The plan gate is now live.** Show the user a short
   summary of the plan, then ask with **AskUserQuestion**:
   - **Approve** → `loop_plan_approve({id})`, then `loop_start({id})` — the
     task is claimed from `in-progress/` and the loop continues at step 3
     (BUILD) in this same session.
   - **Replan** (with the user's reason) → `loop_replan({id, reason})`; the
     next PLAN pass addresses it.
   - **Park for later** → stop here; `/agent-loop-task approve-plan <id>`
     (or just `/agent-loop approve`) resumes it whenever the user is ready.
   Never call `loop_plan_approve` without an explicit user answer — the gate
   exists so no unapproved plan reaches BUILD.
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
   torn down the worktree, and written the `## Run summary` — and returned a
   `gate: {kind:"ship"}` field. **The ship gate is now live.** Show the user a
   short summary of the loop branch's diff, then ask with **AskUserQuestion**:
   - **Ship** → `loop_ship({id})` — the task completes.
   - **Replan** (with the user's reason) → `loop_replan({id, reason})`.
   - **Leave in in-review** → stop here; `/agent-loop ship <id>` (or `/agent-loop approve`)
     ships it later.
   On `{stop}` the task stays in `in-progress/` with an audit note — report
   why. When the iteration cap tripped, the plan itself is suspect: the fix is
   `/agent-loop-task replan <id> <why>` (or `/agent-loop reject <id> <why>`) — the next
   PLAN pass addresses the failure and parks a fresh plan for review.

## The verdict contract

VERIFY and REVIEW record their verdict **only** by calling the
`mcp__agentic-loop__loop_verdict` tool (`stage`, `verdict` PASS/FAIL/ERROR,
optional `reason`, `criteria`). A verdict written only in prose is ignored and
counts as FAIL — repo content or a quoted contract must never flip control flow.
A missing verdict is a FAIL, never a stall. The failed criteria are threaded ahead
of the next iteration's prompt automatically. The `stage` names come from the
running loop's **manifest** — `loop_verdict` accepts any of that kind's check
stages (engineering: `verify`/`review`; pr-sitter: `triage`/`verify`) and
rejects anything else.

## Between-stage bookkeeping (all via MCP tools — never by hand)

- `loop_stage({stage})` before spawning **every** stage subagent, build
  included — it arms the bash allowlist (check stages), the worktree pin, and
  the `stageTimeoutMinutes` deadline (an overdue stage is starved of tools by
  the PreToolUse hook, and `loop_advance` stops the loop). It writes the
  stage marker `<tasksDir>/runs/.stage.json` carrying `{kind, stage,
  worktree, deadline, bashAllowlist}`; the PreToolUse guard prefers the
  marker's allowlist, so each kind's per-stage allowlist from its manifest is
  what actually gates bash.
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

## Loop kinds

Each kind's manifest (`loops/<kind>/loop.json` + `stages/*.md` prompts)
declares its stages (`work` or `check`), transition table
(fire/park/done/stop), iteration cap, work source, and per-stage bash
allowlists; the MCP server loads the manifest and drives it with the same
tool sequence — `loop_stage` → spawn the stage's agent → `loop_advance` —
regardless of kind. Engineering is on by default; enable others via
`.agentic-loop.json`, e.g.
`{"loops": {"pr-sitter": {"enabled": true, "query": "is:open author:@me"}}}`.

**pr-sitter** sits on open PRs matching the query and keeps them green until
a human merges: **triage** (check; spawn `loop-pr-triage`; read-only `gh`
inspection of failing checks / changes requested / new comments / merge
conflict; its `loop_verdict` PASS = actionable, FAIL = nothing to do → done)
→ **fix** (work; spawn `loop-pr-fix`; commits on the PR's existing branch in
a worktree, never pushes) → **verify** (check; reuses `loop-verify`; FAIL
re-fires fix, cap 3) → **publish** (work; spawn `loop-pr-publish`;
`git push origin <branch>` + `gh pr comment` replies per addressed finding —
it **never merges, closes, or approves**). A per-PR dedup ledger at
`<tasksDir>/runs/pr-sitter/pr-<n>.json` (head-SHA + comment-timestamp
watermarks, own-login filter) keeps it from reacting to its own pushes, and
a failed attempt parks the PR until a human pushes a new head.

The PR sitter reaches its platform per `codePlatform`: `github` (`gh`), `ado`
(the `az` CLI), or `ado-mcp` (the Microsoft ADO MCP server named `ado`, for
environments that forbid `az`). In every mode the stages behave identically;
only the inspect/reply tools differ, and the stage prompt says which to use.

**ado-mcp claim is two-phase** (the polling process can't call MCP tools, so an
agent gathers the data first):

1. Call `loop_claim` as usual. If it returns `{claimed:null, needsAdoData:{request,
   guidance}}`, the sitter needs Azure DevOps data it can't fetch itself.
2. Spawn the **`loop-pr-poll`** subagent (Task tool) with `guidance` as its prompt;
   it calls the read-only `ado` MCP tools and returns one JSON bundle.
3. Call `loop_claim` again passing that JSON as `adoData`. It now claims the PR (or
   returns null if nothing needs attention) and you drive triage → … → publish as
   normal. `github` and `ado` modes never take this detour — `loop_claim` claims
   directly.

## What is different from the OpenCode version

- **No `/agent-loop watch`.** Watch needs an autonomous driver firing stages on idle
  events and timers; here the main agent is the driver and the MCP server
  cannot spawn subagents. `/agent-loop claim` is the pull equivalent — one human
  trigger claims and drives the next approved task. Within your turn,
  BUILD → VERIFY → REVIEW still advance without human turns.
- **The interview runs in the main agent.** `/agent-loop-task new` interviews
  the user directly (Task subagents can't converse); the `loop-plan-author`
  subagent only writes the confirmed file(s). A **heavy idea is split** during
  that interview into sibling drafts (vertical, independently shippable slices
  ordered by `priority`) plus one `type: epic` tracking draft that is never
  approved — see `task-backlog-management` → "Slicing a heavy idea".
- Verdicts and all deterministic operations go through the `agentic-loop` MCP
  tools, not in-process plugin hooks.

## Red flags

- Building a task whose plan never went through `/agent-loop-task
  approve-plan` — impossible via the tools (BUILD entry only reads
  `in-progress/`); never work around it.
- Continuing into BUILD after a `{kind:"park"}` without the user's explicit
  Approve answer — the plan gate sits between PLAN and BUILD. The ONLY path
  through it is `loop_plan_approve` + `loop_start` after the user approves
  (inline via AskUserQuestion, or later via `/agent-loop-task approve-plan`).
- Spawning a stage subagent without first calling `loop_stage` — the
  allowlist and deadline won't be armed, and BUILD's audit note won't exist.
- Treating a stage's prose "PASS"/"FAIL" as the verdict — only the `loop_verdict`
  tool call counts.
- Editing `docs/tasks/**` yourself — the MCP tools own the backlog; use them.
  That includes Bash: never `mv`, `mkdir`, `rm`, `touch`, or redirect into a
  status folder — the folder a task file lives in IS its state, and the
  PreToolUse hook blocks these mutations. If the backlog looks damaged (stray
  folders, missing tasks), run `loop_doctor` instead of fixing it by hand.
