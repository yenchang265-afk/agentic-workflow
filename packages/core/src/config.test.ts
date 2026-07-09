import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DEFAULT_CONFIG,
  defaultTrackerSystem,
  enabledLoopKinds,
  parseConfig,
  platformFor,
  trackerUrl,
} from "./config.js"

test("defaults leave worktree isolation off and review single-pass", () => {
  assert.equal(DEFAULT_CONFIG.worktreesDir, undefined)
  assert.equal(DEFAULT_CONFIG.worktreeSetup, undefined)
  assert.deepEqual(DEFAULT_CONFIG.reviewLenses, [])
})

test("parseConfig accepts worktree knobs", () => {
  const c = parseConfig({ worktreesDir: ".loop-worktrees", worktreeSetup: "npm ci" })
  assert.equal(c.worktreesDir, ".loop-worktrees")
  assert.equal(c.worktreeSetup, "npm ci")
})

test("parseConfig rejects an empty worktreesDir", () => {
  assert.throws(() => parseConfig({ worktreesDir: "" }), /Invalid .*worktreesDir/)
})

test("parseConfig rejects an empty worktreeSetup", () => {
  assert.throws(() => parseConfig({ worktreeSetup: "" }), /Invalid .*worktreeSetup/)
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
  const offByDefault = parseConfig({ loops: { "pr-sitter": {} } })
  assert.deepEqual(enabledLoopKinds(offByDefault), ["engineering", "pr-sitter"])
  const disabled = parseConfig({ loops: { engineering: { enabled: false }, "pr-sitter": { enabled: true } } })
  assert.deepEqual(enabledLoopKinds(disabled), ["pr-sitter"])
})

test("kind-specific knobs ride along in the loops section", () => {
  const c = parseConfig({ loops: { "pr-sitter": { enabled: true, query: "is:open author:@me" } } })
  assert.equal(c.loops["pr-sitter"]?.["query"], "is:open author:@me")
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

test("trackerUrl appends the key to baseUrl, or returns undefined without one", () => {
  const pm = parseConfig({ projectManagement: { system: "jira", baseUrl: "https://acme.atlassian.net/browse/" } })
    .projectManagement
  assert.equal(trackerUrl(pm, "PROJ-123"), "https://acme.atlassian.net/browse/PROJ-123")
  const noBase = parseConfig({ projectManagement: { system: "jira" } }).projectManagement
  assert.equal(trackerUrl(noBase, "PROJ-123"), undefined)
  assert.equal(trackerUrl(undefined, "PROJ-123"), undefined)
})

