# Orchestration Patterns

Reference catalog of agent orchestration patterns this repo endorses, plus anti-patterns to avoid. Read this before adding a new slash command that coordinates multiple personas, or before introducing a new persona that "wraps" existing ones.

The governing rule: **the user (or a slash command) is the orchestrator. Personas do not invoke other personas.** Skills are mandatory hops inside a persona's workflow.

---

## Endorsed patterns

### 1. Direct invocation (no orchestration)

Single persona, single perspective, single artifact. The default and the cheapest option.

```
user → <persona> → report → user
```

**Use when:** the work is one perspective on one artifact and you can describe it in one sentence.

**Examples in this repo:** none — every persona here (`workflow-plan`, `workflow-build`,
`workflow-verify`, `workflow-review`, and the per-sitter agents `workflow-pr-*`,
`workflow-review-*`, `workflow-dep-*`, `workflow-main-*`) is stage-bound and always
invoked through its slash command (Pattern 2 below), never called ad hoc by
name. For a genuine one-off, single-perspective task, reach for Claude Code's
built-ins instead — `Explore` for read-only lookups, `general-purpose` for
anything needing edits too.

**Cost:** one round trip. The baseline you should always compare orchestrated patterns against.

---

### 2. Single-persona slash command

A slash command that wraps one persona with the project's skills. Saves the user from re-explaining the workflow every time.

```
/review → workflow-review (five-axis code review, emits a verdict)
```

**Use when:** the same single-persona invocation happens repeatedly with the same setup.

**Examples in this repo:** `/build` → `workflow-build`, `/verify` → `workflow-verify`,
`/review` → `workflow-review` (each a stage of the agentic engineering loop,
`.opencode/commands/{build,verify,review}.md`).

**Cost:** same as direct invocation. The slash command is just a saved prompt.

**Anti-signal:** if the slash command's body is mostly "decide which persona to call," delete it and let the user call the persona directly.

---

### 3. Parallel fan-out with merge

