#!/usr/bin/env node
/**
 * Write the JSON Schema for `.agentic-workflow.json` (design 61) to
 * schema/agentic-workflow.schema.json, derived from core's zod schema — the
 * one that actually parses the file. Reads core's BUILT dist (like
 * build-hooks.mjs): `pnpm gen:schema` builds core first.
 *
 * The output is checked in; `scripts/config-schema.test.mjs` fails when it
 * drifts from `configJsonSchema()`.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { CONFIG_SCHEMA_PATH, configJsonSchema } from "../packages/core/dist/config-schema.js"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const out = path.join(ROOT, CONFIG_SCHEMA_PATH)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, `${JSON.stringify(configJsonSchema(), null, 2)}\n`)
console.log(`gen-schema: wrote ${path.relative(ROOT, out)}`)
