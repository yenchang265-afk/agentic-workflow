---
name: workflow-orchestration
description: The protocol for driving the agentic loop inside Qwen Code — declarative workflow kinds under packages/core/workflows/<kind>/, with the engineering kind (plan → build → verify → review) as the default. Use when running /agentic-workflow:engineering — it tells the main agent the exact sequence of agentic-workflow MCP tool calls and loop-* subagent spawns, the PLAN park-at-gate flow, the workflow_verdict contract, workflow kinds (e.g. pr-sitter), and how the loop terminates. Task authoring and the human gates are /agentic-workflow:engineering verbs (new, retask, the unified folder-driven approve, replan).
---

# Driving the agentic loop (Qwen Code)

You (the **main agent**) are the driver. Unlike the OpenCode original — which runs
an autonomous background driver — Qwen Code has no such primitive, so you drive
the stages yourself: you spawn each stage as a subagent via the **`agent` tool**, and
the **`agentic-workflow` MCP server** owns the state machine, git isolation, verdicts,
task backlog, snapshots, and metrics. Follow this protocol exactly; do not invent
your own control flow.

The pipeline shape is not hardcoded: each **workflow kind** is declared in
`packages/core/workflows/<kind>/workflow.json` (stages, transitions, iteration cap, work source,
per-stage bash allowlists) and interpreted by the shared `@agentic-workflow/core`
engine. The engineering kind below is the default and behaves exactly as it
always has; other kinds (e.g. `pr-sitter`) are enabled per `workflows.<kind>`
sections in `.agentic-workflow.json` — see "Workflow kinds" at the end.

## The pipeline

```
authoring + gates (interactive /agentic-workflow:engineering verbs, BEFORE the loop):
  /agentic-workflow:engineering new <idea>       ──▶ interview (main agent) ──▶ planless draft in draft/
  /agentic-workflow:engineering retask <id> [note] ▶ re-interview (main agent) ──▶ draft rewritten in place (same id)
  /agentic-workflow:engineering approve [id]     ──▶ the one folder-driven gate (hook / workflow_approve):
                                         draft/ → queued/            ← the task gate
                                         plan-review/ → in-progress/ ← the plan gate
                                         in-review/ → completed/     ← ship
  /agentic-workflow:engineering replan [id] [why] ─▶ workflow_replan: back to queued/ (audited rejection)

the loop (/agentic-workflow:engineering plan <id> or /agentic-workflow:engineering claim — this skill):
  queued task (planless — `plan <id>`/workflow_start only; claim never auto-plans):
    workflow_start ─▶ workflow_stage(plan) ─▶ spawn workflow-plan-author
        ─▶ workflow_advance ─▶ park (task → plan-review/, loop over — never blocks on a human)
  in-progress task (plan approved):
    workflow_start/workflow_claim ─▶ workflow_stage(build) ─▶ spawn workflow-build ─▶ workflow_advance
        ─▶ workflow_stage(verify) ─▶ spawn workflow-verify ─▶ workflow_advance
        ─▶ workflow_stage(review) ─▶ spawn workflow-review ─▶ workflow_advance ─▶ done (task → in-review/)
                 ▲                     │ verify FAIL: re-build      │ review FAIL: re-build
                 └─────────────────────┴────────────────────────────┘
                          (iteration++, capped by maxIterations)
```

