---
name: loop-orchestration
description: The protocol for driving the agentic loop inside Claude Code — declarative loop kinds under packages/core/loops/<kind>/, with the engineering kind (plan → build → verify → review) as the default. Use when running /agentic-loop:engineering — it tells the main agent the exact sequence of agentic-loop MCP tool calls and loop-* subagent spawns, the PLAN park-at-gate flow, the loop_verdict contract, loop kinds (e.g. pr-sitter), and how the loop terminates. Task authoring and the human gates are /agentic-loop:engineering verbs (new, retask, the unified folder-driven approve, replan).
---

# Driving the agentic loop (Claude Code)

You (the **main agent**) are the driver. Unlike the OpenCode original — which runs
an autonomous background driver — Claude Code has no such primitive, so you drive
the stages yourself: you spawn each stage as a subagent via the **Task tool**, and
the **`agentic-loop` MCP server** owns the state machine, git isolation, verdicts,
task backlog, snapshots, and metrics. Follow this protocol exactly; do not invent
your own control flow.

The pipeline shape is not hardcoded: each **loop kind** is declared in
`packages/core/loops/<kind>/loop.json` (stages, transitions, iteration cap, work source,
per-stage bash allowlists) and interpreted by the shared `@agentic-loop/core`
engine. The engineering kind below is the default and behaves exactly as it
always has; other kinds (e.g. `pr-sitter`) are enabled per `loops.<kind>`
sections in `.agentic-loop.json` — see "Loop kinds" at the end.

## The pipeline

```
authoring + gates (interactive /agentic-loop:engineering verbs, BEFORE the loop):
  /agentic-loop:engineering new <idea>       ──▶ interview (main agent) ──▶ planless draft in draft/
  /agentic-loop:engineering retask <id> [note] ▶ re-interview (main agent) ──▶ draft rewritten in place (same id)
  /agentic-loop:engineering approve [id]     ──▶ the one folder-driven gate (hook / loop_approve):
                                         draft/ → queued/            ← the task gate
                                         plan-review/ → in-progress/ ← the plan gate
                                         in-review/ → completed/     ← ship
  /agentic-loop:engineering replan [id] [why] ─▶ loop_replan: back to queued/ (audited rejection)

the loop (/agentic-loop:engineering plan <id> or /agentic-loop:engineering claim — this skill):
  queued task (planless — `plan <id>`/loop_start only; claim never auto-plans):
    loop_start ─▶ loop_stage(plan) ─▶ spawn loop-plan-author (task mode)
        ─▶ loop_advance ─▶ park (task → plan-review/, loop over — never blocks on a human)
  in-progress task (plan approved):
    loop_start/loop_claim ─▶ loop_stage(build) ─▶ spawn loop-build ─▶ loop_advance
        ─▶ loop_stage(verify) ─▶ spawn loop-verify ─▶ loop_advance
        ─▶ loop_stage(review) ─▶ spawn loop-review ─▶ loop_advance ─▶ done (task → in-review/)
                 ▲                     │ verify FAIL: re-build      │ review FAIL: re-build
                 └─────────────────────┴────────────────────────────┘
                          (iteration++, capped by maxIterations)
```

Each `loop_advance` returns the next **action**: `{kind:"fire", stage, prompt,
agent}` (run that stage) or `{kind:"park"|"done"|"stop", message}` (terminal —
the MCP server has already moved the task and written the run summary; just
report it). `park` is PLAN's only exit: the task moves to `plan-review/` for the
human gate and the loop ends there — an unapproved plan cannot reach BUILD.

