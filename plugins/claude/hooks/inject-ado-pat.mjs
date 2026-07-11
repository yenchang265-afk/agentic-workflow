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
 *  - a no-op when there is no `ado.pat` in `.agentic-loop.json`.
 *
 * The secret goes only into $CLAUDE_ENV_FILE (session-scoped, managed by Claude
 * Code) — never into a command string or tool-call log.
 */
import fs from "node:fs"
import path from "node:path"

const read = () =>
  new Promise((resolve) => {
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => resolve(s))
  })

/** Single-quote for a POSIX shell (the env file is sourced): wrap in '…', escaping embedded quotes. */
const shellSingleQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`

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

  let pat
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, ".agentic-loop.json"), "utf8"))
    if (cfg && cfg.ado && typeof cfg.ado.pat === "string" && cfg.ado.pat) pat = cfg.ado.pat
  } catch {
    /* no config / unreadable — nothing to inject */
  }
  if (!pat) return

  try {
    fs.appendFileSync(envFile, `export AZURE_DEVOPS_EXT_PAT=${shellSingleQuote(pat)}\n`)
  } catch {
    /* best-effort — never block the session on this */
  }
}

main()
