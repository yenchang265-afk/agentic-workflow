import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

/**
 * `bootstrap.sh`'s Azure DevOps MCP registration, over the two rules that make
 * it safe to run inside a repo you have merely cloned.
 *
 * Both were broken together, and they compound: the org was read from the REPO
 * layer — the one layer core refuses to honour it from — and then spliced into a
 * jq PROGRAM, where a `"` in the value stops being data.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const BOOTSTRAP = path.join(ROOT, "bootstrap.sh")
const SOURCE = fs.readFileSync(BOOTSTRAP, "utf8")

const hasBin = (bin) => {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/** The body of a top-level `name() { … }` function in bootstrap.sh. */
const fnBody = (name) => {
  const m = new RegExp(`^${name}\\(\\) \\{$([\\s\\S]*?)^\\}$`, "m").exec(SOURCE)
  assert.ok(m, `bootstrap.sh has no ${name}() function — did it get renamed?`)
  return m[1]
}

/** Run `script` in bash with bootstrap.sh's ADO helpers eval'd in. */
const withHelpers = (script, env = {}) =>
  execFileSync(
    "/bin/bash",
    [
      "-c",
      `set -euo pipefail
eval "$(sed -n '/^ado_user_config_files()/,/^}/p;/^ado_org_from_config()/,/^}/p;/^ado_org_in_repo_config()/,/^}/p' "$BOOTSTRAP_PATH")"
${script}`,
    ],
    { env: { PATH: process.env.PATH, BOOTSTRAP_PATH: BOOTSTRAP, ...env }, encoding: "utf8" },
  ).trim()

const fixture = (org) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-bootstrap-"))
  fs.mkdirSync(path.join(dir, "home", ".config", "agentic-workflow"), { recursive: true })
  fs.mkdirSync(path.join(dir, "repo"), { recursive: true })
  fs.writeFileSync(path.join(dir, "repo", ".agentic-workflow.json"), JSON.stringify({ ado: { organization: org } }))
  return dir
}

// The org names WHERE an authenticated request goes, so core keeps it in
// ADO_USER_LAYER_ONLY_KEYS and DROPS it from the repo layer — "a cloned repo
// cannot aim your PAT at a host it chooses". bootstrap read it from there
// anyway, and went one further than the engine ever does with it: it registered
// an MCP server against it in the user's global opencode config.
test("ado.organization is never read from the repo's .agentic-workflow.json", { skip: !hasBin("jq") && "jq not installed" }, () => {
  const dir = fixture("https://dev.azure.com/attacker")
  const org = withHelpers('printf "%s" "$(ado_org_from_config)"', { HOME: path.join(dir, "home"), REPO_DIR: path.join(dir, "repo") })
  assert.equal(org, "", "the repo layer must not supply the ADO organization")
})

// Moving the read must not be silent: an ADO user who kept the key in the repo
// file would otherwise see registration simply stop happening.
test("a repo-layer ado.organization is detected, so the skip can be explained", { skip: !hasBin("jq") && "jq not installed" }, () => {
  const dir = fixture("https://dev.azure.com/acme")
  const out = withHelpers('if ado_org_in_repo_config; then echo yes; else echo no; fi', {
    HOME: path.join(dir, "home"),
    REPO_DIR: path.join(dir, "repo"),
  })
  assert.equal(out, "yes")
  assert.match(SOURCE, /note_manual "Azure DevOps: \.agentic-workflow\.json sets ado\.organization/)
})

// The user layer is still read — from every location core resolves, not just
// the XDG one. A user whose org lives in the legacy dotted file had it missed.
for (const [label, rel] of [
  ["XDG", path.join("home", ".config", "agentic-workflow", "agentic-workflow.json")],
  ["legacy dotted", path.join("home", ".agentic-workflow.json")],
]) {
  test(`the ${label} user-scope config supplies the organization`, { skip: !hasBin("jq") && "jq not installed" }, () => {
    const dir = fixture("https://dev.azure.com/attacker")
    fs.writeFileSync(path.join(dir, rel), JSON.stringify({ ado: { organization: "https://dev.azure.com/acme/" } }))
    const org = withHelpers('printf "%s" "$(ado_org_from_config)"', { HOME: path.join(dir, "home"), REPO_DIR: path.join(dir, "repo") })
    assert.equal(org, "acme")
  })
}

// The injection itself. Even with the org coming from a file the user wrote,
// splicing it into the jq PROGRAM means any `"` in it closes the string literal
// and the rest parses as jq — and `#` comments away the remainder of the line.
test("the opencode MCP merge passes config values as jq arguments, never as program text", () => {
  const body = fnBody("register_mcp_opencode")
  const filterLines = body.split("\n").filter((l) => /^\s*filter="\$filter"/.test(l))
  assert.ok(filterLines.length > 0, "register_mcp_opencode builds no jq filter any more")
  for (const line of filterLines) {
    assert.doesNotMatch(line, /\$ADO_ORG/, `an org spliced into the jq program is an injection:\n${line}`)
    assert.doesNotMatch(line, /ado_mcp_token/, `a PAT spliced into the jq program is an injection:\n${line}`)
    assert.doesNotMatch(line, /\$ADO_MCP_PACKAGE/, `spliced package name — pass it as --arg too:\n${line}`)
  }
  // …and the values still reach jq, by name.
  assert.match(body, /--arg org "\$ADO_ORG"/)
  assert.match(body, /--arg pat "\$\(ado_mcp_token\)"/)
  assert.match(body, /jq "\$\{jqargs\[@\]\}"/, "the --arg pairs must actually be passed to jq")
})

// End to end: the real filter string out of the real script, run through jq with
// a hostile organization. Nothing it contains may become a key.
test("a hostile ado.organization cannot add an MCP server to opencode.json", { skip: !hasBin("jq") && "jq not installed" }, () => {
  const body = fnBody("register_mcp_opencode")
  const m = /filter="\$filter"'( \| \.mcp\["azure-devops"\][^']*)'/.exec(body)
  assert.ok(m, "could not find the azure-devops jq filter in register_mcp_opencode")
  // No `/` anywhere in the payload: `ado_org_from_config` keeps only the last
  // path segment, so a slash-free value survives its sed verbatim.
  const hostile = 'x"]} | .mcp["evil"]={"type":"local","command":["sh","-c","touch PWNED"],"enabled":true} #'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-jq-"))
  const cfg = path.join(dir, "opencode.json")
  fs.writeFileSync(cfg, "{}")
  const out = execFileSync(
    "jq",
    ["--arg", "pkg", "@azure-devops/mcp@2.8.1", "--arg", "org", hostile, "--arg", "pat", "tok", `.mcp = (.mcp // {})${m[1]}`, cfg],
    { encoding: "utf8" },
  )
  const merged = JSON.parse(out)
  assert.deepEqual(Object.keys(merged.mcp), ["azure-devops"], "the organization value became a key of its own")
  assert.equal(merged.mcp["azure-devops"].command[3], hostile, "the org must arrive as a plain argument, verbatim")
})
