English | [繁體中文](qwen-host-support.zh-TW.md)

# Adding a third host: Qwen Code (`qwen` CLI)

This is an **implementation plan**, not a record of shipped work (that's
[`improvements/`](./improvements/README.md)) and not a speculative catalog
(that's [`proposed-workflows.md`](./proposed-workflows.md)). It is written
against the real host contract
([`packages/core/src/host.ts`](../../packages/core/src/host.ts)) and the two
existing host adapters, so it can be executed without re-translation.

**Status: slice 0 is built; slices 1–6 are not.** The `AGENTIC_WORKFLOW_HOST`
switch, the `HOST_DIALECT` table, the per-host stage-marker helper, and the
metrics `host` value all ship — so the MCP server already boots and behaves as
the Qwen host. Nothing that host needs in order to be *reachable* (agents,
commands, hooks, installer) exists yet.

## Why

`agentic-workflow` ships one engine (`@agentic-workflow/core`) behind two thin
host adapters — the OpenCode plugin (`plugins/opencode/`) and the Claude Code
plugin driven by a bundled MCP server (`plugins/claude/`). `host.ts` is
deliberately the *entire* host surface, and
[`architecture.md`](../architecture.md) already frames hosts as "thin adapters
over one core". Adding [Qwen Code](https://github.com/QwenLM/qwen-code) is
therefore a packaging and dialect problem, not an engine problem.

Qwen Code (a Gemini-CLI fork) turns out to be much closer to Claude Code than
to OpenCode:

| Capability | Qwen Code | Consequence |
|---|---|---|
| MCP servers over stdio | `mcpServers` in `settings.json` / `qwen-extension.json` | **reuse `agentic-workflow-mcp` verbatim** |
| Subagents | `.qwen/agents/*.md`, YAML frontmatter; explicitly accepts Claude Code frontmatter fields | reuse the generated personas, add a `qwen.yaml` variant |
| Custom commands | `.qwen/commands/**.md`, `{{args}}`, subdirectories → `/ns:name` | `commands/agentic-workflow/engineering.md` → `/agentic-workflow:engineering` |
| Hooks | `PreToolUse`, `UserPromptSubmit`, `SubagentStop`, `SessionStart`, … — the **same stdin-JSON / exit-0-JSON / exit-2-stderr contract as Claude Code**, plus `hookSpecificOutput.updatedInput` | **reuse the hook policy**; swap only the tool-name dialect |
| Subagent spawn | `agent(description, prompt, subagent_type, run_in_background, isolation)` | no per-call `model` argument — see Gap 1 |

So the design is: **Qwen is a sibling packaging of the Claude host's machinery,
not a fork of it.** Nothing is reimplemented; the host-varying bits are pushed
behind one `AGENTIC_WORKFLOW_HOST` switch and one tool-name dialect table.

Scope: full parity with `plugins/claude` (not a thin wrapper), all five
workflow kinds at launch, per-stage models baked into generated agent files.

## Known gaps, stated up front

1. **No per-invocation model.** Qwen's `agent` tool has no `model` argument.
   Mitigation: `install.sh qwen` *generates* `$QWEN_CONFIG_DIR/agents/<name>.md`
   with the subagent's own top-level `model:` frontmatter field resolved from
   `workflows.<kind>.stageModels` and `agentModels`. Documented consequence:
   changing those keys requires re-running the installer. **Resolved during
   slice 0 research:** `model:` is a first-class Qwen subagent field
   (`inherit` | `fast` | `<modelId>` | `<authType>:<modelId>`), so baking is
   native rather than a workaround — but it is a *static* binding, which is
   what makes the re-run necessary.
2. **Extensions cannot carry hooks.** `qwen-extension.json` has no `hooks`
   field, and the guard hooks *are* the safety substrate. The installer must
   therefore merge a hooks block into `settings.json`; an extension-only
   install is not a supported route.
3. **ADO PAT injection has no twin.** `inject-ado-pat.mjs` writes to
   `$CLAUDE_ENV_FILE`; Qwen has no equivalent. On Qwen the SessionStart hook
   degrades to an `additionalContext` notice and the README documents exporting
   `AZURE_DEVOPS_EXT_PAT` directly. Flag it; don't fake it.
4. ~~**MCP tool naming is unconfirmed.**~~ **Resolved — no divergence.**
   Qwen registers MCP tools as `mcp__${serverName}__${serverToolName}` through
   `normalizeToolNameForProvider`, which passes a name through untouched when it
   is ≤63 chars and matches `^[A-Za-z][A-Za-z0-9_-]*$`. Every tool this server
   exposes qualifies (longest: `mcp__agentic-workflow__workflow_plan_approve`,
   44 chars), so the names are **byte-identical to Claude Code's**. The
   check-agent `tools:` lists, the `PreToolUse` matcher, and the spawn prose can
   all be shared verbatim. Claude additionally exposes a plugin-scoped alias
   (`mcp__plugin_agentic-workflow_agentic-workflow__*`) that Qwen has no twin
   for; the Qwen agent files name the single form only.

## Slice 0 — one host switch in the shared machinery

Everything else depends on this. Small, mechanical, no behavior change for the
existing hosts.

- `packages/core/src/workflow/metrics-file.ts` — the run-metrics sidecar's
  `host: z.enum(["opencode", "claude"])` gains `"qwen"`. `packages/hub` reads
  this schema, so this is what makes Qwen runs visible in the hub.
- `packages/core/src/workflow/stage-marker.ts` — today it hardcodes an OpenCode
  marker (`runs/.stage-opencode.json`) as a deliberate sibling of the Claude
  host's `runs/.stage.json`. Add a generic `hostStageMarkerPath(tasksDir, host)`
  and keep the existing named exports as thin wrappers, so the hub's
  driving-oracle, doctor, and board reads keep working unchanged. Qwen gets
  `runs/.stage-qwen.json`.
- `plugins/claude/mcp-server/src/server.ts` — read `AGENTIC_WORKFLOW_HOST`
  (`"claude"` default, or `"qwen"`) once and route the host-varying values
  through a single `HOST_DIALECT` table:
  - `agentRef(name)` — Claude namespaces plugin subagents
    (`agentic-workflow:workflow-build`); Qwen agents installed into
    `$QWEN_CONFIG_DIR/agents/` are referenced by bare `name`.
  - the stage-marker path (via the new core helper) and the metrics `host` field.
  - the spawn prose fed to `spawnNote(lead, tail)` — Claude: "Task tool with
    `model` set to X"; Qwen: "`agent` tool with `subagent_type: X` and
    `run_in_background: false`", with **no model line** (baked into the agent
    file per Gap 1).

  `spawnNote` stays the single choke point, so `server.test.ts`'s existing
  source lint (every `note:` goes through `spawnNote`) keeps holding.
  `dispatch.test.ts` gains the Qwen leg of the agent-identity chain.
