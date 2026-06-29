# agentic-loop

Transforms an engineer's workflow into an agentic loop:

```
explore → plan → build → verify   (repeat)
```

It works in two tools:

- **[opencode](https://opencode.ai)** — a runtime plugin (`src/index.ts`) that hooks session
  lifecycle events so an idle session can be re-driven toward an open goal, plus the workflow
  stage artifacts under `.opencode/`.
- **[Claude Code](https://claude.com/claude-code)** — a marketplace + plugin shipping the same
  workflow stage artifacts (commands, agents, skills) as markdown.

## Workflow stages

Each stage ships a command, a subagent, and a skill.

| Stage | Command | What it does |
|-------|---------|--------------|
| **explore** | `/explore <target>` | Read-only: map relevant code, trace call paths, surface reusable patterns — understanding only, before planning or building. |

More stages (plan, build, verify) to follow.

## Install — opencode

Add the runtime plugin to your `opencode.json`:

```json
{
  "plugin": ["agentic-loop"]
}
```

The stage commands/agents/skills are loaded from `.opencode/` when the repo is checked out in
your project (or copy them into your own `.opencode/`).

## Install — Claude Code

```bash
claude plugin marketplace add <owner>/agentic-loop
claude plugin install agentic-loop@agentic-loop
```

Then `/explore <target>` is available.

## Develop

```bash
npm install        # install @opencode-ai/plugin types + typescript
npm run typecheck  # tsc --noEmit
```

The opencode runtime entry point is `src/index.ts`, exporting the `AgenticLoop` plugin; loop
policy lives in `shouldContinue`.

## License

[Apache-2.0](./LICENSE)
