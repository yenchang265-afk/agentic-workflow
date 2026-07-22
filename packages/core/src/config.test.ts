import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  adoAccessFor,
  applyAdoPatEnv,
  bareModel,
  DEFAULT_CONFIG,
  defaultTrackerSystem,
  enabledLoopKinds,
  loadConfig,
  mergeConfigLayers,
  modelFor,
  unknownStageModelKeys,
  unreviewedAxes,
  parseConfig,
  platformFor,
  trackerUrl,
  triggerFor,
} from "./config.js"
import type { Client } from "./host.js"
import type { StageDef } from "./manifest/schema.js"

test("defaults enable worktree isolation and leave review single-pass", () => {
  assert.equal(DEFAULT_CONFIG.worktreesDir, ".loop-worktrees")
  assert.equal(DEFAULT_CONFIG.worktreeSetup, undefined)
  assert.deepEqual(DEFAULT_CONFIG.reviewLenses, [])
})

test("parseConfig accepts worktree knobs", () => {
  const c = parseConfig({ worktreesDir: ".loop-worktrees", worktreeSetup: "npm ci" })
  assert.equal(c.worktreesDir, ".loop-worktrees")
  assert.equal(c.worktreeSetup, "npm ci")
})

test("parseConfig accepts worktreesDir: false as an explicit opt-out", () => {
  assert.equal(parseConfig({ worktreesDir: false }).worktreesDir, false)
})

test("parseConfig rejects an empty worktreesDir", () => {
  assert.throws(() => parseConfig({ worktreesDir: "" }), /Invalid .*worktreesDir/)
})

test("parseConfig rejects an empty worktreeSetup", () => {
  assert.throws(() => parseConfig({ worktreeSetup: "" }), /Invalid .*worktreeSetup/)
})

test("the backlog is untracked by git by default; ignoreBacklog: false opts back into committing it", () => {
  assert.equal(DEFAULT_CONFIG.ignoreBacklog, true)
  assert.equal(parseConfig({}).ignoreBacklog, true)
  assert.equal(parseConfig({ ignoreBacklog: false }).ignoreBacklog, false)
})

test("parseConfig accepts review lenses and rejects more than five", () => {
  assert.deepEqual(parseConfig({ reviewLenses: ["correctness", "security"] }).reviewLenses, [
    "correctness",
    "security",
  ])
  assert.throws(() => parseConfig({ reviewLenses: ["a", "b", "c", "d", "e", "f"] }), /Invalid .*reviewLenses/)
})

test("parseConfig rejects an empty lens string", () => {
  assert.throws(() => parseConfig({ reviewLenses: [""] }), /Invalid .*reviewLenses/)
})

test("existing knobs keep their defaults and validation", () => {
  assert.equal(DEFAULT_CONFIG.maxIterations, 3)
  assert.equal(DEFAULT_CONFIG.tasksDir, "docs/tasks")
  assert.equal(DEFAULT_CONFIG.stageTimeoutMinutes, 60)
  assert.throws(() => parseConfig({ maxIterations: 0 }), /Invalid/)
})

test("a config still carrying removed keys parses (silent deprecation)", () => {
  const c = parseConfig({ gateBeforeBuild: false, interviewBeforePlan: false })
  assert.equal(c.maxIterations, 3)
  assert.ok(!("gateBeforeBuild" in c))
})

test("loops section defaults to empty and enabledLoopKinds keeps engineering on", () => {
  assert.deepEqual(DEFAULT_CONFIG.loops, {})
  assert.deepEqual(enabledLoopKinds(DEFAULT_CONFIG), ["engineering"])
})

test("other loop kinds are opt-in; engineering can be disabled", () => {
  const c = parseConfig({ loops: { "pr-sitter": { enabled: true, query: "author:@me" } } })
  assert.deepEqual(enabledLoopKinds(c), ["engineering", "pr-sitter"])
  // A section with no explicit `enabled` must NOT activate the kind — otherwise
  // merely tuning a knob silently starts a loop that opens PRs on the user's repo.
  const offByDefault = parseConfig({ loops: { "pr-sitter": {} } })
  assert.deepEqual(enabledLoopKinds(offByDefault), ["engineering"])
  const knobOnly = parseConfig({ loops: { "dep-sitter": { severityFloor: "critical" } } })
  assert.deepEqual(enabledLoopKinds(knobOnly), ["engineering"])
  const explicitlyOff = parseConfig({ loops: { "pr-sitter": { enabled: false } } })
  assert.deepEqual(enabledLoopKinds(explicitlyOff), ["engineering"])
  // Engineering keeps the opposite default: on unless explicitly disabled.
  const engImplicit = parseConfig({ loops: { engineering: {} } })
  assert.deepEqual(enabledLoopKinds(engImplicit), ["engineering"])
  const disabled = parseConfig({ loops: { engineering: { enabled: false }, "pr-sitter": { enabled: true } } })
  assert.deepEqual(enabledLoopKinds(disabled), ["pr-sitter"])
})

