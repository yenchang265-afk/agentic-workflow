#!/usr/bin/env node
/**
 * Merge (or remove) the agentic-workflow entries in a Qwen Code settings.json.
 *
 * Qwen extensions cannot carry hooks — `qwen-extension.json` has no `hooks`
 * field — and the guard hooks ARE the safety substrate, so an extension-only
 * install would silently ship without gates, the check-stage bash allowlist, the
 * worktree pin, and the verdict guard. The installer therefore has to write into
 * the user's settings.json, which means writing into a file we do not own.
 *
 * Two rules follow from that, and both are load-bearing:
 *
 *  1. **Merge, never rewrite.** The file is parsed, our entries are replaced,
 *     and everything else is written back untouched — including keys this
 *     script has never heard of. Formatting is normalized to 2-space JSON,
 *     which is what Qwen itself writes.
 *  2. **Identify our entries by name, not by position.** Our MCP server is the
 *     `agentic-workflow` key; our hooks are the ones whose `name` starts with
 *     `agentic-workflow`. Uninstall removes exactly those, so a hook the user
 *     added by hand to the same event survives.
 *
 * Usage:
 *   node scripts/qwen-settings.mjs merge  <configDir> <pluginRoot> <serverJs> [repoDir]
 *   node scripts/qwen-settings.mjs remove <configDir>
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Everything this installer owns is named with this prefix. */
export const OWNED_PREFIX = "agentic-workflow"
export const SERVER_KEY = "agentic-workflow"

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/**
 * Strip every entry this installer owns from a settings object. Pure, and the
 * first half of `merge` too — which is what makes a re-install idempotent
 * instead of appending a second copy of every hook.
 */
export const stripOwned = (settings) => {
  const next = { ...settings }
  if (next.mcpServers && typeof next.mcpServers === "object") {
    const servers = { ...next.mcpServers }
    delete servers[SERVER_KEY]
    if (Object.keys(servers).length) next.mcpServers = servers
    else delete next.mcpServers
  }
  if (next.hooks && typeof next.hooks === "object") {
    const hooks = {}
    for (const [event, groups] of Object.entries(next.hooks)) {
      if (!Array.isArray(groups)) {
        hooks[event] = groups
        continue
      }
      const kept = groups
        .map((group) => {
          if (!group || !Array.isArray(group.hooks)) return group
          const inner = group.hooks.filter((h) => !String(h?.name ?? "").startsWith(OWNED_PREFIX))
          return inner.length === group.hooks.length ? group : { ...group, hooks: inner }
        })
        // A group we emptied was ours alone; one the user also had entries in
        // keeps its remaining hooks.
        .filter((group) => !group || !Array.isArray(group.hooks) || group.hooks.length > 0)
      if (kept.length) hooks[event] = kept
    }
    if (Object.keys(hooks).length) next.hooks = hooks
    else delete next.hooks
  }
  return next
}

/** Merge our MCP server + hooks into a settings object. Pure. */
export const mergeOwned = (settings, { serverJs, fragment }) => {
  const next = stripOwned(settings)
  next.mcpServers = {
    ...(next.mcpServers ?? {}),
    [SERVER_KEY]: {
      command: "node",
      args: [serverJs],
      // The host switch the MCP server and every guard hook read. Without it the
      // server would name subagents with Claude's plugin namespace and write
      // Claude's stage marker.
      env: { AGENTIC_WORKFLOW_HOST: "qwen" },
    },
  }
  const hooks = { ...(next.hooks ?? {}) }
  for (const [event, groups] of Object.entries(fragment.hooks ?? {})) {
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), ...groups]
  }
  next.hooks = hooks
  return next
}

/** Substitute the plugin root into the fragment's command strings. */
export const resolveFragment = (fragment, pluginRoot) => {
  const raw = JSON.stringify(fragment).replaceAll("${AGENTIC_WORKFLOW_PLUGIN_ROOT}", pluginRoot)
  const resolved = JSON.parse(raw)
  delete resolved._comment
  // The hooks run under bare `node` from this path; tell them where the plugin
  // lives so gate-command can find verbs/ and the MCP server's dist.
  for (const groups of Object.values(resolved.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        hook.env = { ...(hook.env ?? {}), AGENTIC_WORKFLOW_PLUGIN_ROOT: pluginRoot }
      }
    }
  }
  return resolved
}

const write = (file, settings) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
}

const main = () => {
  const [verb, configDir, pluginRoot, serverJs] = process.argv.slice(2)
  if (!verb || !configDir) {
    console.error("usage: qwen-settings.mjs merge <configDir> <pluginRoot> <serverJs> | remove <configDir>")
    process.exit(1)
  }
  const file = path.join(configDir, "settings.json")
  const existing = readJson(file) ?? {}

  if (verb === "remove") {
    if (!fs.existsSync(file)) {
      console.log(`qwen-settings: ${file} not present — nothing to remove`)
      return
    }
    write(file, stripOwned(existing))
    console.log(`qwen-settings: removed agentic-workflow entries from ${file}`)
    return
  }

  if (verb !== "merge") {
    console.error(`qwen-settings: unknown verb "${verb}"`)
    process.exit(1)
  }
  if (!pluginRoot || !serverJs) {
    console.error("qwen-settings: merge needs <pluginRoot> and <serverJs>")
    process.exit(1)
  }
  const fragmentPath = path.join(ROOT, "plugins", "qwen", "hooks", "hooks.json")
  const fragment = readJson(fragmentPath)
  if (!fragment) {
    console.error(`qwen-settings: cannot read ${fragmentPath}`)
    process.exit(1)
  }
  write(file, mergeOwned(existing, { serverJs, fragment: resolveFragment(fragment, pluginRoot) }))
  console.log(`qwen-settings: merged agentic-workflow MCP server + hooks into ${file}`)
}

// Importable for tests; only the CLI path runs main().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
