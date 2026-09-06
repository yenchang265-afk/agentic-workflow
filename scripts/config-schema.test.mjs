import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { CONFIG_SCHEMA_PATH, configJsonSchema } from "../packages/core/dist/config-schema.js"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/**
 * The checked-in JSON Schema (design 61) is generated from the zod schema that
 * parses the file, and this is the drift gate: a config key added to core
 * without `pnpm gen:schema` fails here, so an editor's validation can never
 * lag the runtime's.
 */
test("schema/agentic-workflow.schema.json matches configJsonSchema() — run `pnpm gen:schema` after a config change", () => {
  const onDisk = fs.readFileSync(path.join(ROOT, CONFIG_SCHEMA_PATH), "utf8")
  assert.equal(onDisk, `${JSON.stringify(configJsonSchema(), null, 2)}\n`)
})

test("the schema declares every top-level key the runtime reads, $schema included, and keeps workflows.<kind> loose", () => {
  const s = configJsonSchema()
  const props = s.properties
  for (const key of ["$schema", "maxIterations", "tasksDir", "workflows", "taskBranch", "notifyEvents", "projectManagement"]) assert.ok(key in props, key)
  assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema")
  // prBase is a transform; io:"input" renders its input side as a string.
  assert.equal(props.prBase.type, "string")
  // The kind section stays additionalProperties: true — the near-miss lint (design 60) covers what the schema cannot.
  const section = props.workflows.additionalProperties
  assert.ok("enabled" in section.properties)
  assert.notEqual(section.additionalProperties, false)
})