test("kind-specific knobs ride along in the loops section", () => {
  const c = parseConfig({ loops: { "pr-sitter": { enabled: true, query: "is:open author:@me" } } })
  assert.equal(c.loops["pr-sitter"]?.["query"], "is:open author:@me")
})

test("triggerFor defaults to poll for unconfigured kinds", () => {
  assert.deepEqual(triggerFor(DEFAULT_CONFIG, "engineering"), { type: "poll" })
  const c = parseConfig({ loops: { engineering: {} } })
  assert.deepEqual(triggerFor(c, "engineering"), { type: "poll" })
})

test("loops.<kind>.trigger accepts all three types and knobs still ride along", () => {
  const c = parseConfig({
    loops: {
      engineering: { trigger: { type: "idle" } },
      "pr-sitter": { enabled: true, query: "author:@me", trigger: { type: "cron", schedule: "0 9 * * 1-5" } },
      nightly: { enabled: true, trigger: { type: "poll", intervalMinutes: 30 } },
    },
  })
  assert.deepEqual(triggerFor(c, "engineering"), { type: "idle" })
  assert.deepEqual(triggerFor(c, "pr-sitter"), { type: "cron", schedule: "0 9 * * 1-5" })
  assert.deepEqual(triggerFor(c, "nightly"), { type: "poll", intervalMinutes: 30 })
  assert.equal(c.loops["pr-sitter"]?.["query"], "author:@me")
})

const stageWith = (model?: string): StageDef => ({
  name: "build",
  kind: "work",
  command: "build",
  agent: "loop-build",
  prompt: "stages/build.md",
  isolation: "worktree",
  bashAllowlist: [],
  platformAllowlist: {},
  ...(model ? { model } : {}),
})

test("modelFor: config stageModels wins over the manifest stage's model, which wins over nothing", () => {
  const c = parseConfig({ loops: { engineering: { stageModels: { build: "anthropic/claude-opus-4-5" } } } })
  assert.equal(modelFor(c, "engineering", stageWith("anthropic/claude-sonnet-4-5")), "anthropic/claude-opus-4-5")
  assert.equal(modelFor(DEFAULT_CONFIG, "engineering", stageWith("anthropic/claude-sonnet-4-5")), "anthropic/claude-sonnet-4-5")
  assert.equal(modelFor(DEFAULT_CONFIG, "engineering", stageWith()), undefined)
  // A stageModels entry for a different stage leaves this one alone.
  const other = parseConfig({ loops: { engineering: { stageModels: { review: "anthropic/claude-opus-4-5" } } } })
  assert.equal(modelFor(other, "engineering", stageWith()), undefined)
})

test("loops.<kind>.stageModels validates fail-fast, unlike positional knobs", () => {
  assert.throws(() => parseConfig({ loops: { engineering: { stageModels: { build: 42 } } } }), /stageModels/)
  assert.throws(() => parseConfig({ loops: { engineering: { stageModels: { build: "" } } } }), /stageModels/)
})

const reviewStage = (requiredAxes?: string[]) =>
  ({
    name: "review",
    kind: "check",
    command: "review",
    agent: "loop-review",
    prompt: "stages/review.md",
    isolation: "worktree",
    bashAllowlist: [],
    platformAllowlist: {},
    ...(requiredAxes ? { requiredAxes } : {}),
  }) as Parameters<typeof unreviewedAxes>[1]

test("unreviewedAxes is empty when lenses are off — enforcement is live, nothing is downgraded", () => {
  assert.deepEqual(unreviewedAxes(DEFAULT_CONFIG, reviewStage(["correctness", "security"])), [])
})

test("unreviewedAxes names the required axes no configured lens covers", () => {
  const c = { ...DEFAULT_CONFIG, reviewLenses: ["correctness", "test-adequacy"] }
  assert.deepEqual(unreviewedAxes(c, reviewStage(["correctness", "security", "performance"])), ["security", "performance"])
})

