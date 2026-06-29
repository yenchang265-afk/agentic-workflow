# agentic-loop

An [opencode](https://opencode.ai) plugin that transforms an engineer's workflow into an agentic loop:

```
explore → plan → build → verify   (repeat)
```

It also hooks session lifecycle events so an idle session can be re-driven toward an open goal
instead of stopping after a single turn.

## Workflow stages

Each stage ships a command, a subagent, and a skill (under `.opencode/`).

| Stage | Command | What it does |
|-------|---------|--------------|
| **explore** | `/explore <target>` | Read-only: map relevant code, trace call paths, surface reusable patterns — understanding only, before planning or building. |

More stages (plan, build, verify) to follow.

## Install

Add the runtime plugin to your `opencode.json`:

```json
{
  "plugin": ["agentic-loop"]
}
```

The stage commands/agents/skills load from `.opencode/` when the repo is checked out in your
project (or copy them into your own `.opencode/`).

## Develop

```bash
npm install        # install @opencode-ai/plugin types + typescript
npm run typecheck  # tsc --noEmit
```

The runtime entry point is `src/index.ts`, exporting the `AgenticLoop` plugin; loop policy lives
in `shouldContinue`.

## License

[Apache-2.0](./LICENSE)
