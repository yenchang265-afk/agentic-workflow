#!/usr/bin/env node
/**
 * SessionStart hook: make config `ado.pat` available to Bash tool runs as
 * AZURE_DEVOPS_EXT_PAT, so the PR sitter's stage-agent `curl` calls can
 * authenticate to Azure DevOps on Claude Code — where a stage's Bash runs in
 * the client, not the MCP server, so the server's in-process env export can't
 * reach it (the OpenCode plugin covers its own stages via applyAdoPatEnv).
 *
 * Only fills the gap:
 *  - writes only when Claude Code provides $CLAUDE_ENV_FILE (the supported
 *    channel for persisting env into subsequent Bash executions);
 *  - never overrides a PAT the user already exported (the env var wins);
 *  - a no-op when there is no `ado.pat` in the repo's `.agentic-workflow.json` or
 *    the user-scope config (`${XDG_CONFIG_HOME:-~/.config}/agentic-workflow/agentic-workflow.json`,
 *    or the legacy `~/.agentic-workflow.json`) — repo wins, mirroring the core
 *    loader's layering; $AGENTIC_WORKFLOW_USER_CONFIG overrides the user path,
 *    "" disables the layer).
 *
 * The secret goes only into $CLAUDE_ENV_FILE (session-scoped, managed by Claude
 * Code) — never into a command string or tool-call log.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const read = () =>
  new Promise((resolve) => {
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => resolve(s))
  })

/** Single-quote for a POSIX shell (the env file is sourced): wrap in '…', escaping embedded quotes. */
const shellSingleQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * User-scope config path, mirroring core's resolveUserConfigPath:
 * $AGENTIC_WORKFLOW_USER_CONFIG ("" disables) wins; else
 * `${XDG_CONFIG_HOME:-~/.config}/agentic-workflow/agentic-workflow.json`,
 * falling back on read to the pre-XDG `~/.agentic-workflow.json` when only that exists.
 */
const userConfigPath = () => {
  const env = process.env.AGENTIC_WORKFLOW_USER_CONFIG
  if (env !== undefined) return env === "" ? null : env
  const home = os.homedir()
  if (!home) return null
  const xdg = process.env.XDG_CONFIG_HOME
  const configHome = xdg && xdg.trim() ? xdg : path.join(home, ".config")
  const primary = path.join(configHome, "agentic-workflow", "agentic-workflow.json")
  if (fs.existsSync(primary)) return primary
  const legacy = path.join(home, ".agentic-workflow.json")
  if (fs.existsSync(legacy)) return legacy
  return primary
}

/** Best-effort `ado.pat` from a config file; undefined when absent/unreadable/malformed. */
const readPat = (file) => {
  if (!file) return undefined
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"))
    if (cfg && cfg.ado && typeof cfg.ado.pat === "string" && cfg.ado.pat) return cfg.ado.pat
  } catch {
    /* no config / unreadable — nothing to inject */
  }
  return undefined
}

/**
 * Tell the session the PAT could not be injected, rather than failing silently.
 * `additionalContext` on SessionStart is the only channel available here.
 */
const notice = (text) => {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }) + "\n",
  )
}

const main = async () => {
  if (process.env.AZURE_DEVOPS_EXT_PAT) return // the env var always wins; already set
  const envFile = process.env.CLAUDE_ENV_FILE
  if (!envFile) {
    // No env-file channel. Claude Code always provides one, so this is either a
    // non-Claude host (Qwen Code has no equivalent) or the capability is off.
    // Degrade to a notice ONLY when a PAT is actually configured and an ADO loop
    // would therefore be about to fail — an unrelated session must stay silent,
    // and the notice must never carry the secret itself.
    let input = {}
    try {
      input = JSON.parse(await read())
    } catch {
      /* fall back to cwd */
    }
    const cwd = input.cwd || process.cwd()
    const configured = readPat(path.join(cwd, ".agentic-workflow.json")) ?? readPat(userConfigPath())
    if (configured) {
      notice(
        "agentic-workflow: an `ado.pat` is configured, but this host provides no session env-file channel to " +
          "inject it (that is Claude Code only). Export AZURE_DEVOPS_EXT_PAT in your shell before starting the " +
          "session, or the Azure DevOps sitters will fail to authenticate.",
      )
    }
    return
  }
  // The harness creates the env file before hooks run. A CLAUDE_ENV_FILE that
  // does not already exist as a regular file is not that channel — appending
  // would write the secret to an arbitrary path.
  try {
    if (!fs.statSync(envFile).isFile()) return
  } catch {
    return
  }

  let input = {}
  try {
    input = JSON.parse(await read())
  } catch {
    /* no stdin / not JSON — fall back to process.cwd() */
  }
  const cwd = input.cwd || process.cwd()

  // Repo layer wins over the user layer, mirroring the core loader's merge.
  const pat = readPat(path.join(cwd, ".agentic-workflow.json")) ?? readPat(userConfigPath())
  if (!pat) return

  try {
    fs.appendFileSync(envFile, `export AZURE_DEVOPS_EXT_PAT=${shellSingleQuote(pat)}\n`)
  } catch {
    /* best-effort — never block the session on this */
  }
}

main()
