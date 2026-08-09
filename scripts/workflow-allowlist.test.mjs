import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

/**
 * Invariants over every stage `bashAllowlist` in workflows/<kind>/workflow.json,
 * and over the OpenCode frontmatter generated from it.
 *
 * The `cd * && ` twins used to be hand-listed here, which is how `npm outdated*`
 * shipped without one, and how EVERY read glob (`git *`, `cat *`, …) went without
 * one — the defect that had REVIEW's whole allowlist unreachable in a worktree.
 * `gen-prompts.mjs` derives them now, so the invariants flipped: the manifest must
 * carry only bare forms, and the GENERATED frontmatter must carry both.
 *
 * Reading the committed frontmatter (rather than calling the generator) also
 * catches a stale `npm run gen:prompts`.
 */

const WORKFLOWS = path.join(import.meta.dirname, "..", "packages", "core", "workflows")
const OPENCODE_AGENTS = path.join(import.meta.dirname, "..", "plugins", "opencode", "agents")

const manifests = fs
  .readdirSync(WORKFLOWS)
  .sort()
  .map((kind) => ({ kind, file: path.join(WORKFLOWS, kind, "workflow.json") }))
  .filter(({ file }) => fs.existsSync(file))
  .map(({ kind, file }) => ({ kind, manifest: JSON.parse(fs.readFileSync(file, "utf8")) }))

assert.ok(manifests.length > 0, "no workflow manifests found — wrong path?")

const CD_PREFIX = "cd * && "

/** Every glob a stage grants, `bashAllowlist` plus each platform's extras. */
const stageGlobs = (stage) => [...(stage.bashAllowlist ?? []), ...Object.values(stage.platformAllowlist ?? {}).flat()]

test("no manifest glob is hand-written with the `cd * && ` prefix", () => {
  for (const { kind, manifest } of manifests) {
    for (const stage of manifest.stages ?? []) {
      for (const glob of stageGlobs(stage)) {
        assert.ok(
          !glob.startsWith(CD_PREFIX),
          `${kind}/${stage.name}: "${glob}" hand-writes the "${CD_PREFIX}" prefix — ` +
            `gen-prompts.mjs derives the twins for worktree-isolated stages, so declare the bare form only`,
        )
      }
    }
  }
})

/**
 * The generated frontmatter must grant both shapes for a worktree-isolated stage.
 * OpenCode matches the WHOLE command string — it does not split on `&&` the way
 * the Claude Code guard does — so a stage told to run commands inside its
 * worktree has the bare form unreachable there, and without the twin every such
 * command falls through to the `"*": deny` sentinel.
 */
test("the generated OpenCode frontmatter carries both shapes for a worktree stage", () => {
  let checked = 0
  for (const { kind, manifest } of manifests) {
    for (const stage of manifest.stages ?? []) {
      if (stage.isolation !== "worktree") continue
      const globs = stageGlobs(stage)
      if (globs.length === 0) continue
      const file = path.join(OPENCODE_AGENTS, `${stage.agent}.md`)
      assert.ok(fs.existsSync(file), `${kind}/${stage.name}: no generated agent at ${file}`)
      const granted = new Set([...fs.readFileSync(file, "utf8").matchAll(/^ *"(.+)": allow$/gm)].map((m) => m[1]))
      for (const glob of globs) {
        for (const want of [glob, CD_PREFIX + glob]) {
          assert.ok(
            granted.has(want),
            `${kind}/${stage.name}: ${stage.agent}.md does not grant "${want}" — run \`npm run gen:prompts\``,
          )
        }
        checked++
      }
    }
  }
  // Guards the guard: a path that stopped finding worktree stages would pass
  // vacuously and leave the whole invariant untested.
  assert.ok(checked > 0, "no worktree-isolated stage with an allowlist found — wrong path?")
})

