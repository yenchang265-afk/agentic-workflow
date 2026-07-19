import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type {
  AgentPreset,
  AssetAgent,
  AssetCommand,
  AssetSkill,
  AssetsResponse,
  GenPromptsResponse,
  ScaffoldAgentRequest,
  ScaffoldCommandRequest,
  ScaffoldResponse,
  ScaffoldSkillRequest,
} from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { badRequest, json, ok, type JsonResponse, type ParsedRequest } from "../http.js"
import { SLUG_RE } from "./kinds.js"

/**
 * The creator's asset surface: an inventory of the repo's agent personas,
 * OpenCode command wrappers, and skills (feeding the stage form's pickers),
 * plus one-shot scaffolds for each and a server-side `gen:prompts` run.
 *
 * Scaffolds write idiomatic stubs and never overwrite — the hub gets an asset
 * started; deep editing stays in the user's editor. Parsing is line-based on
 * purpose: the hub carries no yaml dependency, and these files' frontmatter is
 * single-line `key: value` by convention.
 */

// --- inventory ---------------------------------------------------------------

/** The frontmatter block of a `---` fenced markdown file, or "" when absent. */
const frontmatter = (src: string): string => /^---\n([\s\S]*?)\n---/.exec(src)?.[1] ?? ""

/** First top-level `key: value` line of a yaml-ish source; undefined when absent. */
const fmField = (src: string, key: string): string | undefined => {
  const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(src)
  if (!m) return undefined
  const value = (m[1] ?? "").trim().replace(/^["']|["']$/g, "")
  // One-line clamp: these render as picker hints, not documents.
  return value.split("\n")[0]
}

const readIfExists = (file: string): string | undefined =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined

const listDirs = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

export const getAssets = async (deps: HubDeps): Promise<JsonResponse> => {
  const repo = deps.directory

  const agents: AssetAgent[] = listDirs(path.join(repo, "prompts", "agents")).flatMap((name) => {
    try {
      const src =
        readIfExists(path.join(repo, "prompts", "agents", name, "claude.yaml")) ??
        readIfExists(path.join(repo, "prompts", "agents", name, "opencode.yaml")) ??
        ""
      const description = fmField(src, "description")
      return [{ name, ...(description ? { description } : {}) }]
    } catch {
      return [{ name }]
    }
  })

  const commandsDir = path.join(repo, "plugins", "opencode", "commands")
  const commands: AssetCommand[] = (fs.existsSync(commandsDir) ? fs.readdirSync(commandsDir).sort() : [])
    .filter((f) => f.endsWith(".md"))
    .flatMap((f) => {
      const name = f.slice(0, -3)
      try {
        const fm = frontmatter(fs.readFileSync(path.join(commandsDir, f), "utf8"))
        const description = fmField(fm, "description")
        const agent = fmField(fm, "agent")
        return [{ name, ...(agent ? { agent } : {}), ...(description ? { description } : {}) }]
      } catch {
        return [{ name }]
      }
    })

  const skills: AssetSkill[] = listDirs(path.join(repo, "skills")).flatMap((name) => {
    const file = path.join(repo, "skills", name, "SKILL.md")
    if (!fs.existsSync(file)) return []
    try {
      const description = fmField(frontmatter(fs.readFileSync(file, "utf8")), "description")
      return [{ name, ...(description ? { description } : {}) }]
    } catch {
      return [{ name }]
    }
  })

  const response: AssetsResponse = { agents, commands, skills }
  return ok(response)
}

// --- scaffolds ---------------------------------------------------------------

/**
 * Resolve repo-root/<...segments> with the same prefix-confinement rail saveKind
 * uses. SLUG_RE already excludes `/` and `.` so this is belt-and-braces.
 */
export const containedIn = (root: string, ...segments: string[]): string | null => {
  const base = path.resolve(root)
  const abs = path.resolve(base, ...segments)
  return abs.startsWith(base + path.sep) ? abs : null
}

/** A yaml scalar on one line: plain when safe, JSON-quoted when yaml-active. */
export const yamlValue = (s: string): string => (/[:#'"\n\\]|^\s|\s$/.test(s) ? JSON.stringify(s) : s)

/** Descriptions render on one frontmatter/yaml line; collapse any pasted newlines. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim()

/** "my-skill" → "My Skill", for scaffolded headings. */
export const titleCase = (slug: string): string =>
  slug
    .split("-")
    .map((w) => (w ? w[0]?.toUpperCase() + w.slice(1) : w))
    .join(" ")

const skillProse = (skills: readonly string[]): string => {
  if (skills.length === 0) return ""
  const names = skills.map((s) => `\`${s}\``)
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
  const noun = names.length === 1 ? "skill" : "skills"
  return `Invoke the ${list} ${noun} for this stage's workflow; follow them exactly.\n\n`
}

const agentBody = (name: string, description: string, skills: readonly string[]): string =>
  [
    "{{#host opencode}}",
    `You are the **${name}** subagent.`,
    "{{/host}}",
    "{{#host claude}}",
    `You are the **${name}** subagent.`,
    "{{/host}}",
    "",
    description,
    "",
    `${skillProse(skills)}## Your input`,
    "",
    "TODO: describe what this stage receives (the goal, prior artifacts.<stage>).",
    "",
    "## Your job",
    "",
    "TODO: describe the work, step by step.",
    "",
    "## Output",
    "",
    "TODO: describe what this stage returns (work stages just finish; check",
    "stages MUST record a PASS/FAIL verdict via the loop_verdict tool).",
    "",
  ].join("\n")

const OPENCODE_PRESET: Record<AgentPreset, (description: string) => string> = {
  builder: (description) =>
    ["description: " + yamlValue(description), "mode: subagent", "permission:", "  edit: allow", "  bash: allow", ""].join("\n"),
  checker: (description) =>
    [
      "description: " + yamlValue(description),
      "mode: subagent",
      "permission:",
      "  edit: deny",
      "  webfetch: deny",
      "  bash:",
      '    "*": deny',
      "    # {{allowlist}} — globs generated from the stage's bashAllowlist in loops/*/loop.json; edit the manifest, not here",
      "",
    ].join("\n"),
}

const CLAUDE_TOOLS: Record<AgentPreset, string> = {
  builder: "Read, Edit, Write, Bash, Grep, Glob",
  checker: "Read, Grep, Glob, Bash, mcp__agentic-loop__loop_verdict, mcp__plugin_agentic-loop_agentic-loop__loop_verdict",
}

const claudeYaml = (name: string, description: string, preset: AgentPreset): string =>
  [`name: ${name}`, "description: " + yamlValue(description), `tools: ${CLAUDE_TOOLS[preset]}`, ""].join("\n")

const CHECKER_NOTE =
  "gen:prompts will fail for this agent until a saved loop kind gives its stage a bashAllowlist — set it in the stage form, save, then run gen:prompts"

export const scaffoldAgent = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const body = req.body as Partial<ScaffoldAgentRequest> | undefined
  const name = body?.name ?? ""
  const description = oneLine(body?.description ?? "")
  const preset = body?.preset
  const skills = body?.skills ?? []
  if (!SLUG_RE.test(name)) return badRequest(`agent name must match ${SLUG_RE}`)
  if (!description) return badRequest("description is required")
  if (preset !== "builder" && preset !== "checker") return badRequest(`preset must be "builder" or "checker"`)
  for (const skill of skills) {
    if (!SLUG_RE.test(skill) || !fs.existsSync(path.join(deps.directory, "skills", skill, "SKILL.md")))
      return badRequest(`unknown skill "${skill}" — pick skills that exist in skills/`)
  }

  const dir = containedIn(deps.directory, "prompts", "agents", name)
  if (!dir) return badRequest("bad agent path")
  if (fs.existsSync(dir)) return json(409, { error: `agent persona "${name}" already exists at prompts/agents/${name}/` })

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "body.md"), agentBody(name, description, skills))
  fs.writeFileSync(path.join(dir, "opencode.yaml"), OPENCODE_PRESET[preset](description))
  fs.writeFileSync(path.join(dir, "claude.yaml"), claudeYaml(name, description, preset))

  const response: ScaffoldResponse = {
    written: [`prompts/agents/${name}/body.md`, `prompts/agents/${name}/opencode.yaml`, `prompts/agents/${name}/claude.yaml`],
    ...(preset === "checker" ? { notes: [CHECKER_NOTE] } : {}),
  }
  return ok(response)
}

export const scaffoldCommand = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const body = req.body as Partial<ScaffoldCommandRequest> | undefined
  const name = body?.name ?? ""
  const description = oneLine(body?.description ?? "")
  const agent = body?.agent ?? ""
  if (!SLUG_RE.test(name)) return badRequest(`command name must match ${SLUG_RE}`)
  if (!description) return badRequest("description is required")
  // The agent need not exist yet — gen:prompts later normalizes `agent:` from
  // the manifests — but it does become frontmatter, so it must be a slug.
  if (!SLUG_RE.test(agent)) return badRequest(`agent must match ${SLUG_RE}`)

  const file = containedIn(deps.directory, "plugins", "opencode", "commands", `${name}.md`)
  if (!file) return badRequest("bad command path")
  if (fs.existsSync(file)) return json(409, { error: `command "${name}" already exists at plugins/opencode/commands/${name}.md` })

  const content = [
    "---",
    "description: " + yamlValue(description),
    `agent: ${agent}`,
    "subtask: true",
    "---",
    "",
    `Run the **${name.toUpperCase()}** stage on:`,
    "",
    "**$ARGUMENTS**",
    "",
    `Delegated to the \`${agent}\` subagent. TODO: describe what this stage does`,
    "with its input and how it reports its result.",
    "",
  ].join("\n")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)

  const response: ScaffoldResponse = { written: [`plugins/opencode/commands/${name}.md`] }
  return ok(response)
}

