# OpenCode Setup

This repo works with OpenCode two ways: as a real **plugin** that drives an
automatic engineering loop, and — for anything the loop doesn't cover — via a
prompt-driven, skill-invocation mode that mirrors the Claude Code experience.

## Overview

OpenCode has a real plugin system (`@opencode-ai/plugin`: hooks like `event`,
`command.execute.before`, `tool.execute.before`; custom commands under
`.opencode/commands/*.md`; custom subagents under `.opencode/agents/*.md`).
This repo ships one: **`agentic-loop`** (`src/index.ts` → `src/loop/`), which
drives the full DEFINE→PLAN→BUILD→VERIFY→REVIEW→SHIP lifecycle as one pipeline
with two human gates, instead of six manual slash commands. See the
`loop-orchestration` skill for the pipeline, gates, and verdict contracts in
full.

Outside the loop — a one-off request that doesn't need the whole lifecycle —
OpenCode falls back to an **agent-driven workflow**: a strong system prompt
(`AGENTS.md`) plus the built-in `skill` tool and `skills/` directory, so skills
are still selected and executed automatically even without a dedicated
command.

---

## Installing the agentic-loop plugin

1. Clone the repository and install its dependencies (the plugin's own
   TypeScript, `zod`, and `yaml` — separate from anything your target project
   uses):

```bash
git clone https://github.com/addyosmani/agent-skills.git
cd agent-skills
npm install
```

2. Load the plugin. Local plugin files auto-load — no `opencode.json` entry
   needed — from `.opencode/plugin/*.ts` in either scope:
   - **Project-local:** `mkdir -p .opencode/plugin && cp src/index.ts .opencode/plugin/agentic-loop.ts` in the project you want the loop to run against.
   - **User-level (all projects):** copy the same file into `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugin/agentic-loop.ts`.

   To install it as a published package instead, add it to `opencode.json`:

   ```json
   { "plugin": ["agentic-loop"] }
   ```

3. Copy `.opencode/agents/` and `.opencode/commands/` (the loop's stage
   subagents and command wrappers) into your project's `.opencode/`, or work
   directly in this repo, where they're already present. `.opencode/skills`
   is a symlink to this repo's `skills/` catalog, so the stage subagents can
   invoke skills by name via the `skill` tool.

4. Optional: add `.agentic-loop.json` at your project root to override
   `maxIterations`, `gateBeforeBuild`, `gateBeforeShip`, or `tasksDir` — see
   `loop-orchestration` for the defaults.

---

## Commands

Native OpenCode slash commands this plugin provides (`.opencode/commands/`):

| Command | Stage | Writes code? |
|---------|-------|--------------|
| `/loop <goal>` \| `next` \| `task <id>` \| `go` \| `stop` \| `status` | drives all six stages | no (control only) |
| `/define <goal>` | DEFINE | no |
| `/plan <goal>` | PLAN | no |
| `/build <goal+plan>` | BUILD | **yes** |
| `/verify <goal+criteria>` | VERIFY | no |
| `/review <goal+diff>` | REVIEW | no |
| `/ship <goal+review>` | SHIP | no (drafts only) |
| `/explore [path]` | standalone repo-improvement scan, independent of the loop | no |
| `/task new <idea>` | standalone — author a backlog task, optionally linked to an Azure DevOps work item | no (writes a task file) |

Each stage command also works standalone, outside `/loop`. `/spec`, `/test`,
`/review` (the five-axis version), `/code-simplify`, and `/webperf` — this
repo's other slash commands, defined under `.claude/commands/` and mirrored
for Gemini CLI/Antigravity — are **not** OpenCode-native commands; reach them
via the ad-hoc skill-invocation mode below (or just ask in natural language,
since AGENTS.md maps intent to the same underlying skills).

---

## Ad-hoc requests (outside `/loop`)

For anything that doesn't warrant starting a loop:

### Skill Discovery

All skills live in:

```
skills/<skill-name>/SKILL.md
```

OpenCode agents are instructed (via `AGENTS.md`) to:

- Detect when a skill applies
- Invoke the `skill` tool
- Follow the skill exactly

### Automatic Skill Invocation

The agent evaluates every request and maps it to the appropriate skill.

Examples:

- "build a feature" → `incremental-implementation` + `test-driven-development`
- "design a system" → `spec-driven-development`
- "fix a bug" → `debugging-and-error-recovery`
- "review this code" → `code-review-and-quality`
- "run the whole lifecycle on this, mostly unattended" → `/loop <goal>` instead of chaining skills by hand

The user does **not** need to explicitly request skills.

### Lifecycle Mapping (Implicit, Outside the Loop)

The development lifecycle maps to skills the same way `/loop`'s stages do —
see `loop-orchestration` for the pipeline version:

- DEFINE → `spec-driven-development`
- PLAN → `planning-and-task-breakdown`
- BUILD → `incremental-implementation` + `test-driven-development`
- VERIFY → `debugging-and-error-recovery`
- REVIEW → `code-review-and-quality`
- SHIP → `shipping-and-launch`

---

## Usage Examples

### Example 1: Feature Development (ad-hoc)

User:
```
Add authentication to this app
```

Agent behavior:
- Detects feature work
- Invokes `spec-driven-development`
- Produces a spec before writing code
- Moves to planning and implementation skills

### Example 2: Bug Fix (ad-hoc)

User:
```
This endpoint is returning 500 errors
```

Agent behavior:
- Invokes `debugging-and-error-recovery`
- Reproduces → localizes → fixes → adds guards

### Example 3: Full lifecycle, unattended (the loop)

User:
```
/loop Add rate limiting to the public API
```

Agent behavior:
- Runs DEFINE → PLAN, then pauses for plan approval (`/loop go`)
- Runs BUILD → VERIFY → REVIEW, re-planning or re-building on a FAIL within
  the iteration cap
- Pauses again for ship approval (`/loop go`), then runs SHIP
- You review the PR draft and rollback plan, then push and open the PR yourself

---

## Agent Expectations (Critical)

For the ad-hoc mode to work correctly, the agent must follow these rules:

- Always check if a skill applies before acting
- If a skill applies, it MUST be used
- Never skip required workflows (spec, plan, test, etc.)
- Do not jump directly to implementation

These rules are enforced via `AGENTS.md`.

---

## Limitations

- Loop state is in-memory — it does not survive an OpenCode restart (the task
  files on disk under `docs/tasks/` are the durable record; see
  `task-backlog-management`).
- The loop never pushes, opens a PR, or deploys on its own — SHIP only drafts;
  a human executes those steps.
- Outside `/loop`, ad-hoc skill invocation still depends on model compliance
  with `AGENTS.md` — there's no hook enforcing it the way the loop's
  permission-gated subagents do.

---

## Recommended Workflow

For a full lifecycle run: `/loop <goal>`, approve at the two gates, then
review and push what SHIP prepared.

For anything smaller, natural language works:

- "Design a feature"
- "Plan this change"
- "Implement this"
- "Fix this bug"
- "Review this"

The agent will automatically select and execute the correct skills.
