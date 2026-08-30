# Orchestration Patterns

The agent-orchestration patterns this repo endorses, and the shapes it refuses.
Read it before adding a slash command that coordinates several personas, or a
persona that wraps existing ones.

The governing rule: **the user, or a slash command, is the orchestrator.
Personas do not invoke other personas.** Skills are the mandatory hops inside a
persona's own workflow.

## The patterns

**1 — Direct invocation.** One persona, one perspective, one artifact. The
baseline every other pattern is measured against. No persona in this repo is
used this way: `workflow-plan`, `workflow-build`, `workflow-verify`,
`workflow-review` and the per-sitter agents (`workflow-pr-*`,
`workflow-review-*`, `workflow-dep-*`, `workflow-main-*`) are all stage-bound and
reached through their command. For a genuine one-off, use the host's built-ins —
`Explore` for read-only lookups, `general-purpose` when edits are needed.

**2 — Single-persona slash command.** The same invocation, saved with its setup,
which is all a command is: `/build`, `/verify`, `/review`. When a command's body
is mostly *deciding which persona to call*, delete it and let the user call the
persona.

**3 — Parallel fan-out with merge.** Several passes over the same input, each in
its own context, merged into one decision by `worstOf`
(`packages/core/src/workflow/verdict.ts`). A `stageFanout` lens list runs one
`workflow-review` pass per lens; on OpenCode a per-axis fan-out runs its passes
concurrently — each pass in **its own session**, which is what separates the
per-pass verdict, axis requirement, and evidence ledger — clamped by
`workflows.<kind>.stageConcurrency`. Claude Code and Qwen Code serialize every
pass and warn when the knob is set.

Adopt it only when all four hold: the passes have no ordering dependency, each
produces a different *kind* of finding rather than the same finding from a
different angle, the merge fits in the remaining main context, and the wait is
long enough for the parallelism to be noticed. Otherwise fall back to pattern 2.

**4 — Sequential pipeline, run by the user.** `new` → `approve` → `plan-task` →
`approve` → `/build` → `/verify` → `/review` → `approve`. The whole lifecycle is
this pattern, and the orchestration layer is free because there is no
orchestrator agent. Automating it with an LLM lifecycle orchestrator costs the
human checkpoints that catch wrong-direction work, and every hand-off summary
drops the nuance the next stage needed.

**5 — Research isolation.** A sub-agent reads far more than it returns, and the
main session keeps its room to think. Use the host's `Explore` (read-only, cheap,
purpose-built) rather than defining a research persona; define one only when a
domain-specific system prompt is genuinely needed.

An investigation whose hypotheses must argue with each other reaches past all of
these — `references/agent-teams-example.md`.

## The shapes to refuse

Each fails the same way: a layer that routes or paraphrases adds latency and
tokens, drops context at every hand-off, and hides cost from the user.

- **A router persona** that decides which persona to call — slash commands and
  the intent map in `AGENTS.md` already do this, without the paraphrase hops. Add
  or sharpen a command instead.
- **A persona that calls another persona** — the summary it passes on is exactly
  the context the second persona needed, and two output contracts collide. Have
  it *recommend* the follow-up in its report; the user or a command runs it.
- **A sequential orchestrator** that runs the lifecycle on the user's behalf —
  pattern 4 exists because those checkpoints are the value.
- **Deep persona trees** — keep orchestration depth at one hop (command →
  personas), with the merge in the main agent.

Claude Code enforces the middle two by construction: a subagent cannot spawn a
subagent, and teammates cannot spawn teams.

## Host mechanics (Claude Code)

- **Where personas live** — plugin subagents in `agents/` at the plugin root, so
  `plugins/claude/agents/*.md` are auto-discovered with the plugin enabled. They
  are **generated** from `prompts/agents/` by `pnpm gen:prompts`; edit the source.
- **Subagents vs teammates** — a subagent reports back to the main agent; a
  teammate messages other teammates and shares a task list, costs more, and is
  experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). The same persona works
  in both modes, but `skills` and `mcpServers` frontmatter is honoured only for a
  subagent — a teammate loads them from project and user settings, so anything a
  persona depends on must be configured at session level to work in both.
- **Plugin-agent frontmatter** — `hooks`, `mcpServers`, and `permissionMode` are
  silently ignored in a plugin agent; a persona needing them must be copied into
  `.claude/agents/`. What does work: `name`, `description`, `tools`,
  `disallowedTools`, `model`, `maxTurns`, `skills`, `memory`, `background`,
  `effort`, `isolation`, `color`, `initialPrompt`.
- **Parallel spawning takes one turn** — several Agent calls in a *single*
  assistant turn run concurrently; separate turns serialize. The `stageFanout`
  passes are the deliberate exception, and not for runtime reasons: the MCP
  server arms **one pass at a time** (one `armedPass`, one stage marker, one
  evidence ledger, all read by the guard hooks), so a second spawn in the same
  turn would have no identity to attribute its verdict to. Spawn those one per
  turn, in order.
- **Built-ins to check before defining a persona** — `Explore` (read-only
  search), `Plan` (read-only research in plan mode), `general-purpose`
  (exploration plus edits). Layer specialists on top of them rather than
  redefining them.

## Adding to this catalog

A new entry earns its place once you have used the pattern twice in real work,
can name the artifact in this repo that demonstrates it, can say why an existing
pattern would not have done, and can describe its anti-pattern shadow — what
people will build instead when they half-remember it. Entries added before that
become aspirational documentation nobody follows.
