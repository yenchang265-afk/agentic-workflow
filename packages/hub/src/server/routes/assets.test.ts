import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG } from "@agentic-workflow/core/config"
import type { AssetsResponse, GenPromptsResponse, ScaffoldResponse } from "../../shared/api.js"
import type { HubDeps } from "../deps.js"
import { fsClient, sh } from "../fsclient.js"
import { containedIn, getAssets, postGenPrompts, scaffoldAgent, scaffoldCommand, scaffoldSkill, yamlValue } from "./assets.js"

const depsFor = (directory: string): HubDeps => ({
  directory,
  tasksDir: "docs/tasks",
  boards: [],
  config: DEFAULT_CONFIG,
  workflowsDir: "/unused-workflows",
  projectsDir: "/nonexistent-projects",
  opencodeDbPath: "/nonexistent.db",
  client: fsClient,
  sh,
  log: () => {},
})

const req = (body: unknown) => ({ params: {}, query: new URLSearchParams(), body })

const tempRepo = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "hub-assets-"))

const seedRepo = (repo: string): void => {
  const agent = path.join(repo, "prompts", "agents", "workflow-sample")
  fs.mkdirSync(agent, { recursive: true })
  fs.writeFileSync(path.join(agent, "claude.yaml"), "name: workflow-sample\ndescription: Sample agent persona.\ntools: Read\n")
  fs.writeFileSync(path.join(agent, "opencode.yaml"), "description: fallback\nmode: subagent\n")
  const commands = path.join(repo, "plugins", "opencode", "commands")
  fs.mkdirSync(commands, { recursive: true })
  fs.writeFileSync(path.join(commands, "sample.md"), "---\ndescription: Sample command.\nagent: workflow-sample\nsubtask: true\n---\n\nBody.\n")
  const skill = path.join(repo, "skills", "sample-skill")
  fs.mkdirSync(skill, { recursive: true })
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: sample-skill\ndescription: A sample skill.\n---\n\n# Sample Skill\n")
}

test("getAssets inventories agents, commands, and skills with descriptions", async () => {
  const repo = tempRepo()
  seedRepo(repo)
  const res = await getAssets(depsFor(repo))
  assert.equal(res.status, 200)
  const body = res.body as AssetsResponse
  assert.deepEqual(body.agents, [{ name: "workflow-sample", description: "Sample agent persona." }])
  assert.deepEqual(body.commands, [{ name: "sample", agent: "workflow-sample", description: "Sample command." }])
  assert.deepEqual(body.skills, [{ name: "sample-skill", description: "A sample skill." }])
})

test("getAssets returns empty lists for a repo without asset dirs", async () => {
  const res = await getAssets(depsFor(tempRepo()))
  assert.deepEqual(res.body, { agents: [], commands: [], skills: [] })
})

test("getAssets tolerates malformed entries without failing the inventory", async () => {
  const repo = tempRepo()
  seedRepo(repo)
  // an agent dir with no yaml at all, and a skill dir without SKILL.md
  fs.mkdirSync(path.join(repo, "prompts", "agents", "broken-agent"), { recursive: true })
  fs.mkdirSync(path.join(repo, "skills", "empty-skill"), { recursive: true })
  const body = (await getAssets(depsFor(repo))).body as AssetsResponse
  assert.deepEqual(
    body.agents.map((a) => a.name),
    ["broken-agent", "workflow-sample"],
  )
  assert.equal(body.agents.find((a) => a.name === "broken-agent")?.description, undefined)
  assert.deepEqual(
    body.skills.map((s) => s.name),
    ["sample-skill"],
  )
})

