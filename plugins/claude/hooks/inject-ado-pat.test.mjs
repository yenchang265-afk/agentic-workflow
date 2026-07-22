import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * The SessionStart PAT hook, exercised as a subprocess (it has no exports —
 * its whole surface is stdin + env + the $CLAUDE_ENV_FILE side effect).
 * Layering contract: env var wins outright, then the repo's
 * `.agentic-workflow.json`, then the user-scope file ($AGENTIC_WORKFLOW_USER_CONFIG,
 * "" disabling the layer).
 */

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "inject-ado-pat.mjs")

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "inject-ado-pat-"))

/** Run the hook with a repo config, a user config, and extra env; return the env file's content. */
const runHook = ({ repoCfg, userCfg, env = {} }) => {
  const cwd = tempDir()
  if (repoCfg !== undefined) fs.writeFileSync(path.join(cwd, ".agentic-workflow.json"), JSON.stringify(repoCfg))
  const userFile = path.join(tempDir(), ".agentic-workflow.json")
  if (userCfg !== undefined) fs.writeFileSync(userFile, JSON.stringify(userCfg))
  const envFile = path.join(tempDir(), "env")
  fs.writeFileSync(envFile, "")
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd }),
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      AGENTIC_WORKFLOW_USER_CONFIG: userCfg !== undefined ? userFile : "",
      ...env,
    },
  })
  assert.equal(res.status, 0, String(res.stderr))
  return fs.readFileSync(envFile, "utf8")
}

test("repo ado.pat wins over the user layer", () => {
  const out = runHook({ repoCfg: { ado: { pat: "repo-pat" } }, userCfg: { ado: { pat: "user-pat" } } })
  assert.equal(out, "export AZURE_DEVOPS_EXT_PAT='repo-pat'\n")
})

test("user-scope ado.pat fills in when the repo has none", () => {
  const out = runHook({ repoCfg: { codePlatform: "ado" }, userCfg: { ado: { pat: "user-pat" } } })
  assert.equal(out, "export AZURE_DEVOPS_EXT_PAT='user-pat'\n")
})

test("user layer alone suffices (no repo config file)", () => {
  const out = runHook({ userCfg: { ado: { pat: "user-pat" } } })
  assert.equal(out, "export AZURE_DEVOPS_EXT_PAT='user-pat'\n")
})

test("an exported AZURE_DEVOPS_EXT_PAT wins — nothing written", () => {
  const out = runHook({
    repoCfg: { ado: { pat: "repo-pat" } },
    userCfg: { ado: { pat: "user-pat" } },
    env: { AZURE_DEVOPS_EXT_PAT: "env-pat" },
  })
  assert.equal(out, "")
})

test("no pat anywhere → nothing written", () => {
  const out = runHook({ repoCfg: { codePlatform: "github" } })
  assert.equal(out, "")
})