/**
 * OpenCode evaluates permission maps LAST-match-wins over key order, which
 * makes the sentinel's POSITION semantic, not stylistic: `"*": deny` must come
 * before every allow. Allows written above it would all lose to the sentinel
 * (a fully starved stage), and a sentinel written LAST is worse still —
 * OpenCode's `disabled()` checks only the last rule matching the tool name, so
 * a trailing `"*": deny` removes the bash tool from the agent entirely. Nothing
 * in generation enforces this: the sentinel is hand-authored in
 * `prompts/agents/<name>/opencode.yaml` and `expandAllowlist` only splices
 * allows under it, so a reordered source yaml would regenerate "cleanly" into a
 * broken agent.
 */
test("every generated bash permission map opens with the deny sentinel", () => {
  let checked = 0
  for (const file of fs.readdirSync(OPENCODE_AGENTS)) {
    if (!file.endsWith(".md")) continue
    const text = fs.readFileSync(path.join(OPENCODE_AGENTS, file), "utf8")
    const rules = [...text.matchAll(/^ *"(.+)": (allow|deny|ask)$/gm)]
    if (rules.length === 0) continue // bash: allow / bash: deny agents carry no map
    assert.equal(rules[0][1], "*", `${file}: the first bash rule is "${rules[0][1]}", not the "*" sentinel`)
    assert.equal(rules[0][2], "deny", `${file}: the "*" sentinel is "${rules[0][2]}", not deny`)
    for (const rule of rules.slice(1)) {
      assert.notEqual(rule[1], "*", `${file}: a second "*" rule after the sentinel would override it (last match wins)`)
    }
    checked++
  }
  assert.ok(checked > 0, "no generated agent with a bash permission map found — wrong path?")
})

test("no stage allowlist repeats a glob", () => {
  for (const { kind, manifest } of manifests) {
    for (const stage of manifest.stages ?? []) {
      const globs = stage.bashAllowlist ?? []
      assert.equal(new Set(globs).size, globs.length, `${kind}/${stage.name}: duplicate glob in bashAllowlist`)
    }
  }
})

/**
 * One agent, one static frontmatter — an agent bound by several kinds must
 * declare the identical list in each, or `gen-prompts.mjs` cannot render it.
 * `workflow-verify` is the live case: engineering, dep-sitter, main-sitter and
 * pr-sitter all bind it.
 */
test("an agent bound by several manifests declares identical allowlists", () => {
  const byAgent = new Map()
  for (const { kind, manifest } of manifests) {
    for (const stage of manifest.stages ?? []) {
      const globs = [...(stage.bashAllowlist ?? []), ...Object.values(stage.platformAllowlist ?? {}).flat()]
      if (globs.length === 0) continue
      const seen = byAgent.get(stage.agent)
      if (!seen) {
        byAgent.set(stage.agent, { kind, globs })
        continue
      }
      assert.deepEqual(
        globs,
        seen.globs,
        `agent "${stage.agent}" declares a different bash allowlist in ${kind} than in ${seen.kind} — ` +
          `one static frontmatter must serve both, so reconcile them in workflows/*/workflow.json`,
      )
    }
  }
  // Guards the guard: if the shared agent ever stops being shared, this test
  // would pass vacuously and the invariant above would be untested.
  assert.ok(byAgent.has("workflow-verify"), "expected workflow-verify to declare an allowlist")
})

