---
description: The engineering loop — author tasks, gate them, and drive them through plan → build → verify → review
argument-hint: new <idea> | retask <id> [note] | approve [id] [--base=<branch>] [--pr|--push|--local] [--auto-plan] [--all] | replan [id] [reason] | abandon <id> [reason] | remove <id> --force | plan <id> | claim [id] | recover <id> | kinds | doctor [fix|config] | init | stop | status
---

You are about to work the **engineering agentic loop** (typed as
`/agentic-workflow:engineering`) — one command for task authoring, the human
gates, and execution over the task queues. Act on the argument below. (The PR sitter has its own
command: `/agentic-workflow:pr-sitter`.)

**Argument:** `{{args}}`

**Read the verb from the FIRST whitespace-delimited token of the argument;
everything after it is that verb's literal payload.** Match only that first
token against the verb list below. A verb-like word (`plan`, `status`,
`approve`, `replan`, `claim`, `doctor`, `retask`, `new`, …) appearing *inside*
the payload is part of the idea/note/reason, never the verb — e.g.
`new add a status dashboard` is the `new` verb with idea "add a status
dashboard", not `status`.

The **procedure** for the invoked verb is injected into this turn by the
plugin's `UserPromptSubmit` hook, as a block headed **VERB INSTRUCTIONS**.
That block is authoritative — follow it, and ignore any other verb's
description. The index below exists only so you can tell which verb you are
on and who does the work; it is deliberately not a procedure.

- **`new <idea>`** — interview the user into one or more planless drafts. **Yours.**
- **`retask <id> [note]`** — reshape a planless draft. The move is the hook's; the interview is **yours**.
- **`approve [id]`** — THE gate verb, unified and folder-driven. **The hook's, before your turn.**
- **`replan [id] [reason]`** — the sole rejection verb, back to `queued/`. **The hook's, before your turn.**
- **`abandon <id> [reason]`** — cancel a task into `abandoned/` (reversible; the file is kept). **The hook's, before your turn.**
- **`remove <id>`** — hard-delete a task from the backlog. **The hook's, before your turn.** Destructive.
- **`plan <id>`** — run PLAN on one approved task and park the plan for the gate. **Yours.**
- **`claim [id]`** — drive the next plan-approved task, or with an id that one: build-ready work through BUILD → VERIFY → REVIEW, else one to plan. **Yours.**
- **`recover <id>`** — resume a run that stopped early. **Yours.**
- **`stop`** (alias: `abort`) — abort the active loop. **Yours.**
- **`status`** (or bare) — the active loop plus the backlog roll-up. **Yours.**
- **`kinds`** — the workflow kinds and which are enabled. **Yours.**
- **`doctor [fix|config]`** — audit, and with `fix` repair, backlog damage; with
  `config`, report the effective configuration instead. **Yours.**
- **`init`** — scaffold the backlog folders and a safe-key repo config
  (create-if-absent only). **Yours.**

**If no VERB INSTRUCTIONS block reached you, the plugin's hooks are not
running.** Do NOT improvise the procedure and do NOT touch the backlog:
say the hooks are inactive, name the fix (run `./install.sh qwen`, restart the
session, then check that `~/.qwen/settings.json` still carries the
`agentic-workflow` hooks block and that `disableAllHooks` is not set), and
stop. The same applies if the block names a different verb than the one you
were asked for.

**Verify before you report a gate.** A gate verb reaching you means the hook
failed open — run the MCP fallback tool; if it is unavailable, the plugin's
MCP server is not built. Either way, only report the gate as done after
observing the task file in its **target** folder (glob `docs/tasks/*/<id>*`).
File still in its old folder ⇒ nothing moved — report that the plugin isn't
built/running (fix: run `./install.sh qwen`, restart the session) and
never claim the approval happened.

Do not invent your own control flow — the `workflow-orchestration` skill defines
the exact sequence of tool calls and `agent` spawns. The MCP tools own the state
machine, git isolation, verdicts, backlog moves, snapshots, and metrics; you
own spawning the stage subagents — always with the `agent` tool, passing the
response's `agent` field as `subagent_type` and `run_in_background: false`
(a stage must finish before you advance). Never pass a `model`: this host has
no per-call model, and each stage agent already carries its own.

Never touch `docs/tasks/**` directly — no `run_shell_command`
`mv`/`mkdir`/`rm`/redirects into it, no `write_file`/`edit` of files in status
folders (a PreToolUse hook blocks
these; the gate hook and the MCP tools own every backlog move). The folder a
task file lives in IS its state. If the backlog looks damaged, run `doctor`.
