English | [繁體中文](README.zh-TW.md)

# Docs index

One canonical file per topic — update the canonical file and link to it;
don't copy content between docs. If a fact about behavior, config, or
security posture seems to belong in two places, it belongs in one; the other
should link.

| Doc | Canonical for |
|-----|---------------|
| [manual.html](manual.html) | The guided, single-page **user manual** — install → config wizard → the loop → gates → reference tables. Start here if you're new; it restates the docs below rather than owning any topic (see the note under this table) |
| [workflows/](workflows/README.md) | Each kind's full picture (engineering, pr-sitter, review-sitter, dep-sitter, main-sitter) — architecture (stage pipeline, mermaid diagram, config keys), enable snippet, command surface, and 1-2 worked examples, all in one file per kind |
| [architecture.md](architecture.md) | The framework only (core package, manifest engine, scheduler, work sources, the watch lease) and how the Claude Code variant + admin hub differ — per-kind architecture lives in `workflows/` |
| [sitters.md](sitters.md) | What the four sitters have in common (shape, opt-in, untrusted-input handling), why all four are experimental, and an index into their individual files under `workflows/` |
| [configuration.md](configuration.md) | Every `.agentic-workflow.json` field (layers/precedence, `workflows`, `codePlatform`/`ado`, `projectManagement`, hardening, env vars) |
| [opencode.md](opencode.md) | OpenCode-specific execution details (watch triggers, ESC/recover) and the full OpenCode command surface |
| [qwen.md](qwen.md) | Qwen Code (**experimental**) install, execution model, command surface, and its static per-stage models |
| [`../plugins/claude/README.md`](../plugins/claude/README.md) | Claude Code install, the MCP-server command surface, and known limitations |
| [`../packages/core/workflows/README.md`](../packages/core/workflows/README.md) | Authoring a new workflow kind (manifest schema, prompt templates, hooks, work sources) |
| [`../packages/hub/README.md`](../packages/hub/README.md) | The admin hub (beta): install, views, and its own config |
| [invariants/](invariants/README.md) | The engineering invariants behind the one-line rules in `AGENTS.md` — claims and liveness, git isolation, verdicts, the bash allowlist, the host protocol, the task ledger, the driver and its hooks |
| [design/threat-model.md](design/threat-model.md) | Security posture — threats and controls for every workflow kind |
| [design/proposed-workflows.md](design/proposed-workflows.md) | Not-yet-built workflow kind proposals (three entries have since shipped — see `sitters.md` for their current behavior) |
| [design/qwen-host-support.md](design/qwen-host-support.md) | Design record for the third host, Qwen Code — now shipped; see `qwen.md` for how it behaves today |
| [design/proposed-hub-features.md](design/proposed-hub-features.md) | Admin hub proposals — the gate/doctor/config write surface (all four have since shipped: the foundation, prompt preview, gate actions, the backlog doctor, and the config editor — see `../packages/hub/README.md` for what the hub does today) |
| [design/improvements/](design/improvements/README.md) | Implementation design records for shipped hardening work (worktrees, state persistence, verdict quality, …) |
| [migration.md](migration.md) | Upgrading from earlier layouts (the old `/agent-loop` command, `in-planning/`, the blocking PLAN gate) |
| [templates/AGENTS.md](templates/AGENTS.md) | Starter `AGENTS.md`/`CLAUDE.md` to copy into a project driven by agentic-workflow |
| [`../prompts/README.md`](../prompts/README.md) | How the single-source agent-prompt pipeline works (`prompts/agents/` → `pnpm gen:prompts` → all three plugins) |

`manual.html` restates most of the above for convenience (quickstart, config
reference, command cheat-sheet), so it is **canonical for nothing**: if it and
a doc above disagree, the doc above wins.

It is hand-maintained, **not generated** — which makes it the one file here
that drifts silently. Two rules keep it honest:

1. A change that touches a **default, a wizard question, a config key, or a
   command's arguments** must update `manual.html` in the same PR.
2. Its footer carries a **"last reviewed against the repo"** date. Bump it
   whenever you sweep the page against the source, so a reader can tell at a
   glance how much to trust it.

## Translations

English is canonical; a translation is a manually maintained clone, not a
generated one — when the English doc changes, update the translation in the
same PR (or file a follow-up) rather than letting it drift silently. Name a
translated file `<name>.<BCP-47-lang-code>.md` next to the English original
(e.g. [`README.zh-TW.md`](../README.zh-TW.md) next to [`../README.md`](../README.md))
and put a one-line language switcher as the first line of both files, e.g.
`English | [繁體中文](README.zh-TW.md)` in the English file and
`[English](README.md) | 繁體中文` in the translated one. All user-facing
docs (this index, the topic files under `docs/`, and the package/plugin
READMEs) have a zh-TW translation today; add more languages the same way
as the need comes up. Contributor- and agent-facing engineering notes —
[`invariants/`](invariants/README.md) and [`ideas/`](ideas/) — are English-only,
because their readers are the people and agents editing this repo's source.