test("scaffoldAgent writes body.md + both yamls with host blocks and skill prose", async () => {
  const repo = tempRepo()
  seedRepo(repo)
  const res = await scaffoldAgent(
    depsFor(repo),
    req({ name: "workflow-newbie", description: "Does new things.", preset: "builder", skills: ["sample-skill"] }),
  )
  assert.equal(res.status, 200)
  const body = res.body as ScaffoldResponse
  assert.equal(body.written.length, 3)
  assert.equal(body.notes, undefined)

  const dir = path.join(repo, "prompts", "agents", "workflow-newbie")
  const bodyMd = fs.readFileSync(path.join(dir, "body.md"), "utf8")
  assert.match(bodyMd, /\{\{#host opencode\}\}/)
  assert.match(bodyMd, /\{\{#host claude\}\}/)
  assert.match(bodyMd, /Invoke the `sample-skill` skill for this stage's workflow/)
  assert.match(bodyMd, /loop_verdict/)
  const opencode = fs.readFileSync(path.join(dir, "opencode.yaml"), "utf8")
  assert.match(opencode, /edit: allow/)
  assert.match(opencode, /bash: allow/)
  const claude = fs.readFileSync(path.join(dir, "claude.yaml"), "utf8")
  assert.match(claude, /name: workflow-newbie/)
  assert.match(claude, /tools: Read, Edit, Write, Bash, Grep, Glob/)
})

test("scaffoldAgent checker preset carries the allowlist marker, verdict tools, and the ordering note", async () => {
  const repo = tempRepo()
  const res = await scaffoldAgent(depsFor(repo), req({ name: "workflow-checker", description: "Checks things.", preset: "checker" }))
  assert.equal(res.status, 200)
  const body = res.body as ScaffoldResponse
  assert.equal(body.notes?.length, 1)
  assert.match(body.notes?.[0] ?? "", /bashAllowlist/)

  const dir = path.join(repo, "prompts", "agents", "workflow-checker")
  const opencode = fs.readFileSync(path.join(dir, "opencode.yaml"), "utf8")
  assert.match(opencode, /"\*": deny/)
  assert.match(opencode, /\{\{allowlist\}\}/)
  assert.match(fs.readFileSync(path.join(dir, "claude.yaml"), "utf8"), /loop_verdict/)
})

test("scaffold handlers reject bad slugs, duplicates, and unknown skills", async () => {
  const repo = tempRepo()
  seedRepo(repo)
  const deps = depsFor(repo)

  assert.equal((await scaffoldAgent(deps, req({ name: "Bad Name", description: "x", preset: "builder" }))).status, 400)
  assert.equal((await scaffoldAgent(deps, req({ name: "workflow-x", description: "", preset: "builder" }))).status, 400)
  assert.equal((await scaffoldAgent(deps, req({ name: "workflow-x", description: "x", preset: "root" }))).status, 400)
  assert.equal(
    (await scaffoldAgent(deps, req({ name: "workflow-x", description: "x", preset: "builder", skills: ["nope"] }))).status,
    400,
  )
  assert.equal((await scaffoldAgent(deps, req({ name: "workflow-sample", description: "x", preset: "builder" }))).status, 409)

  assert.equal((await scaffoldCommand(deps, req({ name: "sample", description: "x", agent: "workflow-sample" }))).status, 409)
  assert.equal((await scaffoldCommand(deps, req({ name: "new-cmd", description: "x", agent: "Bad Agent" }))).status, 400)

  assert.equal((await scaffoldSkill(deps, req({ name: "sample-skill", description: "x" }))).status, 409)
  assert.equal((await scaffoldSkill(deps, req({ name: "UPPER", description: "x" }))).status, 400)
})

test("scaffoldCommand and scaffoldSkill write idiomatic stubs", async () => {
  const repo = tempRepo()
  const deps = depsFor(repo)

  const cmd = await scaffoldCommand(deps, req({ name: "triage", description: "Triage: the incoming work.", agent: "workflow-triage" }))
  assert.equal(cmd.status, 200)
  const cmdMd = fs.readFileSync(path.join(repo, "plugins", "opencode", "commands", "triage.md"), "utf8")
  // description contains a colon → JSON-quoted in the frontmatter
  assert.match(cmdMd, /description: "Triage: the incoming work\."/)
  assert.match(cmdMd, /agent: workflow-triage/)
  assert.match(cmdMd, /subtask: true/)
  assert.match(cmdMd, /\*\*\$ARGUMENTS\*\*/)

  const skill = await scaffoldSkill(deps, req({ name: "release-notes", description: "Writes release notes." }))
  assert.equal(skill.status, 200)
  const skillMd = fs.readFileSync(path.join(repo, "skills", "release-notes", "SKILL.md"), "utf8")
  assert.match(skillMd, /name: release-notes/)
  assert.match(skillMd, /# Release Notes/)
})

test("containedIn confines paths under the root", () => {
  assert.ok(containedIn("/repo", "skills", "x"))
  assert.equal(containedIn("/repo", "..", "outside"), null)
  assert.equal(containedIn("/repo", "/etc", "passwd"), null)
})

test("yamlValue quotes yaml-active strings and passes plain ones through", () => {
  assert.equal(yamlValue("plain words here"), "plain words here")
  assert.equal(yamlValue("has: colon"), '"has: colon"')
  assert.equal(yamlValue("has # hash"), '"has # hash"')
  assert.equal(yamlValue(" leading space"), '" leading space"')
})

test("postGenPrompts runs the repo generator and reports failure output", async () => {
  const repo = tempRepo()
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true })

  fs.writeFileSync(path.join(repo, "scripts", "gen-prompts.mjs"), "console.log('generated ok')\n")
  const good = (await postGenPrompts(depsFor(repo))).body as GenPromptsResponse
  assert.equal(good.ok, true)
  assert.match(good.output, /generated ok/)

  fs.writeFileSync(path.join(repo, "scripts", "gen-prompts.mjs"), "console.error('boom'); process.exit(1)\n")
  const bad = (await postGenPrompts(depsFor(repo))).body as GenPromptsResponse
  assert.equal(bad.ok, false)
  assert.match(bad.output, /boom/)

  const missing = await postGenPrompts(depsFor(tempRepo()))
  assert.equal(missing.status, 400)
})