- **Optional but recommended:** move `plugins/claude/mcp-server/` →
  `packages/mcp-server/` (workspace name `agentic-workflow-mcp` unchanged). A
  second host consuming a binary that lives inside the first host's directory is
  a smell. Mechanical: root `workspaces`, `plugins/claude/.mcp.json`,
  `install.sh`, `plugins/claude/install.sh`, CI paths. This step can be dropped
  — nothing else in the plan depends on it.

## Slice 1 — the MCP and agent substrate

**Prerequisite:** run `qwen` against the built server once and record the actual
MCP tool name for `workflow_verdict` (Gap 4). Everything below uses that literal.

- `prompts/agents/<name>/qwen.yaml` — one new file per persona in
  `prompts/agents/` (17 today). Qwen accepts Claude Code frontmatter, so
  `claude.yaml` is the starting point: `name`, `description`, `tools`. The check
  agents (`workflow-verify`, `workflow-review`, `workflow-pr-triage`,
  `workflow-review-fetch`, `workflow-dep-scan`, `workflow-main-diagnose`) must
  name the Qwen-resolved verdict tool. No `{{allowlist}}` marker: Qwen has no
  per-agent permission map, so the bash allowlist is enforced by the
  `PreToolUse` guard exactly as on Claude Code.
- `scripts/gen-prompts.mjs` — add
  `{host: "qwen", frontmatter: "qwen.yaml", outDir: "plugins/qwen/agents"}` to
  the `HOSTS` array. The `{{#host <name>}}` renderer already accepts any
  lowercase host name and `expandAllowlist` is already OpenCode-only, so no
  other change is needed there.
