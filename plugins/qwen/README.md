English | [繁體中文](README.zh-TW.md)

# agentic-workflow — Qwen Code plugin

The Qwen Code host for the shared `@agentic-workflow/core` engine. Same workflow
kinds, same gates, same backlog as the OpenCode and Claude Code hosts.

**The canonical documentation is [`docs/qwen.md`](../../docs/qwen.md)** — install,
execution model, command surface, and the known gaps. This file describes only
what is in this directory.

## Layout

| Path | Source or generated |
|---|---|
| `agents/` | **generated** from `prompts/agents/*/{body.md,qwen.yaml}` by `npm run gen:prompts` |
| `commands/` | hand-authored — the routers Qwen loads as `/agentic-workflow:<name>` |
| `verbs/` | **generated** from `prompts/verbs/` — the per-verb procedures the hook injects |
| `skills/workflow-orchestration/` | **generated** from `prompts/skills/` — the driving protocol |
| `hooks/` | **generated** by `npm run build:hooks` from `plugins/claude/hooks/src/` |
| `hooks/hooks.json` | hand-authored — the fragment the installer merges into `settings.json` |

Never edit a generated file; edit its source and re-run the generator. CI fails
on drift.

## Why so much is shared with the Claude plugin

Qwen Code's extension surface is much closer to Claude Code's than to
OpenCode's: MCP servers over stdio, subagents whose frontmatter it parses with
Claude Code compatibility, and a hook system with the same stdin-JSON /
exit-0-JSON / exit-2-stderr contract plus `hookSpecificOutput.updatedInput`.

So this host is a **sibling packaging of the Claude host's machinery, not a fork
of it**:

- the **MCP server** is the same binary (`plugins/claude/mcp-server/`), switched
  to this host by `AGENTIC_WORKFLOW_HOST=qwen`;
- the **guard hooks** are the same sources, with only the tool *names* they key
  off resolved at runtime through `plugins/claude/hooks/src/dialect.mjs`;
- the **verbs** and the **orchestration skill** are rendered from one shared
  source, because the two hosts run the same protocol and differ only in tool
  names.

The MCP tool names need no translation at all: Qwen registers MCP tools as
`mcp__<server>__<tool>` and passes a name through unchanged when it is ≤63 chars
and matches `^[A-Za-z][A-Za-z0-9_-]*$`, which every tool this server exposes
satisfies.

## There is no extension manifest, on purpose

`qwen extensions install` copies the extension directory, which would leave the
manifest's path to the shared MCP server dangling — and a Qwen extension cannot
carry hooks at all, so it would ship without the safety substrate. Use
`./install.sh qwen`.
