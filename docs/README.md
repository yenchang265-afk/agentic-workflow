# Docs index

One canonical file per topic — update the canonical file and link to it;
don't copy content between docs. If a fact about behavior, config, or
security posture seems to belong in two places, it belongs in one; the other
should link.

| Doc | Canonical for |
|-----|---------------|
| [loops/](loops/README.md) | Each kind's full picture (engineering, pr-sitter, review-sitter, dep-sitter, main-sitter) — architecture (stage pipeline, mermaid diagram, config keys), enable snippet, command surface, and 1-2 worked examples, all in one file per kind |
| [architecture.md](architecture.md) | The framework only (core package, manifest engine, scheduler, work sources, the watch lease) and how the Claude Code variant + admin hub differ — per-kind architecture lives in `loops/` |
| [sitters.md](sitters.md) | What the four experimental sitters have in common (shape, opt-in, untrusted-input handling) and an index into their individual files under `loops/` |
| [configuration.md](configuration.md) | Every `.agentic-loop.json` field (layers/precedence, `loops`, `codePlatform`/`ado`, `projectManagement`, hardening, env vars) |
| [opencode.md](opencode.md) | OpenCode-specific execution details (watch triggers, ESC/recover) and the full OpenCode command surface |
| [`../plugins/claude/README.md`](../plugins/claude/README.md) | Claude Code install, the MCP-server command surface, and known limitations |
| [`../packages/core/loops/README.md`](../packages/core/loops/README.md) | Authoring a new loop kind (manifest schema, prompt templates, hooks, work sources) |
| [`../packages/hub/README.md`](../packages/hub/README.md) | The admin hub (beta): install, views, and its own config |
| [design/threat-model.md](design/threat-model.md) | Security posture — threats and controls for every loop kind |
| [design/proposed-loops.md](design/proposed-loops.md) | Not-yet-built loop kind proposals (three entries have since shipped — see `sitters.md` for their current behavior) |
| [design/proposed-hub-features.md](design/proposed-hub-features.md) | Admin hub proposals — the gate/doctor/config write surface (the foundation, prompt preview and gate actions have since shipped; doctor and the config editor have not — see `../packages/hub/README.md` for what the hub does today) |
| [design/improvements/](design/improvements/README.md) | Implementation design records for shipped hardening work (worktrees, state persistence, verdict quality, …) |
| [migration.md](migration.md) | Upgrading from earlier layouts (the old `/agent-loop` command, `in-planning/`, the blocking PLAN gate) |
| [templates/AGENTS.md](templates/AGENTS.md) | Starter `AGENTS.md`/`CLAUDE.md` to copy into a project driven by agentic-loop |
| [`../prompts/README.md`](../prompts/README.md) | How the single-source agent-prompt pipeline works (`prompts/agents/` → `npm run gen:prompts` → both plugins) |

`manual.html` is a hand-maintained, single-page HTML manual that restates
most of the above for convenience (quickstart, config reference, command
cheat-sheet). It is **not regenerated from these docs** — treat it as a
known staleness risk, not a source of truth; if it and a canonical doc above
disagree, the canonical doc wins.