- `prompts/agents/*/body.md` — add `{{#host qwen}}` blocks wherever the driving
  protocol is host-specific (spawn tool name, verdict tool name). The existing
  `{{#host claude}}` blocks are the guide for what needs a twin.
- `scripts/qwen-agents.mjs` (new) — an install-time generator that reads
  `.agentic-workflow.json` (repo layer plus user layer, using the same
  standalone resolution `plugins/claude/hooks/verb-slice.mjs` already
  implements) and writes `$QWEN_CONFIG_DIR/agents/<name>.md` as *copies* of
  `plugins/qwen/agents/<name>.md` with `modelConfig.model` injected from
  `stageModels`/`agentModels`. This is the Gap 1 mitigation. Agents are the only
  assets installed as copies rather than symlinks, and the README says why.

## Slice 2 — commands and verb slicing

Qwen, like Claude Code, cannot rewrite a submitted prompt — its
`UserPromptSubmit` hook can only block or add
`hookSpecificOutput.additionalContext`. So Qwen inherits the **Claude** slicing
shape (a physical router plus an injected verb block), not the OpenCode one.
The `!{shell}` injection Qwen supports inside command bodies was considered and
rejected: it raises an execution-confirmation prompt on every invocation.

Because the verb prose now differs across *two* injection hosts, stop
hand-maintaining it:

- **Move `plugins/claude/verbs/engineering.md` → `prompts/verbs/engineering.md`**
  and generate both `plugins/claude/verbs/engineering.md` and
  `plugins/qwen/verbs/engineering.md` from it via `gen-prompts.mjs`, using the
  same `{{#host}}` blocks. The `<!-- aw:verb … -->` markers pass through
  untouched. This removes the drift risk `AGENTS.md` warns about: a verb that
  loses its block does not error, it silently falls back to no instructions.
- `plugins/qwen/commands/` — files mirroring `plugins/claude/commands/` (the
  `engineering.md` router plus `plan`, `pr-sitter`, `review-sitter`,
  `dep-sitter`, `main-sitter`), with `$ARGUMENTS` → `{{args}}` and MCP tool
  names in the Qwen dialect. Keep an `argument-hint:` key in the frontmatter
  even though Qwen ignores it — the coverage test parses it as the verb roster,
  and an ignored key is cheaper than a second mechanism.
- Installed to `$QWEN_CONFIG_DIR/commands/agentic-workflow/*.md`, which Qwen's
  subdirectory namespacing renders as `/agentic-workflow:engineering` —
  byte-identical command names to the other two hosts.

## Slice 3 — hooks, the safety substrate

The hook *contract* is already compatible; only tool identity differs. Do not
fork the policy — extract the dialect.

- `plugins/claude/hooks/src/dialect.mjs` (new shared source) — maps `tool_name`
  to a canonical kind and normalizes the input keys, keyed off
  `AGENTIC_WORKFLOW_HOST`:
  - Claude: `Bash` → bash (`command`); `Edit|Write|NotebookEdit` → write
    (`file_path|path|notebook_path`)
  - Qwen: `run_shell_command` → bash (`command`); `write_file|replace|edit` →
    write (`file_path`)
