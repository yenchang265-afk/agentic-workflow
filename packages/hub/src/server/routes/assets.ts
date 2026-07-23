import { execFile } from "node:child_process"
import fsp from "node:fs/promises"
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
import { withLock } from "../lock.js"
import { containedIn } from "../paths.js"
import { exists, SLUG_RE } from "./kinds.js"

// Re-exported for existing importers/tests; the implementation lives in paths.ts.
export { containedIn }

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

const readIfExists = (file: string): Promise<string | undefined> =>
  fsp.readFile(file, "utf8").then(
    (s) => s,
    () => undefined,
  )

const listDirs = async (dir: string): Promise<string[]> => {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

export const getAssets = async (deps: HubDeps): Promise<JsonResponse> => {
  const repo = deps.directory

  const agents: AssetAgent[] = await Promise.all(
    (await listDirs(path.join(repo, "prompts", "agents"))).map(async (name) => {
      const src =
        (await readIfExists(path.join(repo, "prompts", "agents", name, "claude.yaml"))) ??
        (await readIfExists(path.join(repo, "prompts", "agents", name, "opencode.yaml"))) ??
        ""
      const description = fmField(src, "description")
      return { name, ...(description ? { description } : {}) }
    }),
  )

  const commandsDir = path.join(repo, "plugins", "opencode", "commands")
  const commandFiles = await fsp.readdir(commandsDir).then(
    (fs) => fs.sort(),
    () => [] as string[],
  )
  const commands: AssetCommand[] = await Promise.all(
    commandFiles
      .filter((f) => f.endsWith(".md"))
      .map(async (f) => {
        const name = f.slice(0, -3)
        const fm = frontmatter((await readIfExists(path.join(commandsDir, f))) ?? "")
        const description = fmField(fm, "description")
        const agent = fmField(fm, "agent")
        return { name, ...(agent ? { agent } : {}), ...(description ? { description } : {}) }
      }),
  )

  const skills: AssetSkill[] = (
    await Promise.all(
      (await listDirs(path.join(repo, "skills"))).map(async (name) => {
        const src = await readIfExists(path.join(repo, "skills", name, "SKILL.md"))
        if (src === undefined) return []
        const description = fmField(frontmatter(src), "description")
        return [{ name, ...(description ? { description } : {}) }]
      }),
    )
  ).flat()

  const response: AssetsResponse = { agents, commands, skills }
  return ok(response)
}

// --- scaffolds ---------------------------------------------------------------

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
    "stages MUST record a PASS/FAIL verdict via the workflow_verdict tool).",
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
      "    # {{allowlist}} — globs generated from the stage's bashAllowlist in workflows/*/workflow.json; edit the manifest, not here",
      "",
    ].join("\n"),
}

const CLAUDE_TOOLS: Record<AgentPreset, string> = {
  builder: "Read, Edit, Write, Bash, Grep, Glob",
  checker: "Read, Grep, Glob, Bash, mcp__agentic-workflow__workflow_verdict, mcp__plugin_agentic-workflow_agentic-workflow__workflow_verdict",
}

const claudeYaml = (name: string, description: string, preset: AgentPreset): string =>
  [`name: ${name}`, "description: " + yamlValue(description), `tools: ${CLAUDE_TOOLS[preset]}`, ""].join("\n")

const CHECKER_NOTE =
  "gen:prompts will fail for this agent until a saved workflow kind gives its stage a bashAllowlist — set it in the stage form, save, then run gen:prompts"

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
    if (!SLUG_RE.test(skill) || !(await exists(path.join(deps.directory, "skills", skill, "SKILL.md"))))
      return badRequest(`unknown skill "${skill}" — pick skills that exist in skills/`)
  }

  const dir = containedIn(deps.directory, "prompts", "agents", name)
  if (!dir) return badRequest("bad agent path")

  // Exists-check + multi-file write, serialized per target (same shape as saveKind).
  return withLock(`scaffold:${dir}`, async () => {
    if (await exists(dir)) return json(409, { error: `agent persona "${name}" already exists at prompts/agents/${name}/` })

    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, "body.md"), agentBody(name, description, skills))
    await fsp.writeFile(path.join(dir, "opencode.yaml"), OPENCODE_PRESET[preset](description))
    await fsp.writeFile(path.join(dir, "claude.yaml"), claudeYaml(name, description, preset))

    const response: ScaffoldResponse = {
      written: [`prompts/agents/${name}/body.md`, `prompts/agents/${name}/opencode.yaml`, `prompts/agents/${name}/claude.yaml`],
      ...(preset === "checker" ? { notes: [CHECKER_NOTE] } : {}),
    }
    return ok(response)
  })
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
  await fsp.mkdir(path.dirname(file), { recursive: true })
  // `wx` refuses an existing file atomically — no exists-check race to close.
  try {
    await fsp.writeFile(file, content, { flag: "wx" })
  } catch {
    return json(409, { error: `command "${name}" already exists at plugins/opencode/commands/${name}.md` })
  }

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
  return withLock(`scaffold:${dir}`, async () => {
    if (await exists(dir)) return json(409, { error: `skill "${name}" already exists at skills/${name}/` })
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, "SKILL.md"), content)

    const response: ScaffoldResponse = { written: [`skills/${name}/SKILL.md`] }
    return ok(response)
  })
}

// --- gen:prompts -------------------------------------------------------------

/**
 * Run the repo's persona generator server-side. Failure is a domain outcome the
 * UI renders (`ok: false` + output), not a 500 — same philosophy as gate
 * actions. `process.execPath` avoids PATH assumptions.
 */
export const postGenPrompts = async (deps: HubDeps): Promise<JsonResponse> => {
  const script = path.join(deps.directory, "scripts", "gen-prompts.mjs")
  if (!(await exists(script))) return badRequest("this repo has no scripts/gen-prompts.mjs")
  // This executes repo-controlled code with the hub's privileges off a
  // header-only-auth POST. Two rails before running it: the resolved script
  // must live INSIDE the monitored repo (no symlink pointing elsewhere), and
  // it must be a regular file.
  try {
    const real = await fsp.realpath(script)
    const root = await fsp.realpath(deps.directory)
    if (real !== script && !real.startsWith(root + path.sep)) {
      return badRequest("scripts/gen-prompts.mjs resolves outside the repo — refusing to run it")
    }
    if (!(await fsp.stat(real)).isFile()) return badRequest("scripts/gen-prompts.mjs is not a regular file")
  } catch {
    return badRequest("scripts/gen-prompts.mjs could not be resolved")
  }

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
