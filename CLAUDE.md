# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`agentic-loop` — an [opencode](https://opencode.ai) plugin that turns the engineer
workflow into an agentic loop (`explore → plan → build → verify`). It also wires
session lifecycle events so an idle session can be re-driven toward an open goal
instead of stopping after one turn.

## Workflow stages

Each stage ships a command, a subagent, and a skill under `.opencode/`:

| Artifact | Path |
|----------|------|
| command  | `.opencode/commands/<stage>.md` (`agent`, `subtask`) |
| subagent | `.opencode/agents/<stage>.md` (`mode`, `permission`) |
| skill    | `.opencode/skills/<stage>/SKILL.md` |

Currently implemented stages: **explore** (read-only locator; `/explore` delegates to
the `explore` subagent, which maps code and surfaces reusable patterns — no edits/plans).

## Commands

```bash
npm install        # install deps (@opencode-ai/plugin types, typescript)
npm run typecheck  # tsc --noEmit — the primary correctness gate
npm test           # node --test (no tests yet)
```

There is no build step: opencode loads the TypeScript entry point directly via
Bun at runtime. `package.json` `exports`/`main`/`types` all point at the raw
`src/index.ts`. `npm run typecheck` is the gate that matters before publishing.

Note: `@opencode-ai/plugin` declares a Node `>=22` engine; local Node is 18, so
`npm install` prints `EBADENGINE` warnings — harmless for typechecking.

## Architecture

Single entry point: `src/index.ts` exports `AgenticLoop: Plugin`.

- A plugin is an `async` factory receiving `PluginInput` (`{ client, project,
  directory, worktree, $, ... }`) and returning a `Hooks` object.
- `client` is the opencode SDK client; `client.app.log({ body: { service,
  level, message } })` writes to opencode's server logs.
- **Hooks vs. events**: top-level keys of the returned object are *hooks*
  (`event`, `tool.execute.before`, `chat.message`, ...). Session lifecycle
  signals like `session.idle` are *events* — they are NOT top-level hooks.
  Subscribe via the `event` hook and switch on `event.type` (e.g.
  `"session.idle"`, with `event.properties.sessionID`). Type definitions for
  every hook live in `node_modules/@opencode-ai/plugin/dist/index.d.ts`; event
  shapes live in `@opencode-ai/sdk`'s `gen/types.gen.d.ts` (`EventSessionIdle`,
  etc.) — consult these before adding a handler.
- **Loop policy** is isolated in the `shouldContinue(sessionID)` function. This
  is the intended extension point: decide whether to re-prompt a session when
  it goes idle. The scaffold default returns `false` (observe only).

## License

Apache-2.0 — preserve license headers and the `LICENSE` file.