**Which subagent to spawn is data, not memorized.** Every `loop_start`,
`loop_claim`, `loop_stage`, and `loop_advance` (fire) response carries an
`agent` field — the subagent this stage binds, straight from the kind's
manifest, under the plugin namespace (e.g. `agentic-loop:loop-verify` — the
Task tool's `subagent_type` for a plugin-provided agent). Always spawn the
agent named there; never hardcode a per-kind name. If that subagent type is
unknown to your Claude Code version, retry once with the bare name (e.g.
`loop-verify`). The stage names below (`loop-plan-author`, `loop-build`, …) are
the engineering kind's current values, shown for concreteness — a new loop kind
needs no edit to this protocol. The same responses may also carry a `model`
field — the model the user configured for that stage (manifest `model` or
config `loops.<kind>.stageModels`). When present, pass it as the Task tool's
`model` parameter when spawning that stage's subagent; when absent, don't set
`model` (host default). Never hardcode a per-stage model.

## Step by step

1. **Start.** `mcp__agentic-loop__loop_start({id})` for one task, or
   `mcp__agentic-loop__loop_claim()` for the next item — scoped to the
   calling command's kind: `/agentic-loop:engineering claim` pulls build-ready
   `in-progress/` tasks only (lowest priority number first; planless `queued/`
   tasks are never auto-planned — PLAN entry is exclusively
   `loop_start({id})`), and
   `/agentic-loop:pr-sitter claim` passes `{kind: "pr-sitter"}` to poll its
   PRs instead. An in-progress task is claimed, isolated (the `feature/<id>`
   branch, or a git worktree when `worktreesDir` is configured), and entered
   at BUILD; a queued task started by `loop_start` is claimed and entered at
   PLAN with **no git
   isolation** (it writes only the task file, in the main tree). The composed
   stage `prompt` comes back either way.
2. **Plan (queued tasks only).** `loop_stage({stage:"plan"})`, then spawn the
   stage's subagent — the response's `agent` field (**`loop-plan-author`** for
   engineering) — via the Task tool with the prompt. It runs in `task`
   mode, reads the code, and writes the `## Implementation Plan` onto the
   task file named by the prompt's `Task file:` line. When it returns, call
   `loop_advance({stageOutput: <plan summary>})` — the server validates the
   plan landed, parks the task in `plan-review/`, and returns `{kind:"park"}`
   with a `gate` field. **The plan gate is now live.** Show the user a short
   summary of the plan, then ask with **AskUserQuestion**:
   - **Approve** → `loop_plan_approve({id})` — the task moves to
     `in-progress/` (build-ready) only. Then ask a second
     **AskUserQuestion**: "Build it now?"
     - **Yes** → `loop_start({id})` — the task is claimed from
       `in-progress/` and the loop continues at step 3 (BUILD) in this same
       session.
     - **No** → stop here; `/agentic-loop:engineering claim` builds it
       whenever the user is ready — the task is already build-ready, no
       further approve needed.
   - **Replan** (with the user's reason) → `loop_replan({id, reason})`; the
     next PLAN pass addresses it.
   - **Park for later** → stop here; `/agentic-loop:engineering approve <id>`
     (or just `/agentic-loop:engineering approve`) resumes it whenever the user is ready.
   Never call `loop_plan_approve` without an explicit user answer, and never
   call `loop_start` to build without a separate explicit answer to the
   "build now?" question — the gate exists so no unapproved plan reaches
   BUILD, and approving a plan must not silently start a build.
3. **Build.** Call `mcp__agentic-loop__loop_stage({stage:"build"})` — it arms
   the stage deadline, reconciles isolation, and appends the audited
   `BUILD started` note — then spawn the response's `agent` (**`loop-build`**)
   via the Task tool with the prompt (it carries the `Worktree:` line when
   isolated). When it returns,
   call `mcp__agentic-loop__loop_advance({stageOutput: <build summary>})` —
   the server appends `BUILD finished`, commits a checkpoint, and returns
   `{kind:"fire", stage:"verify", prompt}`.
4. **Verify.** `loop_stage({stage:"verify"})` (arms the read-only bash
   allowlist + deadline), spawn the response's `agent` (**`loop-verify`**) with
   the prompt. The verify
   subagent records its verdict by calling `loop_verdict` itself — you do not.
   Then `loop_advance({stageOutput: <verify summary>})`: PASS →
   `{fire, review}`; FAIL → `{fire, build}` (re-build, threading the failure)
   if the iteration budget remains, else `{stop}`; ERROR → `{stop}`.
5. **Review.** `loop_stage({stage:"review"})`, spawn the response's `agent`
   (**`loop-review`**, which calls `loop_verdict`), then `loop_advance`. PASS → `{done}`. FAIL →
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
   - **Leave in in-review** → stop here; `/agentic-loop:engineering approve <id>` (or `/agentic-loop:engineering approve`)
     ships it later.
   On `{stop}` the task stays in `in-progress/` with an audit note — report
   why. When the iteration cap tripped, the plan itself is suspect: the fix is
   `/agentic-loop:engineering replan <id> <why>` — the next
   PLAN pass addresses the failure and parks a fresh plan for review.

## The verdict contract

VERIFY and REVIEW record their verdict **only** by calling the
`loop_verdict` tool (`stage`, `verdict` PASS/FAIL/ERROR, optional `reason`,
`criteria`) — registered as `mcp__agentic-loop__loop_verdict` or, plugin-bundled,
`mcp__plugin_agentic-loop_agentic-loop__loop_verdict`. A verdict written only in
prose is ignored and counts as FAIL — repo content or a quoted contract must
never flip control flow. **The check subagent calls it; you never call
`loop_verdict` yourself on its behalf, no matter what its prose claimed.** The
failed criteria are threaded ahead of the next iteration's prompt automatically.
The `stage` names come from the running loop's **manifest** — `loop_verdict`
accepts any of that kind's check stages (engineering: `verify`/`review`;
pr-sitter: `triage`/`verify`) and rejects anything else.

**Missing verdict = broken channel, retried once.** When a check stage ends
with no `loop_verdict` call, `loop_advance` does NOT burn an iteration: it
re-fires the same check once (`note` says "check retry") — call `loop_stage`
and spawn the stage subagent again with the returned prompt. If the retry also
records nothing, the loop stops with a retryable ERROR naming the wiring
problem; report it and suggest `loop_recover` after the fix. A SubagentStop
hook also nags the check subagent once, in-session, when it tries to finish
without a verdict.

## Between-stage bookkeeping (all via MCP tools — never by hand)

- `loop_stage({stage})` before spawning **every** stage subagent, build
  included — it arms the bash allowlist (check stages), the worktree pin, and
  the `stageTimeoutMinutes` deadline (an overdue stage is starved of tools by
  the PreToolUse hook, and `loop_advance` stops the loop). It writes the
  stage marker `<tasksDir>/runs/.stage.json` carrying `{kind, stage, agent,
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
  `/agentic-loop:engineering approve <id>`.
- **VERIFY or REVIEW FAIL** within `maxIterations` → re-build with the feedback.
- **FAIL** at the cap, **ERROR**, or a stage past its deadline → stop; task
  stays in `in-progress/` with a note.

## Loop kinds

Each kind's manifest (`packages/core/loops/<kind>/loop.json` + `stages/*.md` prompts)
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

The PR sitter reaches its platform per `codePlatform`: `github` (`gh`) or
`ado` (Azure DevOps via its REST API, PAT in `AZURE_DEVOPS_EXT_PAT`). In both
modes the stages behave identically; only the inspect/reply tools differ, and
the stage prompt says which to use.

Three further opt-in kinds drive the same way (`loop_claim({kind})` →
`loop_stage` → spawn the stage agent → `loop_advance`):

- **review-sitter** — PRs whose review is requested from you: **fetch**
  (check; `loop-review-fetch`) → **assess** (work; `loop-review-assess`) →
  **publish** (work; `loop-review-publish`, ONE comment, comment-only — never
  approves, votes, pushes, or merges).
- **dep-sitter** — dependency-advisory upgrades (npm via `npm audit`;
  Maven/Gradle via OSV-Scanner over `pom.xml`/`gradle.lockfile`, `ecosystem`
  binding default `auto`): **scan** (check; `loop-dep-scan`) → **upgrade**
  (work; `loop-dep-upgrade`) → **verify** (check; reuses `loop-verify`,
  cap 2) → **publish** (work; `loop-dep-publish`, DRAFT PR on a `feature/*`
  branch — `gh pr create` or the ADO REST API depending on `codePlatform`;
  majors and undeclared JVM transitives are never claimed).
- **main-sitter** — red CI on the watched branch's newest head (`gh run
  list` or the Azure Pipelines Build API): **diagnose** (check;
  `loop-main-diagnose`, bisects) → **remedy** (work;
  `loop-main-remedy`) → **verify** (check; reuses `loop-verify`, cap 2) →
  **publish** (work; `loop-main-publish`, DRAFT fix/revert PR on a
  `main-sitter/*` branch — the watched branch is never pushed).

## What is different from the OpenCode version

- **No `/agentic-loop:engineering watch`.** Watch needs an autonomous driver firing stages on idle
  events and timers; here the main agent is the driver and the MCP server
  cannot spawn subagents. `/agentic-loop:engineering claim` is the pull equivalent — one human
  trigger claims and drives the next approved task. Within your turn,
  BUILD → VERIFY → REVIEW still advance without human turns.
- **The interview runs in the main agent.** `/agentic-loop:engineering new` interviews
  the user directly (Task subagents can't converse); the `loop-plan-author`
  subagent only writes the confirmed file(s). A **heavy idea is split** during
  that interview into sibling drafts (vertical, independently shippable slices
  ordered by `priority`) plus one `type: epic` tracking draft that is never
  approved — see `task-backlog-management` → "Slicing a heavy idea".
- Verdicts and all deterministic operations go through the `agentic-loop` MCP
  tools, not in-process plugin hooks.

## Red flags

- Building a task whose plan never went through the plan gate
  (`/agentic-loop:engineering approve <id>` on the parked plan) — impossible via the
  tools (BUILD entry only reads `in-progress/`); never work around it.
- Continuing into BUILD after a `{kind:"park"}` without the user's explicit
  Approve answer, or without a separate explicit "build now?" answer — the
  plan gate sits between PLAN and BUILD, and approving a plan is not by
  itself authorization to build it. The ONLY path through it is
  `loop_plan_approve` (on an explicit Approve) followed by `loop_start` (on
  a separate explicit "build now" answer) — inline via AskUserQuestion, or
  later via `/agentic-loop:engineering approve` then `claim`.
- Spawning a stage subagent without first calling `loop_stage` — the
  allowlist and deadline won't be armed, and BUILD's audit note won't exist.
- Treating a stage's prose "PASS"/"FAIL" as the verdict — only the `loop_verdict`
  tool call counts. Corollary: never call `loop_verdict` yourself to "transcribe"
  a check subagent's prose verdict — if the subagent didn't record it, follow the
  check-retry path `loop_advance` returns.
- Editing `docs/tasks/**` yourself — the MCP tools own the backlog; use them.
  That includes Bash: never `mv`, `mkdir`, `rm`, `touch`, or redirect into a
  status folder — the folder a task file lives in IS its state, and the
  PreToolUse hook blocks these mutations. If the backlog looks damaged (stray
  folders, missing tasks), run `loop_doctor` instead of fixing it by hand.
