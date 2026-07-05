# Architecture

The full picture: three human gates thread an unattended PLAN / BUILD →
VERIFY → REVIEW loop, and the `docs/tasks/` backlog folders *are* the state —
a task's folder is its status. The loop plans a task right before execution
(so plans don't rot while tasks sit parked) and **parks** the plan for human
review instead of blocking on it.

```mermaid
flowchart TB
    You([You])

    subgraph authoring["AUTHORING + GATES — /agent-loop-task · interactive, human in the loop"]
        direction TB
        new["<b>/agent-loop-task new &lt;idea&gt;</b><br/>agent: loop-plan-author<br/>skills: interview-me,<br/>task-backlog-management<br/><i>interviews you into a planless draft</i>"]
        explore["<b>/explore</b><br/>agent: loop-explore<br/>skill: task-backlog-management<br/><i>scans repo, drafts ≤5 tasks</i>"]
        approve{{"<b>/agent-loop-task approve &lt;id&gt;</b><br/>plugin queues the reviewed draft<br/>★ HUMAN GATE 1 — the task"}}
        approveplan{{"<b>/agent-loop-task approve-plan &lt;id&gt;</b><br/>plugin validates the parked plan<br/>★ HUMAN GATE 2 — the plan<br/>(reject: replan &lt;id&gt; &lt;why&gt; → back to queued/)"}}
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

    subgraph execution["THE LOOP — /agent-loop · unattended, driven on session.idle"]
        direction TB
        claim["<b>/agent-loop task &lt;id&gt;</b> — run one now<br/><b>/agent-loop watch [interval]</b> — worker session,<br/>claims via atomic mkdir lock<br/>(build work beats plan work)"]
        planstage["<b>PLAN</b><br/>agent: loop-plan-author · task file only, main tree<br/>skill: planning-and-task-breakdown<br/><i>writes ## Implementation Plan in place,<br/>then parks — the loop exits</i>"]
        build["<b>BUILD</b><br/>agent: loop-build · edit ✅ bash ✅<br/>skills: incremental-implementation,<br/>test-driven-development<br/><i>TDD on loop/&lt;id&gt; branch or worktree,<br/>commit checkpoint per iteration</i>"]
        verify["<b>VERIFY</b><br/>agent: loop-verify · edit ❌ bash: test allowlist<br/>skill on FAIL: debugging-and-error-recovery<br/><i>runs tests + acceptance criteria,<br/>verdict via loop_verdict tool only</i>"]
        review["<b>REVIEW</b><br/>agent: loop-review · edit ❌ bash: read-only<br/>skills: code-review-and-quality<br/>(+ security-and-hardening, performance-optimization)<br/><i>5-axis diff review, once per reviewLens,<br/>worst verdict wins</i>"]
    end

    ship{{"<b>/agent-loop ship &lt;id&gt;</b><br/>you review the branch diff<br/>★ HUMAN GATE 2"}}

    You -->|"idea"| new
    new -->|"writes draft"| draft
    explore -->|"writes drafts"| draft
    draft -->|"you review the draft"| approve
    approve -->|"queues (audited, committed)"| queued
    queued -->|"claimed"| claim
    claim --> planstage
    planstage -->|"parks (audited, committed)"| planreview
    planreview --> approveplan
    approveplan -->|"parks (audited, committed)"| inprogress
    approveplan -.->|"replan &lt;id&gt; → re-queued<br/>(audited rejection)"| queued
    inprogress --> claim
    claim --> build
    build --> verify
    verify -->|"PASS"| review
    verify -.->|"FAIL → re-build<br/>with failure output"| build
    review -.->|"FAIL → re-build<br/>with feedback"| build
    review -->|"PASS"| inreview
    inreview --> ship
    ship --> completed
    build -.->|"iteration cap (maxIterations) trips:<br/>plan is suspect → human sends it back<br/>via /agent-loop-task replan &lt;id&gt;"| queued
    verify -.->|"ERROR → stop for human"| You
```

Dotted edges are failure paths. VERIFY/REVIEW FAIL both re-enter BUILD and
share one iteration budget (`maxIterations`, default 3); an ERROR verdict
stops the loop for a human without burning an iteration. PLAN never blocks:
its only exit is the park into `plan-review/` — a watcher can plan a whole
queue overnight and you batch-review the plans. The loop never pushes or
opens a PR — REVIEW PASS parks the task in `in-review/` for you.

## Who does what

| Command | Handled by | Subagent | Write access | Skills loaded | Produces |
|---------|-----------|----------|--------------|---------------|----------|
| `/agent-loop-task new <idea>` | plugin → agent | `loop-plan-author` | task files only (bash ❌) | `interview-me`, `task-backlog-management` | planless draft in `draft/` |
| `/agent-loop-task approve <id>` | plugin only (agent writes nothing) | — | — | — | task queued in `queued/` |
| `/agent-loop-task approve-plan <id>` | plugin only (agent writes nothing) | — | — | — | task parked in `in-progress/` |
| `/agent-loop-task replan <id> [why]` | plugin only (agent writes nothing) | — | — | — | task re-queued in `queued/`, rejection audited |
| PLAN (in the loop, on a `queued/` task) | driver → agent | `loop-plan-author` (task mode) | task files only | `planning-and-task-breakdown` | `## Implementation Plan` in place → task parked in `plan-review/` |
| `/agent-loop task\|watch\|ship\|recover\|stop\|status` | plugin driver (`src/loop/driver.ts`) | spawns the three stage agents below | — | `loop-orchestration` protocol | stage sequencing, claims, snapshots, run log |
| BUILD (also `/build`) | driver → agent | `loop-build` | edit ✅ bash ✅ | `incremental-implementation`, `test-driven-development` | code + one commit checkpoint per iteration |
| VERIFY (also `/verify`) | driver → agent | `loop-verify` | edit ❌ bash: test-runner allowlist | `debugging-and-error-recovery` (on FAIL) | trusted `loop_verdict` PASS/FAIL/ERROR |
| REVIEW (also `/review`) | driver → agent | `loop-review` | edit ❌ bash: read-only git/fs | `code-review-and-quality` (+ `security-and-hardening`, `performance-optimization`) | trusted `loop_verdict` per lens, worst wins |
| `/plan` (ad hoc) | agent | `loop-plan` | none (read-only) | `spec-driven-development`, `planning-and-task-breakdown` | a plan in chat — writes no file |
| `/explore` | agent | `loop-explore` | task files only | `task-backlog-management` | ≤5 schema-valid drafts in `draft/` |

Verdicts are only trusted through the `loop_verdict` plugin tool — a stage
agent claiming "PASS" in prose is ignored. Stage agents can't approve tasks,
move backlog folders, or ship; the plugin and the human own every transition
between folders.

## Claude Code variant (`claude-plugin/`)

Same pipeline and the same backlog lifecycle, different driver: Claude Code
has no background `session.idle` driver, so the main agent drives the loop
through a bundled MCP server (`mcp__agentic-loop__loop_*` tools):

```mermaid
flowchart LR
    startq["loop_start / loop_claim<br/>(queued task)"] --> plan["spawn <b>loop-plan-author</b><br/>task mode"]
    plan --> park[("plan-review/<br/>park — loop over")]
    park -.->|"human: approve-plan"| startb
    startb["loop_start / loop_claim<br/>(in-progress task)"] --> build["spawn <b>loop-build</b>"]
    build --> verify["spawn <b>loop-verify</b>"]
    verify -->|"PASS"| review["spawn <b>loop-review</b>"]
    verify -.->|"FAIL → re-build"| build
    review -.->|"FAIL → re-build"| build
    review -->|"PASS"| done[("in-review/")]
```

Differences worth knowing in a demo: there is no standing `/agent-loop watch`
— `/agent-loop claim` is the one-shot pull equivalent (build-ready tasks beat
queued ones); and stage guardrails (verify/review bash allowlists, worktree
pinning, stage deadlines) are enforced by a `PreToolUse` hook reading
`runs/.stage.json` rather than by agent permissions. Install and command
details live in [`claude-plugin/README.md`](../claude-plugin/README.md).
