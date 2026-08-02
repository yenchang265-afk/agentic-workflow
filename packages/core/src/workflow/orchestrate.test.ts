import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_CONFIG, parseConfigWith, ConfigSchema } from "../config.js"
import { defaultWorkflowsDir } from "../manifest/dir.js"
import type { Client, Shell } from "../host.js"
import { serializeTask, parseTask } from "../task/schema.js"
import { PLAN_HEADING } from "../task/store.js"
import {
  buildEntryState,
  buildWorkSources,
  workflowWorkTree,
  makeManifestCache,
  planEntryState,
  taskGoal,
  taskRef,
} from "./orchestrate.js"
import type { AdoGateway } from "../source/ado-gateway.js"

const noopShell = ((..._args: unknown[]) => {
  throw new Error("shell must not run during source construction")
}) as unknown as Shell
const noopClient = {} as unknown as Client

/**
 * A gateway that is never called — source CONSTRUCTION must not touch Azure
 * DevOps. Its presence is what lets an ado-platform kind wire at all, so these
 * tests pass it wherever they exercise the ado path.
 */
const noopGateway = new Proxy({} as AdoGateway, {
  get: () => () => {
    throw new Error("the gateway must not be called during source construction")
  },
})

const task = (body: string) => {
  const raw = serializeTask({ title: "Do the thing", body })
  return parseTask("my-task.md", raw, "/repo/docs/tasks/queued/my-task.md")
}

test("taskGoal joins title and body; taskRef carries id/path/acceptance", () => {
  const t = task("Some context.")
  assert.equal(taskGoal(t), "Do the thing\n\nSome context.")
  assert.deepEqual(taskRef(t, t.path), { id: "my-task", path: "/repo/docs/tasks/queued/my-task.md", acceptance: t.acceptance })
})

test("buildEntryState enters at build with the persisted plan; planEntryState at plan", () => {
  const planned = task(`${PLAN_HEADING}\n\n1. Step.`)
  const build = buildEntryState(planned)
  assert.equal(build.stage, "build")
  assert.match(build.artifacts["plan"] ?? "", /1\. Step\./)
  const plan = planEntryState(task("no plan yet"))
  assert.equal(plan.stage, "plan")
})

test("planEntryState threads a pending replan reason; absent otherwise", () => {
  const rejected = task(
    `${PLAN_HEADING}\n\nOld approach.\n` +
      `\n> Plan rejected — sent back to queued for re-planning — wrong layer [2026-01-02T00:00:00.000Z by dev]\n`,
  )
  const state = planEntryState(rejected)
  assert.deepEqual(state.replan, { reason: "wrong layer" })
  assert.equal(planEntryState(task("no plan yet")).replan, undefined)
})

test("workflowWorkTree prefers the state's worktree over the main tree", () => {
  const base = planEntryState(task("x"))
  assert.equal(workflowWorkTree("/repo", base), "/repo")
  assert.equal(workflowWorkTree("/repo", { ...base, git: { base: "main", branch: "b", worktree: "/wt" } }), "/wt")
})

test("makeManifestCache loads eagerly, caches, and serves lazy kinds", () => {
  const manifestFor = makeManifestCache(defaultWorkflowsDir(), ["engineering"])
  const eng = manifestFor("engineering")
  assert.equal(eng.manifest.kind, "engineering")
  assert.equal(manifestFor("engineering"), eng, "same cached instance")
  assert.equal(manifestFor("pr-sitter").manifest.kind, "pr-sitter")
})

test("an unscoped poll on a default config is engineering only; the sitters are opt-in", () => {
  // Every sitter is experimental, so a bare poll on a default config reaches
  // none of them until one is explicitly enabled.
  const deps = { $: noopShell, client: noopClient, directory: "/repo", log: () => {}, isDriving: () => false, adoGateway: noopGateway }
  const manifestFor = makeManifestCache(defaultWorkflowsDir())

  assert.deepEqual(
    buildWorkSources(deps, DEFAULT_CONFIG, manifestFor).map((s) => s.workflowKind),
    ["engineering"],
  )
  const withPr = parseConfigWith(ConfigSchema, { workflows: { "pr-sitter": { enabled: true } } })
  assert.deepEqual(
    buildWorkSources(deps, withPr, manifestFor).map((s) => s.workflowKind),
    ["engineering", "pr-sitter"],
  )
  assert.deepEqual(
    buildWorkSources(deps, withPr, manifestFor, "pr-sitter").map((s) => s.workflowKind),
    ["pr-sitter"],
  )
  // Disabling engineering too leaves nothing to poll.
  const noEng = parseConfigWith(ConfigSchema, { workflows: { engineering: { enabled: false } } })
  assert.deepEqual(buildWorkSources(deps, noEng, manifestFor).map((s) => s.workflowKind), [])
})

