import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { commandAllowed, isFindMutation, REVIEW_ALLOW, VERIFY_ALLOW } from "./src/allowlist.mjs"

/**
 * Find-mutation vectors shared with the core twin
 * (packages/core/src/task/write-backstop.test.ts) via one fixture file, so the
 * two classifiers cannot drift between hosts.
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const findVectors = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "..", "packages", "core", "src", "__fixtures__", "find-abuse-vectors.json"), "utf8"))

test("isFindMutation rejects every shared abuse vector and passes every read-only one", () => {
  for (const cmd of findVectors.mutating) assert.equal(isFindMutation(cmd), true, cmd)
  for (const cmd of findVectors.readOnly) assert.equal(isFindMutation(cmd), false, cmd)
})

test("commandAllowed denies a mutating find even though the allowlist carries `find *`", () => {
  for (const list of [VERIFY_ALLOW, REVIEW_ALLOW]) {
    for (const cmd of findVectors.mutating) assert.equal(commandAllowed(cmd, list), false, cmd)
    // The read-only find forms the glob was written for still pass.
    assert.equal(commandAllowed("find . -name '*.ts'", list), true)
    assert.equal(commandAllowed("find src -type f -newer package.json", list), true)
  }
})

test("commandAllowed denies a mutating find chained behind an allowed read", () => {
  assert.equal(commandAllowed("git status && find . -delete", VERIFY_ALLOW), false)
  assert.equal(commandAllowed("find . -name '*.ts' && git status", VERIFY_ALLOW), true)
})
