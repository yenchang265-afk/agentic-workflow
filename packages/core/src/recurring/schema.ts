import { z } from "zod"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { mintShortId, shortIdOf, slugify } from "../task/schema.js"

/**
 * Schema for a **recurring task definition** — a goal a human authors ONCE that
 * then repeats its whole lifecycle on its own schedule, forever, until a human
 * pauses or removes it.
 *
 * Deliberately a PARALLEL schema to `task/schema.ts`, not an extension of it.
 * The two model different things and the difference is not cosmetic:
 *
 * - A backlog task's status IS the folder it lives in, and `canTransition`
 *   (`task/store.ts`) hardcodes `completed`/`abandoned` as permanent sinks. A
 *   recurring definition has no status at all: it sits in one flat directory
 *   and is never "done", so none of that machinery applies to it.
 * - The fields a backlog task carries for epic-slicing and tracker pairing
 *   (`type`, `epic`, `priority`, `estimate`, `assignee`, `tracker`) have no
 *   consumer here. Carrying them anyway would be schema surface that reads as
 *   supported and silently isn't.
 *
 * What it does share is the FILE SHAPE — YAML frontmatter plus a markdown body,
 * parsed the same way — so a definition is as hand-editable as a task file, and
 * the pure id helpers (`slugify`/`mintShortId`/`shortIdOf`) are reused verbatim.
 *
 * This module is **pure**: it parses and validates text and never touches the
 * filesystem (that is `store.ts`).
 */

/**
 * How often one definition fires. Two forms, because they answer different
 * questions: an interval means "this long after it last ran" (drifts with
 * run duration, which is what you want for "every few hours"), a cron
 * expression means "at these wall-clock times" (which is what you want for
 * "09:00 every Monday").
 *
 * The cron expression is validated for SYNTAX at authoring time by
 * `scheduleError` (schedule.ts) rather than here, so this schema stays pure of
 * the croner dependency and a definition file with a typo'd expression still
 * PARSES — it is then reported as a broken schedule rather than vanishing from
 * every listing with a swallowed parse error.
 */
export const RecurringScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("interval"), minutes: z.number().int().positive() }),
  z.object({
    type: z.literal("cron"),
    expression: z.string().min(1),
    /**
     * IANA zone the expression is read in. Unset means **UTC**
     * (`CRON_DEFAULT_TIMEZONE`, applied in schedule.ts), NOT the host's local
     * zone: a definition file is committed to the repo and may be polled from a
     * laptop in one zone and a runner in another, and a schedule that silently
     * means something different per machine is a scheduling bug you only notice
     * hours late. Set it explicitly (`Europe/London`) for local wall-clock time.
     */
    timezone: z.string().min(1).optional(),
  }),
])

export type RecurringSchedule = z.infer<typeof RecurringScheduleSchema>

/**
 * A YAML string-list field that tolerates the colon-space footgun documented in
 * `task/schema.ts`: `- Posts a digest: grouped by area` parses as a single-key
 * MAP, not the string the author meant. Normalize every item to a string before
 * validation so a plainly-valid file is never rejected.
 */
const coerceListItem = (v: unknown): string => {
  if (typeof v === "string") return v
  if (v === null || v === undefined) return ""
  if (Array.isArray(v)) return v.map(coerceListItem).join(", ")
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => (val === null || val === undefined ? `${k}:` : `${k}: ${coerceListItem(val)}`))
      .join(", ")
  }
  return String(v)
}

const StringListSchema = z.preprocess((v) => (Array.isArray(v) ? v.map(coerceListItem) : v), z.array(z.string()))

export const RecurringFrontmatterSchema = z.object({
  /** Required. The one-line description; also the headline of every cycle's goal. */
  title: z.string().min(1, "title is required"),
  /** Required. When this definition fires. */
  schedule: RecurringScheduleSchema,
  /**
   * Paused definitions are skipped by the work source but keep their ledger, so
   * resuming picks up from the real `lastRunAt` rather than firing immediately.
   */
  paused: z.boolean().default(false),
  /** Testable criteria folded into each cycle's goal text. Optional. */
  acceptance: StringListSchema.default([]),
  /** Free-form tags. Optional. */
  labels: StringListSchema.default([]),
})

export type RecurringFrontmatter = z.infer<typeof RecurringFrontmatterSchema>

/** One parsed recurring definition. */
export interface RecurringDef {
  /** Stable id = the filename without its `.md` extension. */
  readonly id: string
  readonly title: string
  readonly schedule: RecurringSchedule
  readonly paused: boolean
  readonly acceptance: readonly string[]
  readonly labels: readonly string[]
  /** The free-form markdown body after the frontmatter — the goal's detail. */
  readonly body: string
  /** Absolute path to the definition file on disk. */
  readonly path: string
}

/** Leading `---\n…\n---` frontmatter block, then the body. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** Derive a definition's id from its filename (`f7k3-digest.md` → `f7k3-digest`). */
export const recurringId = (filename: string): string => filename.replace(/\.md$/i, "")