test("buildWorkSources yields one source per enabled kind, in order", () => {
  const config = parseConfigWith(ConfigSchema, { workflows: { "dep-sitter": { enabled: true } } })
  const manifestFor = makeManifestCache(defaultWorkflowsDir())
  const sources = buildWorkSources(
    { $: noopShell, client: noopClient, directory: "/repo", log: () => {}, isDriving: () => false },
    config,
    manifestFor,
  )
  // The default-on kind plus the opted-in one, in claim-priority order.
  assert.deepEqual(
    sources.map((s) => s.workflowKind),
    ["engineering", "dep-sitter"],
  )
})

test("an unloadable kind is skipped with a warning, not fatal", () => {
  const config = parseConfigWith(ConfigSchema, { workflows: { "no-such-kind": { enabled: true } } })
  const warnings: string[] = []
  const manifestFor = makeManifestCache(defaultWorkflowsDir())
  const sources = buildWorkSources(
    { $: noopShell, client: noopClient, directory: "/repo", log: (_l, m) => warnings.push(m), isDriving: () => false },
    config,
    manifestFor,
  )
  assert.deepEqual(
    sources.map((s) => s.workflowKind),
    ["engineering"],
    "the default-on kind survives the bad kind",
  )
  assert.ok(warnings.some((w) => w.includes('no-such-kind')))
})

test("a kind filter restricts the sources to that kind", () => {
  const config = parseConfigWith(ConfigSchema, { workflows: { "pr-sitter": { enabled: true } } })
  const manifestFor = makeManifestCache(defaultWorkflowsDir())
  const deps = { $: noopShell, client: noopClient, directory: "/repo", log: () => {}, isDriving: () => false, adoGateway: noopGateway }
  assert.equal(buildWorkSources(deps, config, manifestFor, "pr-sitter").length, 1)
  assert.equal(buildWorkSources(deps, DEFAULT_CONFIG, manifestFor, "engineering").length, 1)
})

test("buildWorkSources wires review-sitter as a second pull-request source alongside pr-sitter", () => {
  const config = parseConfigWith(ConfigSchema, {
    workflows: { "pr-sitter": { enabled: true }, "review-sitter": { enabled: true } },
  })
  const manifestFor = makeManifestCache(defaultWorkflowsDir())
  const deps = { $: noopShell, client: noopClient, directory: "/repo", log: () => {}, isDriving: () => false, adoGateway: noopGateway }
  const sources = buildWorkSources(deps, config, manifestFor)
  assert.equal(sources.length, 3)
  assert.deepEqual(
    sources.map((s) => s.workflowKind),
    ["engineering", "pr-sitter", "review-sitter"],
  )
  // The claim/watch kind filter reaches the reviewer kind on its own too.
  assert.equal(buildWorkSources(deps, config, manifestFor, "review-sitter")[0]?.workflowKind, "review-sitter")
})

test('a manifest using the legacy "github-pr" type still wires on both platforms', () => {
  const workflows = fs.mkdtempSync(path.join(os.tmpdir(), "workflows-"))
  for (const kind of ["engineering", "pr-sitter"]) {
    fs.cpSync(path.join(defaultWorkflowsDir(), kind), path.join(workflows, kind), { recursive: true })
  }
  const manifestPath = path.join(workflows, "pr-sitter", "workflow.json")
  const legacy = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { workSource: { type: string } }
  legacy.workSource.type = "github-pr"
  fs.writeFileSync(manifestPath, JSON.stringify(legacy))

  const manifestFor = makeManifestCache(workflows)
  const deps = { $: noopShell, client: noopClient, directory: "/repo", log: () => {}, isDriving: () => false, adoGateway: noopGateway }
  const github = parseConfigWith(ConfigSchema, { workflows: { "pr-sitter": { enabled: true } } })
  assert.equal(buildWorkSources(deps, github, manifestFor, "pr-sitter").length, 1)

  const ado = parseConfigWith(ConfigSchema, {
    codePlatform: "ado",
    ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" },
    workflows: { "pr-sitter": { enabled: true } },
  })
  assert.equal(buildWorkSources(deps, ado, manifestFor, "pr-sitter").length, 1)
})

