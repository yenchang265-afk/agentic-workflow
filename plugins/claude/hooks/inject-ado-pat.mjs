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
 *  - a no-op when there is no `ado.pat` in the repo's `.agentic-loop.json` or
 *    the user-scope `~/.agentic-loop.json` (repo wins, mirroring the core
 *    loader's layering; $AGENTIC_LOOP_USER_CONFIG overrides the user path,
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

/** User-scope config path: $AGENTIC_LOOP_USER_CONFIG ("" disables), else ~/.agentic-loop.json. */
const userConfigPath = () => {
  const env = process.env.AGENTIC_LOOP_USER_CONFIG
  if (env !== undefined) return env === "" ? null : env
  const home = os.homedir()
  return home ? path.join(home, ".agentic-loop.json") : null
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

const main = async () => {
  const envFile = process.env.CLAUDE_ENV_FILE
  if (!envFile) return // not Claude Code / capability unavailable — nothing to do
  if (process.env.AZURE_DEVOPS_EXT_PAT) return // the env var always wins; already set

  let input = {}
  try {
    input = JSON.parse(await read())
  } catch {
    /* no stdin / not JSON — fall back to process.cwd() */
  }
  const cwd = input.cwd || process.cwd()

  // Repo layer wins over the user layer, mirroring the core loader's merge.
  const pat = readPat(path.join(cwd, ".agentic-loop.json")) ?? readPat(userConfigPath())
  if (!pat) return

  try {
    fs.appendFileSync(envFile, `export AZURE_DEVOPS_EXT_PAT=${shellSingleQuote(pat)}\n`)
  } catch {
    /* best-effort — never block the session on this */
  }
}

main()
