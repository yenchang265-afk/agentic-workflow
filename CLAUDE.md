# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`agentic-loop` — a **dual-target** plugin that turns the engineer workflow into an
agentic loop (`explore → plan → build → verify`). It targets two tools:

- **opencode** — a runtime plugin (`src/index.ts`) that re-drives idle sessions,
  plus stage artifacts under `.opencode/`.
- **Claude Code** — a marketplace + plugin (`.claude-plugin/`) shipping the same
  stage artifacts as root-level markdown.

## Dual-target layout

The two ecosystems read different directories and use different frontmatter, so
every stage artifact exists as **two copies** — keep them in sync:

| Artifact | Claude Code (repo root) | opencode |
|----------|-------------------------|----------|
| command  | `commands/<stage>.md` (`argument-hint`) | `.opencode/commands/<stage>.md` (`agent`, `subtask`) |
| subagent | `agents/<stage>.md` (`tools`) | `.opencode/agents/<stage>.md` (`mode`, `permission`) |
| skill    | `skills/<stage>/SKILL.md` | `.opencode/skills/<stage>/SKILL.md` |

Manifests: `.claude-plugin/marketplace.json` (lists the plugin, `source: "./"`) and
`.claude-plugin/plugin.json` (points at the root `commands/`, `agents/`, `skills/`).
The skill body is identical across copies; command/agent bodies are near-identical
but differ in frontmatter only. **When editing a stage, update both copies.**

The runtime loop (`src/index.ts`) is **opencode-only** — Claude Code has no JS plugin
API. A Claude Code `Stop`-hook equivalent is intentionally not implemented yet.

Currently implemented stages: **explore**.

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