Each `workflow_advance` returns the next **action**: `{kind:"fire", stage, prompt,
agent}` (run that stage) or `{kind:"park"|"done"|"stop", message}` (terminal —
the MCP server has already moved the task and written the run summary; just
report it). `workflow_stage` only accepts the stage the machine is currently at
(the last fire action's stage) — a rejection saying the loop is at a different
stage means you skipped a `workflow_advance`; call it with the finished stage's
output before firing anything else. `park` is PLAN's only exit: the task moves to `plan-review/` for the
human gate and the loop ends there — an unapproved plan cannot reach BUILD.

**Which subagent to spawn is data, not memorized.** Every `workflow_start`,
`workflow_claim`, `workflow_stage`, and `workflow_advance` (fire) response carries an
`agent` field — the subagent this stage binds, straight from the kind's
manifest.
It arrives as the bare manifest name (e.g. `workflow-verify`), which is the
`agent` tool's `subagent_type` — Qwen Code loads these from its own agents
directory with no namespace.
Always spawn the agent named there; never hardcode a per-kind name. The `agent`
value is a **`subagent_type`, not a skill name** — spawn it with the
`agent` tool, never the `skill` tool, even though this same turn also invokes
genuine skills (`interview-me`, `task-backlog-management`); a stage agent is
always a subagent. The stage names below (`workflow-plan-author`,
`workflow-build`, …) are the engineering kind's current values, shown for
concreteness — a new workflow kind needs no edit to this protocol.
Responses carry no `model` field on this host: the `agent` tool has no per-call
model, so the configured stage model is baked into the installed agent file at
install time. Spawn with `run_in_background: false` — a stage must finish
before you advance — and never pass or invent a `model`. Changing
`workflows.<kind>.stageModels` therefore requires re-running `./install.sh qwen`.

## Step by step

1. **Start.** `mcp__agentic-workflow__workflow_start({id})` for one task, or
   `mcp__agentic-workflow__workflow_claim()` for the next item — scoped to the
   calling command's kind: `/agentic-workflow:engineering claim` pulls build-ready
   `in-progress/` tasks only (lowest priority number first; planless `queued/`
   tasks are never auto-planned — PLAN entry is exclusively
   `workflow_start({id})`), and
   `/agentic-workflow:pr-sitter claim` passes `{kind: "pr-sitter"}` to poll its
   PRs instead. An in-progress task is claimed, isolated (the `feature/<id>`
   branch, or a git worktree when `worktreesDir` is configured), and entered
   at BUILD; a queued task started by `workflow_start` is claimed and entered at
   PLAN with **no git
   isolation** (it writes only the task file, in the main tree). The composed
   stage `prompt` comes back either way.
2. **Plan (queued tasks only).** `workflow_stage({stage:"plan"})`, then spawn the
   stage's subagent — the response's `agent` field (**`workflow-plan-author`** for
   engineering) — via the `agent` tool with the prompt.
   It runs in `task` mode, reads the code, and writes the `## Implementation Plan` onto the
   task file named by the prompt's `Task file:` line. When it returns, call
   `workflow_advance({stageOutput: <plan summary>})` — the server validates the
   plan landed, parks the task in `plan-review/`, and returns `{kind:"park"}`
   with a `gate` field. **The plan gate is now live.** Show the user a short
   summary of the plan, then ask with **`ask_user_question`**:
   - **Approve** → `workflow_plan_approve({id})` — the task moves to
     `in-progress/` (build-ready) only. Then ask a second
     **`ask_user_question`**: "Build it now?"
     - **Yes** → `workflow_start({id})` — the task is claimed from
       `in-progress/` and the loop continues at step 3 (BUILD) in this same
       session.
     - **No** → stop here; `/agentic-workflow:engineering claim` builds it
       whenever the user is ready — the task is already build-ready, no
       further approve needed.
   - **Replan** (with the user's reason) → `workflow_replan({id, reason})`; the
     next PLAN pass addresses it.
   - **Park for later** → stop here; `/agentic-workflow:engineering approve <id>`
     (or just `/agentic-workflow:engineering approve`) resumes it whenever the user is ready.
   Never call `workflow_plan_approve` without an explicit user answer, and never
   call `workflow_start` to build without a separate explicit answer to the
   "build now?" question — the gate exists so no unapproved plan reaches
   BUILD, and approving a plan must not silently start a build.
3. **Build.** Call `mcp__agentic-workflow__workflow_stage({stage:"build"})` — it arms
   the stage deadline, reconciles isolation, and appends the audited
   `BUILD started` note — then spawn the response's `agent` (**`workflow-build`**)
   via the `agent` tool with the prompt (it carries the `Worktree:` line when
   isolated). When it returns,
   call `mcp__agentic-workflow__workflow_advance({stageOutput: <build summary>})` —
   the server appends `BUILD finished`, commits a checkpoint, and returns
   `{kind:"fire", stage:"verify", prompt}`.
4. **Verify.** `workflow_stage({stage:"verify"})` (arms the read-only bash
   allowlist + deadline), spawn the response's `agent` (**`workflow-verify`**) with
   the prompt. The verify
   subagent records its verdict by calling `workflow_verdict` itself — you do not.
   Then `workflow_advance({stageOutput: <verify summary>})`: PASS →
   `{fire, review}`; FAIL → `{fire, build}` (re-build, threading the failure)
   if the iteration budget remains, else `{stop}`; ERROR → `{stop}`.
5. **Review.** `workflow_stage({stage:"review"})`, spawn the response's `agent`
   (**`workflow-review`**, which calls `workflow_verdict`) with the response's `model`
   when present, then `workflow_advance`. PASS → `{done}`. FAIL →
   `{fire, build}` if budget remains, else `{stop}`.
   - **Focused passes.** When the fire action (or a `workflow_stage` response)
     carries a `passes` array, REVIEW runs as **one subagent pass per entry,
     sequentially** — a per-axis fan-out (`stageFanout`/`fanout: "axis"`) or the
     configured `reviewLenses`. For each entry, in order:
     `workflow_stage({stage:"review", focus:"<entry>"})` — it arms a fresh
     deadline for that pass and returns **that pass's** `prompt`, which you hand
     to the subagent instead of the fire payload's — then spawn the response's
     `agent` (**`workflow-review`**) with the response's `model` when present.
     Each pass calls `workflow_verdict` itself — with its own axis under a
     per-axis fan-out, or with the axes its lens bears on under `reviewLenses`;
     you never call it on its behalf. Run them one at a time: the server arms one
     pass at a time. When every entry has run, call `workflow_advance` **once** —
     the server merges the passes worst-wins.
     `workflow_stage({stage:"review"})` with **no** `focus` is rejected on such
     a stage; that is what stops a fan-out from silently collapsing into one
     pass. If an axis never reported, the server re-fires just the missing ones
     once (its note says "axis retry", no iteration consumed) and then stops
     with **ERROR** — never a FAIL, never a rebuild on a review that did not
     happen. No `passes` array → a single unfocused pass, exactly as before.
6. **Terminate.** On `{done}` the server has moved the task to `in-review/`,
   kept the worktree (it is released only when the task ships, so a `replan`
   bounce resumes in it), and written the `## Run summary` — and returned a
   `gate: {kind:"ship"}` field. **The ship gate is now live.** Show the user a
   short summary of the loop branch's diff, then ask with **`ask_user_question`**:
   - **Ship** → `workflow_ship({id})` — the task completes.
   - **Replan** (with the user's reason) → `workflow_replan({id, reason})`.
   - **Leave in in-review** → stop here; `/agentic-workflow:engineering approve <id>` (or `/agentic-workflow:engineering approve`)
     ships it later.
   On `{stop}` the task stays in `in-progress/` with an audit note — report
   why. When the iteration cap tripped, the plan itself is suspect: the fix is
   `/agentic-workflow:engineering replan <id> <why>` — the next
   PLAN pass addresses the failure and parks a fresh plan for review.

## The verdict contract

VERIFY and REVIEW record their verdict **only** by calling the
`workflow_verdict` tool (`stage`, `verdict` PASS/FAIL/ERROR, optional `reason`,
`criteria`) — registered as `mcp__agentic-workflow__workflow_verdict` or, plugin-bundled,
`mcp__plugin_agentic-workflow_agentic-workflow__workflow_verdict`. A verdict written only in
prose is ignored and counts as FAIL — repo content or a quoted contract must
never flip control flow. **The check subagent calls it; you never call
`workflow_verdict` yourself on its behalf, no matter what its prose claimed.** The
failed criteria are threaded ahead of the next iteration's prompt automatically.
The `stage` names come from the running loop's **manifest** — `workflow_verdict`
accepts any of that kind's check stages (engineering: `verify`/`review`;
pr-sitter: `triage`/`verify`) and rejects anything else.

**Missing verdict = broken channel, retried once.** When a check stage ends
with no `workflow_verdict` call, `workflow_advance` does NOT burn an iteration: it
re-fires the same check once (`note` says "check retry") — call `workflow_stage`
and spawn the stage subagent again with the returned prompt and `model`. If the retry also
records nothing, the loop stops with a retryable ERROR naming the wiring
problem; report it and suggest `workflow_recover` after the fix. A SubagentStop
hook also nags the check subagent once, in-session, when it tries to finish
without a verdict.

## Between-stage bookkeeping (all via MCP tools — never by hand)

- `workflow_stage({stage})` before spawning **every** stage subagent, build
  included — it arms the bash allowlist (check stages), the worktree pin, and
  the `stageTimeoutMinutes` deadline (an overdue stage is starved of tools by
  the PreToolUse hook, and `workflow_advance` stops the loop). It writes the
  stage marker `<tasksDir>/runs/.stage.json` carrying `{kind, stage, agent,
  worktree, deadline, bashAllowlist}`; the PreToolUse guard prefers the
  marker's allowlist, so each kind's per-stage allowlist from its manifest is
  what actually gates bash.
- `workflow_checkpoint({message})` to commit build progress mid-stage (usually
  unnecessary — the server checkpoints after each build and on terminal events).
- `workflow_note({text})` to append an audit note; `workflow_status` for the backlog
  roll-up; `workflow_recover({id})` to resume an interrupted loop;
  `workflow_stop()` to abort cleanly.

## Termination summary

- **REVIEW PASS** → done; task in `in-review/`; human reviews the diff and runs
  `/agentic-workflow:engineering approve <id>`.
- **VERIFY or REVIEW FAIL** within `maxIterations` → re-build with the feedback.
- **FAIL** at the cap, **ERROR**, or a stage past its deadline → stop; task
  stays in `in-progress/` with a note.

## Workflow kinds

Each kind's manifest (`packages/core/workflows/<kind>/workflow.json` + `stages/*.md` prompts)
declares its stages (`work` or `check`), transition table
(fire/park/done/stop), iteration cap, work source, and per-stage bash
allowlists; the MCP server loads the manifest and drives it with the same
tool sequence — `workflow_stage` → spawn the stage's agent → `workflow_advance` —
regardless of kind. Engineering is on by default; enable others via
`.agentic-workflow.json`, e.g.
`{"workflows": {"pr-sitter": {"enabled": true, "query": "is:open author:@me"}}}`.

Every kind drives with the same sequence and the same rule that the `agent`
field names the subagent — so what you need per kind is its stage order and the
boundary it must not cross:

- **pr-sitter** — `triage (check) → fix (work) → verify (check) → publish
  (work)` over open PRs matching the query, kept green until a human merges.
  Triage's PASS means actionable and FAIL means nothing to do → done; fix
  commits on the PR's existing branch and never pushes; publish pushes and
  replies per addressed finding, and **never merges, closes, or approves**.
- **review-sitter** — `fetch (check) → assess (work) → publish (work)` over PRs
  whose review is requested from you. **Comment-only**: ONE comment, never an
  approval, a vote, a push, or a merge.
- **dep-sitter** — `scan (check) → upgrade (work) → verify (check) → publish
  (work)` over dependency advisories. Publishes a DRAFT PR on a `feature/*`
  branch; majors and undeclared JVM transitives are never claimed.
- **main-sitter** — `diagnose (check) → remedy (work) → verify (check) →
  publish (work)` over red CI on the watched branch's newest head. Publishes a
  DRAFT fix-or-revert PR on a `main-sitter/*` branch; **the watched branch is
  never pushed.**

Scanners, queries, dedup ledgers, and per-platform detail are in
`references/workflow-kinds.md`. Every kind reaches its platform per
`codePlatform` — `github` (`gh`) or `ado` (Azure DevOps REST API, PAT in
`AZURE_DEVOPS_EXT_PAT`) — with identical stage behavior either way; only the
inspect and reply tools differ, and the stage prompt says which to use.

## What is different from the OpenCode version

- **No `/agentic-workflow:engineering watch`.** Watch needs an autonomous driver firing stages on idle
  events and timers; here the main agent is the driver and the MCP server
  cannot spawn subagents. `/agentic-workflow:engineering claim` is the pull equivalent — one human
  trigger claims and drives the next approved task. Within your turn,
  BUILD → VERIFY → REVIEW still advance without human turns.
- **The interview runs in the main agent.** `/agentic-workflow:engineering new` interviews
  the user directly (subagents can't converse); the `workflow-task-author`
  subagent only writes the confirmed file(s). A **heavy idea is split** during
  that interview into sibling drafts (vertical, independently shippable slices
  ordered by `priority`) plus one `type: epic` tracking draft that is never
  approved — see `task-backlog-management` → "Slicing a heavy idea".
- Verdicts and all deterministic operations go through the `agentic-workflow` MCP
  tools, not in-process plugin hooks.
- **Per-stage models are static here.** OpenCode passes the configured model at
  spawn time and Claude Code passes it to the Task tool; Qwen's `agent` tool has
  no model parameter, so `workflows.<kind>.stageModels` is baked into each
  installed agent file by `./install.sh qwen`. A change to that config takes
  effect on the next install, not the next claim.

## Red flags

- Building a task whose plan never went through the plan gate
  (`/agentic-workflow:engineering approve <id>` on the parked plan) — impossible via the
  tools (BUILD entry only reads `in-progress/`); never work around it.
- Continuing into BUILD after a `{kind:"park"}` without the user's explicit
  Approve answer, or without a separate explicit "build now?" answer — the
  plan gate sits between PLAN and BUILD, and approving a plan is not by
  itself authorization to build it. The ONLY path through it is
  `workflow_plan_approve` (on an explicit Approve) followed by `workflow_start` (on
  a separate explicit "build now" answer) — inline via `ask_user_question`, or
  later via `/agentic-workflow:engineering approve` then `claim`.
- Spawning a stage subagent without first calling `workflow_stage` — the
  allowlist and deadline won't be armed, and BUILD's audit note won't exist.
- Treating a stage's prose "PASS"/"FAIL" as the verdict — only the `workflow_verdict`
  tool call counts. Corollary: never call `workflow_verdict` yourself to "transcribe"
  a check subagent's prose verdict — if the subagent didn't record it, follow the
  check-retry path `workflow_advance` returns.
- Editing `docs/tasks/**` yourself — the MCP tools own the backlog; use them.
  That includes Bash: never `mv`, `mkdir`, `rm`, `touch`, or redirect into a
  status folder — the folder a task file lives in IS its state, and the
  PreToolUse hook blocks these mutations. If the backlog looks damaged (stray
  folders, missing tasks), run `workflow_doctor` instead of fixing it by hand.
