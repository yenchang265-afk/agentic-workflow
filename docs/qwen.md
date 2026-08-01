English | [繁體中文](qwen.zh-TW.md)

# Qwen Code plugin

**Experimental** — this host's interface and behavior may still change.

How the Qwen Code variant executes, its command surface, and install details.
For the shared pipeline picture see [architecture.md](architecture.md); for the
other two hosts see [opencode.md](opencode.md) and
[`plugins/claude/README.md`](../plugins/claude/README.md).

## Execution model

The shared engineering pipeline (gates, PLAN park, BUILD/VERIFY/REVIEW,
`maxIterations`, ship) is documented once in
[`docs/workflows/engineering.md`](workflows/engineering.md#architecture) — this
section covers only what is specific to running it on Qwen Code.

Qwen Code drives the loop the same way Claude Code does, and for the same
reason: it has no autonomous background driver, so **the main agent is the
driver**. It calls the bundled `agentic-workflow` MCP server for every
deterministic operation (claim, isolate, compose, advance, verdict, gate) and
spawns each stage itself with the **`agent` tool**, passing the response's
`agent` field as `subagent_type` and `run_in_background: false`.

There is therefore **no `watch` mode** — `/agentic-workflow:engineering claim`
is the pull equivalent. Within one turn, BUILD → VERIFY → REVIEW still advance
without further human turns.

Human gates are **interactive**, again like Claude Code: a park or a done
returns a `gate` field and the driving agent asks inline with
`ask_user_question` rather than making you type the next command. The
folder-driven `approve` / `replan` commands still work and are what a
non-interactive session uses.

## Command surface

Identical to the Claude Code variant — Qwen's subdirectory namespacing renders
`commands/agentic-workflow/engineering.md` as `/agentic-workflow:engineering`:

| Command | What it does |
|---|---|
| `/agentic-workflow:engineering` | The engineering loop: `new`, `retask`, `approve`, `replan`, `abandon`, `remove`, `plan`, `claim`, `recover`, `kinds`, `doctor`, `stop`, `status` |
| `/agentic-workflow:pr-sitter` | The PR sitter: `claim [<pr>]`, `status`, `stop` |
| `/agentic-workflow:review-sitter` | The review sitter |
| `/agentic-workflow:dep-sitter` | The dependency sitter (experimental) |
| `/agentic-workflow:main-sitter` | The default-branch CI sitter (experimental) |
| `/agentic-workflow:plan` | Ad-hoc, read-only planning — not part of the loop |

As on Claude Code, the invoked verb's procedure is injected into the turn by a
`UserPromptSubmit` hook. If you ever see the loop say **"no VERB INSTRUCTIONS
block reached you"**, the hooks are not running — re-run the installer and
restart the session.

## Install

```bash
./install.sh qwen
```

That builds the shared MCP server, symlinks the commands / skills / references
into `$QWEN_CONFIG_DIR` (default `~/.qwen`), generates the stage agents, and
merges the hooks and the MCP server entry into `settings.json`. Re-run it any
time; it is idempotent. Reverse it with `./uninstall.sh qwen`.

`./install.sh` with no argument detects installed hosts and offers Qwen Code
alongside the others.

**Why the installer rather than `qwen extensions install`.** A Qwen extension
cannot carry hooks — `qwen-extension.json` has no `hooks` field — and the guard
hooks *are* the safety substrate: the backlog-mutation guard, the check-stage
bash allowlist, the worktree pin, and the trusted-verdict nag all live there.
An extension install would also copy the plugin directory, leaving its path to
the shared MCP server dangling. So there is no extension manifest in this repo,
deliberately.

## What the installer writes

| Path | Kind | Why |
|---|---|---|
| `$QWEN_CONFIG_DIR/commands/agentic-workflow/*.md` | symlink | the namespace dir is what produces `/agentic-workflow:<name>` |
| `$QWEN_CONFIG_DIR/skills/*` | symlink | the shared skill library, plus the Qwen rendering of `workflow-orchestration` |
| `$QWEN_CONFIG_DIR/references/*.md` | symlink | shared checklists |
| `$QWEN_CONFIG_DIR/agents/*.md` | **copy** | each carries a baked-in `model:` — see below |
| `$QWEN_CONFIG_DIR/settings.json` | **merged** | hooks + the `agentic-workflow` MCP server |

`settings.json` is your file. The installer replaces only the `agentic-workflow`
MCP server key and the hooks whose `name` starts with `agentic-workflow`, and
`./uninstall.sh qwen` removes exactly those — a hook you added to the same event
survives both.

## Per-stage models are static here

This is the one behavioral difference from the other two hosts, and it is worth
knowing before you configure `stageModels`.

OpenCode passes the configured model at spawn time; Claude Code rewrites the
spawn call's `model` from a `PreToolUse` hook, so on both of those a config edit
is live on the next spawn (an opencode restart aside). **Qwen's `agent` tool has
no model parameter at all**, so neither approach is available. Qwen subagents
do take a top-level `model:` frontmatter field, so the binding moves from
runtime to install time: `./install.sh qwen` resolves
`workflows.<kind>.stageModels` and `agentModels` and writes `model:` into each
generated agent file.

The consequence: **a change to `stageModels` or `agentModels` takes effect on
the next install, not the next claim.** Re-run `./install.sh qwen` after editing
them.

One more consequence worth stating: an agent that backs stages in two kinds with
*different* configured models cannot be expressed by a static binding —
`workflow-verify` backs a stage in four kinds today. The installer reports that
conflict and leaves the first-resolved model in place rather than silently
picking whichever manifest loaded last.

## Known gaps

- **Azure DevOps needs its MCP server registered by hand** — `bootstrap.sh`
  does not yet register it for the Qwen host. Register it under exactly the
  name `azure-devops` — the
  stage prompts name tools as `mcp__azure-devops__<tool>`, so any other name
  makes every ADO stage call a tool that does not exist. There is no longer a
  PAT-injection gap: the driver hands the credential to the server it launches,
  and the stage agents use the server you registered.
- **No `watch` mode**, as above — that is a property of the host, not a
  limitation of the plugin.

## Configuration

Identical to the other hosts: `.agentic-workflow.json` layered over an optional
user-scope `~/.config/agentic-workflow/agentic-workflow.json`. Every field is
documented in [configuration.md](configuration.md).
