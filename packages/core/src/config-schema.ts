import { z } from "zod"
import { ConfigSchema } from "./config.js"

/**
 * The JSON Schema for `.agentic-workflow.json` (design 61), derived from the
 * zod schema that actually parses the file — so an editor's red squiggle and
 * `loadConfig`'s refusal can never disagree about a key's type. Checked in at
 * `CONFIG_SCHEMA_PATH` by `scripts/gen-schema.mjs`; `scripts/config-schema.test.mjs`
 * fails when the file drifts from this function.
 *
 * `io: "input"` renders the INPUT side of every transform (`prBase` is a
 * `.transform().pipe()` and would otherwise be unrepresentable); refinements
 * (`superRefine`, `.refine`) are not expressible in JSON Schema and are
 * dropped — the runtime still enforces them. `workflows.<kind>` sections stay
 * `additionalProperties: true` because they are loose by design (kind-specific
 * knobs ride along), which is exactly why design 60's near-miss lint exists
 * beside this: the schema cannot flag `enable`, the lint can.
 */
export const CONFIG_SCHEMA_PATH = "schema/agentic-workflow.schema.json"

export const configJsonSchema = (): Record<string, unknown> => {
  const body = z.toJSONSchema(ConfigSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>
  // Key order is what makes the checked-in file diffable; the metadata leads.
  const { $schema: _dropped, ...rest } = body
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/yenchang265-afk/agentic-workflow/schema/agentic-workflow.schema.json",
    title: ".agentic-workflow.json",
    description:
      "Configuration for the agentic-workflow loop and sitters. Every field has a default; refinements the runtime enforces (e.g. codePlatform 'ado' requires an ado section) are not expressed here.",
    ...rest,
  }
}