test("buildWorkSources wires dep-sitter and main-sitter on both github and ado — no more skip-with-warning", () => {
  const config = parseConfigWith(ConfigSchema, {
    workflows: { "dep-sitter": { enabled: true }, "main-sitter": { enabled: true } },
  })
  const manifestFor = makeManifestCache(defaultWorkflowsDir())
  const deps = { $: noopShell, client: noopClient, directory: "/repo", log: () => {}, isDriving: () => false, adoGateway: noopGateway }
  assert.deepEqual(
    buildWorkSources(deps, config, manifestFor).map((s) => s.workflowKind),
    ["engineering", "dep-sitter", "main-sitter"],
  )
  const warnings: string[] = []
  const ado = parseConfigWith(ConfigSchema, {
    codePlatform: "ado",
    ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" },
    workflows: { "dep-sitter": { enabled: true }, "main-sitter": { enabled: true } },
  })
  const sources = buildWorkSources(
    { ...deps, log: (_l: string, m: string) => void warnings.push(m) },
    ado,
    manifestFor,
  )
  assert.deepEqual(
    sources.map((s) => s.workflowKind),
    ["engineering", "dep-sitter", "main-sitter"],
  )
  assert.deepEqual(warnings, [])
})

test("the workflows.dep-sitter.ecosystem override reaches the source through buildWorkSources", async () => {
  // A minimal scripted shell: osv-scanner probes succeed, everything else succeeds empty.
  const ran: string[] = []
  const shell = ((strings: TemplateStringsArray, ...exprs: unknown[]) => {
    let cmd = ""
    strings.forEach((s, i) => {
      cmd += s
      if (i < exprs.length) cmd += String(exprs[i])
    })
    ran.push(cmd.trim().replace(/\s+/g, " "))
    const chain = {
      quiet: () => chain,
      nothrow: () => chain,
      cwd: () => chain,
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ exitCode: 0, stdout: { toString: () => "{}" }, stderr: { toString: () => "" } }).then(resolve),
    }
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
  const client = {
    file: {
      async list() {
        return { data: [] }
      },
      async read({ query }: { query: { path: string } }) {
        // Both manifests exist — only the ecosystem override keeps npm out.
        const files: Record<string, string> = { "package.json": "{}", "pom.xml": "<project></project>" }
        const content = files[query.path]
        return { data: content ? { content } : null }
      },
    },
    app: { async log() {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  const config = parseConfigWith(ConfigSchema, {
    workflows: { "dep-sitter": { enabled: true, ecosystem: "maven" } },
  })
  // Scope to the one kind under test — engineering would otherwise sit ahead
  // of dep-sitter in claim-priority order.
  const sources = buildWorkSources(
    { $: shell, client, directory: "/repo", log: () => {}, isDriving: () => false },
    config,
    makeManifestCache(defaultWorkflowsDir()),
    "dep-sitter",
  )
  assert.deepEqual(
    sources.map((s) => s.workflowKind),
    ["dep-sitter"],
  )
  await sources[0]?.claimNext()
  assert.ok(ran.some((c) => c.startsWith("osv-scanner")))
  assert.ok(ran.every((c) => !c.startsWith("npm ")))
})

test("an ado kind with no gateway contributes no source and warns, leaving other kinds polling", () => {
  // One unusable ADO section must not stop the whole host: the engineering
  // backlog is platform-agnostic and has to keep running.
  const warnings: string[] = []
  const config = parseConfigWith(ConfigSchema, {
    codePlatform: "ado",
    ado: { organization: "https://dev.azure.com/acme", project: "widgets", selfLogin: "sitter@acme.com" },
    workflows: { "pr-sitter": { enabled: true } },
  })
  const sources = buildWorkSources(
    {
      $: noopShell,
      client: noopClient,
      directory: "/repo",
      log: (_l: string, m: string) => void warnings.push(m),
      isDriving: () => false,
    },
    config,
    makeManifestCache(defaultWorkflowsDir()),
  )
  assert.deepEqual(
    sources.map((s) => s.workflowKind),
    ["engineering"],
  )
  assert.match(warnings.join("\n"), /no Azure DevOps MCP gateway is available/)
})