/**
 * A glob is POSITION-anchored, and the JVM build tools are the toolchains that
 * do not put their goal first: Maven and Gradle take global options (`-B`, `-q`,
 * `-pl core -am`, `--no-daemon`) and preceding lifecycle phases (`clean`) BEFORE
 * the goal, and Gradle qualifies a task by module (`:core:test`). So `mvn test*`
 * — the shape every other runner uses — matched only the bare `mvn test`, and
 * `mvn clean test` / `mvn -B test` / `./gradlew :core:test` all fell through to
 * the deny sentinel. VERIFY then recorded ERROR for a runner the project has,
 * which is exactly the failure the widening in #241 set out to remove.
 *
 * Hence the second form per goal (`mvn * test*`, and `gradle *:test*`). This IS a
 * deliberate widening, and the shape of it is worth stating exactly: trailing
 * goals were always admitted (every glob ends in `*` compiled with dotAll, so
 * `mvn test <anything>` has always matched), but the second form additionally
 * admits a goal BEFORE the anchor — `mvn deploy test` matches `mvn * test*`.
 * That is accepted rather than closed: the goal names are a scope boundary
 * against a confused agent (threat model T2), never a sandbox, and pinning the
 * prefix would re-introduce the false denials this widening removes. Anything
 * that needs to be a real boundary belongs in the guard, not in a glob.
 *
 * Asserted against BOTH hosts' matchers, because they differ: the Claude Code /
 * Qwen guard splits on `&&` and matches each segment, while OpenCode matches the
 * WHOLE command string against the generated frontmatter — which is why the
 * worktree form is tested there and not here.
 */
const verifyGlobs = () => {
  const stage = manifests
    .flatMap(({ manifest }) => manifest.stages ?? [])
    .find((s) => s.agent === "workflow-verify")
  assert.ok(stage, "no workflow-verify stage found — wrong path?")
  return stageGlobs(stage)
}

/** OpenCode's matcher: the whole command string against one frontmatter glob. */
const toRe = (glob) => new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "s")
const openCodeAllows = (cmd, globs) => globs.some((g) => toRe(g).test(cmd.trim()))

const JVM_ACCEPTED = [
  "mvn test",
  "mvn clean test",
  "mvn -B test",
  "mvn -q -B clean verify",
  "mvn compile",
  "mvn test-compile",
  "mvn --batch-mode test",
  "mvn -pl core -am test",
  "mvn -Dtest=FooTest test",
  "mvn clean install",
  "mvn package",
  "./mvnw clean verify",
  "./mvnw -B test",
  "gradle clean test",
  "gradle --no-daemon check",
  "./gradlew clean build",
  "./gradlew :core:test",
  "./gradlew -q :app:core:check",
]

test("the VERIFY allowlist accepts idiomatic Maven and Gradle invocations", async () => {
  const { commandAllowed } = await import("../plugins/claude/hooks/src/allowlist.mjs")
  const globs = verifyGlobs()
  const frontmatter = new Set(
    [...fs.readFileSync(path.join(OPENCODE_AGENTS, "workflow-verify.md"), "utf8").matchAll(/^ *"(.+)": allow$/gm)].map((m) => m[1]),
  )
  for (const cmd of JVM_ACCEPTED) {
    assert.ok(commandAllowed(cmd, globs), `Claude/Qwen guard denies "${cmd}" — the manifest glob is goal-position-anchored`)
    assert.ok(openCodeAllows(cmd, [...frontmatter]), `OpenCode denies "${cmd}" — run \`npm run gen:prompts\``)
    // In a worktree the stage is told to prefix the runner; OpenCode needs the twin.
    assert.ok(openCodeAllows(`cd /wt/x && ${cmd}`, [...frontmatter]), `OpenCode denies "${cmd}" inside a worktree`)
  }
})

/**
 * The same position-anchoring lesson, one ecosystem over. A JS package manager
 * puts its WORKSPACE selector before the script name — `npm -w apps/web test`,
 * `pnpm -r test`, `pnpm --filter web test`, `yarn workspace web test` — and
 * berry moves the subcommand entirely (`yarn workspaces foreach run test`). So
 * `npm test*` / `npm run *`, the shapes that serve a single-package repo,
 * matched none of them, and a monorepo's CI commands all fell through to the
 * deny sentinel. That is the failure mode that matters most now that VERIFY's
 * checks are DISCOVERED from what the repo already declares: the plan names the
 * right command, admission refuses it, and the stage quietly runs no checks at
 * all behind one warning line.
 *
 * The flags are ENUMERATED (`npm -w *`, `pnpm --filter*`) rather than tolerated
 * generically (`npm -* test*`). A generic leading-flag form would also match
 * `npm --tag test publish`, since the glob only needs the literal " test"
 * somewhere after the flag — quietly putting publish on a check stage's list.
 * The JVM widening got away with `mvn * test*` because Maven's option syntax
 * (`-Dtest=Foo`) never produces a space-delimited " test"; npm's does.
 *
 * Also here: the local-binary invocations CI uses directly rather than through a
 * script — `pnpm exec <tool>` (the twin of the `npx <tool>` entries), `npx next`,
 * and Turborepo, which is scoped to `turbo run*` so that `turbo login` / `turbo
 * link` — network and auth, not checks — stay off the list.
 */
