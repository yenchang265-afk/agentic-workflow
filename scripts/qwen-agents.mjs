#!/usr/bin/env node
/**
 * Install the Qwen stage agents, baking each one's configured model into its
 * frontmatter.
 *
 * Qwen's `agent` tool has no per-call `model` argument (unlike OpenCode's
 * session.command and Claude's Task tool), so `workflows.<kind>.stageModels`
 * and `agentModels` cannot be threaded at spawn time. Qwen subagents DO take a
 * top-level `model:` field, so the binding moves from runtime to install time:
 * these files are COPIES, not symlinks, with `model:` injected.
 *
 * The cost of that trade, and the reason it is documented everywhere it
 * surfaces: a change to stageModels/agentModels takes effect on the next
 * `./install.sh qwen`, not the next claim.
 *
 * Dependency-free on purpose (fs + path only): the installer may run this
 * before, or without, a built @agentic-workflow/core.
 *
 * Usage: node scripts/qwen-agents.mjs <configDir> [repoDir]
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * Field-level deep merge of raw config layers (override wins): plain objects
 * merge per key recursively; arrays, scalars, and null replace wholesale —
 * duplicated from core's `mergeConfigLayers` rather than imported, same
 * dependency-free reason as `userConfigPath` below. A plain top-level spread
 * here let a project config's `workflows.<anyKind>` silently REPLACE (not
 * merge with) a user config's `workflows.<otherKind>.stageModels`/
 * `agentModels`, so this installer's model resolution diverged from what the
 * real runtime config loader (which DOES deep-merge) would have produced.
 */
export const mergeConfigLayers = (base, override) => {
  if (override === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfigLayers(base[key], value) : value
  }
  return out
}

/**
 * The user-scope config path, resolved the same way core does — duplicated
 * rather than imported for the dependency-free reason above, exactly as
 * hooks/verb-slice.mjs already duplicates it.
 */
export const userConfigPath = (env = process.env, home = os.homedir()) => {
  if (env.AGENTIC_WORKFLOW_USER_CONFIG !== undefined) return env.AGENTIC_WORKFLOW_USER_CONFIG || null
  const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config")
  const primary = path.join(xdg, "agentic-workflow", "agentic-workflow.json")
  if (fs.existsSync(primary)) return primary
  const legacy = path.join(home, ".agentic-workflow.json")
  return fs.existsSync(legacy) ? legacy : null
}

/**
 * Strip the `provider/` prefix — Qwen takes bare model ids.
 *
 * Must stay semantically identical to core's `bareModel` (config-layers.ts),
 * which this file deliberately does not import (see the dependency-free note in
 * the header). It takes the LAST segment, not "everything after the first":
 * those differ for a multi-segment id like `openrouter/anthropic/claude-sonnet-4-5`,
 * which used to bake here as `anthropic/claude-sonnet-4-5` while every other
 * host resolved it to `claude-sonnet-4-5`. `qwen-settings.test.mjs` pins the two
 * implementations to the same answer so the copies cannot drift again.
 */
export const bareModel = (model) =>
  typeof model === "string" && model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model

/**
 * Resolve agent -> model from a merged config plus the workflow manifests.
 *
 * `agentModels.<agent>` is the explicit per-agent knob and wins outright.
 * Otherwise an agent inherits the model configured for the STAGE it backs, via
 * each kind's manifest. An agent backing two kinds' stages with different
 * models is a genuine ambiguity, so it is reported AND left unset rather than
 * silently resolved — `workflow-verify` is shared by four kinds today. An
 * explicit `agentModels.<agent>` still resolves it, which is the way out the
 * warning points at.
 *
 * Kept in step with `resolveAgentModels` in packages/core/src/config-layers.ts
 * — the same rule, and the tests pin both to the same answers.
 */
