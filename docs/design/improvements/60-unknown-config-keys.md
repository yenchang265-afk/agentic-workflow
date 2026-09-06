English | [繁體中文](60-unknown-config-keys.zh-TW.md)

# 60 — A config key nothing reads is named, with the key it is one typo from

**Status: implemented.**

## The problem

`.agentic-workflow.json` is parsed by zod, and zod strips what the schema
does not declare — so a misspelled top-level key (`maxIteration`) was gone
before any code could see it, the behaviour reverted to a default, and
nothing anywhere said so. `workflows.<kind>` sections are `looseObject` by
design (kind-specific knobs ride along), so `"enable": true` under
`engineering` SURVIVED parsing and was read by nothing; the one warning that
named that typo (`unenabledConfiguredKinds`) fires for opt-in kinds only.
The hub's Config tab had a near-miss lint for the section knobs; the CLI
hosts, and the load itself, had none.

## What changed

- **`unknownConfigKeys(rawMerged)`** in `config.ts`, judged from the RAW
  merged layers — the same pre-parse vantage `retiredConfigKeys` needs, and
  for the same reason. Three scopes: top level against `ConfigSchema.shape`
  (retired keys excluded, they have their own warning), `projectManagement.*`
  against its schema, and `workflows.<kind>.*` flagged ONLY when one typo
  away from a declared section key (`workflowSectionKeys`, read off the
  schema so it cannot drift) — an unrecognised knob there is not evidence of
  a typo. `ado` is skipped (loose by design; `deprecatedAdoKeys` covers it).
- **`isNearMiss`** moved from the hub into core's zod-free `config-layers.ts`
  so both lints share one notion of a near miss.
- **`loadConfigWith` warns** per unknown key at load, and
  **`effectiveConfigReport` carries `unknownKeys`** (through an optional lint
  callback — that module is zod-free), which both hosts' `doctor config`
  render with the suggestion.
- **`$schema`** is declared (design 61), so an editor pointer is not itself
  reported.

## Sharp edges

- **Raw, never parsed.** A `Config` cannot name a key it no longer has.
- **Loose sections stay loose.** Flagging every unknown knob there would
  manufacture the exact reads-as-broken failure the hub's lint documents;
  the near-miss rule is what makes the warning trustworthy.
