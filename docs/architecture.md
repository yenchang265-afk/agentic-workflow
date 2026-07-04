# Architecture

The full picture: two human gates bracket an unattended BUILD → VERIFY →
REVIEW loop, and the `docs/tasks/` backlog folders *are* the state — a task's
folder is its status.

```mermaid
flowchart TB
    You([You])

    subgraph planning["PLANNING — /loop-plan · interactive, human in the loop"]
        direction TB
        new["<b>/loop-plan new &lt;idea&gt;</b><br/>agent: loop-plan-author<br/>skills: interview-me,<br/>task-backlog-management<br/><i>interviews you into a planless draft</i>"]
        explore["<b>/explore</b><br/>agent: loop-explore<br/>skill: task-backlog-management<br/><i>scans repo, drafts ≤5 tasks</i>"]
        plantask["<b>/loop-plan task &lt;id&gt;</b><br/>agent: loop-plan-author<br/>skill: planning-and-task-breakdown<br/><i>writes ## Implementation Plan</i>"]
        approve{{"<b>/loop-plan approve &lt;id&gt;</b><br/>plugin validates the plan<br/>★ HUMAN GATE 1"}}
    end

    subgraph backlog["BACKLOG — docs/tasks/ · folder = status"]
        direction LR
        draft[("draft/")]
        inplanning[("in-planning/")]
        inprogress[("in-progress/<br/>approved queue")]
        inreview[("in-review/")]
        completed[("completed/")]
    end

    subgraph execution["EXECUTION — /loop · unattended, driven on session.idle"]
        direction TB
        claim["<b>/loop task &lt;id&gt;</b> — run one now<br/><b>/loop watch [interval]</b> — worker session,<br/>claims approved tasks via atomic mkdir lock"]
        build["<b>BUILD</b><br/>agent: loop-build · edit ✅ bash ✅<br/>skills: incremental-implementation,<br/>test-driven-development<br/><i>TDD on loop/&lt;id&gt; branch or worktree,<br/>commit checkpoint per iteration</i>"]
        verify["<b>VERIFY</b><br/>agent: loop-verify · edit ❌ bash: test allowlist<br/>skill on FAIL: debugging-and-error-recovery<br/><i>runs tests + acceptance criteria,<br/>verdict via loop_verdict tool only</i>"]
        review["<b>REVIEW</b><br/>agent: loop-review · edit ❌ bash: read-only<br/>skills: code-review-and-quality<br/>(+ security-and-hardening, performance-optimization)<br/><i>5-axis diff review, once per reviewLens,<br/>worst verdict wins</i>"]
    end

    ship{{"<b>/loop ship &lt;id&gt;</b><br/>you review the branch diff<br/>★ HUMAN GATE 2"}}

    You -->|"idea"| new
    new -->|"writes draft"| draft
    explore -->|"writes drafts"| draft
    draft -->|"you review the draft"| plantask
    plantask -->|"moves + plans<br/>(audited, committed)"| inplanning
    inplanning --> approve
    approve -->|"parks (audited, committed)"| inprogress
    inprogress --> claim
    claim --> build
    build --> verify
    verify -->|"PASS"| review
    verify -.->|"FAIL → re-build<br/>with failure output"| build
    review -.->|"FAIL → re-build<br/>with feedback"| build
    review -->|"PASS"| inreview
    inreview --> ship
    ship --> completed
    build -.->|"iteration cap (maxIterations) trips:<br/>plan is suspect → human re-plans<br/>via /loop-plan task &lt;id&gt;"| plantask
    verify -.->|"ERROR → stop for human"| You
```

Dotted edges are failure paths. VERIFY/REVIEW FAIL both re-enter BUILD and
share one iteration budget (`maxIterations`, default 3); an ERROR verdict
stops the loop for a human without burning an iteration. The loop never
pushes or opens a PR — REVIEW PASS parks the task in `in-review/` for you.

## Who does what

| Command | Handled by | Subagent | Write access | Skills loaded | Produces |
|---------|-----------|----------|--------------|---------------|----------|
| `/loop-plan new <idea>` | plugin → agent | `loop-plan-author` | task files only (bash ❌) | `interview-me`, `task-backlog-management`, `planning-and-task-breakdown` | planless draft in `draft/` |
| `/loop-plan task <id>` | plugin (move) → agent | `loop-plan-author` | task files only | `planning-and-task-breakdown` | `## Implementation Plan` in `in-planning/` |
| `/loop-plan approve <id>` | plugin only (agent writes nothing) | — | — | — | task parked in `in-progress/` |
| `/loop task\|watch\|ship\|recover\|stop\|status` | plugin driver (`src/loop/driver.ts`) | spawns the three stage agents below | — | `loop-orchestration` protocol | stage sequencing, claims, snapshots, run log |
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

Same pipeline, different driver: Claude Code has no background `session.idle`
driver, so the main agent drives the loop through a bundled MCP server
(`mcp__agentic-loop__loop_*` tools), and PLAN runs *inside* the loop with a
conversational gate instead of the separate `/loop-plan` command:

```mermaid
flowchart LR
    start["/loop &lt;goal&gt;<br/>loop_start"] --> plan["spawn <b>loop-plan</b><br/>read-only"]
    plan --> gate{{"★ HUMAN GATE<br/>loop_approve"}}
    gate --> build["spawn <b>loop-build</b>"]
    build --> verify["spawn <b>loop-verify</b>"]
    verify -->|"PASS"| review["spawn <b>loop-review</b>"]
    verify -.->|"FAIL → re-plan"| plan
    review -.->|"FAIL → re-build"| build
    review -->|"PASS"| done[("in-review/")]
```

Two behavioral differences worth knowing in a demo: on VERIFY FAIL the Claude
Code loop goes back to **PLAN** (OpenCode re-builds), and stage guardrails
(verify/review bash allowlists, worktree pinning) are enforced by a
`PreToolUse` hook reading `runs/.stage.json` rather than by agent
permissions. One supervised loop per session — no `/loop watch`. Install and
command details live in [`claude-plugin/README.md`](../claude-plugin/README.md).
