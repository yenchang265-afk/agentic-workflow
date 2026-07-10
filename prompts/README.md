# prompts/ — single-source agent prompts

The 8 loop stage/authoring agents ship on **both** hosts (OpenCode and Claude
Code), which used to mean two hand-maintained copies per agent that drifted.
Each agent now has one source here:

```
prompts/agents/<name>/
├── body.md        # the canonical prompt body (host conditionals allowed)
├── opencode.yaml  # OpenCode frontmatter (mode/permission dialect), verbatim
└── claude.yaml    # Claude Code frontmatter (name/tools dialect), verbatim
```

`npm run gen:prompts` (scripts/gen-prompts.mjs) renders them into the
checked-in outputs both hosts actually load:

- `plugins/opencode/agents/<name>.md`
- `plugins/claude/agents/<name>.md`

**Never edit the generated files** — edit the source here and re-run the
generator; CI fails when they drift (`git diff --exit-code`).

## Host conditionals

Genuinely host-specific text (tool names, enforcement mechanisms, protocol
details) lives in blocks whose markers sit on their own lines:

```
{{#host opencode}}
Only the OpenCode rendering keeps this.
{{/host}}
{{#host claude}}
Only the Claude rendering keeps this.
{{/host}}
```

Keep the blocks small and few — shared substance belongs in the unconditional
text so it can't drift between hosts again.

The two `loop-orchestration` SKILL.md files are **not** generated: they
document two genuinely different driving protocols (the OpenCode in-process
driver vs the Claude MCP tool sequence) and stay authored per host —
`skills/loop-orchestration/SKILL.md` and
`plugins/claude/skills/loop-orchestration/SKILL.md`.