- `plugins/claude/hooks/src/check-stage-guard.entry.mjs` — replace the literal
  `"Bash"` and `WRITE_TOOLS` checks with dialect lookups. All four controls
  (the always-on backlog-mutation guard, the check-stage bash allowlist,
  worktree pinning, and the ADO/GitHub/`git push` backstops) and the
  `updatedInput` rewrite path carry over unchanged — Qwen supports
  `hookSpecificOutput.updatedInput` and the same exit-2-blocks semantics.
- `check-verdict-guard`, `reconcile`, and
  `gate-command`/`gate-parse`/`gate-result`/`verb-slice` — logic unchanged.
  `gate-command.mjs` gains `AGENTIC_WORKFLOW_PLUGIN_ROOT` as a fallback ahead of
  its existing `CLAUDE_PLUGIN_ROOT` lookup; the installer supplies it via the
  hook entry's `env` field.
- `inject-ado-pat.mjs` — on Qwen, emit an `additionalContext` notice instead of
  writing an env file (Gap 3).
- `scripts/build-hooks.mjs` — emit a **second, fully generated** bundle set into
  `plugins/qwen/hooks/`. Bundle the currently hand-written entries
  (`gate-command.mjs` and its pure helpers) too, so `plugins/qwen/hooks/` is
  100% generated and CI's existing `git diff --exit-code` drift gate covers it.
  Hooks run under bare `node` with no `node_modules`, which is why everything
  shared with core is inlined — that constraint is unchanged.
- `plugins/qwen/hooks/hooks.json` — the settings fragment the installer merges.
  The same four events; the `PreToolUse` matcher becomes
  `run_shell_command|write_file|replace|edit|<qwen mcp prefix>.*`.

## Slice 4 — install and uninstall

Follow the **OpenCode** installer idiom (symlink into a config dir), not the
Qwen extension idiom: `qwen extensions install` *copies* its source, which
breaks the edit-repo-see-changes loop, and extensions cannot carry hooks anyway
(Gap 2).

`install.sh` gains a `qwen` target alongside `opencode|claude|all|config` — the
dispatch `case`, a `has_qwen()` next to `has_claude`/`has_opencode`, the
interactive menu, and the default-target picker. `install_qwen()`:

1. build core and `agentic-workflow-mcp` (a root `npm install`, which runs `prepare`)
2. symlink `plugins/qwen/commands/*.md` → `$QWEN_CONFIG_DIR/commands/agentic-workflow/`
3. symlink `skills/` and `references/` using the same relative-symlink pattern
   as `plugins/claude/install.sh`, including the `workflow-orchestration`
   carve-out — Qwen needs its own copy of that skill, since the driving protocol
   genuinely differs per host and [`prompts/README.md`](../../prompts/README.md)
   already documents why it is not generated
4. `node scripts/qwen-agents.mjs` → generated agents with baked models
5. `node scripts/qwen-settings.mjs merge` → idempotently merge
   `mcpServers.agentic-workflow` (an absolute path to `dist/server.js`, with
   `env: {"AGENTIC_WORKFLOW_HOST": "qwen"}`) and the hooks block into
   `$QWEN_CONFIG_DIR/settings.json`, inside a marked, removable region. Merge
   JSON in Node, never with `sed`; preserve unknown keys.

`$QWEN_CONFIG_DIR` defaults to `~/.qwen`, with an explicit override mirroring
how `OPENCODE_CONFIG_DIR` is treated today, so CI can round-trip into a temp dir.

`uninstall.sh` gains a `qwen` target that removes the symlinks, the generated
agents, and the marked settings region, leaving the rest of `settings.json`
byte-identical.

Also ship `plugins/qwen/qwen-extension.json` for `qwen extensions install <path>`
discovery, documented as **secondary and hook-less** — the installer remains the
supported route.

## Slice 5 — tests and CI

- `plugins/claude/hooks/dialect.test.mjs` — both dialects, unknown tool ids,
  missing input keys.
