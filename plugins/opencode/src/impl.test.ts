import assert from "node:assert/strict"
import { test } from "node:test"
import { clearWorkflow, setWorkflow, type WorkflowState } from "@agentic-workflow/core/workflow/state"
import { parseConfig } from "@agentic-workflow/core/config"
import type { Config } from "./config.ts"
import { agentModelPatch, applyAgentModels, draftModelNote, makeAgenticWorkflow } from "./impl.ts"

/**
 * The worktree-pinning guard in `tool.execute.before`, driven end-to-end through
 * the plugin factory with a fake client. Stage commands run as subtasks, so tool
 * calls arrive with the CHILD session's id — the regression here is the guard
 * reading only `getWorkflow(input.sessionID)` and silently skipping enforcement for
 * every stage subagent (edits landed in the human's main tree).
 */

type Hooks = { "tool.execute.before": (input: { sessionID: string; tool: string; callID: string }, output: { args: Record<string, unknown> }) => Promise<void> }

const makeHooks = async (
  sessions: Record<string, string | undefined>,
  opts: { failSessionApi?: boolean; failShell?: boolean; configJson?: string } = {},
): Promise<Hooks> => {
  const client = {
    app: { log: async () => {} },
    file: {
      read: async () =>
        opts.configJson === undefined ? Promise.reject(new Error("no config file")) : { data: { content: opts.configJson } },
    },
    session: {
      get: async ({ path: { id } }: { path: { id: string } }) => {
        if (opts.failSessionApi) throw new Error("session API down")
        return { data: { parentID: sessions[id] } }
      },
    },
    tui: { showToast: async () => {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  // A Bun shell that throws stands in for any hard failure inside the plugin's
  // deterministic half (spawn refused, git missing, fs error) — the command hook
  // must not let that failure hand the model the rendered body.
  const $ = (() => {
    if (opts.failShell) throw new Error("shell unavailable")
    return { quiet: () => ({ nothrow: () => Promise.resolve({ exitCode: 1, stdout: "" }) }) }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
  return (await makeAgenticWorkflow({ client, directory: "/repo", $, worktree: "/repo" } as never)) as unknown as Hooks
}

const worktreeWorkflow = (): WorkflowState => ({
  goal: "Do it",
  stage: "build",
  iteration: 0,
  artifacts: {},
  task: { id: "t", path: "/repo/docs/tasks/in-progress/t.md", acceptance: [] },
  git: { base: "main", branch: "feature/t", worktree: "/repo/.worktrees/t" },
  isolated: true,
})

test("worktree pinning fires for a stage subagent's child session (the dead-guard regression)", async () => {
  setWorkflow("drv", worktreeWorkflow())
  try {
    const hooks = await makeHooks({ child: "drv" })
    // A main-tree path is REMAPPED onto the worktree mirror, even though the
    // call carries the CHILD id. Refusing it made the agent retry the same edit
    // on the current branch; correcting it lands the work where it belongs.
    const mainTree = { args: { filePath: "/repo/src/x.ts" } }
    await hooks["tool.execute.before"]({ sessionID: "child", tool: "write", callID: "c1" }, mainTree)
    assert.equal(mainTree.args.filePath, "/repo/.worktrees/t/src/x.ts")
    // A relative path resolves against the worktree, not the main tree's cwd.
    const relative = { args: { filePath: "src/x.ts" } }
    await hooks["tool.execute.before"]({ sessionID: "child", tool: "edit", callID: "c2" }, relative)
    assert.equal(relative.args.filePath, "/repo/.worktrees/t/src/x.ts")
    // Already inside the worktree → untouched.
    const inside = { args: { filePath: "/repo/.worktrees/t/src/x.ts" } }
    await hooks["tool.execute.before"]({ sessionID: "child", tool: "write", callID: "c3" }, inside)
    assert.equal(inside.args.filePath, "/repo/.worktrees/t/src/x.ts")
    // A path under neither tree has no worktree equivalent → still refused.
    await assert.rejects(
      () => hooks["tool.execute.before"]({ sessionID: "child", tool: "write", callID: "c4" }, { args: { filePath: "/etc/passwd" } }),
      /outside both it and the repo/,
    )
    // The worktree's frozen backlog copy stays off-limits (the always-on backlog
    // guard reaches it first; the worktree pin is the second line behind it).
    await assert.rejects(
      () =>
        hooks["tool.execute.before"](
          { sessionID: "child", tool: "write", callID: "c5" },
          { args: { filePath: "/repo/.worktrees/t/docs/tasks/in-progress/t.md" } },
        ),
      /docs\/tasks|driver-owned/,
    )
  } finally {
    clearWorkflow("drv")
  }
})

test("a session with no loop ancestor is untouched while a worktree loop runs elsewhere", async () => {
  setWorkflow("drv", worktreeWorkflow())
  try {
    const hooks = await makeHooks({ stranger: undefined })
    await hooks["tool.execute.before"]({ sessionID: "stranger", tool: "write", callID: "c1" }, { args: { filePath: "/elsewhere/x.ts" } })
  } finally {
    clearWorkflow("drv")
  }
})

test("session-API failure while a worktree loop is live fails CLOSED for edit tools", async () => {
  setWorkflow("drv", worktreeWorkflow())
  try {
    const hooks = await makeHooks({}, { failSessionApi: true })
    await assert.rejects(
      () => hooks["tool.execute.before"]({ sessionID: "child", tool: "write", callID: "c1" }, { args: { filePath: "/repo/src/x.ts" } }),
      /could not be attributed/,
    )
  } finally {
    clearWorkflow("drv")
  }
})

test("bash is pinned to the worktree while a worktree loop drives (the sometimes-builds-in-main-tree bug)", async () => {
  setWorkflow("drv", worktreeWorkflow())
  try {
    const hooks = await makeHooks({ child: "drv" })
    // Unpinned mutating command → would run in the main tree → prefix inserted.
    const unpinned = { args: { command: "npm test" } }
    await hooks["tool.execute.before"]({ sessionID: "child", tool: "bash", callID: "c1" }, unpinned)
    assert.equal(unpinned.args.command, "cd /repo/.worktrees/t && npm test")
    // Already cd-pinned → untouched.
    const pinned = { args: { command: "cd /repo/.worktrees/t && npm test" } }
    await hooks["tool.execute.before"]({ sessionID: "child", tool: "bash", callID: "c2" }, pinned)
    assert.equal(pinned.args.command, "cd /repo/.worktrees/t && npm test")
    // Read-only inspection stays allowed unpinned and unchanged.
    const readOnly = { args: { command: "git status" } }
    await hooks["tool.execute.before"]({ sessionID: "child", tool: "bash", callID: "c3" }, readOnly)
    assert.equal(readOnly.args.command, "git status")
    // Escaping cd → no prefix can fix it → refused.
    await assert.rejects(
      () => hooks["tool.execute.before"]({ sessionID: "child", tool: "bash", callID: "c4" }, { args: { command: "cd /repo/.worktrees/t && cd .. && rm -rf x" } }),
      /leaves it/,
    )
    // Writing to an absolute main-tree path from inside a pinned chain → refused.
    await assert.rejects(
      () =>
        hooks["tool.execute.before"](
          { sessionID: "child", tool: "bash", callID: "c5" },
          { args: { command: "cd /repo/.worktrees/t && cp dist/a.js /repo/dist/a.js" } },
        ),
      /reaches \/repo\/dist\/a\.js/,
    )
  } finally {
    clearWorkflow("drv")
  }
})

test("bash in a session with no loop ancestor is untouched while a worktree loop runs elsewhere", async () => {
  setWorkflow("drv", worktreeWorkflow())
  try {
    const hooks = await makeHooks({ stranger: undefined })
    await hooks["tool.execute.before"]({ sessionID: "stranger", tool: "bash", callID: "c1" }, { args: { command: "npm test" } })
  } finally {
    clearWorkflow("drv")
  }
})

test("session-API failure while a worktree loop is live fails CLOSED for bash too", async () => {
  setWorkflow("drv", worktreeWorkflow())
  try {
    const hooks = await makeHooks({}, { failSessionApi: true })
    await assert.rejects(
      () => hooks["tool.execute.before"]({ sessionID: "child", tool: "bash", callID: "c1" }, { args: { command: "npm test" } }),
      /could not be attributed/,
    )
  } finally {
    clearWorkflow("drv")
  }
})

test("edits to the worktree's frozen backlog copy are refused (task files are driver-owned)", async () => {
  setWorkflow("drv", worktreeWorkflow())
  try {
    const hooks = await makeHooks({ child: "drv" })
    // Status-folder copy: already denied by the always-on backlog guard.
    await assert.rejects(
      () =>
        hooks["tool.execute.before"](
          { sessionID: "child", tool: "edit", callID: "c1" },
          { args: { filePath: "/repo/.worktrees/t/docs/tasks/in-progress/t.md" } },
        ),
      /direct edits under docs\/tasks/,
    )
    // The backlog guard's draft carve-out must NOT extend to the worktree's
    // frozen copy — a draft written there rides the feature branch.
    await assert.rejects(
      () =>
        hooks["tool.execute.before"](
          { sessionID: "child", tool: "write", callID: "c2" },
          { args: { filePath: "/repo/.worktrees/t/docs/tasks/draft/new-idea.md" } },
        ),
      /driver-owned/,
    )
  } finally {
    clearWorkflow("drv")
  }
})

test("no live loop → no session walk, edits pass through", async () => {
  const hooks = await makeHooks({}, { failSessionApi: true }) // API failure must not matter when nothing is live
  await hooks["tool.execute.before"]({ sessionID: "any", tool: "write", callID: "c1" }, { args: { filePath: "/anywhere/x.ts" } })
})

/**
 * The command-hook success-path override: a report-and-stop verb (watch, claim,
 * status, unwatch, …) is fully handled in the plugin, but its only signal is a
 * toast the model can't see, while the descriptive command template still
 * renders. The hook must replace that template with the plugin's outcome so the
 * model reports the action instead of reading it as information. Pass-through
 * verbs (new/retask/approve/remove) must be left untouched.
 */
type CmdHooks = {
  "command.execute.before": (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts?: Array<{ type?: string; text?: string }> },
  ) => Promise<void>
}

const TEMPLATE = "ORIGINAL RENDERED COMMAND TEMPLATE — a description of the loop."

/** A body marked up the way the real engineering command is (see command-slice.ts). */
const MARKED_TEMPLATE = [
  "shared preamble",
  "<!-- aw:verb new -->",
  "interview the user, then spawn the plan author",
  "<!-- /aw:verb new -->",
  "<!-- aw:verb claim -->",
  "claim the next build-ready task",
  "<!-- /aw:verb claim -->",
  "never touch docs/tasks yourself",
].join("\n")

const runCommand = async (args: string, output: { parts?: Array<{ type?: string; text?: string }> }, configJson?: string) => {
  const hooks = (await makeHooks({}, configJson === undefined ? {} : { configJson })) as unknown as CmdHooks
  await hooks["command.execute.before"]({ command: "agentic-workflow:engineering", sessionID: "ses_c", arguments: args }, output)
  return output
}

test("command hook overrides the rendered template with the outcome for a report-and-stop verb", async () => {
  const output = { parts: [{ type: "text", text: TEMPLATE }] }
  // `unwatch` on the default-enabled engineering kind completes deterministically
  // and returns its outcome; the hook must feed that back into the prompt.
  await runCommand("unwatch", output)
  assert.notEqual(output.parts[0]!.text, TEMPLATE, "the descriptive template must be replaced")
  assert.match(output.parts[0]!.text!, /Report exactly that result to the user and stop/)
})

test("command hook passes an unmarked template through untouched", async () => {
  const output = { parts: [{ type: "text", text: TEMPLATE }] }
  // The sitter commands carry no markers; their bodies must survive byte-identical.
  await runCommand("new add rate limiting", output)
  assert.equal(output.parts[0]!.text, TEMPLATE, "nothing to slice means nothing to change")
})

test("command hook slices a marked template to the invoked verb for a pass-through verb", async () => {
  const output = { parts: [{ type: "text", text: MARKED_TEMPLATE }] }
  // `new` needs the model's interview turn, so its instructions must survive —
  // but every other verb's must not, and the markers must not reach the model.
  await runCommand("new add rate limiting", output)
  const text = output.parts[0]!.text!
  assert.match(text, /interview the user/, "the invoked verb's block must survive")
  assert.match(text, /shared preamble/)
  assert.match(text, /never touch docs\/tasks yourself/, "shared prose must survive")
  assert.doesNotMatch(text, /claim the next build-ready task/, "another verb's block must be gone")
  assert.doesNotMatch(text, /aw:verb/, "markers must not reach the model")
})

test("command hook slices on the quote-trimmed verb, matching what $1 renders", async () => {
  const output = { parts: [{ type: "text", text: MARKED_TEMPLATE }] }
  // opencode's $1 placeholder reads the first token quote-aware and trims the
  // quotes, so `'new' …` renders `Verb: new` — the slice must agree with it
  // rather than fall back to the full body on the verb `'new'`.
  await runCommand("'new' add rate limiting", output)
  const text = output.parts[0]!.text!
  assert.match(text, /interview the user/, "the quoted verb must still slice to new's block")
  assert.doesNotMatch(text, /claim the next build-ready task/)
})

test("a verb whose block slices to nothing keeps the full body, not just the draft note", async () => {
  // `base = sliced ?? rendered` treated an EMPTY slice as a usable one, so a
  // verb block that tidies to nothing plus a configured drafting model replaced
  // the entire command body with the model sentence: no task, no prohibitions,
  // no usage. An empty slice is not a slice — fall back like a missing one.
  // Every line sits inside a verb block, and the invoked verb's block is blank —
  // so the slice really is empty rather than "shared prose only".
  const emptyBlock = [
    "<!-- aw:verb new -->",
    "",
    "<!-- /aw:verb new -->",
    "<!-- aw:verb claim -->",
    "claim the next build-ready task",
    "<!-- /aw:verb claim -->",
  ].join("\n")
  const output = { parts: [{ type: "text", text: emptyBlock }] }
  await runCommand("new add rate limiting", output, JSON.stringify({ agentModels: { "workflow-task-author": "anthropic/claude-haiku-4-5" } }))
  const text = output.parts[0]!.text!
  assert.match(text, /workflow-task-author/, "the drafting model note still rides along")
  assert.ok(text.replace(/Invoke the[\s\S]*$/, "").trim().length > 0, "the note must not be the ENTIRE body")
})

test("the gate verbs are report-and-stop: the gate outcome replaces the rendered template", async () => {
  // Core self-verifies the moves, so no model turn glob-verifies them — the
  // hook must feed the deterministic outcome back as the whole prompt.
  for (const args of ["replan my-task too vague", "approve my-task", "remove my-task", "abandon my-task superseded"]) {
    const output = { parts: [{ type: "text", text: MARKED_TEMPLATE }] }
    await runCommand(args, output)
    assert.match(output.parts[0]!.text!, /Report exactly that result to the user and stop/, args)
    assert.doesNotMatch(output.parts[0]!.text!, /interview the user/, "the descriptive template must be gone")
  }
})

test("the outcome override still wins over the slice for a report-and-stop verb", async () => {
  const output = { parts: [{ type: "text", text: MARKED_TEMPLATE }] }
  await runCommand("unwatch", output)
  assert.match(output.parts[0]!.text!, /Report exactly that result to the user and stop/)
  assert.doesNotMatch(output.parts[0]!.text!, /aw:verb/)
})

test("command hook slices a template split across text parts", async () => {
  // opencode owns how it chunks the rendered body; a marker may straddle parts.
  const half = MARKED_TEMPLATE.indexOf("<!-- aw:verb claim")
  const output = {
    parts: [
      { type: "text", text: MARKED_TEMPLATE.slice(0, half) },
      { type: "text", text: MARKED_TEMPLATE.slice(half) },
    ],
  }
  await runCommand("new add rate limiting", output)
  assert.match(output.parts[0]!.text!, /interview the user/)
  assert.doesNotMatch(output.parts[0]!.text!, /claim the next build-ready task/)
  assert.equal(output.parts[1]!.text, "", "no leftover template text may survive in a later part")
})

/**
 * The failure path. The slice has already written the invoked verb's prose to
 * `output` by the time the plugin dispatches, so a throw in the deterministic
 * half is the ONE path on which a report-and-stop verb's description of PLUGIN
 * work becomes the model's instructions — the `if (outcome)` override that
 * normally replaces it never runs. Both dispatch orders must be covered:
 * `approve`/`replan` run the gate move before reconciling, every other verb
 * reconciles first.
 */
const FAILURE_TEMPLATE = [
  "shared preamble",
  "<!-- aw:verb recover -->",
  "re-claim the task and resume from its state snapshot",
  "<!-- /aw:verb recover -->",
  "<!-- aw:verb retask -->",
  "interview the user and reshape the draft in place",
  "<!-- /aw:verb retask -->",
  "never touch docs/tasks yourself",
].join("\n")

const runFailingCommand = async (args: string): Promise<string> => {
  const output = { parts: [{ type: "text", text: FAILURE_TEMPLATE }] }
  const hooks = (await makeHooks({}, { failShell: true })) as unknown as CmdHooks
  await hooks["command.execute.before"]({ command: "agentic-workflow:engineering", sessionID: "ses_f", arguments: args }, output)
  return output.parts[0]!.text!
}

test("a throw in the deterministic half overrides the body instead of leaving it as instructions", async () => {
  const text = await runFailingCommand("recover t1")
  assert.match(text, /FAILED while running/, "a toast is invisible to the model — the failure must be in the prompt")
  assert.match(text, /shell unavailable/, "the real error must reach the user")
  assert.doesNotMatch(text, /resume from its state snapshot/, "the verb's description of plugin work must not survive as instructions")
  assert.doesNotMatch(text, /aw:verb/, "markers must not reach the model")
  assert.doesNotMatch(text, /already ran/, "the success override must not claim the work landed")
})

test("the failure override is inert when the deterministic half succeeds", async () => {
  // The guard must not cost the pass-through verbs their body. `retask` needs
  // its prose — the interview and rewrite are the model's turn — so a
  // catch-all that fired on any swallowed internal error would silently break
  // it. The plugin's own refusal (no such task) is handled, not thrown.
  const output = { parts: [{ type: "text", text: FAILURE_TEMPLATE }] }
  const hooks = (await makeHooks({})) as unknown as CmdHooks
  await hooks["command.execute.before"]({ command: "agentic-workflow:engineering", sessionID: "ses_g", arguments: "retask t1" }, output)
  const text = output.parts[0]!.text!
  assert.match(text, /reshape the draft in place/, "a pass-through verb keeps its instructions")
  assert.doesNotMatch(text, /FAILED while running/, "no throw means no failure override")
  assert.doesNotMatch(text, /resume from its state snapshot/, "still sliced to the invoked verb")
})

/**
 * `agentModels` — the model source for the drafting invocation, which is not a
 * stage run and so has no StageDef and no fire payload to carry one.
 */
test("draftModelNote names the configured drafting model for new and retask only", () => {
  const config = parseConfig({ agentModels: { "workflow-task-author": "anthropic/claude-haiku-4-5" } }) as Config
  for (const verb of ["new", "retask"]) {
    const note = draftModelNote(config, "engineering", verb)
    assert.match(note!, /`workflow-task-author` subagent with the model `anthropic\/claude-haiku-4-5`/, verb)
    // OpenCode takes provider-qualified ids, so the prefix must survive here —
    // only the Claude host strips it (bareModel).
    assert.match(note!, /anthropic\//, "the provider prefix must not be stripped on this host")
    assert.match(note!, /drafting invocation only/, "it must not read as retargeting the PLAN stage")
  }
  // `plan`'s invocation IS the PLAN stage — stageModels governs it, and naming
  // agentModels here would give the model two competing answers.
  assert.equal(draftModelNote(config, "engineering", "plan"), null)
  assert.equal(draftModelNote(config, "engineering", "claim"), null)
  assert.equal(draftModelNote(config, "pr-sitter", "new"), null, "the knob is engineering's drafting path only")
})

test("draftModelNote is silent when no drafting model is configured", () => {
  const bare = parseConfig({}) as Config
  assert.equal(draftModelNote(bare, "engineering", "new"), null)
  const other = parseConfig({ agentModels: { "workflow-plan": "haiku" } }) as Config
  assert.equal(draftModelNote(other, "engineering", "new"), null, "a different agent's entry must not leak in")
})

/**
 * The deterministic half of the same knob: the `config` hook binds
 * `agent.<name>.model` so the drafting and ad-hoc spawns — which the MODEL
 * initiates, out of reach of `session.command({ model })` — pick the configured
 * model up as an opencode setting rather than as a request in a prompt.
 */
test("agentModelPatch keeps the provider prefix and ignores junk", () => {
  assert.deepEqual(agentModelPatch({ agentModels: { "workflow-plan": "anthropic/claude-haiku-4-5" } }), {
    // OpenCode takes provider-qualified ids; only Claude (alias enum) and Qwen
    // (bare ids) narrow them.
    "workflow-plan": "anthropic/claude-haiku-4-5",
  })
  assert.deepEqual(agentModelPatch({ agentModels: { a: "  haiku  " } }), { a: "haiku" })
  for (const raw of [null, undefined, 42, "nope", {}, { agentModels: null }, { agentModels: 42 }, { agentModels: [] }]) {
    assert.deepEqual(agentModelPatch(raw), {}, `raw: ${JSON.stringify(raw)}`)
  }
  assert.deepEqual(agentModelPatch({ agentModels: { a: 42, b: "", c: "   ", d: null } }), {})
})

test("applyAgentModels writes only agent.<name>.model, creating the map when absent", () => {
  const config: { agent?: Record<string, { model?: string } | undefined> } = {}
  assert.deepEqual(applyAgentModels(config, { "workflow-plan": "anthropic/x" }), ["workflow-plan"])
  assert.deepEqual(config, { agent: { "workflow-plan": { model: "anthropic/x" } } })
})

test("applyAgentModels leaves an agent we do not name completely alone", () => {
  const config = { agent: { "workflow-verify": { model: "user/choice" } } }
  assert.deepEqual(applyAgentModels(config, { "workflow-plan": "ours/x" }), ["workflow-plan"])
  assert.equal(config.agent["workflow-verify"].model, "user/choice")
})

test("naming an agent the user also configured overrides only its model, preserving the rest", () => {
  // `agentModels` is the more specific instruction, so it wins — but a user's
  // permission/tools settings for that agent are not ours to discard.
  const config = { agent: { "workflow-plan": { model: "user/choice", temperature: 0.2, tools: { bash: false } } } }
  applyAgentModels(config, { "workflow-plan": "ours/x" })
  assert.deepEqual(config.agent["workflow-plan"], { model: "ours/x", temperature: 0.2, tools: { bash: false } })
})

test("an empty patch touches nothing at all — not even to create the agent map", () => {
  const config: { agent?: Record<string, { model?: string } | undefined> } = {}
  assert.deepEqual(applyAgentModels(config, {}), [])
  assert.deepEqual(config, {}, "a default install must see a byte-identical config")
})

test("unrelated config keys survive applyAgentModels verbatim", () => {
  const config = { model: "session/default", theme: "dark", agent: { other: { model: "keep/me" } } }
  applyAgentModels(config, { "workflow-plan": "ours/x" })
  assert.deepEqual(config, {
    model: "session/default",
    theme: "dark",
    agent: { other: { model: "keep/me" }, "workflow-plan": { model: "ours/x" } },
  })
})
