English | [繁體中文](61-config-json-schema.zh-TW.md)

# 61 — A JSON Schema for `.agentic-workflow.json`, generated from the parser

**Status: implemented.**

## The problem

The config's shape lived only in zod. An editor could not complete a key or
flag a wrong type, and the field-by-field reference in
`docs/configuration.md` was the only thing to check against — prose that
drifts. zod 4 renders JSON Schema natively; nothing called it.

## What changed

- **`configJsonSchema()`** (`config-schema.ts`) renders `ConfigSchema` with
  `io: "input"` (so `prBase`'s transform shows its input side) and
  `unrepresentable: "any"`, with `$schema`/`$id`/`title` leading the object
  so the file diffs cleanly.
- **`schema/agentic-workflow.schema.json`** is checked in, written by
  `pnpm gen:schema` (`scripts/gen-schema.mjs`, off core's built dist like
  `build-hooks`). `scripts/config-schema.test.mjs` is the drift gate: a
  config key added without regenerating fails `test:all`.
- **`$schema`** is a declared optional key, so `"$schema":
  "./schema/agentic-workflow.schema.json"` (or the raw GitHub URL) validates
  and is not reported unknown (design 60).

## Sharp edges

- **Refinements are not in the schema.** `superRefine` (an `ado` section
  when a platform is `ado`) and `.refine` predicates cannot be expressed; the
  runtime still enforces them, and the file's description says so.
- **`workflows.<kind>` stays `additionalProperties: true`.** The section is
  loose by design, so the schema cannot flag `enable` — design 60's near-miss
  lint is the complement, not a duplicate.