- `plugins/claude/hooks/qwen-command-coverage.test.mjs` — reuse `verb-slice.mjs`'s
  `verbsIn` / `unmarkedLines` / advertised-verb parsing against the Qwen router
  and generated verbs file. This is what stops a verb from silently losing its
  block on the new host.
- `scripts/qwen-settings.test.mjs` — merge is idempotent, uninstall is exact,
  unknown keys survive.
- `mcp-server/src/dispatch.test.ts` — extend the `workflow.json` `stage.agent` ↔
  agent-file `name` ↔ `agentRef` chain to `plugins/qwen/agents/`.
- `mcp-server/src/server.test.ts` — assert the Qwen dialect's spawn prose names
  the `agent` tool and `run_in_background: false`, mirroring the existing Claude
  spawn-prose lint.
- `.github/workflows/test.yml`:
  - prompt-drift gate path list gains `plugins/qwen/agents`,
    `plugins/qwen/verbs`, `plugins/claude/verbs`
  - hook-drift gate path list gains `plugins/qwen/hooks`
  - the MCP smoke run is repeated with `AGENTIC_WORKFLOW_HOST=qwen`
  - `bash -n` and `shellcheck` lists gain any new shell
  - an install round trip: `./install.sh qwen "$d"` twice →
    `./uninstall.sh qwen "$d"` → assert no dangling symlinks **and** a clean
    `settings.json`

## Slice 6 — docs

Repo rule ([`docs/README.md`](../README.md)): one canonical file per topic, and
every doc has a `.zh-TW.md` twin updated in the same change.

- `docs/qwen.md` + `.zh-TW.md` — new, modeled on [`opencode.md`](../opencode.md)
- [`architecture.md`](../architecture.md) + `.zh-TW.md` — a third node in the
  `hosts` mermaid subgraph, and a "Qwen Code variant" section alongside the
  existing "Claude Code variant"
- `plugins/qwen/README.md` + `.zh-TW.md` — install, commands, and the four gaps
  stated plainly
- `AGENTS.md` — the "Plugin Structure" tree, and the "Per-verb command slicing"
  section, which currently says "the two hosts differ" and must become three
- root `README.md` + `README.zh-TW.md` — the install matrix

## Verification

1. `npm run typecheck:all && npm run test:all` — unit and hook tests across all
   workspaces.
2. `node scripts/gen-prompts.mjs && node scripts/build-hooks.mjs && git diff --exit-code`
   — proves the generated agents, verbs, and hook bundles are in sync with their
   sources.
3. `AGENTIC_WORKFLOW_HOST=qwen node <mcp>/dist/server.js < /dev/null` → "MCP
   server ready" on stderr, stdout empty (stdout is reserved for the MCP
   transport).
4. Install round trip into a temp `QWEN_CONFIG_DIR`: install twice
   (idempotence), confirm `settings.json` has exactly one marked region,
   uninstall, confirm the file returns to its pre-install content.
5. **End to end in a real `qwen` session** against a throwaway repo — the only
   step that proves the host actually drives:
   - `/agentic-workflow:engineering new <idea>` → a draft appears in
     `docs/tasks/draft/`, which proves commands resolve, the router loads, and
     the verb block is injected. If the "no VERB INSTRUCTIONS block reached you"
     message shows, the hooks are not wired.
   - `approve` → `queued/`; `plan <id>` → parks in `plan-review/`; `approve` →
     `in-progress/`
   - `claim` → BUILD → VERIFY → REVIEW runs in a worktree; confirm
     `runs/.stage-qwen.json` is written, and that an off-allowlist bash call
     during VERIFY is **blocked** by the guard
   - `approve` → ships
   - confirm `runs/<id>.metrics.json` carries `host: "qwen"` and that the run
     shows up in `npm run hub`
6. Confirm that a check stage returning prose "PASS" without calling the verdict
   tool is caught by the SubagentStop verdict guard. The trusted-verdict rail is
   the single most important thing to prove on a new host.
