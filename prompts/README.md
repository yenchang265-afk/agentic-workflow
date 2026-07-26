# prompts/ — single-source agent prompts

The 17 workflow stage/authoring agents ship on **every** host (OpenCode, Claude
Code, Qwen Code), which used to mean a hand-maintained copy per host that
drifted. Each agent now has one source here:

```
prompts/agents/<name>/
├── body.md        # the canonical prompt body (host conditionals allowed)
├── opencode.yaml  # OpenCode frontmatter (mode/permission dialect), verbatim
├── claude.yaml    # Claude Code frontmatter (name/tools dialect), verbatim
└── qwen.yaml      # Qwen Code frontmatter (name/tools list dialect), verbatim
```

Two more single-sourced trees sit alongside it, both for the prompt-INJECTING
hosts (Claude Code and Qwen Code, which drive the loop identically and differ
only in tool names):

```
prompts/verbs/<command>.md        → plugins/{claude,qwen}/verbs/
prompts/skills/<name>/SKILL.md    → plugins/{claude,qwen}/skills/
```

`npm run gen:prompts` (scripts/gen-prompts.mjs) renders them into the
checked-in outputs both hosts actually load:

- `plugins/opencode/agents/<name>.md`
- `plugins/claude/agents/<name>.md`
- `plugins/qwen/agents/<name>.md`

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
{{#host claude|qwen}}
Both prompt-injecting hosts keep this — one block, not two twins.
{{/host}}
```

Keep the blocks small and few — shared substance belongs in the unconditional
text so it can't drift between hosts again.

A block whose host is not named is DROPPED, so name every host it applies to.
Prefer the `|` list over duplicating a block: two near-identical twins are
exactly how the hosts drifted before. A typo'd host name throws rather than
silently vanishing from every rendering.

Host-specific **words** inside a sentence use inline tokens instead —
`{{spawnTool}}`, `{{askTool}}`, `{{modelClause}}`, `{{hostName}}`, defined in
`scripts/gen-prompts.mjs` — because a per-word block would shred the prose into
fragments nobody can read or keep in step.

**OpenCode's** `workflow-orchestration` SKILL.md is **not** generated: it
documents a genuinely different driving protocol (an in-process driver, not an
MCP tool sequence) and stays hand-authored at
`skills/workflow-orchestration/SKILL.md`.

The Claude Code and Qwen Code copies ARE generated, from
`prompts/skills/workflow-orchestration/SKILL.md` — those two run the same
protocol and differ only in tool names, so a second hand-maintained 290-line
copy would be pure drift surface.