const JS_WORKSPACE_ACCEPTED = [
  "npm -w apps/web test",
  "npm -w apps/web run build",
  "npm --workspace=apps/web run test",
  "npm --workspaces test",
  "pnpm -r test",
  "pnpm --recursive run lint",
  "pnpm --filter web test",
  "pnpm -F @acme/web run build",
  "yarn workspace web test",
  "yarn workspaces foreach run test",
  "pnpm exec tsc --noEmit",
  "pnpm exec playwright test",
  "pnpm exec next build",
  "npx next build",
  "npx next lint",
  "npx turbo run test",
  "turbo run build",
]

test("the VERIFY allowlist accepts idiomatic workspace-scoped JS invocations", async () => {
  const { commandAllowed } = await import("../plugins/claude/hooks/src/allowlist.mjs")
  const globs = verifyGlobs()
  const frontmatter = new Set(
    [...fs.readFileSync(path.join(OPENCODE_AGENTS, "workflow-verify.md"), "utf8").matchAll(/^ *"(.+)": allow$/gm)].map((m) => m[1]),
  )
  for (const cmd of JS_WORKSPACE_ACCEPTED) {
    assert.ok(commandAllowed(cmd, globs), `Claude/Qwen guard denies "${cmd}" — the manifest glob is subcommand-position-anchored`)
    assert.ok(openCodeAllows(cmd, [...frontmatter]), `OpenCode denies "${cmd}" — run \`npm run gen:prompts\``)
    assert.ok(openCodeAllows(`cd /wt/x && ${cmd}`, [...frontmatter]), `OpenCode denies "${cmd}" inside a worktree`)
  }
})

test("the VERIFY allowlist still refuses to publish a JS package or drive Turborepo's account", async () => {
  const { commandAllowed } = await import("../plugins/claude/hooks/src/allowlist.mjs")
  const globs = verifyGlobs()
  const refused = [
    "npm publish",
    "npm -w apps/web publish",
    // The vector that rules out a generic `npm -* test*`: it carries a literal
    // " test" after a leading flag, so the loose form would have allowed it.
    "npm --tag test publish",
    "pnpm publish -r",
    "pnpm -r publish",
    "yarn npm publish",
    "turbo login",
    "turbo link",
    "npx turbo login",
  ]
  for (const cmd of refused) {
    assert.equal(commandAllowed(cmd, globs), false, `VERIFY allows "${cmd}" — a check stage must never publish or authenticate`)
  }
})

/**
 * The widening must not reach the publish half of either tool's lifecycle: a
 * check stage builds and tests, it never releases. `mvn deploy` / `gradle publish`
 * stay off the list, and (unlike `install`, which writes only to the local `~/.m2`
 * repository the build itself reads) they push artifacts to a remote.
 */
test("the VERIFY allowlist still refuses the JVM publish goals", async () => {
  const { commandAllowed } = await import("../plugins/claude/hooks/src/allowlist.mjs")
  const globs = verifyGlobs()
  for (const cmd of ["mvn deploy", "mvn clean deploy", "mvn release:perform", "./mvnw deploy -B", "gradle publish", "./gradlew publishToMavenLocal"]) {
    assert.equal(commandAllowed(cmd, globs), false, `VERIFY allows "${cmd}" — a check stage must never publish`)
  }
})
