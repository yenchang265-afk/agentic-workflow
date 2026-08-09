/**
 * Tool-identity dialect for the hook guards.
 *
 * The guards' POLICY is host-neutral — the same backlog-mutation rules, the same
 * check-stage bash allowlist, the same worktree pin, the same ADO/GitHub/push
 * backstops. What is NOT host-neutral is the tool *names* that policy keys off:
 * Claude Code calls the shell `Bash`, Qwen Code calls it `run_shell_command`.
 * Keeping the policy in one place and the names here is what stops a second host
 * from becoming a fork of a 300-line security guard.
 *
 * Selected by AGENTIC_WORKFLOW_HOST — the same switch the MCP server reads, so
 * the marker the server WRITES and the marker the guard READS can never disagree.
 *
 * Keep this file dependency-free (no @agentic-workflow/core, no node built-ins
 * beyond `process`) so a test can import it under bare `node --test`, matching
 * ./allowlist.mjs.
 */

/**
 * Qwen tool ids come from qwen-code's packages/core/src/tools/tool-names.ts.
 * `replace` is its LEGACY alias for `edit` and is still accepted at runtime
 * (ToolNamesMigration), so it is listed too — a legacy name that slipped past
 * the guard would be a hole, not a cosmetic miss.
 *
 * `MultiEdit` is deliberately absent from the Claude list: no such tool exists,
 * and matching it only obscured that `NotebookEdit` is the third real one.
 */
const DIALECTS = {
  claude: {
    stageMarkerFile: ".stage.json",
    // Mirrors core's `stageEvidenceFile(host)`; per host for the same reason the
    // marker is (one host's session must never write into another's ledger).
    evidenceFile: ".stage-evidence.json",
    // Claude Code surfaces plugin MCP tools under a second, plugin-bundled
    // alias; Qwen has only the one registration.
    verdictAliases:
      "mcp__agentic-workflow__workflow_verdict or, plugin-bundled, mcp__plugin_agentic-workflow_agentic-workflow__workflow_verdict",
    bash: ["Bash"],
    write: ["Edit", "Write", "NotebookEdit"],
    // The inspection tools whose target path is recorded as check-stage evidence
    // (hooks/src/evidence.mjs). Read-only by construction — a write tool's path
    // is not evidence of having *looked* at anything.
    read: ["Read", "Grep", "Glob"],
    spawnTool: "Task tool",
    // Whether the host's spawn tool takes a per-call model. False on Qwen: the
    // model is baked into the installed agent file, so telling the orchestrator
    // to "set `model`" would name a parameter that does not exist.
    conveysSpawnModel: true,
    // The tool names that spawn a subagent — read by the PreToolUse model stamp
    // AND by the spawn-stage guard. `Task` was renamed `Agent` in Claude Code
    // 2.1.63 and is still accepted as an alias, so both are matched: a rename
    // that silently stopped matching would disable the model binding and the
    // stage guard without failing anything.
    spawn: ["Agent", "Task"],
    // What the host prepends to a plugin agent's name in `subagent_type`
    // (`agentic-workflow:workflow-build`). Stripped before the name is checked
    // against the agents this plugin ships.
    agentPrefixes: ["agentic-workflow:", "mcp__plugin_agentic-workflow_agentic-workflow__"],
    installer: "plugins/claude/install.sh",
    // The host's structured question tool, named by the gate follow-up the hook
    // injects (hooks/gate-ask.mjs). Same per-host split as gen-prompts.mjs's
    // {{askTool}} token, and it exists for the same reason: a follow-up naming
    // the other host's tool does not fail loudly, it just never opens a window.
    askTool: "AskUserQuestion",
  },
  qwen: {
    stageMarkerFile: ".stage-qwen.json",
    evidenceFile: ".stage-evidence-qwen.json",
    verdictAliases: "mcp__agentic-workflow__workflow_verdict",
    bash: ["run_shell_command"],
    write: ["write_file", "edit", "replace", "notebook_edit"],
    read: ["read_file", "read_many_files", "search_file_content", "glob"],
    spawnTool: "`agent` tool",
    conveysSpawnModel: false,
    // Qwen spawns a subagent with the `agent` tool, passing the bare agent name
    // as `subagent_type` (docs/qwen.md). This list was empty while the model
    // stamp was its only reader — `conveysSpawnModel: false` stops that hook
    // before it looks at a tool name — but the spawn-stage guard reads it too and
    // is NOT gated by that flag, so an empty list would silently disable the
    // guard on this host.
    spawn: ["agent"],
    agentPrefixes: [],
    installer: "./install.sh qwen",
    askTool: "ask_user_question",
  },
}

/** The write tools' path argument, in probe order. Shared: both hosts use `file_path`. */
export const WRITE_PATH_KEYS = ["file_path", "path", "notebook_path"]

export const KNOWN_HOSTS = Object.keys(DIALECTS)

/**
 * The active host, or null when AGENTIC_WORKFLOW_HOST names one we don't know.
 * Unset (or empty — wrappers propagate empty env vars) means Claude Code, which
 * is the host that shipped first and never sets the variable.
 *
 * Null is returned rather than a fallback ON PURPOSE. Defaulting a typo'd host
 * to Claude would leave every Qwen tool name matching nothing, so the guard
 * would wave through every write and every off-allowlist command while looking
 * healthy — a silent hole. The caller blocks instead.
 */
export const hostFor = (env = process.env) => {
  const raw = env.AGENTIC_WORKFLOW_HOST || undefined
  if (raw === undefined) return "claude"
  return raw in DIALECTS ? raw : null
}

/** The dialect for a host name, or null when unknown. */
export const dialectFor = (host) => (host && host in DIALECTS ? DIALECTS[host] : null)

export const isBashTool = (d, tool) => d.bash.includes(tool)
export const isWriteTool = (d, tool) => d.write.includes(tool)
export const isReadTool = (d, tool) => d.read.includes(tool)

/**
 * The host-neutral name core's `classifyMutation` matches on. Core keys off the
 * Claude spelling (`/^(write|edit|multiedit|notebookedit)$/i`, `/^bash$/i`), so
 * a Qwen `run_shell_command` must arrive as `Bash` or the always-on backlog
 * guard would classify it as "some other tool" and allow it through.
 */
export const canonicalTool = (d, tool) => {
  if (isBashTool(d, tool)) return "Bash"
  if (isWriteTool(d, tool)) return "Write"
  return String(tool ?? "")
}

/** The write target's path from a tool input, or undefined. */
export const writePathOf = (ti) => {
  for (const key of WRITE_PATH_KEYS) if (ti[key] !== undefined) return ti[key]
  return undefined
}

/** Which key held the write path, for rewriting it in place. */
export const writePathKeyOf = (ti) => WRITE_PATH_KEYS.find((key) => ti[key] !== undefined) ?? "file_path"

/** The message shown when AGENTIC_WORKFLOW_HOST names a host we don't know. */
export const unknownHostMessage = (raw) =>
  `agentic-workflow: AGENTIC_WORKFLOW_HOST="${raw}" is not a known host (expected one of: ${KNOWN_HOSTS.join(", ")}). ` +
  `Blocking rather than guessing: on the wrong dialect this guard would not recognize a single tool name and would ` +
  `wave through every backlog mutation. Fix the value in your host's settings and restart the session.`