test("unreviewedAxes is empty when the lens list already names every required axis", () => {
  const c = { ...DEFAULT_CONFIG, reviewLenses: ["Correctness", " security "] }
  assert.deepEqual(unreviewedAxes(c, reviewStage(["correctness", "security"])), [])
})

test("unreviewedAxes is empty for a stage that requires no axes (verify, the sitters)", () => {
  const c = { ...DEFAULT_CONFIG, reviewLenses: ["correctness"] }
  assert.deepEqual(unreviewedAxes(c, reviewStage()), [])
})

test("unknownStageModelKeys names stageModels entries that match no stage of the kind", () => {
  const c = parseConfig({
    loops: { engineering: { stageModels: { build: "anthropic/claude-opus-4-5", BUILD: "x", triage: "y" } } },
  })
  assert.deepEqual(unknownStageModelKeys(c, "engineering", ["plan", "build", "verify", "review"]), ["BUILD", "triage"])
  // Every key matching a stage, an absent section, and an absent stageModels are all clean.
  assert.deepEqual(unknownStageModelKeys(c, "pr-sitter", ["triage"]), [])
  assert.deepEqual(unknownStageModelKeys(DEFAULT_CONFIG, "engineering", ["build"]), [])
})

test("bareModel strips a provider prefix and passes bare ids through", () => {
  assert.equal(bareModel("anthropic/claude-sonnet-4-5"), "claude-sonnet-4-5")
  assert.equal(bareModel("openrouter/anthropic/claude-sonnet-4-5"), "claude-sonnet-4-5")
  assert.equal(bareModel("sonnet"), "sonnet")
})

test("loops.<kind>.trigger rejects unknown types and malformed shapes", () => {
  assert.throws(() => parseConfig({ loops: { engineering: { trigger: { type: "webhook" } } } }), /trigger/)
  assert.throws(() => parseConfig({ loops: { engineering: { trigger: { type: "cron" } } } }), /schedule/)
  assert.throws(
    () => parseConfig({ loops: { engineering: { trigger: { type: "poll", intervalMinutes: 0 } } } }),
    /intervalMinutes/,
  )
  assert.throws(
    () => parseConfig({ loops: { engineering: { trigger: { type: "poll", intervalMinutes: 2000 } } } }),
    /intervalMinutes/,
  )
})

test("codePlatform defaults to github and rejects unknown platforms", () => {
  assert.equal(DEFAULT_CONFIG.codePlatform, "github")
  assert.equal(platformFor(DEFAULT_CONFIG, "pr-sitter"), "github")
  assert.throws(() => parseConfig({ codePlatform: "gitlab" }), /Invalid .*codePlatform/)
})

test("global codePlatform ado requires the ado section and a selfLogin", () => {
  assert.throws(() => parseConfig({ codePlatform: "ado" }), /requires an 'ado' section/)
  // A PAT can't resolve identity, so selfLogin is required.
  assert.throws(
    () => parseConfig({ codePlatform: "ado", ado: { organization: "https://dev.azure.com/acme", project: "widgets" } }),
    /requires ado\.selfLogin/,
  )
  const c = parseConfig({
    codePlatform: "ado",
    ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" },
  })
  assert.equal(c.codePlatform, "ado")
  assert.equal(c.ado?.project, "widgets")
  assert.equal(platformFor(c, "pr-sitter"), "ado")
})