export const resolveAgentModels = (config, manifests) => {
  const models = {}
  const conflicts = []
  // Agents whose stage models disagreed — left UNSET, exactly as the docstring
  // above and main()'s warning both say. `continue`-ing on the clash instead
  // kept whichever kind was iterated first (manifests are read in directory
  // order), so the operator read "leaving the model unset for that agent"
  // while an arbitrary kind's model was baked into the installed agent file.
  // Tracked separately from `models` so a LATER binding cannot resurrect it.
  const conflicted = new Set()
  for (const { kind, stages } of manifests) {
    const stageModels = config?.workflows?.[kind]?.stageModels ?? {}
    for (const stage of stages) {
      const model = stageModels[stage.name]
      if (!model || !stage.agent) continue
      const bare = bareModel(model)
      if (conflicted.has(stage.agent)) {
        conflicts.push(`${stage.agent}: unset (conflicting stage models) vs "${bare}" (${kind}.${stage.name})`)
        continue
      }
      if (models[stage.agent] && models[stage.agent] !== bare) {
        conflicts.push(`${stage.agent}: "${models[stage.agent]}" vs "${bare}" (${kind}.${stage.name})`)
        conflicted.add(stage.agent)
        delete models[stage.agent]
        continue
      }
      models[stage.agent] = bare
    }
  }
  for (const [agent, model] of Object.entries(config?.agentModels ?? {})) {
    if (typeof model === "string" && model) models[agent] = bareModel(model)
  }
  return { models, conflicts }
}

/** Read every kind's stage list straight from the manifests. */
const readManifests = () => {
  const dir = path.join(ROOT, "packages", "core", "workflows")
  const out = []
  for (const kind of fs.readdirSync(dir).sort()) {
    const manifest = readJson(path.join(dir, kind, "workflow.json"))
    if (manifest?.stages) out.push({ kind, stages: manifest.stages })
  }
  return out
}

/**
 * Insert or replace the frontmatter `model:` line. Returns the source unchanged
 * when no model applies, so an unconfigured install ships the generated file
 * byte-for-byte and `model` stays absent (Qwen reads that as `inherit`).
 */
export const withModel = (src, model) => {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(src)
  if (!fm) throw new Error("agent file has no frontmatter block")
  let body = fm[1].replace(/^model:.*$/m, "").replace(/\n{2,}/g, "\n").trim()
  if (model) body = `${body}\nmodel: ${model}`
  return `---\n${body}\n---\n${src.slice(fm[0].length)}`
}

const main = () => {
  const [configDir, repoDir] = process.argv.slice(2)
  if (!configDir) {
    console.error("usage: qwen-agents.mjs <configDir> [repoDir]")
    process.exit(1)
  }
  const cwd = repoDir || process.cwd()
  const userPath = userConfigPath()
  const config = mergeConfigLayers(userPath ? (readJson(userPath) ?? {}) : {}, readJson(path.join(cwd, ".agentic-workflow.json")) ?? {})
  const { models, conflicts } = resolveAgentModels(config, readManifests())
  for (const c of conflicts) {
    console.warn(`qwen-agents: WARNING conflicting stageModels for ${c} — leaving the model unset for that agent`)
  }

  const srcDir = path.join(ROOT, "plugins", "qwen", "agents")
  const outDir = path.join(configDir, "agents")
  fs.mkdirSync(outDir, { recursive: true })
  let wrote = 0
  let baked = 0
  for (const file of fs.readdirSync(srcDir).sort()) {
    if (!file.endsWith(".md")) continue
    const agent = file.slice(0, -3)
    const model = models[agent]
    fs.writeFileSync(path.join(outDir, file), withModel(fs.readFileSync(path.join(srcDir, file), "utf8"), model))
    wrote++
    if (model) baked++
  }
  console.log(`qwen-agents: wrote ${wrote} agents to ${outDir} (${baked} with a configured model)`)
  if (baked) console.log("qwen-agents: re-run the installer after changing stageModels/agentModels — the binding is static")
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