/**
 * Parse and validate a recurring definition file. Throws a readable,
 * filename-prefixed error when the frontmatter is missing, not valid YAML, or
 * fails the schema.
 */
export const parseRecurring = (filename: string, content: string, path: string): RecurringDef => {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) {
    throw new Error(`${filename}: missing YAML frontmatter (expected a leading --- block)`)
  }
  const [, yamlBlock, body] = match

  let raw: unknown
  try {
    raw = parseYaml(yamlBlock ?? "")
  } catch (err) {
    throw new Error(`${filename}: invalid YAML frontmatter (${(err as Error).message})`)
  }

  const result = RecurringFrontmatterSchema.safeParse(raw)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")
    throw new Error(`${filename}: ${detail}`)
  }

  const fm = result.data
  return {
    id: recurringId(filename),
    title: fm.title,
    schedule: fm.schedule,
    paused: fm.paused,
    acceptance: fm.acceptance,
    labels: fm.labels,
    body: (body ?? "").trim(),
    path,
  }
}

/** Fields for a new definition. `title` and `schedule` are required. */
export interface RecurringInput {
  readonly title: string
  readonly schedule: RecurringSchedule
  readonly paused?: boolean
  readonly acceptance?: readonly string[]
  readonly labels?: readonly string[]
  readonly body?: string
}

/**
 * The `RecurringInput` that would round-trip an already-parsed definition — the
 * seam a caller spreads a patch over (`{ ...recurringToInput(def), paused: true }`)
 * before handing the whole thing to `serializeRecurring`. Drops `id` and `path`:
 * those are the FILE's identity, not the definition's content. Pure.
 */
export const recurringToInput = (def: RecurringDef): RecurringInput => ({
  title: def.title,
  schedule: def.schedule,
  paused: def.paused,
  acceptance: def.acceptance,
  labels: def.labels,
  body: def.body,
})

/**
 * Top-level frontmatter keys `RecurringFrontmatterSchema` does not know.
 *
 * zod STRIPS unknown keys, so `serializeRecurring` silently deletes them —
 * harmless when creating a file, destructive when rewriting one a human put
 * extra fields on. A caller about to rewrite in place screens with this and
 * refuses, turning silent data loss into a visible message naming the keys.
 * Same contract as `unknownFrontmatterKeys` in `task/schema.ts`. Pure.
 */
export const unknownRecurringKeys = (content: string): string[] => {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) return []
  let raw: unknown
  try {
    raw = parseYaml(match[1] ?? "")
  } catch {
    return []
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return []
  const known = new Set(Object.keys(RecurringFrontmatterSchema.shape))
  return Object.keys(raw as Record<string, unknown>).filter((k) => !known.has(k))
}

/**
 * Serialize a definition to markdown (frontmatter + body) — the inverse of
 * `parseRecurring`. Validates through the same schema, so the required fields
 * are enforced and defaults apply.
 */
export const serializeRecurring = (input: RecurringInput): string => {
  const fm = RecurringFrontmatterSchema.parse({
    title: input.title,
    schedule: input.schedule,
    paused: input.paused,
    acceptance: input.acceptance,
    labels: input.labels,
  })
  const out: Record<string, unknown> = { title: fm.title }
  out.schedule =
    fm.schedule.type === "interval"
      ? { type: "interval", minutes: fm.schedule.minutes }
      : {
          type: "cron",
          expression: fm.schedule.expression,
          ...(fm.schedule.timezone !== undefined ? { timezone: fm.schedule.timezone } : {}),
        }
  out.paused = fm.paused
  if (fm.acceptance.length) out.acceptance = fm.acceptance
  if (fm.labels.length) out.labels = fm.labels
  const frontmatter = stringifyYaml(out).trimEnd()
  const body = (input.body ?? "").trim()
  return `---\n${frontmatter}\n---\n${body ? `${body}\n` : ""}`
}

export interface RecurringFile {
  readonly id: string
  readonly filename: string
  readonly content: string
}

/**
 * Build a definition file whose id is `<shortHash>-<slug>`, the same id shape
 * backlog tasks use — so the short handle a human types (`pause f7k3`) works
 * identically on both sides. `taken` is the existing ids to avoid colliding
 * with. Pure given `mint`; writing to disk is `store.writeRecurring`.
 */
export const buildRecurringFile = (
  input: RecurringInput,
  taken: Iterable<string> = [],
  mint: () => string = mintShortId,
): RecurringFile => {
  const content = serializeRecurring(input) // validates before we bother with a slug
  const slug = slugify(input.title) || "recurring"
  const takenList = [...taken]
  const takenHashes = new Set(takenList.map(shortIdOf))
  const takenIds = new Set(takenList)
  let id = `${mint()}-${slug}`
  for (let tries = 0; takenHashes.has(shortIdOf(id)) && tries < 8; tries++) id = `${mint()}-${slug}`
  for (let tries = 0; takenIds.has(id); tries++) id = `${mint()}-${slug}-${tries}`
  return { id, filename: `${id}.md`, content }
}