test("ado.customHeaders parses as a string map and rejects empty keys or values", () => {
  const c = parseConfig({
    codePlatform: "ado",
    ado: {
      organization: "https://dev.azure.com/acme",
      project: "widgets",
      selfLogin: "sitter@acme.com",
      customHeaders: { "Proxy-Authorization": "Bearer proxy-token", "X-Route": "internal" },
    },
  })
  assert.deepEqual(c.ado?.customHeaders, { "Proxy-Authorization": "Bearer proxy-token", "X-Route": "internal" })
  const base = { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" }
  assert.throws(
    () => parseConfig({ codePlatform: "ado", ado: { ...base, customHeaders: { "": "value" } } }),
    /Invalid .*customHeaders/,
  )
  assert.throws(
    () => parseConfig({ codePlatform: "ado", ado: { ...base, customHeaders: { "X-Route": "" } } }),
    /Invalid .*customHeaders/,
  )
})

test("ado.insecureSkipTlsVerify parses as an optional boolean, off by default", () => {
  const base = { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" }
  const unset = parseConfig({ codePlatform: "ado", ado: base })
  assert.equal(unset.ado?.insecureSkipTlsVerify, undefined)
  const on = parseConfig({ codePlatform: "ado", ado: { ...base, insecureSkipTlsVerify: true } })
  assert.equal(on.ado?.insecureSkipTlsVerify, true)
  assert.throws(
    () => parseConfig({ codePlatform: "ado", ado: { ...base, insecureSkipTlsVerify: "yes" } }),
    /Invalid .*insecureSkipTlsVerify/,
  )
})

test("per-loop codePlatform overrides the global default and also requires the ado section and selfLogin", () => {
  assert.throws(
    () => parseConfig({ loops: { "pr-sitter": { enabled: true, codePlatform: "ado" } } }),
    /requires an 'ado' section/,
  )
  assert.throws(
    () =>
      parseConfig({
        loops: { "pr-sitter": { enabled: true, codePlatform: "ado" } },
        ado: { organization: "https://dev.azure.com/acme", project: "widgets" },
      }),
    /requires ado\.selfLogin/,
  )
  const c = parseConfig({
    loops: { "pr-sitter": { enabled: true, codePlatform: "ado" } },
    ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" },
  })
  assert.equal(platformFor(c, "pr-sitter"), "ado")
  assert.equal(platformFor(c, "engineering"), "github")
  const back = parseConfig({
    codePlatform: "ado",
    ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" },
    loops: { "pr-sitter": { enabled: true, codePlatform: "github" } },
  })
  assert.equal(platformFor(back, "pr-sitter"), "github")
})

test("ado section fields are validated", () => {
  assert.throws(
    () =>
      parseConfig({ codePlatform: "ado", ado: { organization: "", project: "p", selfLogin: "sitter@acme.com" } }),
    /Invalid .*ado/,
  )
})

test("ado.access defaults to az, parses each method, and rejects unknown values", () => {
  const base = { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" }
  const defaulted = parseConfig({ codePlatform: "ado", ado: base })
  assert.equal(defaulted.ado?.access, "az")
  assert.equal(adoAccessFor(defaulted), "az")
  for (const access of ["az", "rest", "mcp"] as const) {
    const c = parseConfig({ codePlatform: "ado", ado: { ...base, access } })
    assert.equal(c.ado?.access, access)
    assert.equal(adoAccessFor(c), access)
  }
  assert.throws(() => parseConfig({ codePlatform: "ado", ado: { ...base, access: "cli" } }), /Invalid .*access/)
  // No ado section at all (github config) → the pure helper still answers.
  assert.equal(adoAccessFor(DEFAULT_CONFIG), "az")
})

test("ado.pat is an accepted optional config field", () => {
  const c = parseConfig({
    codePlatform: "ado",
    ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com", pat: "tok" },
  })
  assert.equal(c.ado?.pat, "tok")
})

test("applyAdoPatEnv exports ado.pat to AZURE_DEVOPS_EXT_PAT only when the env var is unset", () => {
  const saved = process.env.AZURE_DEVOPS_EXT_PAT
  try {
    delete process.env.AZURE_DEVOPS_EXT_PAT
    applyAdoPatEnv({ ado: { pat: "cfg-pat" } })
    assert.equal(process.env.AZURE_DEVOPS_EXT_PAT, "cfg-pat")
    // env var wins: an existing value is never overridden
    process.env.AZURE_DEVOPS_EXT_PAT = "env-pat"
    applyAdoPatEnv({ ado: { pat: "cfg-pat" } })
    assert.equal(process.env.AZURE_DEVOPS_EXT_PAT, "env-pat")
    // no ado.pat → no-op
    delete process.env.AZURE_DEVOPS_EXT_PAT
    applyAdoPatEnv({ ado: {} })
    assert.equal(process.env.AZURE_DEVOPS_EXT_PAT, undefined)
  } finally {
    if (saved === undefined) delete process.env.AZURE_DEVOPS_EXT_PAT
    else process.env.AZURE_DEVOPS_EXT_PAT = saved
  }
})

// --- projectManagement ---

test("projectManagement is off by default", () => {
  assert.equal(DEFAULT_CONFIG.projectManagement, undefined)
  assert.equal(defaultTrackerSystem(DEFAULT_CONFIG), undefined)
})

test("parseConfig accepts a minimal projectManagement section", () => {
  const cfg = parseConfig({ projectManagement: { system: "jira" } })
  assert.equal(cfg.projectManagement?.system, "jira")
  assert.equal(defaultTrackerSystem(cfg), "jira")
})

test("parseConfig accepts the full projectManagement shape", () => {
  const cfg = parseConfig({
    projectManagement: {
      system: "azure-devops",
      baseUrl: "https://dev.azure.com/acme/proj/_workitems/edit/",
      defaultType: "task",
    },
  })
  assert.equal(cfg.projectManagement?.system, "azure-devops")
  assert.equal(cfg.projectManagement?.defaultType, "task")
})

test("parseConfig rejects an unknown tracker system and a non-URL baseUrl", () => {
  assert.throws(() => parseConfig({ projectManagement: { system: "trello" } }), /system/)
  assert.throws(
    () => parseConfig({ projectManagement: { system: "jira", baseUrl: "not a url" } }),
    /baseUrl/,
  )
})

// --- mergeConfigLayers ---

test("mergeConfigLayers: scalars and arrays in the override replace wholesale", () => {
  assert.deepEqual(mergeConfigLayers({ maxIterations: 5 }, { maxIterations: 7 }), { maxIterations: 7 })
  assert.deepEqual(
    mergeConfigLayers({ reviewLenses: ["security", "perf"] }, { reviewLenses: ["correctness"] }),
    { reviewLenses: ["correctness"] },
  )
})

test("mergeConfigLayers: nested objects merge per field (the ado split use case)", () => {
  const user = { ado: { organization: "https://dev.azure.com/acme", selfLogin: "me@acme.com", pat: "tok" } }
  const repo = { ado: { project: "widgets", repository: "widgets-api" } }
  assert.deepEqual(mergeConfigLayers(user, repo), {
    ado: {
      organization: "https://dev.azure.com/acme",
      selfLogin: "me@acme.com",
      pat: "tok",
      project: "widgets",
      repository: "widgets-api",
    },
  })
})

test("mergeConfigLayers: loops merge per kind and per knob; other kinds survive", () => {
  const user = { loops: { "pr-sitter": { enabled: true } } }
  const repo = { loops: { "pr-sitter": { query: "author:@me" }, engineering: { enabled: false } } }
  assert.deepEqual(mergeConfigLayers(user, repo), {
    loops: { "pr-sitter": { enabled: true, query: "author:@me" }, engineering: { enabled: false } },
  })
})

test("mergeConfigLayers: stageModels merge per stage; repo wins per key", () => {
  const user = { loops: { engineering: { stageModels: { build: "a", review: "b" } } } }
  const repo = { loops: { engineering: { stageModels: { build: "c" } } } }
  assert.deepEqual(mergeConfigLayers(user, repo), {
    loops: { engineering: { stageModels: { build: "c", review: "b" } } },
  })
})

test("mergeConfigLayers: null replaces like a scalar; type mismatch → override wins", () => {
  assert.deepEqual(mergeConfigLayers({ ado: { pat: "tok" } }, { ado: null }), { ado: null })
  assert.deepEqual(mergeConfigLayers({ ado: { pat: "tok" } }, { ado: "oops" }), { ado: "oops" })
})

test("mergeConfigLayers: empty override returns the base; undefined override keeps base", () => {
  assert.deepEqual(mergeConfigLayers({ tasksDir: "x" }, {}), { tasksDir: "x" })
  assert.deepEqual(mergeConfigLayers({ tasksDir: "x" }, undefined), { tasksDir: "x" })
})

test("defaults apply only after the merge: a repo omission cannot clobber a user value", () => {
  const merged = mergeConfigLayers({ maxIterations: 5 }, { tasksDir: "work/tasks" })
  const c = parseConfig(merged)
  assert.equal(c.maxIterations, 5)
  assert.equal(c.tasksDir, "work/tasks")
})

// --- layered loadConfig ---

const stubClient = (repoContent: string | undefined): Client => ({
  file: {
    list: async () => ({ data: [] }),
    read: async () => ({ data: repoContent === undefined ? null : { content: repoContent } }),
  },
  app: { log: async () => undefined },
})

const tempUserFile = (content: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-loop-config-"))
  const file = path.join(dir, ".agentic-loop.json")
  fs.writeFileSync(file, content)
  return file
}

test("loadConfig layers user under repo; repo wins field by field", async () => {
  const userPath = tempUserFile(JSON.stringify({ maxIterations: 5, tasksDir: "user/tasks" }))
  const c = await loadConfig(stubClient(JSON.stringify({ tasksDir: "repo/tasks" })), "/repo", {
    userConfigPath: userPath,
  })
  assert.equal(c.maxIterations, 5)
  assert.equal(c.tasksDir, "repo/tasks")
})

test("loadConfig: superRefine validates the combined view (org/selfLogin from user, project from repo)", async () => {
  const userPath = tempUserFile(
    JSON.stringify({ ado: { organization: "https://dev.azure.com/acme", selfLogin: "me@acme.com", pat: "tok" } }),
  )
  const repo = JSON.stringify({ codePlatform: "ado", ado: { project: "widgets" } })
  const c = await loadConfig(stubClient(repo), "/repo", { userConfigPath: userPath })
  assert.equal(c.ado?.organization, "https://dev.azure.com/acme")
  assert.equal(c.ado?.project, "widgets")
  assert.equal(c.ado?.selfLogin, "me@acme.com")
  // Same repo file without the user layer is incomplete.
  await assert.rejects(
    () => loadConfig(stubClient(repo), "/repo", { userConfigPath: null }),
    /ado\.organization/,
  )
})

test("loadConfig: user-only, repo-only, and neither", async () => {
  const userPath = tempUserFile(JSON.stringify({ maxIterations: 9 }))
  const userOnly = await loadConfig(stubClient(undefined), "/repo", { userConfigPath: userPath })
  assert.equal(userOnly.maxIterations, 9)
  const repoOnly = await loadConfig(stubClient(JSON.stringify({ maxIterations: 2 })), "/repo", {
    userConfigPath: null,
  })
  assert.equal(repoOnly.maxIterations, 2)
  const neither = await loadConfig(stubClient(undefined), "/repo", { userConfigPath: null })
  assert.deepEqual(neither, DEFAULT_CONFIG)
})

test("loadConfig: absent or empty user file → layer skipped", async () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentic-loop-config-")), "nope.json")
  const c = await loadConfig(stubClient(undefined), "/repo", { userConfigPath: missing })
  assert.deepEqual(c, DEFAULT_CONFIG)
  const empty = tempUserFile("")
  const c2 = await loadConfig(stubClient(undefined), "/repo", { userConfigPath: empty })
  assert.deepEqual(c2, DEFAULT_CONFIG)
})

test("loadConfig: malformed user file throws naming its path", async () => {
  const badJson = tempUserFile("{ nope")
  await assert.rejects(
    () => loadConfig(stubClient(undefined), "/repo", { userConfigPath: badJson }),
    new RegExp(`Invalid .*${path.basename(path.dirname(badJson))}.*not valid JSON`),
  )
  const nonObject = tempUserFile(JSON.stringify(["not", "an", "object"]))
  await assert.rejects(
    () => loadConfig(stubClient(undefined), "/repo", { userConfigPath: nonObject }),
    /top level must be a JSON object/,
  )
})

test("loadConfig: merged-parse errors name both layers", async () => {
  const userPath = tempUserFile(JSON.stringify({ maxIterations: 0 }))
  await assert.rejects(
    () => loadConfig(stubClient(JSON.stringify({ tasksDir: "x" })), "/repo", { userConfigPath: userPath }),
    /Invalid \.agentic-loop\.json \(merged with .*\): .*maxIterations/,
  )
})

test("trackerUrl appends the key to baseUrl, or returns undefined without one", () => {
  const pm = parseConfig({ projectManagement: { system: "jira", baseUrl: "https://acme.atlassian.net/browse/" } })
    .projectManagement
  assert.equal(trackerUrl(pm, "PROJ-123"), "https://acme.atlassian.net/browse/PROJ-123")
  const noBase = parseConfig({ projectManagement: { system: "jira" } }).projectManagement
  assert.equal(trackerUrl(noBase, "PROJ-123"), undefined)
  assert.equal(trackerUrl(undefined, "PROJ-123"), undefined)
})


test("review-sitter is opt-in like every non-engineering kind; its query knob rides the open record", () => {
  assert.deepEqual(enabledLoopKinds(parseConfig({})), ["engineering"])
  const c = parseConfig({ loops: { "review-sitter": { enabled: true, query: "is:open review-requested:@me" } } })
  assert.deepEqual(enabledLoopKinds(c), ["engineering", "review-sitter"])
  assert.equal(c.loops["review-sitter"]?.["query"], "is:open review-requested:@me")
})