export const scaffoldSkill = async (deps: HubDeps, req: ParsedRequest): Promise<JsonResponse> => {
  const body = req.body as Partial<ScaffoldSkillRequest> | undefined
  const name = body?.name ?? ""
  const description = oneLine(body?.description ?? "")
  if (!SLUG_RE.test(name)) return badRequest(`skill name must match ${SLUG_RE}`)
  if (!description) return badRequest("description is required")

  const dir = containedIn(deps.directory, "skills", name)
  if (!dir) return badRequest("bad skill path")
  if (fs.existsSync(dir)) return json(409, { error: `skill "${name}" already exists at skills/${name}/` })

  const content = [
    "---",
    `name: ${name}`,
    "description: " + yamlValue(description),
    "---",
    "",
    `# ${titleCase(name)}`,
    "",
    "TODO: describe when to invoke this skill and the workflow it prescribes.",
    "",
  ].join("\n")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), content)

  const response: ScaffoldResponse = { written: [`skills/${name}/SKILL.md`] }
  return ok(response)
}

// --- gen:prompts -------------------------------------------------------------

/**
 * Run the repo's persona generator server-side. Failure is a domain outcome the
 * UI renders (`ok: false` + output), not a 500 — same philosophy as gate
 * actions. `process.execPath` avoids PATH assumptions.
 */
export const postGenPrompts = async (deps: HubDeps): Promise<JsonResponse> => {
  const script = path.join(deps.directory, "scripts", "gen-prompts.mjs")
  if (!fs.existsSync(script)) return badRequest("this repo has no scripts/gen-prompts.mjs")

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script],
      { cwd: deps.directory, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = [stdout, stderr, err && !stderr.includes(err.message) ? err.message : ""]
          .filter(Boolean)
          .join("\n")
          .trim()
        const response: GenPromptsResponse = { ok: !err, output }
        resolve(ok(response))
      },
    )
  })
}
