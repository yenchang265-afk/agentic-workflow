import assert from "node:assert/strict"
import { test } from "node:test"
import { isUnknownAsset, knownNames } from "./assets.js"

test("knownNames maps inventories and tolerates a missing one", () => {
  assert.deepEqual(knownNames([{ name: "a" }, { name: "b" }]), ["a", "b"])
  assert.deepEqual(knownNames(undefined), [])
})

test("isUnknownAsset flags only non-empty values absent from the inventory", () => {
  const names = ["workflow-build", "workflow-verify"]
  assert.equal(isUnknownAsset(names, "workflow-build"), false)
  assert.equal(isUnknownAsset(names, " workflow-build "), false)
  assert.equal(isUnknownAsset(names, "workflow-nope"), true)
  assert.equal(isUnknownAsset(names, ""), false)
  assert.equal(isUnknownAsset(names, "   "), false)
  assert.equal(isUnknownAsset([], "anything"), true)
})