Multiple personas operate on the same input concurrently, each producing an independent report. A merge step (in the main agent's context) synthesizes them into a single decision.

```
                          ┌─→ workflow-review (lens: correctness) ─┐
REVIEW stage → fan out ───┼─→ workflow-review (lens: security)    ─┤→ worstOf → one verdict
                          └─→ workflow-review (lens: performance)  ─┘
```

**Use when:**
- The sub-tasks are genuinely independent (no shared mutable state, no ordering dependency)
- Each sub-agent benefits from its own context window
- The merge step is small enough to stay in the main context
- Wall-clock latency matters

**Examples in this repo:** the `reviewLenses` config (up to 5 lenses) runs one
`workflow-review` pass per lens, then combines them with `worstOf` into a single
machine-readable verdict (`packages/core/src/workflow/verdict.ts`; see
`docs/design/improvements/04-verdict-quality.md`).
On the OpenCode plugin a **per-axis fan-out runs its passes in parallel** (each
pass gets its own session, which is what separates the per-pass verdict, axis
requirement and evidence ledger), and `workflows.<kind>.stageConcurrency` clamps
it. Free-text `reviewLenses` passes still run **sequentially** unless that knob
opts them in — this page claimed parallel for a long time while both hosts
serialized everything, which is the kind of drift worth naming. The Claude Code
and Qwen Code hosts serialize every pass and warn if the knob is set.

**Cost:** N parallel sub-agent contexts + one merge turn. Higher than direct invocation, but faster wall-clock and produces better reports because each sub-agent stays focused on its single perspective.

**Validation checklist before adopting this pattern:**
- [ ] Can I run all sub-agents at the same time without ordering issues?
- [ ] Does each persona produce a different *kind* of finding, not just the same finding from a different angle?
- [ ] Will the merge step fit in the main agent's remaining context?
- [ ] Is the user's wait time long enough that parallelism is actually noticeable?

If any answer is "no," fall back to direct invocation or a single-persona command.

---

### 4. Sequential pipeline as user-driven slash commands

The user runs slash commands in a defined order, carrying context (or commit history) between them. There is no orchestrator agent — the user IS the orchestrator.

```
user runs:  /agentic-workflow:engineering new  →  /agentic-workflow:engineering approve  →
            /plan-task  →  /agentic-workflow:engineering approve  →
            /build  →  /verify  →  /review  →  /agentic-workflow:engineering approve
```

**Use when:** the workflow has dependencies (each step needs the previous step's output) and human judgment between steps adds value.

**Examples in this repo:** the entire PLAN → BUILD → VERIFY → REVIEW lifecycle.

**Cost:** one sub-agent context per step. Free for the orchestration layer because there is no orchestrator agent.

**Why not automate it:** an LLM "lifecycle orchestrator" would (a) lose nuance between steps because it has to summarize for hand-off, (b) skip the human checkpoints that catch wrong-direction work early, and (c) double the token cost via paraphrasing turns.

---

### 5. Research isolation (context preservation)

When a task requires reading large amounts of material that shouldn't pollute the main context, spawn a research sub-agent that returns only a digest.

```
main agent → research sub-agent (reads 50 files) → digest → main agent continues
```

**Use when:**
- The main session needs to stay focused on a downstream task
- The investigation result is much smaller than the input it consumes
- The decision quality benefits from the main agent having room to think after

**Examples:** "Find every call site of this deprecated API across the monorepo," "Summarize what these 30 ADRs say about caching."

**Cost:** one isolated sub-agent context. Worth it any time the alternative is loading hundreds of files into the main context.

**On Claude Code, use the built-in `Explore` subagent** rather than defining a custom research persona. `Explore` runs on Haiku, is denied write/edit tools, and is purpose-built for this pattern. Define a custom research subagent only when `Explore` doesn't fit (e.g. you need a domain-specific system prompt the model wouldn't infer).

---

## Claude Code compatibility

This catalog is harness-agnostic, but most readers will run it on Claude Code. Here's how each pattern maps onto Claude Code's primitives — and where the platform enforces our rules for us.

### Where personas live

Plugin subagents go in `agents/` at the plugin root. The Claude Code plugin here lives in `plugins/claude/` (manifest at `plugins/claude/.claude-plugin/plugin.json`), so `plugins/claude/agents/workflow-build.md`, `plugins/claude/agents/workflow-review.md`, etc. are auto-discovered when the plugin is enabled. No path configuration needed. (Those agent files are generated from `prompts/agents/` via `npm run gen:prompts` — edit the sources, not the outputs.)

### Subagents vs. Agent Teams

Claude Code has two parallelism primitives. Pattern 3 (parallel fan-out with merge) maps to **subagents**. If you need teammates that talk to each other, use **Agent Teams** instead.

| | Subagents | Agent Teams |
|--|-----------|-------------|
| Coordination | Main agent fans out, sub-agents only report back | Teammates message each other, share a task list |
| Context | Own context window per subagent | Own context window per teammate |
| When to use | Independent tasks producing reports | Collaborative work needing discussion |
| Status | Stable | Experimental — requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` |
| Cost | Lower | Higher — each teammate is a separate Claude instance |

**The personas in this repo work in both modes.** When spawned as subagents (e.g. the `reviewLenses` fan-out in Pattern 3), they report findings to the main session. When spawned as teammates (`Spawn a teammate using the workflow-review agent type…`), they can challenge each other's findings directly. The persona definition is the same; only the spawning context changes.

One subtlety: the `skills` and `mcpServers` frontmatter fields in a persona are honored when it runs as a subagent but **ignored when it runs as a teammate** — teammates load skills and MCP servers from your project and user settings, the same as a regular session. If a persona depends on a specific skill or MCP server being loaded, configure it at the session level so it's available in both modes.

### Platform-enforced rules

Two rules in this catalog aren't just convention — Claude Code enforces them:

- **"Subagents cannot spawn other subagents"** (verbatim from the docs). Anti-pattern B (persona-calls-persona) and Anti-pattern D (deep persona trees) cannot exist on Claude Code by construction.
- **"No nested teams"** — teammates cannot spawn their own teams. Same anti-patterns blocked at the team level.

This means you can adopt the patterns in this catalog without worrying about contributors accidentally building the anti-patterns. They'll just fail to load.

### Built-in subagents to know about

Before defining a custom subagent, check whether one of these covers the role:

| Built-in | Purpose |
|----------|---------|
| `Explore` | Read-only codebase search and analysis. Use this for Pattern 5 (research isolation). |
| `Plan` | Read-only research during plan mode. |
| `general-purpose` | Multi-step tasks needing both exploration and modification. |

Don't redefine these. Layer your specialist personas (`workflow-plan`, `workflow-build`, `workflow-verify`, `workflow-review`, and the per-sitter agents `workflow-pr-*`, `workflow-review-*`, `workflow-dep-*`, `workflow-main-*`) on top of them.

### Frontmatter restrictions for plugin agents

Plugin subagents do **not** support the `hooks`, `mcpServers`, or `permissionMode` frontmatter fields — these are silently ignored. If a future persona needs any of those, the user must copy the file into `.claude/agents/` or `~/.claude/agents/` instead.

The fields that DO work in plugin agents are: `name`, `description`, `tools`, `disallowedTools`, `model`, `maxTurns`, `skills`, `memory`, `background`, `effort`, `isolation`, `color`, `initialPrompt`. Use `model` per-persona if you want to optimize cost (e.g. a lighter model for `workflow-pr-triage`'s classification pass, a heavier one for `workflow-review`'s five-axis analysis).

### Spawning multiple subagents in parallel

In Claude Code, parallel fan-out (Pattern 3) requires issuing **multiple Agent tool calls in a single assistant turn**. Sequential turns serialize execution. Any new orchestrator command should do the same.

Note the `reviewLenses` / `stageFanout` passes are the exception, and not because of the agent runtime: the MCP server arms **one pass at a time** (one `armedPass`, one stage marker, one evidence ledger, all read by the guard hooks), so a second spawn in the same turn would have no identity to attribute its verdict to. Spawn those one per turn, in order, as the orchestration skill says.

---

## Worked example: Agent Teams for competing-hypothesis debugging

Moved to `references/agent-teams-example.md` — reach for it when you are choosing
between a subagent fan-out (Pattern 3) and Agent Teams for an investigation whose
hypotheses have to argue with each other.

---

## Anti-patterns

### A. Router persona ("meta-orchestrator")

A persona whose job is to decide which other persona to call.

```
/work → router-persona → "this needs a review" → code-reviewer → router (paraphrases) → user
```

**Why it fails:**
- Pure routing layer with no domain value
- Adds two paraphrasing hops → information loss + roughly 2× token cost
- The user already knew they wanted a review; they could have called `/review` directly
- Replicates the work that slash commands and intent mapping in `AGENTS.md` already do

**What to do instead:** add or refine slash commands. Document intent → command mapping in `AGENTS.md`.

---

### B. Persona that calls another persona

A `code-reviewer` that internally invokes `security-auditor` when it sees auth code.

**Why it fails:**
- Personas were designed to produce a single perspective; chaining them defeats that
- The summary the calling persona passes loses context the called persona needs
- Failure modes multiply (which persona's output format wins? whose rules apply?)
- Hides cost from the user

**What to do instead:** have the calling persona *recommend* a follow-up audit in its report. The user or a slash command runs the second pass.

---

### C. Sequential orchestrator that paraphrases

An agent that calls `/spec`, then `/plan`, then `/build`, etc. on the user's behalf.

**Why it fails:**
- Loses the human checkpoints that catch wrong-direction work
- Each hand-off summarizes context — accumulated drift over a long pipeline
- Doubles token cost: orchestrator turn + sub-agent turn for every step
- Removes user agency at exactly the points where judgment matters most

**What to do instead:** keep the user as the orchestrator. Document the recommended sequence in `README.md` and let users invoke it.

---

### D. Deep persona trees

`/ship` calls a `pre-ship-coordinator` that calls a `quality-coordinator` that calls `code-reviewer`.

**Why it fails:**
- Each layer adds latency and tokens with no decision value
- Debugging becomes a multi-level investigation
- The leaf personas lose context to multiple summarization steps

**What to do instead:** keep the orchestration depth at most 1 (slash command → personas). The merge happens in the main agent.

---

## Decision flow

When considering a new orchestrated workflow, walk this flow:

```
Is the work one perspective on one artifact?
├── Yes → Direct invocation. Stop.
└── No  → Will the same composition repeat?
         ├── No  → Direct invocation, ad hoc. Stop.
         └── Yes → Are sub-tasks independent?
                  ├── No  → Sequential slash commands run by user (Pattern 4).
                  └── Yes → Parallel fan-out with merge (Pattern 3).
                           Validate against the checklist above.
                           If any check fails → fall back to single-persona command (Pattern 2).
```

---

## When to add a new pattern to this catalog

Add a new entry only after:

1. You've used the pattern at least twice in real work
2. You can name a concrete artifact in this repo that demonstrates it
3. You can explain why an existing pattern wouldn't have worked
4. You can describe its anti-pattern shadow (what people will mistakenly build instead)

Premature catalog entries become aspirational documentation that no one follows.
