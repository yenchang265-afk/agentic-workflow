English | [繁體中文](engineering.zh-TW.md)

# engineering

The engineering workflow: PLAN (park at the human plan gate) then BUILD → VERIFY → REVIEW over the docs/tasks backlog.

## Enable

No configuration needed — the engineering loop runs by default. To disable it:

```jsonc
{
  "workflows": {
    "engineering": { "enabled": false }
  }
}
```

## Commands

**OpenCode**

```
/agentic-workflow:engineering new <idea> | retask <id> [note] | approve [id] | replan [id] [reason] | abandon <id> [reason] | remove <id> --force | plan <id> | claim | watch [poll [interval] | cron <schedule> | idle | <interval>] | unwatch | recover <id> | kinds | doctor [fix] | stop | status
```

**Claude Code (MCP)**

```
/agentic-workflow:engineering new <idea> | retask <id> [note] | approve [id] | replan [id] [reason] | abandon <id> [reason] | remove <id> --force | plan <id> | claim | recover <id> | kinds | doctor [fix] | stop | status
```

(Claude Code has no standing watcher; `claim` is the one-shot pull verb.)

## Architecture

The full picture: three human gates thread an unattended PLAN / BUILD →
VERIFY → REVIEW loop, and the `docs/tasks/` backlog folders *are* the state —
a task's folder is its status. The loop plans a task right before execution
(so plans don't rot while tasks sit parked) and **parks** the plan for human
review instead of blocking on it. The pipeline shape below — stage order,
retry budget, park/done statuses, stop messages — comes from
`packages/core/workflows/engineering/workflow.json`; the engine just interprets it.

### Pipeline

```mermaid
flowchart TB
    You([You])

    subgraph authoring["AUTHORING + GATES — /agentic-workflow:engineering new/retask/approve · interactive, human in the loop"]
        direction TB
        new["<b>/agentic-workflow:engineering new &lt;idea&gt;</b><br/>main agent interviews you (interview-me),<br/>then workflow-task-author writes it<br/>(task-backlog-management)<br/><i>planless draft in draft/</i>"]
        approve{{"<b>/agentic-workflow:engineering approve &lt;id&gt;</b><br/>plugin queues the reviewed draft<br/>★ HUMAN GATE 1 — the task"}}
        approveplan{{"<b>/agentic-workflow:engineering approve &lt;id&gt;</b><br/>plugin validates the parked plan<br/>★ HUMAN GATE 2 — the plan<br/>(replan &lt;id&gt; &lt;why&gt; → back to queued/)"}}
    end

    subgraph backlog["BACKLOG — docs/tasks/ · folder = status"]
        direction LR
        draft[("draft/")]
        queued[("queued/<br/>planless")]
        planreview[("plan-review/")]
        inprogress[("in-progress/<br/>build-ready queue")]
        inreview[("in-review/")]
        completed[("completed/")]
    end

    subgraph execution["THE LOOP — /agentic-workflow:engineering · unattended, driven on session.idle"]
        direction TB
        claim["<b>/agentic-workflow:engineering plan &lt;id&gt;</b> — plan one now, no tick needed<br/><b>/agentic-workflow:engineering claim</b> — one-shot pull<br/><b>/agentic-workflow:engineering watch [trigger]</b> — worker session,<br/>claims via atomic mkdir lock<br/>(build-ready in-progress/ first, then queued/ to plan)"]
        planstage["<b>PLAN</b><br/>agent: workflow-plan-author · task file only, main tree<br/>skill: planning-and-task-breakdown<br/>(+ api-and-interface-design, deprecation-and-migration,<br/>documentation-and-adrs when relevant)<br/><i>writes ## Implementation Plan in place,<br/>then parks — the loop exits</i>"]
        build["<b>BUILD</b><br/>agent: workflow-build · edit ✅ bash ✅<br/>skills: incremental-implementation,<br/>test-driven-development<br/>(+ frontend-ui-engineering, observability-and-instrumentation,<br/>code-simplification when relevant)<br/><i>TDD on feature/&lt;id&gt; branch or worktree,<br/>commit checkpoint per iteration</i>"]
        verify["<b>VERIFY</b><br/>agent: workflow-verify · edit ❌ bash: test allowlist<br/>skill on FAIL: debugging-and-error-recovery<br/><i>loop runs the plan's agentic-checks first (exit codes bind),<br/>then acceptance criteria — verdict via workflow_verdict only</i>"]
        review["<b>REVIEW</b><br/>agent: workflow-review · edit ❌ bash: read-only<br/>skills: code-review-and-quality<br/>(+ security-and-hardening, performance-optimization)<br/><i>5-axis diff review; optionally once per axis<br/>(stageFanout) or per reviewLens — worst verdict wins</i>"]
    end

    ship{{"<b>/agentic-workflow:engineering approve &lt;id&gt;</b><br/>you review the branch diff<br/>★ HUMAN GATE 3"}}

    You -->|"idea"| new
    new -->|"writes draft"| draft
    draft -->|"you review the draft"| approve
    approve -->|"queues (audited, committed)"| queued
    queued -->|"claimed"| claim
    claim --> planstage
    planstage -->|"parks (audited, committed)"| planreview
    planreview --> approveplan
    approveplan -->|"parks (audited, committed)"| inprogress
    approveplan -.->|"replan &lt;id&gt; → re-queued plan-next<br/>(audited rejection, re-plan chained)"| queued
    inprogress --> claim
    claim --> build
    build --> verify
    verify -->|"PASS"| review
    verify -.->|"FAIL → re-build<br/>with failure output"| build
    review -.->|"FAIL → re-build<br/>with feedback"| build
    review -->|"PASS"| inreview
    inreview --> ship
    ship --> completed
    build -.->|"iteration cap (maxIterations) trips:<br/>plan is suspect → human sends it back<br/>via /agentic-workflow:engineering replan &lt;id&gt;"| queued
    verify -.->|"ERROR → stop for human"| You
```

Dotted edges are failure paths. VERIFY/REVIEW FAIL both re-enter BUILD and
share one iteration budget (`maxIterations`, default 3); an ERROR verdict
stops the loop for a human without burning an iteration.

A re-build always receives the **structured** failure first — the verdict
reason, the failed acceptance criteria, and the blocking axis findings with
`file:line` — followed by the failing stage's prose. Under a configured
`stageContext` budget (see [configuration.md](../configuration.md)) the prose
may arrive as a bounded excerpt with the elided middle marked, but the
structured block is never trimmed and the run log always keeps the full text.
Every stage's **goal is deduplicated at render**: the task body's
`## Implementation Plan` section reaches the prompt only once (as the plan
artifact) and the audit-note tail is stripped — the task file on disk keeps
both, and a `stageContext` `goal` key can additionally cap what remains.
Each counted iteration also appends one line to a bounded **attempts ledger**
(stage, verdict, one-line reason) that the next BUILD prompt carries, so a
re-build can see what the previous attempts already tried instead of
rediscovering — and a capped run says what those iterations did, not just that
there were three of them. That context reaches the sibling stages too: VERIFY
carries the same ledger, so a failure that recurs across attempts is named as
recurrence rather than reported fresh; a re-fired BUILD is pointed at the
cumulative diff of its prior iterations' commits; REVIEW is shown what VERIFY
established — the recorded verdict, never the transcript — and shares the
final-iteration warning; and each inlined feedback section carries a
data-not-instructions fence. PLAN runs right before execution — `claim`/`watch`
fall back to an approved `queued/` task once no build-ready work is left, and
`plan <id>` plans one without waiting for a tick — and never blocks: its only
exit is the park into `plan-review/` for your gate. A PLAN run that crashes
leaves a stale claim marker in `queued/.claims/`; the next claim walk releases
it once it reads stale, and `doctor fix` releases it on demand.

With `workflows.engineering.planVisualization: true`, PLAN's prompt also
carries an opt-in **visualization block**: when the change's shape is what the
plan gate has to judge — state/lifecycle transitions, flow across two or more
packages, concurrency or locking, data-shape changes — the plan should include
```mermaid`` diagram(s) inside `## Implementation Plan`. It is agent-judged,
never enforced (small or mechanical plans are told to skip it, and the park
gate does not check for a diagram); the hub's plan-review view renders the
fence as an actual diagram in a sandboxed iframe, still commentable like any
other block. See `docs/configuration.md`.

Which queued task gets planned first is normally its priority number, but a
**plan request** overrides that for one task: the admin hub's Plan button writes
a marker in `queued/.requests/<id>` meaning "plan this one next". It is an
ordering hint and nothing more — it moves no file, writes no commit, starts
nothing, and never preempts build-ready `in-progress/` work, since the pools are
still walked in manifest priority order. The claim that honours it spends it; a
request whose task has since left `queued/` is dropped by the next claim walk or
by `doctor fix`. `plan <id>` consumes one too, so asking from the hub and then
planning by hand leaves nothing behind. The engineering loop never
pushes or opens a PR on its own — REVIEW PASS just parks the task in
`in-review/` for you. Ship (`in-review/` → `completed/`) is still a
human-invoked gate, but it now publishes per `shipPublish` (default `"pr"`:
pushes the task's `feature/<id>` branch and opens or reuses a **draft** PR —
GitHub or Azure DevOps per `codePlatform`; `"push"` pushes with no PR;
`"local"` ships nothing off your machine — overridable per call with
`--pr`/`--push`/`--local`). The PR targets the branch the run was cut from,
which the done note records on the task; `prBase` and a per-ship
`--base=<branch>` override it — so the merge decision stays yours while the "now
go push and open a PR" step doesn't.

### Who does what

| Command | Handled by | Subagent | Write access | Skills loaded | Produces |
|---------|-----------|----------|--------------|---------------|----------|
| `/agentic-workflow:engineering new <idea>` | plugin → agent | `workflow-task-author` | task files only (bash ❌) | `interview-me`, `task-backlog-management` | planless draft in `draft/` |
| `/agentic-workflow:engineering retask <id> [note]` | plugin (places the task) → agent (reshapes) | `workflow-task-author` (retask mode) | task files only (bash ❌) | `interview-me`, `task-backlog-management` | rewritten **in place** in `draft/` (same id); a `queued/` task is moved back to `draft/` first, withdrawing its approval and dropping any superseded plan an earlier `replan` left on it; refused from `plan-review/` on (use `replan`) |
| `/agentic-workflow:engineering approve [id]` | plugin only (agent writes nothing) | — | — | — | the folder-driven gate: draft → `queued/`, plan-review → `in-progress/`, in-review → `completed/` (ship — publishes per `shipPublish`, overridable per call with `--pr`/`--push`/`--local`; the PR targets the recorded run base, or `prBase`, or `--base=<branch>`) |
| `/agentic-workflow:engineering replan [id] [why]` | plugin (rejects, then chains the re-plan) | `workflow-plan-author` (the chained PLAN pass) | — | — | task re-queued marked plan-next, rejection audited, and a PLAN pass fires immediately (a busy session or claim race leaves it plan-next for the next `claim`/`watch`); the reason is threaded into that pass's prompt as a structured section and the revised plan re-parks in `plan-review/` |
| PLAN (in the loop, on a `queued/` task) | driver → agent | `workflow-plan-author` | task files only | `planning-and-task-breakdown` (+ `api-and-interface-design`, `deprecation-and-migration`, `documentation-and-adrs` when relevant) | `## Implementation Plan` in place → task parked in `plan-review/` |
| `/agentic-workflow:engineering plan\|claim\|watch\|recover\|stop\|status` | plugin driver (`plugins/opencode/src/workflow/driver.ts`) | spawns the three stage agents below | — | `workflow-orchestration` protocol | stage sequencing, claims, snapshots, run log |
| BUILD (also `/build`) | driver → agent | `workflow-build` | edit ✅ bash ✅ | `incremental-implementation`, `test-driven-development` (+ `frontend-ui-engineering`, `observability-and-instrumentation`, `code-simplification` when relevant) | code + one commit checkpoint per iteration |
| VERIFY (also `/verify`) | driver → agent | `workflow-verify` | edit ❌ bash: test-runner allowlist | `debugging-and-error-recovery` (on FAIL) | trusted `workflow_verdict` PASS/FAIL/ERROR |
| REVIEW (also `/review`) | driver → agent | `workflow-review` | edit ❌ bash: read-only git/fs | `code-review-and-quality` (+ `security-and-hardening`, `performance-optimization`) | trusted `workflow_verdict` per pass (single, per axis, or per lens), worst wins |
| `/plan` (ad hoc) | agent | `workflow-plan` | none (read-only) | `spec-driven-development`, `planning-and-task-breakdown` | a plan in chat — writes no file |

Verdicts are only trusted through the `workflow_verdict` plugin tool — a stage
agent claiming "PASS" in prose is ignored. Stage agents can't approve tasks,
move backlog folders, or ship; the plugin and the human own every transition
between statuses.

VERIFY additionally declares `discoverChecks`: before the stage fires, the loop
runs the commands the approved plan declared in its `### Verification`
`agentic-checks` block, in the work tree, and their exit codes bind the verdict
(0 adds nothing, 124/126/127 ⇒ ERROR, anything else ⇒ FAIL). The agent is told
they are established fact and must cite rather than re-run them.

Two properties matter more than the convenience. The commands are **frozen at
plan time** — the block is text in the task file, re-read on every iteration —
so BUILD→VERIFY→BUILD checks the same way each time; a stage that picked its own
commands per run would move the verdict without the code moving. And what may
run is capped by **VERIFY's own bash allowlist**: a discovered command is
admitted only if the agent could have run it unprompted. That allowlist is the
boundary rather than your approval of the plan, because task files live under
`tasksDir` — repo content a clone can ship. Every failure mode degrades to fewer
checks plus a warning: no block, malformed JSON, a refused command, or a binary
that is not installed all leave the loop checking exactly as it did before.
Pin your own commands with `workflows.engineering.stageChecks` (a present-but-
empty list disables both), or turn the channel off with `"discoverChecks": false`.

VERIFY and REVIEW additionally declare `requireEvidence`, so a **PASS** from
either must cite the commands it ran and the files it read (`evidence:
[{ kind, ref, result }]`). Those citations are cross-checked against a ledger the
host's tool guard writes independently of the agent — so a PASS from a pass that
ran nothing, or one whose every citation matches nothing observed, is rejected
rather than recorded. FAIL and ERROR are never gated: a check that could not run
is an ERROR naming what is missing. See `packages/core/workflows/README.md` for
the rule's limits — it makes an unearned PASS falsifiable, not impossible.

### Backlog integrity rails

Three layers keep a confused agent from corrupting the folder-is-status
backlog (threat model T3/T3b):

- **Backlog-mutation guard** (`task/guard.ts`, always on): agent tool calls
  that would mutate `<tasksDir>/` are default-denied on both substrates —
  Claude Code via the PreToolUse hook (inline copy, kept in sync), OpenCode
  via `tool.execute.before`. Read-only commands pass; direct writes are
  limited to authoring `draft/*.md` and the live PLAN stage's own `queued/`
  task (the stage marker's `taskId` / the driving loop's state names it). The
  deterministic movers stay authoritative: `moveTask` + `canTransition`
  enforce one-stage-at-a-time, and `statusOf` rejects unknown folders.
- **Reconciliation sweep** (`task/audit.ts`): detects stray folders (a
  `run/` an agent invented), task files outside every status folder, and one
  id duplicated across status folders. Surfaced at session start (both
  substrates), in `workflow_status`, and as warnings on claims.
- **Doctor** (`workflow_doctor` / `/agentic-workflow:engineering doctor [fix]`): reports the sweep's
  findings plus held claim markers and stray plan-request markers (a request
  whose task has left `queued/`); with `fix` it applies only the
  unambiguous repairs — rescue strays back to `draft/` (audited + committed),
  remove emptied stray folders, release stale orphaned claim markers, drop
  stray plan requests. Duplicates are always a human call.

The watch lease (one watch-mode process per clone, across every kind) is
documented once, framework-level, in
[`docs/architecture.md`](../architecture.md#watch-lease).

## Example: Draft, approve, plan, and execute

This walkthrough shows the full happy path from interview through delivery.

1. **Author a task**
   ```
   /agentic-workflow:engineering new Implement dark mode toggle
   ```
   The command interviews you: what's the goal, acceptance criteria, any open questions? It creates a planless draft in `docs/tasks/draft/` with an auto-generated id (e.g., `my-dashboard-dark-mode`). The draft waits in draft/ for you to confirm it's ready to queue.

2. **Approve it into the backlog**
   ```
   /agentic-workflow:engineering approve my-dashboard-dark-mode
   ```
   Moves the task from `draft/` to `queued/` — now it's eligible for execution.

3. **Plan the first task**
   ```
   /agentic-workflow:engineering plan my-dashboard-dark-mode
   ```
   Enters the PLAN stage: the agent reads the task and writes a detailed implementation plan (## Implementation Plan heading in the task file). PLAN parks at a human gate (`plan-review/`) and exits — you review the plan, maybe reshape it, then approve it.

4. **Approve the plan**
   ```
   /agentic-workflow:engineering approve my-dashboard-dark-mode
   ```
   Moves the task from `plan-review/` to `in-progress` — ready for BUILD.

5. **Execute the loop**
   ```
   /agentic-workflow:engineering watch 30s
   ```
   Starts a standing watcher that polls every 30 seconds. When it finds a task in `in-progress`, it runs BUILD (code changes) → VERIFY (tests pass?) → REVIEW (code review) unattended. If all stages PASS, the task lands in `in-review/` (human review before merge). If any stage FAIL, it retries BUILD up to 3 times, then stops. `watch` turns *this* session into the worker — to run the next step, use a separate terminal/session, or press ESC (pauses, keeps the run recoverable) or `unwatch` (stops watching, lets any in-flight loop finish) first.

6. **Approve the finished work**
   ```
   /agentic-workflow:engineering approve my-dashboard-dark-mode
   ```
   BUILD/VERIFY/REVIEW never push or open a PR themselves — this is the step that ships it: it pushes the `feature/my-dashboard-dark-mode` branch and opens (or reuses) a draft PR, then moves the task from `in-review/` to `completed/`.

## Example: Recover a stalled task

If a build crashes or you interrupt it (ESC), the task stalls in `in-progress`. Recover it:

1. **Check status**
   ```
   /agentic-workflow:engineering status
   ```
   Shows the current loop + backlog summary. See which task is stalled.

2. **Recover and resume**
   ```
   /agentic-workflow:engineering recover my-dashboard-dark-mode
   ```
   Resumes immediately, this turn — re-claims the task and re-enters the exact stage its state snapshot stopped at (re-reading the task file first, in case you edited it while stalled), then continues BUILD → VERIFY → REVIEW.

## Learn more

- Framework internals (core package, scheduler, work sources) and the watch lease: [`docs/architecture.md`](../architecture.md)
- Sitters: [`docs/sitters.md`](../sitters.md)
- Command reference & troubleshooting: [`docs/opencode.md`](../opencode.md) (OpenCode-specific), [`plugins/claude/README.md`](../../plugins/claude/README.md) (Claude Code)
- Author a new workflow kind: [`packages/core/workflows/README.md`](../../packages/core/workflows/README.md)
