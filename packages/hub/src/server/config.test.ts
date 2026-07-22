import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { HubSectionSchema, loadHubSettings } from "./config.js"

const userFile = (content: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-config-"))
  const file = path.join(dir, ".agentic-workflow.json")
  fs.writeFileSync(file, content)
  return file
}

test("HubSectionSchema accepts repos + optional port", () => {
  const parsed = HubSectionSchema.parse({ repos: ["/a", "/b/*"], port: 5000 })
  assert.deepEqual(parsed, { repos: ["/a", "/b/*"], port: 5000 })
})

test("HubSectionSchema rejects empty repos and unknown keys", () => {
  assert.throws(() => HubSectionSchema.parse({ repos: [] }))
  assert.throws(() => HubSectionSchema.parse({ repos: ["/a"], extra: true }))
})

test("loadHubSettings reads the hub section from the user-scope file", () => {
  const file = userFile(JSON.stringify({ codePlatform: "github", hub: { repos: ["/a"], port: 5000 } }))
  assert.deepEqual(loadHubSettings(file), { repos: ["/a"], port: 5000 })
})

test("loadHubSettings returns null when the layer is disabled, absent, or hub-less", () => {
  assert.equal(loadHubSettings(null), null)
  assert.equal(loadHubSettings(path.join(os.tmpdir(), "hub-config-nope", "missing.json")), null)
  assert.equal(loadHubSettings(userFile(JSON.stringify({ codePlatform: "github" }))), null)
})

test("loadHubSettings throws a readable error naming the file on bad content", () => {
  const notJson = userFile("not json")
  assert.throws(() => loadHubSettings(notJson), new RegExp(notJson.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  const badHub = userFile(JSON.stringify({ hub: { repos: [] } }))
  assert.throws(() => loadHubSettings(badHub), /hub\.repos/)
})
