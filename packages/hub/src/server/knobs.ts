import type { ConfigWarning, KindBoardInfo } from "../shared/api.js"
import { isPlainObject } from "./configlayers.js"

/**
 * Advisory linting for `loops.<kind>` sections.
 *
 * `config.loops` is a `z.looseObject`, so per-kind knobs pass validation
 * unchecked, and `loop/orchestrate.ts` reads them **positionally by string key
 * with bare `typeof` checks**. A typo (`severityfloor`) or a wrong type
 * (`severityFloor: 7`) is therefore *silently ignored* — the loop runs on a
 * default and nobody is told. Catching that is the config editor's best trick.
 *
 * **Why this lives in hub and is advisory, not in core's schema.** The
 * looseness is deliberate: core's comment says kind-specific knobs "ride along
 * and are validated by the kind itself", and kinds are user-authorable — the
 * whole creator feature exists to author them. Making `loops` strict would be a
 * breaking change: every config carrying a knob core doesn't know would fail
 * `loadConfig`, breaking both hosts and every user's repo at once. So these are
 * warnings that annotate a save; they never fail one.
 *
 * **The cost, named:** this registry duplicates knowledge that lives in
 * orchestrate.ts and can drift. `knobs.test.ts` pins it with a drift alarm that
 * reads orchestrate's source and asserts the knob names match. If that ever
 * becomes a nuisance, the fix is to promote this registry into core *next to*
 * orchestrate and have orchestrate read from it.
 */

type KnobType = "string" | "boolean"

interface KnobDef {
  readonly type: KnobType
  /** Where orchestrate.ts reads it — quoted in the warning so the claim is checkable. */
  readonly site: string
}

/** Knobs every kind accepts, whatever its work source. Validated by core's schema. */
const UNIVERSAL: Readonly<Record<string, KnobDef>> = {
  enabled: { type: "boolean", site: "config.ts" },
  codePlatform: { type: "string", site: "config.ts" },
}

/** Knobs orchestrate.ts reads per work-source type. Mirrors `buildWorkSources`. */
export const BY_SOURCE: Readonly<Record<KindBoardInfo["sourceType"], Readonly<Record<string, KnobDef>>>> = {
  backlog: {},
  "github-pr": { query: { type: "string", site: "orchestrate.ts:112" } },
  "dependency-scan": {
    severityFloor: { type: "string", site: "orchestrate.ts:124" },
    includeOutdated: { type: "boolean", site: "orchestrate.ts:125" },
    ecosystem: { type: "string", site: "orchestrate.ts:126" },
  },
  "ci-runs": { branch: { type: "string", site: "orchestrate.ts:132" } },
}

/** Object-shaped keys validated by core's schema (LoopTriggerSchema; the `stageModels` record) — not positional knobs. */
const STRUCTURED_KEYS: readonly string[] = ["trigger", "stageModels"]

/** Levenshtein distance, capped: we only care whether it's 1. */
const isNearMiss = (a: string, b: string): boolean => {
  if (a === b) return false
  if (a.toLowerCase() === b.toLowerCase()) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (a.length === b.length) {
      i++
      j++
    } else if (a.length > b.length) i++
    else j++
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

/**
 * Lint every `loops.<kind>` section against the knobs its work source actually
 * reads. Pure. Never fails a save — every finding is advisory.
 */
export const lintLoopKnobs = (rawLoops: unknown, boards: readonly KindBoardInfo[]): ConfigWarning[] => {
  if (!isPlainObject(rawLoops)) return []
  const byKind = new Map(boards.map((b) => [b.kind, b]))
  const warnings: ConfigWarning[] = []

  for (const [kind, section] of Object.entries(rawLoops)) {
    const board = byKind.get(kind)
    if (!board) {
      warnings.push({
        path: `loops.${kind}`,
        message: `no loop kind "${kind}" is installed — this section is inert. Enabled kinds: ${boards.map((b) => b.kind).join(", ") || "(none)"}.`,
      })
      continue
    }
    if (!isPlainObject(section)) continue

    const forSource = BY_SOURCE[board.sourceType] ?? {}
    const known: Record<string, KnobDef> = { ...UNIVERSAL, ...forSource }

    for (const [key, value] of Object.entries(section)) {
      if (STRUCTURED_KEYS.includes(key)) continue
      const def = known[key]

      if (!def) {
        // Is it a knob some *other* source reads? That's a more useful thing to
        // say than "unknown", because the value looks right and simply never fires.
        const owner = Object.entries(BY_SOURCE).find(([src, defs]) => src !== board.sourceType && defs[key])
        if (owner) {
          warnings.push({
            path: `loops.${kind}.${key}`,
            message: `"${key}" only applies to ${owner[0]} kinds, and "${kind}" is ${board.sourceType} — it is silently ignored.`,
          })
          continue
        }
        const suggestion = Object.keys(known).find((k) => isNearMiss(k, key))
        warnings.push({
          path: `loops.${kind}.${key}`,
          message: suggestion
            ? `unknown knob "${key}" — did you mean "${suggestion}"? It is silently ignored.`
            : `unknown knob "${key}" — it is silently ignored.`,
          ...(suggestion ? { suggestion } : {}),
        })
        continue
      }

      if (typeof value !== def.type) {
        warnings.push({
          path: `loops.${kind}.${key}`,
          message: `"${key}" is read only when it is a ${def.type} (${def.site}) — a ${typeof value} is silently ignored.`,
        })
      }
    }
  }
  return warnings
}
