import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * The installers' closing block (design 66): the LAST thing a successful
 * install prints names the first command to type per host. Source-grep tests
 * in the style of bootstrap-ado.test.mjs — the scripts are not executed.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

test("install.sh and install.ps1 both end on next_steps for every plugin target, naming init before new", () => {
  const sh = read("install.sh")
  const ps = read("install.ps1")
  assert.match(sh, /\ncase "\$TARGET" in\n  opencode\|claude\|qwen\|all\) next_steps "\$TARGET" ;;\nesac\s*$/)
  assert.match(ps, /\nif \(\$Target -in @\('opencode', 'claude', 'qwen', 'all'\)\) \{ Write-NextSteps \$Target \}\s*$/)
  for (const text of [sh, ps]) {
    const block = text.slice(text.indexOf("== next: what to type first =="))
    for (const host of ["OpenCode:", "Claude Code:", "Qwen Code:", "Hub:"]) assert.ok(block.includes(host), host)
    const init = block.indexOf("engineering init")
    const first = block.indexOf("engineering new <idea>")
    assert.ok(init !== -1 && first !== -1 && init < first, "init is named before new")
  }
})

test("the standalone Claude installer and bootstrap.sh close on the same first commands", () => {
  for (const rel of ["plugins/claude/install.sh", "plugins/claude/install.ps1", "bootstrap.sh"]) {
    const text = read(rel)
    const init = text.lastIndexOf("/agentic-workflow:engineering init")
    const first = text.lastIndexOf("/agentic-workflow:engineering new <idea>")
    assert.ok(init !== -1, `${rel} names init`)
    assert.ok(first !== -1 && init < first, `${rel} names init before new`)
  }
})

test("no installer still sends the human to `status` as the first move", () => {
  for (const rel of ["install.sh", "install.ps1"]) {
    assert.doesNotMatch(read(rel), /then run \/agentic-workflow:engineering status/)
  }
})
