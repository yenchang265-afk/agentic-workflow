import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

/**
 * No stage subagent may ask the human. A drive is unattended between the plan
 * gate and the ship gate, so a question dialog opened mid-stage stalls the run
 * on someone who may not be at the terminal — and on a `watch` worker, on
 * nobody at all. A stage's uncertainty belongs in a FAIL/ERROR verdict or
 * `workflow_blocked`, both of which keep the loop's control flow.
 *
 * The three hosts get there differently, which is the whole reason this test
 * exists:
 *
 * - Claude Code and Qwen Code agents declare an explicit `tools:` ENUMERATION,
 *   so they exclude the ask tool by construction — correct today only because
 *   nobody has added it to a list. This test states it.
 * - OpenCode agents declare only `permission:`, and an OpenCode agent inherits
 *   every tool the host ships unless it says otherwise. That is how `question`
 *   (shipped in @opencode-ai/plugin 1.18.5) reached all of them at once,
 *   unannounced, and stalled unattended drives mid-VERIFY. A new agent added to
 *   `prompts/agents/` inherits the hole the same way — hence a test over the
 *   GENERATED files, which is where the hole would appear.
 *
 * Both OpenCode keys are required: `tools.question: false` removes the tool so
 * the model never sees it, `permission.question: deny` refuses the call if the
 * tools map is ever bypassed or that key renamed. They fail at different layers
 * and both fail SILENTLY, which is why neither alone is enough.
 *
 * The plugin's `tool.execute.before` guard is the third layer (see
 * `plugins/opencode/src/impl.test.ts`) — it is the only one that does not
 * depend on a host config key behaving as documented.
 */

const ROOT = path.join(import.meta.dirname, "..")
const OPENCODE_AGENTS = path.join(ROOT, "plugins", "opencode", "agents")
const ENUMERATED = [
  { dir: path.join(ROOT, "plugins", "claude", "agents"), host: "claude", ask: "AskUserQuestion" },
  { dir: path.join(ROOT, "plugins", "qwen", "agents"), host: "qwen", ask: "ask_user_question" },
]

/** Frontmatter of an agent file, or null when it doesn't open with one. */
const frontmatter = (file) => {
  const m = fs.readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  return m ? m[1] : null
}

const agentFiles = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()

test("every generated OpenCode agent denies the question tool, both ways", () => {
  const offences = []
  let checked = 0
  for (const file of agentFiles(OPENCODE_AGENTS)) {
    const fm = frontmatter(path.join(OPENCODE_AGENTS, file))
    if (fm === null) {
      offences.push(`${file}: no frontmatter block`)
      continue
    }
    // Both keys are nested one level (under `permission:` / `tools:`), so the
    // indentation is part of the match — a top-level `question:` would be a
    // different setting entirely.
    if (!/^ +question: deny$/m.test(fm)) offences.push(`${file}: no "question: deny" under permission:`)
    if (!/^ +question: false$/m.test(fm)) offences.push(`${file}: no "question: false" under tools:`)
    checked++
  }
  assert.deepEqual(offences, [], `edit prompts/agents/<name>/opencode.yaml and re-run \`pnpm gen:prompts\`:\n${offences.join("\n")}`)
  assert.ok(checked > 0, "no generated OpenCode agent found — wrong path?")
})

test("no Claude or Qwen agent lists an ask tool in its tools enumeration", () => {
  const offences = []
  let checked = 0
  for (const { dir, host, ask } of ENUMERATED) {
    for (const file of agentFiles(dir)) {
      const fm = frontmatter(path.join(dir, file))
      if (fm === null) {
        offences.push(`${host}/${file}: no frontmatter block`)
        continue
      }
      if (fm.includes(ask)) offences.push(`${host}/${file}: lists ${ask} — a stage subagent must not be able to ask`)
      checked++
    }
  }
  assert.deepEqual(offences, [], offences.join("\n"))
  assert.ok(checked > 0, "no generated Claude/Qwen agent found — wrong path?")
})
